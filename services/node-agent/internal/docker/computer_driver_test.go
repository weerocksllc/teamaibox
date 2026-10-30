package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type computerResourceFixture struct {
	binding                                    ComputerContainerBinding
	status                                     ComputerRuntimeStatus
	reads, prepares, deletes, shutdowns, binds int
	readError                                  error
	protected                                  bool
	onShutdown                                 func()
}

func (f *computerResourceFixture) ComputerProtectionConfigured() bool { return f.protected }
func (f *computerResourceFixture) PrepareComputerData(context.Context, agent.ComputerCommand) error {
	f.prepares++
	return nil
}
func (f *computerResourceFixture) VerifyComputerData(context.Context, agent.ComputerCommand) error {
	return nil
}
func (f *computerResourceFixture) BindComputerRun(context.Context, agent.ComputerCommand) (ComputerContainerBinding, error) {
	f.binds++
	return f.binding, nil
}
func (f *computerResourceFixture) ResolveComputerRun(context.Context, agent.ComputerCommand) (ComputerContainerBinding, error) {
	return f.binding, nil
}
func (f *computerResourceFixture) ReadComputerStatus(context.Context, agent.ComputerCommand) (ComputerRuntimeStatus, error) {
	f.reads++
	return f.status, f.readError
}
func (f *computerResourceFixture) RequestComputerShutdown(context.Context, agent.ComputerCommand) error {
	f.shutdowns++
	if f.onShutdown != nil {
		f.onShutdown()
	}
	return nil
}
func (f *computerResourceFixture) DeleteComputerData(context.Context, agent.ComputerCommand) error {
	f.deletes++
	return nil
}
func (f *computerResourceFixture) VerifyComputerDeleted(context.Context, agent.ComputerCommand) error {
	return nil
}

func computerDriverFixture(t *testing.T) (*ComputerDriver, *computerResourceFixture, agent.ComputerCommand, *phoneEngineState) {
	t.Helper()
	p, b, s := computerFixture(t)
	s.State.Running = true
	s.State.Status = "running"
	p.Run.ContainerID = &s.ID
	resources := &computerResourceFixture{binding: b, protected: true, status: ComputerRuntimeStatus{ComputerID: p.ComputerID, OwnerID: p.OwnerID, NodeID: p.NodeID,
		VolumeID: p.VolumeID, FirmwareID: p.FirmwareID, TPMID: p.TPMID, RunID: p.Run.ID, Generation: p.Generation, RuntimeImage: p.RuntimeImage,
		Phase: "running", UpdatedAtUnixMs: time.Now().UnixMilli()}}
	engine := &EngineRuntime{baseURL: "http://docker/v1.48", client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/json") {
			t.Fatalf("unexpected Docker mutation: %s %s", r.Method, r.URL.Path)
		}
		raw, _ := json.Marshal(s)
		return response(http.StatusOK, string(raw)), nil
	})}}
	driver, err := NewComputerDriver(engine, resources, time.Millisecond, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return driver, resources, p, &s
}

func TestComputerDriverShutdownWaitsForGuestProofWithoutDockerStop(t *testing.T) {
	d, f, p, s := computerDriverFixture(t)
	f.onShutdown = func() {
		s.State.Running = false
		s.State.Status = "exited"
		f.status.Phase = "stopped"
		f.status.CleanShutdown = true
	}
	r, err := d.ReconcileComputer(context.Background(), "shutdown", p)
	if err != nil || !r.Stopped || !r.CleanShutdown || r.Running || f.shutdowns != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	// Retry is inspect-only after guest exit; no second shutdown or kill.
	if _, err = d.ReconcileComputer(context.Background(), "shutdown", p); err != nil || f.shutdowns != 1 {
		t.Fatal("shutdown replay changed guest")
	}
}

func TestComputerDriverShutdownTimeoutRetainsLiveGuest(t *testing.T) {
	d, f, p, s := computerDriverFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, err := d.ReconcileComputer(ctx, "shutdown", p)
	if err == nil || err.Error() != "computer_shutdown_pending" || !s.State.Running || f.shutdowns != 1 || f.deletes != 0 {
		t.Fatal("timeout forced guest stop or storage release")
	}
}

