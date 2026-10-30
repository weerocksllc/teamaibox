package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func computerPayload() ComputerCommand {
	tpm := newUUID()
	return ComputerCommand{ComputerIdentity: ComputerIdentity{ComputerID: workerID, OwnerID: attemptID, NodeID: nodeID,
		VolumeID: profileID, FirmwareID: newUUID(), TPMID: &tpm, OperationID: leaseID, Generation: 1},
		PoolID: "windows-test", ProfileID: "windows11-pro", RuntimeImage: "sha256:" + strings.Repeat("a", 64),
		Resources: ComputerResources{VCPUs: 4, MemoryBytes: 8 << 30, DiskBytes: 128 << 30},
		Run:       &ComputerRun{ID: newUUID(), Generation: 1, RuntimeImage: "sha256:" + strings.Repeat("a", 64)}}
}
func TestComputerCommittedAllocationGrammar(t *testing.T) {
	p := computerPayload()
	p.Allocation = &ComputerAllocation{MemoryBytes: 10 << 30, CPUIds: []int{10, 11, 12, 13}}
	raw, _ := json.Marshal(p)
	decoded, err := decodeComputerCommand(raw, "start")
	if err != nil || decoded.Allocation == nil || decoded.Allocation.CPUIds[0] != 10 {
		t.Fatal(err)
	}
	for _, fault := range []string{"duplicate", "memory", "count", "negative", "shutdown", "null", "unknown"} {
		t.Run(fault, func(t *testing.T) {
			var fields map[string]any
			_ = json.Unmarshal(raw, &fields)
			allocation := fields["allocation"].(map[string]any)
			action := "start"
			switch fault {
			case "duplicate":
				allocation["cpuIds"] = []int{0, 0, 1, 2}
			case "memory":
				allocation["memoryBytes"] = 1
			case "count":
				allocation["cpuIds"] = []int{1}
			case "negative":
				allocation["cpuIds"] = []int{-1, 0, 1, 2}
			case "shutdown":
				action = "shutdown"
			case "null":
				allocation["cpuIds"] = nil
			case "unknown":
				allocation["hostCommand"] = "no"
			}
			bad, _ := json.Marshal(fields)
			if _, e := decodeComputerCommand(bad, action); e == nil {
				t.Fatal("invalid allocation accepted")
			}
		})
	}
}

type computerRuntimeStub struct {
	calls     int
	protected bool
	stopped   bool
}

func (d *computerRuntimeStub) ComputerProtectionConfigured() bool { return d.protected }
func (d *computerRuntimeStub) ExecuteComputer(ctx context.Context, action string, p ComputerCommand, o Ownership) (ComputerResult, error) {
	d.calls++
	if _, ok := ctx.Deadline(); !ok || o.NodeID != p.NodeID || o.LeaseID != p.ComputerID {
		return ComputerResult{}, errors.New("computer_authority_invalid")
	}
	if d.stopped {
		return ComputerResult{}, errors.New("computer_stale_run")
	}
	return ComputerResult{ComputerIdentity: p.ComputerIdentity, RunID: p.Run.ID, ContainerID: strings.Repeat("b", 64), RuntimeImage: p.RuntimeImage, Running: true}, nil
}
func TestComputerCommandUsesExistingAuthenticationAndNeverReplaysCachedRunning(t *testing.T) {
	s, _, _ := serviceFixture(t)
	runtime := &computerRuntimeStub{protected: true}
	if err := s.ConfigureComputers(runtime); err != nil {
		t.Fatal(err)
	}
	p := computerPayload()
	e := envelope(t, newUUID(), "virtual-computer.start", p, p.Generation+1)
	e.LeaseID = p.ComputerID
	r, err := s.Handle(context.Background(), e, proof(t, e, "computer-first"))
	if err != nil || r.Status != "succeeded" || runtime.calls != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	runtime.stopped = true
	r, err = s.Handle(context.Background(), e, proof(t, e, "computer-repeat"))
	if err != nil || r.ErrorCode != "computer_stale_run" || runtime.calls != 2 {
		t.Fatalf("cached stale run: %+v %v", r, err)
	}
}
func TestComputerUnconfiguredRuntimeDoesNotFallBackToPhoneDriver(t *testing.T) {
	s, _, _ := serviceFixture(t)
	p := computerPayload()
	e := envelope(t, newUUID(), "virtual-computer.start", p, p.Generation+1)
	e.LeaseID = p.ComputerID
	r, err := s.Handle(context.Background(), e, proof(t, e, "computer-unconfigured"))
	if err != nil || r.ErrorCode != "computer_runtime_not_configured" {
		t.Fatalf("%+v %v", r, err)
	}
}
func TestComputerConfigurationRequiresLocalResourceProtection(t *testing.T) {
	s, _, _ := serviceFixture(t)
	if s.ConfigureComputers(&computerRuntimeStub{}) == nil {
		t.Fatal("unprotected runtime enabled")
	}
}
func TestComputerCommandRejectsHostOptionsAndDifferentNode(t *testing.T) {
	p := computerPayload()
	raw, _ := json.Marshal(p)
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	fields["command"] = "shell"
	changed, _ := json.Marshal(fields)
	if _, err := decodeComputerCommand(changed, "start"); err == nil {
		t.Fatal("host command allowed")
	}
	delete(fields, "command")
	delete(fields, "tpmId")
	changed, _ = json.Marshal(fields)
	if _, err := decodeComputerCommand(changed, "start"); err == nil {
		t.Fatal("missing explicit TPM field")
	}
	s, _, _ := serviceFixture(t)
	runtime := &computerRuntimeStub{protected: true}
	_ = s.ConfigureComputers(runtime)
	p.NodeID = newUUID()
	e := envelope(t, newUUID(), "virtual-computer.start", p, p.Generation+1)
	e.LeaseID = p.ComputerID
	r, err := s.Handle(context.Background(), e, proof(t, e, "computer-foreign-node"))
	if err != nil || r.ErrorCode != "computer_payload_invalid" || runtime.calls != 0 {
		t.Fatalf("%+v %v", r, err)
	}
}
func TestComputerDecodeRejectsDuplicateKeysAndAllowsExplicitNullRun(t *testing.T) {
	p := computerPayload()
	p.Run = nil
	p.Generation = 0
	raw, _ := json.Marshal(p)
	if _, err := decodeComputerCommand(raw, "create"); err != nil {
		t.Fatal(err)
	}
	for _, changed := range []string{
		strings.Replace(string(raw), `"generation":0`, `"generation":1,"generation":0`, 1),
		strings.Replace(string(raw), `"vcpus":4`, `"vcpus":8,"vcpus":4`, 1),
	} {
		if _, err := decodeComputerCommand([]byte(changed), "create"); err == nil {
			t.Fatal("duplicate field accepted")
		}
	}
}
func TestComputerResultMustMatchPersistentDiskFirmwareTPMAndRun(t *testing.T) {
	p := computerPayload()
	r := ComputerResult{ComputerIdentity: p.ComputerIdentity, RunID: p.Run.ID, ContainerID: strings.Repeat("b", 64), RuntimeImage: p.RuntimeImage, Running: true}
	if err := validateComputerResult("start", p, r); err != nil {
		t.Fatal(err)
	}
	r.FirmwareID = newUUID()
	if validateComputerResult("start", p, r) == nil {
		t.Fatal("different firmware accepted")
	}
	r.ComputerIdentity = p.ComputerIdentity
	r.Running = false
	r.Stopped = true
	if validateComputerResult("shutdown", p, r) == nil {
		t.Fatal("unconfirmed shutdown accepted")
	}
}
