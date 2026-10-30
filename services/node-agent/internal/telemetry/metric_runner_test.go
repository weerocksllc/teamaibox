package telemetry

import (
	"context"
	"errors"
	"testing"
	"time"
)

type metricStub struct {
	err   error
	calls int
	after func(int)
}

func (stub *metricStub) Metrics(context.Context, string, int64, MetricSnapshot) (*MetricResponse, error) {
	stub.calls++
	if stub.after != nil {
		stub.after(stub.calls)
	}
	return &MetricResponse{}, stub.err
}

func TestMetricRunnerWaitsForHeartbeatAfterControlPlaneRestart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := &metricStub{err: &APIError{Status: 409, Code: "managed_node_not_reporting"}}
	client.after = func(n int) {
		if n == 2 {
			client.err = nil
		}
		if n == 3 {
			cancel()
		}
	}
	runner, err := NewMetricRunner(client, staticMetric{}, "node", 1, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	runner.interval = time.Millisecond // accelerate test ticks only
	if err = runner.Run(ctx); err != nil || client.calls != 3 {
		t.Fatalf("metrics restarted Agent: %v calls=%d", err, client.calls)
	}
}

func TestMetricRunnerStillHonorsAuthorityFences(t *testing.T) {
	for _, failure := range []*APIError{
		{Status: 401, Code: "managed_node_certificate_rejected"},
		{Status: 403, Code: "managed_node_not_reporting"},
		{Status: 409, Code: "managed_node_disabled"},
		{Status: 409, Code: "stale_node_generation"},
		{Status: 409, Code: "unknown_conflict"},
	} {
		if !terminalMetricError(failure) {
			t.Fatalf("ignored authority fence: %s", failure.Code)
		}
	}
}

func TestMetricRunnerRejectedMeasurementDoesNotRestartAgent(t *testing.T) {
	for _, code := range []string{"node_metric_invalid", "node_metric_sensitive"} {
		ctx, cancel := context.WithCancel(context.Background())
		client := &metricStub{err: &APIError{Status: 400, Code: code}}
		client.after = func(n int) {
			if n == 2 {
				client.err = nil
			}
			if n == 3 {
				cancel()
			}
		}
		runner, err := NewMetricRunner(client, staticMetric{}, "node", 1, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		runner.interval = time.Millisecond
		if err = runner.Run(ctx); err != nil || client.calls != 3 {
			t.Fatalf("measurement rejection restarted Agent: %s %v calls=%d", code, err, client.calls)
		}
		cancel()
	}
}

type staticMetric struct{ err error }

func (provider staticMetric) Snapshot(context.Context) (MetricSnapshot, error) {
	return MetricSnapshot{}, provider.err
}

func TestMetricRunnerRejectsUnsafeIntervals(t *testing.T) {
	if _, err := NewMetricRunner(&metricStub{}, staticMetric{}, "node", 1, time.Second); err == nil {
		t.Fatal("expected short interval rejection")
	}
}

func TestMetricRunnerStopsOnCertificateFence(t *testing.T) {
	runner, err := NewMetricRunner(&metricStub{err: &APIError{Status: 401, Code: "managed_node_certificate_rejected"}}, staticMetric{}, "node", 1, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := runner.Run(ctx); err == nil {
		t.Fatal("expected metric fence")
	}
}

func TestMetricRunnerToleratesTransientCollectionFailure(t *testing.T) {
	runner, err := NewMetricRunner(&metricStub{}, staticMetric{err: errors.New("temporary")}, "node", 1, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
}
