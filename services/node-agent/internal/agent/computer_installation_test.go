package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type installationDriverFixture struct {
	*computerTestDriver
	mediaCalls int
}

type blockingInstallationDriver struct {
	*installationDriverFixture
	entered chan struct{}
	release chan struct{}
}

func (d *blockingInstallationDriver) ApplyComputerInstallation(ctx context.Context, p ComputerCommand, input io.Reader) (ComputerResult, error) {
	close(d.entered)
	select {
	case <-d.release:
		return d.installationDriverFixture.ApplyComputerInstallation(ctx, p, input)
	case <-ctx.Done():
		return ComputerResult{}, ctx.Err()
	}
}

func (d *blockingInstallationDriver) ComputerBaseline(context.Context) (json.RawMessage, error) {
	return json.RawMessage(`{"available":true}`), nil
}

func TestComputerInstallationStreamAllowsStatusAndFencesOnlyTargetMutations(t *testing.T) {
	directory, policy, base, p := computerFixture(t)
	driver := &blockingInstallationDriver{&installationDriverFixture{computerTestDriver: base}, make(chan struct{}), make(chan struct{})}
	c, err := NewComputerCoordinator(directory, policy, driver)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err = computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	request := p
	request.OperationID = newUUID()
	request.Installation = &ComputerInstallationCommand{Action: "eject", Revision: 2}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, e := c.ExecuteComputerInstallation(ctx, request, Ownership{NodeID: policy.NodeID, NodeGeneration: 1, LeaseID: p.ComputerID, FencingToken: p.Generation + 1}, strings.NewReader(""))
		done <- e
	}()
	<-driver.entered
	checked := make(chan error, 1)
	go func() {
		if _, e := c.ComputerBaseline(ctx); e != nil {
			checked <- e
			return
		}
		_, e := computerDo(c, "start", computerStart(p))
		if e == nil || e.Error() != "computer_operation_pending" {
			checked <- fmt.Errorf("target mutation was not fenced: %v", e)
			return
		}
		other := p
		other.ComputerID, other.VolumeID, other.FirmwareID, other.OperationID = newUUID(), newUUID(), newUUID(), newUUID()
		tpm := newUUID()
		other.TPMID = &tpm
		_, e = computerDo(c, "create", other)
		checked <- e
	}()
	select {
	case err = <-checked:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("installation stream blocked status or another computer")
	}
	close(driver.release)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	if _, err = computerDo(c, "start", computerStart(p)); err != nil {
		t.Fatal(err)
	}
}

func (d *installationDriverFixture) ApplyComputerInstallation(ctx context.Context, p ComputerCommand, input io.Reader) (ComputerResult, error) {
	d.mediaCalls++
	r := ComputerResult{ComputerIdentity: p.ComputerIdentity, InstallationRevision: p.Installation.Revision, MediaDigest: p.Installation.Digest, MediaReady: true}
	if p.Run != nil {
		r.RunID = p.Run.ID
		r.ContainerID = *p.Run.ContainerID
		r.RuntimeImage = p.RuntimeImage
	}
	return r, nil
}
func TestComputerInstallationPreservesLifecycleJournalAndRejectsForeignOrStaleRequests(t *testing.T) {
	directory, policy, base, p := computerFixture(t)
	driver := &installationDriverFixture{computerTestDriver: base}
	c, err := NewComputerCoordinator(directory, policy, driver)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err = computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	read := func() []byte {
		b, e := os.ReadFile(filepath.Join(directory, "computers.json"))
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	before := read()
	request := p
	request.OperationID = newUUID()
	request.Installation = &ComputerInstallationCommand{Action: "eject", Revision: 2}
	call := func(p ComputerCommand) (ComputerResult, error) {
		return c.ExecuteComputerInstallation(context.Background(), p, Ownership{NodeID: policy.NodeID, NodeGeneration: 1, LeaseID: p.ComputerID, FencingToken: p.Generation + 1}, strings.NewReader(""))
	}
	result, err := call(request)
	if err != nil || !result.MediaReady {
		t.Fatal(result, err)
	}
	raw, _ := json.Marshal(result)
	var decoded map[string]any
	json.Unmarshal(raw, &decoded)
	if v, present := decoded["mediaDigest"]; !present || v != nil {
		t.Fatal("eject must explicitly report a null medium")
	}
	if !bytes.Equal(before, read()) {
		t.Fatal("media mutation rewrote lifecycle journal")
	}
	foreign := request
	foreign.OwnerID = newUUID()
	if _, err = call(foreign); err == nil {
		t.Fatal("foreign owner accepted")
	}
	stale := request
	stale.Generation = 1
	if _, err = call(stale); err == nil {
		t.Fatal("unadmitted generation accepted")
	}
	if driver.mediaCalls != 1 {
		t.Fatal("invalid request reached driver")
	}
	p = computerStart(p)
	started, err := computerDo(c, "start", p)
	if err != nil {
		t.Fatal(err)
	}
	request = p
	request.OperationID = newUUID()
	request.Run = &ComputerRun{ID: p.Run.ID, Generation: p.Generation, RuntimeImage: p.RuntimeImage, ContainerID: &started.ContainerID}
	request.Installation = &ComputerInstallationCommand{Action: "eject", Revision: 3}
	before = read()
	if _, err = call(request); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, read()) || base.starts != 1 {
		t.Fatal("optical command restarted the VM")
	}
	legacy, _ := json.Marshal(started)
	var old map[string]any
	json.Unmarshal(legacy, &old)
	if _, present := old["mediaDigest"]; present {
		t.Fatal("legacy result protocol changed")
	}
}
func TestComputerInstallationPayloadRequiresClosedExplicitMediaFields(t *testing.T) {
	_, _, _, p := computerFixture(t)
	p.Installation = &ComputerInstallationCommand{Action: "eject", Revision: 1}
	raw, _ := json.Marshal(p)
	if _, err := decodeComputerCommand(raw, "installation"); err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	json.Unmarshal(raw, &value)
	delete(value["installation"].(map[string]any), "digest")
	raw, _ = json.Marshal(value)
	if _, err := decodeComputerCommand(raw, "installation"); err == nil {
		t.Fatal("missing digest accepted")
	}
}