func TestComputerPendingShutdownKeepsRecoveryInspectionAvailable(t *testing.T) {
	d, f, p, s := computerDriverFixture(t)
	f.status.Phase = "stopping"
	for _, code := range []string{"", "computer_shutdown_timeout", "computer_runtime_unavailable"} {
		f.status.ErrorCode = nil
		if code != "" {
			f.status.ErrorCode = &code
		}
		r, err := d.RecheckComputer(context.Background(), "inspect", p)
		if code == "computer_runtime_unavailable" {
			if err == nil || r.Running {
				t.Fatal("unrelated runtime failure accepted")
			}
		} else if err != nil || !r.Running || r.Stopped || r.CleanShutdown {
			t.Fatal("live shutdown guest unavailable for recovery", r, err)
		}
	}
	if !s.State.Running || f.shutdowns != 0 || f.deletes != 0 {
		t.Fatal("inspection changed guest")
	}
}

func TestComputerDriverExitedContainerAloneIsNotCleanShutdown(t *testing.T) {
	for _, fault := range []string{"missing-proof", "OOM", "exit-code", "status-mismatch", "error"} {
		t.Run(fault, func(t *testing.T) {
			d, f, p, s := computerDriverFixture(t)
			s.State.Running = false
			s.State.Status = "exited"
			f.status.Phase = "stopped"
			f.status.CleanShutdown = true
			switch fault {
			case "missing-proof":
				f.readError = errors.New("missing")
			case "OOM":
				s.State.OOMKilled = true
			case "exit-code":
				s.State.ExitCode = 1
			case "status-mismatch":
				f.status.OwnerID = "foreign"
			case "error":
				v := "unclean"
				f.status.ErrorCode = &v
			}
			r, err := d.RecheckComputer(context.Background(), "shutdown", p)
			if err == nil || r.CleanShutdown || !r.Stopped {
				t.Fatal("unclean stop accepted")
			}
		})
	}
}

func TestComputerDriverRunningRequiresFreshExactRuntimeStatus(t *testing.T) {
	for _, fault := range []string{"missing", "stale", "future", "wrong-owner", "wrong-disk", "wrong-run", "wrong-image", "unavailable"} {
		t.Run(fault, func(t *testing.T) {
			d, f, p, _ := computerDriverFixture(t)
			switch fault {
			case "missing":
				f.readError = errors.New("missing")
			case "stale":
				f.status.UpdatedAtUnixMs -= 31000
			case "future":
				f.status.UpdatedAtUnixMs += 31000
			case "wrong-owner":
				f.status.OwnerID = "other"
			case "wrong-disk":
				f.status.VolumeID = "other"
			case "wrong-run":
				f.status.RunID = "other"
			case "wrong-image":
				f.status.RuntimeImage = "other"
			case "unavailable":
				f.status.Phase = "unavailable"
			}
			r, err := d.RecheckComputer(context.Background(), "start", p)
			if err == nil || r.Running {
				t.Fatal("unavailable runtime reported running")
			}
		})
	}
}

func TestComputerDriverReadOnlyChecksNeverProvisionDeleteOrStart(t *testing.T) {
	d, f, p, _ := computerDriverFixture(t)
	for _, action := range []string{"create", "delete", "start", "inspect"} {
		if _, err := d.RecheckComputer(context.Background(), action, p); err != nil {
			t.Fatal(err)
		}
	}
	if f.prepares+f.deletes+f.shutdowns+f.binds != 0 {
		t.Fatal("recheck mutated resources")
	}
}

func TestComputerDriverCreatedContainerIsNotConfirmedStopped(t *testing.T) {
	d, f, p, s := computerDriverFixture(t)
	s.State.Running = false
	s.State.Status = "created"
	r, _ := d.RecheckComputer(context.Background(), "inspect", p)
	if r.Stopped || r.CleanShutdown || f.prepares+f.deletes+f.shutdowns+f.binds != 0 {
		t.Fatal("pending Docker start released resources or changed guest", r)
	}
}

func TestComputerDriverReplayedStartReusesSameRunningContainer(t *testing.T) {
	d, f, p, s := computerDriverFixture(t)
	before := s.ID
	r, err := d.ReconcileComputer(context.Background(), "start", p)
	if err != nil || !r.Running || r.ContainerID != before || f.binds != 1 {
		t.Fatalf("%+v %v", r, err)
	}
}
