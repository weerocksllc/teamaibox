package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type computerTestDriver struct {
	t         *testing.T
	directory string
	starts    int
	effects   int
	checks    int
	live      bool
	loseReply bool
	refuse    bool
}

func (d *computerTestDriver) ComputerProtectionConfigured() bool { return true }
func (d *computerTestDriver) ReconcileComputer(ctx context.Context, a string, p ComputerCommand) (ComputerResult, error) {
	raw, err := os.ReadFile(filepath.Join(d.directory, "computers.json"))
	if err != nil {
		d.t.Fatal(err)
	}
	var j computerJournal
	if json.Unmarshal(raw, &j) != nil || j.Computers[p.ComputerID].Command.OperationID != p.OperationID {
		d.t.Fatal("effect before persisted operation")
	}
	d.effects++
	if d.refuse {
		return ComputerResult{ComputerIdentity: p.ComputerIdentity, Rejected: true, NoSideEffects: true, ErrorCode: "computer_capacity_unavailable"}, nil
	}
	if a == "start" && !d.live {
		d.starts++
		d.live = true
	}
	if a == "shutdown" {
		d.live = false
	}
	if d.loseReply {
		d.loseReply = false
		return ComputerResult{}, errors.New("lost_reply")
	}
	return d.result(a, p), nil
}
func (d *computerTestDriver) RecheckComputer(ctx context.Context, a string, p ComputerCommand) (ComputerResult, error) {
	d.checks++
	return d.result(a, p), nil
}
func (d *computerTestDriver) result(a string, p ComputerCommand) ComputerResult {
	r := ComputerResult{ComputerIdentity: p.ComputerIdentity}
	switch a {
	case "create":
		r.Provisioned = true
		r.Encryption = "luks2"
	case "delete":
		r.DataDeleted = true
	default:
		r.RunID = p.Run.ID
		r.RuntimeImage = p.RuntimeImage
		r.ContainerID = strings.Repeat("b", 64)
		r.Running = d.live
		r.Stopped = !d.live
		r.CleanShutdown = a == "shutdown" && !d.live
	}
	return r
}
func computerFixture(t *testing.T) (string, ComputerRuntimePolicy, *computerTestDriver, ComputerCommand) {
	t.Helper()
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	policy := ComputerRuntimePolicy{NodeID: newUUID(), NodeGeneration: 1, PoolID: "windows-pool", InstalledProfiles: map[string]string{"win11": "sha256:" + strings.Repeat("a", 64)}}
	tpm := newUUID()
	p := ComputerCommand{ComputerIdentity: ComputerIdentity{ComputerID: newUUID(), OwnerID: newUUID(), NodeID: policy.NodeID, VolumeID: newUUID(), FirmwareID: newUUID(), TPMID: &tpm, OperationID: newUUID()},
		PoolID: policy.PoolID, ProfileID: "win11", RuntimeImage: policy.InstalledProfiles["win11"], Resources: ComputerResources{VCPUs: 4, MemoryBytes: 8 << 30, DiskBytes: 96 << 30}}
	return directory, policy, &computerTestDriver{t: t, directory: directory}, p
}
func computerDo(c *ComputerCoordinator, a string, p ComputerCommand) (ComputerResult, error) {
	return c.ExecuteComputer(context.Background(), a, p, Ownership{NodeID: c.policy.NodeID, NodeGeneration: c.policy.NodeGeneration, LeaseID: p.ComputerID, FencingToken: p.Generation + 1})
}
func computerStart(p ComputerCommand) ComputerCommand {
	p.OperationID = newUUID()
	p.Generation++
	p.Run = &ComputerRun{ID: newUUID(), Generation: p.Generation, RuntimeImage: p.RuntimeImage}
	return p
}
func computerOpen(t *testing.T, path string, policy ComputerRuntimePolicy, d *computerTestDriver) *ComputerCoordinator {
	t.Helper()
	c, err := NewComputerCoordinator(path, policy, d)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestComputerObservedExitPersistsAndAllowsOnlyFreshGeneration(t *testing.T) {
	for _, lost := range []bool{false, true} {
		dir, policy, driver, p := computerFixture(t)
		c := computerOpen(t, dir, policy, driver)
		if _, err := computerDo(c, "create", p); err != nil {
			t.Fatal(err)
		}
		p = computerStart(p)
		driver.loseReply = lost
		_, err := computerDo(c, "start", p)
		if (err != nil) != lost {
			t.Fatal("unexpected start response", err)
		}
		driver.live = false // Independent guest exit or runtime crash.
		inspect := p
		inspect.OperationID = newUUID()
		r, err := computerDo(c, "inspect", inspect)
		if err != nil || !r.Stopped || r.CleanShutdown {
			t.Fatal("exit not recorded truthfully", err, r)
		}
		c.Close()
		c = computerOpen(t, dir, policy, driver)
		if _, err := computerDo(c, "start", p); err == nil {
			t.Fatal("old start replay restarted a finished run")
		}
		p = computerStart(p)
		if _, err := computerDo(c, "start", p); err != nil {
			t.Fatal("fresh run denied after observed exit", err)
		}
		if driver.starts != 2 {
			t.Fatal("incorrect number of actual starts")
		}
		c.Close()
	}
}

func TestComputerInstalledRuntimeUpdateOnlyAtStoppedFreshStart(t *testing.T) {
	dir, policy, driver, p := computerFixture(t)
	c := computerOpen(t, dir, policy, driver)
	if _, err := computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	c.Close()
	updated := "sha256:" + strings.Repeat("f", 64)
	policy.InstalledProfiles[p.ProfileID] = updated
	c = computerOpen(t, dir, policy, driver)
	defer c.Close()
	p.RuntimeImage = updated
	p = computerStart(p)
	if _, err := computerDo(c, "start", p); err != nil {
		t.Fatal(err)
	}
	if driver.starts != 1 {
		t.Fatal("expected exactly one new run")
	}
	// Changing the installed policy while a guest is live never rebinds that
	// run, even if the caller supplies an otherwise valid fresh operation.
	other := "sha256:" + strings.Repeat("e", 64)
	c.policy.InstalledProfiles[p.ProfileID] = other
	p.RuntimeImage = other
	p.Run.RuntimeImage = other
	p.OperationID = newUUID()
	for _, action := range []string{"start", "inspect", "shutdown"} {
		if _, err := computerDo(c, action, p); err == nil {
			t.Fatalf("active image replacement accepted: %s", action)
		}
	}
	if driver.starts != 1 {
		t.Fatal("live guest was restarted")
	}
}

func TestComputerPersistBeforeEffectAndPreserveAcrossAgentReconnection(t *testing.T) {
	dir, policy, driver, p := computerFixture(t)
	c := computerOpen(t, dir, policy, driver)
	if _, err := computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	p = computerStart(p)
	first, err := computerDo(c, "start", p)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	policy.NodeGeneration = 2
	c = computerOpen(t, dir, policy, driver)
	defer c.Close()
	repeated, err := computerDo(c, "start", p)
	if err != nil {
		t.Fatal(err)
	}
	if first != repeated || driver.starts != 1 || driver.checks != 1 {
		t.Fatalf("guest restarted or identity changed: %#v %#v", first, repeated)
	}
	if _, err = c.ExecuteComputer(context.Background(), "start", p, Ownership{NodeID: policy.NodeID, NodeGeneration: 1, LeaseID: p.ComputerID, FencingToken: p.Generation + 1}); err == nil {
		t.Fatal("stale transport accepted")
	}
}

func TestComputerMaintenanceRetainsOldRunRecoveryAndStoppedDeletion(t *testing.T) {
	dir, policy, driver, p := computerFixture(t)
	c := computerOpen(t, dir, policy, driver)
	defer c.Close()
	if _, err := computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	p = computerStart(p)
	result, err := computerDo(c, "start", p)
	if err != nil {
		t.Fatal(err)
	}
	p.Run.ContainerID = &result.ContainerID
	c.policy.InstalledProfiles[p.ProfileID] = "sha256:" + strings.Repeat("f", 64)
	p.OperationID = newUUID()
	if _, err := computerDo(c, "inspect", p); err != nil {
		t.Fatal(err)
	}
	if _, err := computerDo(c, "shutdown", p); err != nil {
		t.Fatal(err)
	}
	p.OperationID = newUUID()
	p.Run = nil
	if _, err := computerDo(c, "delete", p); err != nil {
		t.Fatal(err)
	}
	if driver.starts != 1 {
		t.Fatal("maintenance restarted the guest")
	}
}
func TestComputerLostReplyReconcilesSameRunAndDifferentOperationCannotDuplicate(t *testing.T) {
	dir, policy, driver, p := computerFixture(t)
	c := computerOpen(t, dir, policy, driver)
	if _, err := computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	p = computerStart(p)
	driver.loseReply = true
	if _, err := computerDo(c, "start", p); err == nil {
		t.Fatal("expected lost response")
	}
	c.Close()
	c = computerOpen(t, dir, policy, driver)
	defer c.Close()
	other := p
	other.OperationID = newUUID()
	if _, err := computerDo(c, "start", other); err == nil {
		t.Fatal("parallel operation accepted")
	}
	if _, err := computerDo(c, "start", p); err != nil {
		t.Fatal(err)
	}
	if driver.starts != 1 {
		t.Fatal("duplicated run")
	}
}
func TestComputerReplayDoesNotReviveExitedGuestAndDeleteNeedsStop(t *testing.T) {
	dir, policy, driver, p := computerFixture(t)
	c := computerOpen(t, dir, policy, driver)
	defer c.Close()
	if _, err := computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	p = computerStart(p)
	if _, err := computerDo(c, "start", p); err != nil {
		t.Fatal(err)
	}
	driver.live = false
	if _, err := computerDo(c, "start", p); err == nil {
		t.Fatal("cached running success returned")
	}
	if driver.live || driver.starts != 1 {
		t.Fatal("exited guest revived")
	}
	deletion := p
	deletion.OperationID = newUUID()
	deletion.Run = nil
	if _, err := computerDo(c, "delete", deletion); err == nil {
		t.Fatal("unconfirmed guest deleted")
	}
}
func TestComputerExplicitShutdownAndNewStartKeepStorageAndRejectStaleRun(t *testing.T) {
	dir, policy, driver, p := computerFixture(t)
	c := computerOpen(t, dir, policy, driver)
	defer c.Close()
	if _, err := computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	p = computerStart(p)
	running, err := computerDo(c, "start", p)
	if err != nil {
		t.Fatal(err)
	}
	old := p
	stop := p
	stop.OperationID = newUUID()
	run := *p.Run
	run.ContainerID = &running.ContainerID
	stop.Run = &run
	if _, err = computerDo(c, "shutdown", stop); err != nil {
		t.Fatal(err)
	}
	next := computerStart(stop)
	if _, err = computerDo(c, "start", next); err != nil {
		t.Fatal(err)
	}
	if _, err = computerDo(c, "start", old); err == nil {
		t.Fatal("stale start accepted")
	}
	if next.VolumeID != old.VolumeID || next.FirmwareID != old.FirmwareID || *next.TPMID != *old.TPMID || next.Run.ID == old.Run.ID {
		t.Fatal("persistent identity changed")
	}
}
func TestComputerRejectsVolumeOwnerProfileAndOperationRebinding(t *testing.T) {
	dir, policy, driver, p := computerFixture(t)
	c := computerOpen(t, dir, policy, driver)
	defer c.Close()
	if _, err := computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*ComputerCommand){func(q *ComputerCommand) { q.VolumeID = newUUID() }, func(q *ComputerCommand) { q.OwnerID = newUUID() }, func(q *ComputerCommand) { q.RuntimeImage = "sha256:" + strings.Repeat("c", 64) }, func(q *ComputerCommand) { q.Resources.MemoryBytes *= 2 }} {
		q := p
		change(&q)
		if _, err := computerDo(c, "create", q); err == nil {
			t.Fatal("identity change accepted")
		}
	}
	q := p
	q.ComputerID = newUUID()
	q.OperationID = newUUID()
	if _, err := computerDo(c, "create", q); err == nil {
		t.Fatal("volume reused by another computer")
	}
}
func TestComputerJournalHasSingleOwnerAndRejectsCorruption(t *testing.T) {
	dir, policy, driver, _ := computerFixture(t)
	c := computerOpen(t, dir, policy, driver)
	if second, err := NewComputerCoordinator(dir, policy, driver); err == nil {
		second.Close()
		t.Fatal("two agents acquired journal")
	}
	c.Close()
	if err := os.WriteFile(filepath.Join(dir, "computers.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if second, err := NewComputerCoordinator(dir, policy, driver); err == nil {
		second.Close()
		t.Fatal("corrupted state silently reset")
	}
}
func TestComputerCapacityRejectionIsStableButAllowsNewGeneration(t *testing.T) {
	dir, policy, driver, p := computerFixture(t)
	c := computerOpen(t, dir, policy, driver)
	defer c.Close()
	if _, err := computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	p = computerStart(p)
	driver.refuse = true
	r, err := computerDo(c, "start", p)
	if err != nil || !r.Rejected {
		t.Fatal("expected refusal", err)
	}
	effects := driver.effects
	driver.refuse = false
	r, err = computerDo(c, "start", p)
	if err != nil || !r.Rejected || driver.effects != effects {
		t.Fatal("rejected request later started a guest")
	}
	p = computerStart(p)
	if _, err := computerDo(c, "start", p); err != nil {
		t.Fatal(err)
	}
}
