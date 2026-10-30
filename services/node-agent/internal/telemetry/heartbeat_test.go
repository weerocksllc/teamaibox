package telemetry

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type staticInventory struct {
	value Inventory
	err   error
}

func (provider staticInventory) Snapshot(context.Context) (Inventory, error) {
	return provider.value, provider.err
}

type heartbeatStub struct {
	err   error
	calls int
	after func(int)
}

type generationReconcilerStub struct {
	current int64
	next    int64
	calls   int
}

func (stub *generationReconcilerStub) Advance(current, next int64) error {
	stub.current, stub.next = current, next
	stub.calls++
	return nil
}

func TestHeartbeatRunnerRetriesControlPlaneOutageWithoutRestart(t *testing.T) {
	for _, failure := range []error{errors.New("connection refused"), &APIError{Status: 503, Code: "unavailable", Retryable: true}} {
		ctx, cancel := context.WithCancel(context.Background())
		client := &heartbeatStub{err: failure}
		client.after = func(n int) {
			if n == 2 {
				client.err = nil
			}
			if n == 3 {
				cancel()
			}
		}
		runner, err := NewHeartbeatRunner(client, staticInventory{}, "node", 1, time.Second, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		now := time.Unix(0, 0)
		runner.clock = func() time.Time { now = now.Add(3 * time.Second); return now }
		err = runner.Run(ctx)
		cancel()
		if err != nil || client.calls != 3 {
			t.Fatalf("transient outage restarted agent: %v calls=%d", err, client.calls)
		}
	}
}

func (stub *heartbeatStub) Heartbeat(context.Context, string, int64, Inventory) (*HeartbeatResponse, error) {
	stub.calls++
	if stub.after != nil {
		stub.after(stub.calls)
	}
	return &HeartbeatResponse{}, stub.err
}

func TestHeartbeatRunnerStopsImmediatelyWhenGenerationIsFenced(t *testing.T) {
	client := &heartbeatStub{err: &APIError{Status: 409, Code: "stale_node_generation", Retryable: true}}
	runner, err := NewHeartbeatRunner(client, staticInventory{value: Inventory{}}, "node", 1, time.Second, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	err = runner.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "fenced") || client.calls != 1 {
		t.Fatalf("runner did not fail closed: %v", err)
	}
}

func TestMaintenanceReadinessRequiresAcceptedHeartbeatAndFencingStillStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := &heartbeatStub{err: errors.New("temporary outage")}
	ready := 0
	client.after = func(n int) {
		if n == 2 {
			client.err = nil
		}
		if n == 3 {
			cancel()
		}
	}
	runner, err := NewHeartbeatRunner(client, staticInventory{}, "node", 9, time.Second, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.RunWithReady(ctx, func() {
		ready++
		if client.calls != 2 {
			t.Fatal("premature readiness")
		}
	}); err != nil || ready != 1 {
		t.Fatalf("readiness %d error %v", ready, err)
	}
	client = &heartbeatStub{err: &APIError{Status: 409, Code: "stale_node_generation", Retryable: true}}
	runner, _ = NewHeartbeatRunner(client, staticInventory{}, "node", 9, time.Second, 2*time.Second)
	if err := runner.RunWithReady(context.Background(), func() { t.Fatal("fenced maintenance reported ready") }); err == nil {
		t.Fatal("fence bypassed")
	}
}

func TestHeartbeatRunnerPersistsOnlyForwardServerGenerationBeforeRestart(t *testing.T) {
	client := &heartbeatStub{err: &APIError{Status: 409, Code: "stale_node_generation", Retryable: true, Details: APIErrorDetails{CurrentGeneration: 3}}}
	runner, err := NewHeartbeatRunner(client, staticInventory{value: Inventory{}}, "node", 1, time.Second, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	reconciler := new(generationReconcilerStub)
	if err := runner.SetGenerationReconciler(reconciler); err != nil {
		t.Fatal(err)
	}
	err = runner.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "restart required") || reconciler.calls != 1 || reconciler.current != 1 || reconciler.next != 3 {
		t.Fatalf("runner did not persist the forward generation fence: %v %#v", err, reconciler)
	}
}

func TestHeartbeatRunnerStopsBeforeSchedulerStaleWindowOnLocalInventoryFailure(t *testing.T) {
	client := &heartbeatStub{}
	runner, err := NewHeartbeatRunner(client, staticInventory{err: errors.New("inventory unavailable")}, "node", 1, time.Second, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	runner.clock = func() time.Time { now = now.Add(time.Second); return now }
	err = runner.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "maximum silence") || client.calls != 0 {
		t.Fatalf("runner did not fail closed: %v", err)
	}
}
