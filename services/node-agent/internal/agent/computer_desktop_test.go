package agent

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
)

type desktopComputerDriver struct {
	*computerTestDriver
	opens   int
	pending bool
}

func (d *desktopComputerDriver) ReconcileComputer(ctx context.Context, action string, p ComputerCommand) (ComputerResult, error) {
	if action == "shutdown" && d.pending {
		return ComputerResult{}, errors.New("computer_shutdown_pending")
	}
	return d.computerTestDriver.ReconcileComputer(ctx, action, p)
}

func TestComputerDesktopAvailableDuringPendingShutdown(t *testing.T) {
	dir, policy, base, p := computerFixture(t)
	driver := &desktopComputerDriver{computerTestDriver: base, pending: true}
	c, err := NewComputerCoordinator(dir, policy, driver)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err = computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	p = computerStart(p)
	r, err := computerDo(c, "start", p)
	if err != nil {
		t.Fatal(err)
	}
	p.Run.ContainerID = &r.ContainerID
	p.OperationID = newUUID()
	if _, err = computerDo(c, "shutdown", p); err == nil {
		t.Fatal("shutdown should still be pending")
	}
	conn, err := c.OpenComputerDesktop(context.Background(), p, "console")
	if err != nil {
		t.Fatal("recovery desktop unavailable", err)
	}
	conn.Close()
	conn, err = c.OpenComputerDesktop(context.Background(), p, "audio")
	if err != nil {
		t.Fatal("private audio unavailable", err)
	}
	conn.Close()
	if !base.live || base.starts != 1 {
		t.Fatal("guest changed")
	}
	q := p
	q.OwnerID = newUUID()
	if _, err = c.OpenComputerDesktop(context.Background(), q, "console"); err == nil {
		t.Fatal("foreign owner accepted")
	}
	if _, err = c.OpenComputerDesktop(context.Background(), q, "audio"); err == nil {
		t.Fatal("foreign audio accepted")
	}
	if _, err = c.OpenComputerDesktop(context.Background(), p, "4714"); err == nil {
		t.Fatal("arbitrary audio destination accepted")
	}
}

func (d *desktopComputerDriver) OpenComputerDesktop(_ context.Context, _ ComputerCommand, _ string) (net.Conn, error) {
	d.opens++
	a, b := net.Pipe()
	b.Close()
	return a, nil
}

func TestComputerDesktopSurvivesRejectedShutdownAndAgentReconnection(t *testing.T) {
	dir, policy, base, p := computerFixture(t)
	driver := &desktopComputerDriver{computerTestDriver: base}
	c, err := NewComputerCoordinator(dir, policy, driver)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = computerDo(c, "create", p); err != nil {
		t.Fatal(err)
	}
	p = computerStart(p)
	running, err := computerDo(c, "start", p)
	if err != nil {
		t.Fatal(err)
	}
	p.Run.ContainerID = &running.ContainerID
	open := func() {
		t.Helper()
		conn, err := c.OpenComputerDesktop(context.Background(), p, "console")
		if err != nil {
			t.Fatal(err)
		}
		conn.Close()
	}
	open()
	base.refuse = true
	p.OperationID = newUUID()
	result, err := computerDo(c, "shutdown", p)
	if err != nil || !result.Rejected || !base.live {
		t.Fatal("fixture did not retain running guest", err)
	}
	open()
	c.Close()
	policy.NodeGeneration++
	// Updating the installed runtime must not deny the retained exact live run.
	policy.InstalledProfiles[p.ProfileID] = "sha256:" + strings.Repeat("f", 64)
	c, err = NewComputerCoordinator(dir, policy, driver)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	open()
	if driver.opens != 3 || base.starts != 1 {
		t.Fatal("guest restarted or desktop lost")
	}
	for _, mutate := range []func(*ComputerCommand){
		func(q *ComputerCommand) { q.OwnerID = newUUID() },
		func(q *ComputerCommand) { q.VolumeID = newUUID() },
		func(q *ComputerCommand) { q.Generation++ },
		func(q *ComputerCommand) { q.RuntimeImage = "sha256:" + strings.Repeat("f", 64) },
		func(q *ComputerCommand) { q.Run.ID = newUUID() },
		func(q *ComputerCommand) { id := strings.Repeat("c", 64); q.Run.ContainerID = &id },
	} {
		q := p
		run := *p.Run
		q.Run = &run
		mutate(&q)
		if conn, err := c.OpenComputerDesktop(context.Background(), q, "console"); err == nil {
			conn.Close()
			t.Fatal("changed guest binding accepted")
		}
	}
	if driver.opens != 3 {
		t.Fatal("rejected desktop reached runtime")
	}
}
