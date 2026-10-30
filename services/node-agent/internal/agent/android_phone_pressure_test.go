package agent

import (
	"context"
	"errors"
	"math"
	"os"
	"sync"
	"testing"
	"time"
)

func quietPhoneMemory(now time.Time) []PhoneMemorySample {
	values := make([]PhoneMemorySample, 17)
	for i := range values {
		values[i] = PhoneMemorySample{ObservedAt: now.Add(time.Duration(i-16) * 2 * time.Second).Format(time.RFC3339Nano), AvailableBytes: 40 << 30, SwapOutBytes: 9 << 30}
	}
	return values
}

func TestPhonePressureThresholdsAndSustainedWindows(t *testing.T) {
	for _, name := range []string{"quiet_old_swap", "margin", "margin_equal", "psi_8s", "psi_10s", "psi_interrupted", "swap_8s", "swap_10s", "swap_equal", "swap_interrupted"} {
		t.Run(name, func(t *testing.T) {
			now := time.Now()
			values := quietPhoneMemory(now)
			want, admission := "", name == "quiet_old_swap" || name == "margin_equal" || name == "margin"
			switch name {
			case "margin":
				values[16].AvailableBytes = 1
			case "margin_equal":
				values[16].AvailableBytes = 16 << 30
			case "psi_8s", "psi_10s", "psi_interrupted":
				begin := 11
				if name == "psi_8s" {
					begin = 12
				}
				for i := begin; i < len(values); i++ {
					values[i].PSISomeAverage10 = 5
				}
				if name == "psi_10s" {
					want = "memory_pressure"
				}
				if name == "psi_interrupted" {
					values[14].PSISomeAverage10 = 0
				}
			case "swap_8s", "swap_10s", "swap_equal", "swap_interrupted":
				begin, rate := 12, uint64(2<<20)
				if name == "swap_8s" {
					begin = 13
				}
				if name == "swap_equal" {
					rate = 1 << 20
				}
				for i := begin; i < len(values); i++ {
					values[i].SwapOutBytes = values[i-1].SwapOutBytes + rate*2
					if name == "swap_interrupted" && i == 14 {
						values[i].SwapOutBytes = values[i-1].SwapOutBytes
					}
				}
				if name == "swap_10s" {
					want = "swap_out"
				}
			}
			got, err := AssessPhoneMemory(values, now)
			if err != nil || got.StopReason != want || got.AdmissionQuiet != admission && name != "margin" {
				t.Fatalf("assessment: %+v, %v", got, err)
			}
		})
	}
}

func TestPhonePressureRejectsMissingStaleInvalidAndResetSamples(t *testing.T) {
	for _, name := range []string{"missing", "stale", "future", "short", "gap", "counter_reset", "nan", "infinity", "negative_psi", "impossible_psi", "overflow", "duplicate_time"} {
		t.Run(name, func(t *testing.T) {
			now := time.Now()
			values := quietPhoneMemory(now)
			switch name {
			case "missing":
				values = nil
			case "stale":
				now = now.Add(11 * time.Second)
			case "future":
				now = now.Add(-2 * time.Second)
			case "short":
				values = values[3:]
			case "gap":
				values = append(values[:3], values[6:]...)
			case "counter_reset":
				values[16].SwapOutBytes = 0
			case "nan":
				values[16].PSISomeAverage10 = math.NaN()
			case "infinity":
				values[16].PSISomeAverage10 = math.Inf(1)
			case "negative_psi":
				values[16].PSISomeAverage10 = -1
			case "impossible_psi":
				values[16].PSISomeAverage10 = 101
			case "overflow":
				values[16].AvailableBytes = 1 << 53
			case "duplicate_time":
				values[16].ObservedAt = values[15].ObservedAt
			}
			if _, err := AssessPhoneMemory(values, now); err == nil {
				t.Fatal("invalid baseline accepted")
			}
		})
	}
}

type phoneMemoryFixture struct {
	mu          sync.Mutex
	reason      string
	unavailable bool
}

func (m *phoneMemoryFixture) PhoneMemorySamples(ctx context.Context) ([]PhoneMemorySample, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.unavailable {
		return nil, errors.New("phone_baseline_unavailable")
	}
	values := quietPhoneMemory(time.Now())
	if m.reason == "memory_pressure" {
		for i := 11; i < len(values); i++ {
			values[i].PSISomeAverage10 = 5
		}
	}
	if m.reason == "admission_margin" {
		values[16].AvailableBytes = 20 << 30
	}
	return values, nil
}
func (m *phoneMemoryFixture) set(reason string) { m.mu.Lock(); defer m.mu.Unlock(); m.reason = reason }

func protectedPhoneCoordinator(t *testing.T, driver PhoneDriver) (*PhoneCoordinator, *phoneMemoryFixture, string) {
	t.Helper()
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	c, err := NewPhoneCoordinator(dir, PhoneRuntimePolicy{NodeID: nodeID, NodeGeneration: nodeGeneration, PoolID: "phones-luks", ImageDigest: phonePayload().Run.ImageDigest}, driver)
	if err != nil {
		t.Fatal(err)
	}
	m := &phoneMemoryFixture{}
	if err := c.ConfigurePhoneProtection(m); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c, m, dir
}

func TestPhoneCommandRouteCannotEnableRuntimeWithoutPressureProtection(t *testing.T) {
	s, _, _ := serviceFixture(t)
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	c, err := NewPhoneCoordinator(dir, PhoneRuntimePolicy{NodeID: nodeID, NodeGeneration: nodeGeneration,
		PoolID: "phones-luks", ImageDigest: phonePayload().Run.ImageDigest}, &phoneDriverStub{})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := s.ConfigurePhones(c); err == nil {
		t.Fatal("unguarded runtime was enabled")
	}
	if err := c.ConfigurePhoneProtection(&phoneMemoryFixture{}); err != nil {
		t.Fatal(err)
	}
	if err := s.ConfigurePhones(c); err != nil {
		t.Fatal(err)
	}
}

func TestPhoneProtectionStopsNewestRetainsDataAndSurvivesRestart(t *testing.T) {
	d := &phoneDriverStub{}
	c, memory, dir := protectedPhoneCoordinator(t, d)
	a, b := phonePayload(), phonePayload()
	b.PhoneID, b.OwnerID, b.VolumeID = newUUID(), newUUID(), newUUID()
	b.Run = &PhoneRunIdentity{ID: newUUID(), ReservationID: newUUID(), ImageDigest: a.Run.ImageDigest, MemoryBytes: PhoneMemoryBytes, CPUMillis: PhoneCPUMillis}
	for _, p := range []PhoneCommandPayload{a, b} {
		provisionPhone(t, c, p)
		if _, err := executePhone(c, "start", p); err != nil {
			t.Fatal(err)
		}
	}
	// Deterministic ordering independent of sub-millisecond machine speed.
	j, _ := c.read()
	newest := j.Phones[b.PhoneID]
	newest.StartedAtUnixMs = j.Phones[a.PhoneID].StartedAtUnixMs + 1
	j.Phones[b.PhoneID] = newest
	_ = c.write(j)
	memory.set("memory_pressure")
	result, err := c.ProtectPhones(context.Background())
	if err != nil || result.PhoneID != b.PhoneID || result.ProtectionReason != "memory_pressure" || !result.RuntimeStopped || !d.live[a.Run.ID] || d.live[b.Run.ID] {
		t.Fatalf("bad protection %+v %v", result, err)
	}
	for _, call := range d.calls {
		if call == "delete" {
			t.Fatal("protection deleted data")
		}
	}
	_ = c.Close()
	c, err = NewPhoneCoordinator(dir, PhoneRuntimePolicy{NodeID: nodeID, NodeGeneration: nodeGeneration, PoolID: "phones-luks", ImageDigest: a.Run.ImageDigest}, d)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.ConfigurePhoneProtection(memory); err != nil {
		t.Fatal(err)
	}
	status, err := executePhone(c, "inspect", b)
	if err != nil || status.ProtectionReason != "memory_pressure" || !status.RuntimeStopped {
		t.Fatalf("lost stopped reason %+v %v", status, err)
	}
	if _, err := executePhone(c, "start", b); err == nil {
		t.Fatal("replayed protected run")
	}
	memory.set("")
	if _, err := c.ProtectPhones(context.Background()); err != nil || !d.live[a.Run.ID] {
		t.Fatal("stopped healthy old phone")
	}
}

func TestPhoneProtectionUnconfirmedStopRetriesAfterPressureRecovers(t *testing.T) {
	d := &phoneDriverStub{}
	c, memory, _ := protectedPhoneCoordinator(t, d)
	p := phonePayload()
	provisionPhone(t, c, p)
	_, _ = executePhone(c, "start", p)
	memory.set("memory_pressure")
	d.stopFails = true
	if _, err := c.ProtectPhones(context.Background()); err == nil {
		t.Fatal("unconfirmed stop succeeded")
	}
	j, _ := c.read()
	if j.Phones[p.PhoneID].Phase != "stopping" || !d.live[p.Run.ID] {
		t.Fatal("released unconfirmed run")
	}
	memory.set("")
	d.stopFails = false
	result, err := c.ProtectPhones(context.Background())
	if err != nil || !result.RuntimeStopped || result.ProtectionReason != "memory_pressure" {
		t.Fatalf("retry lost: %+v %v", result, err)
	}
}

// Missing telemetry and configured totals do not block starts. Actual
// sustained pressure protection and exact-run fencing remain independent.
func TestPhoneStartDoesNotBookMemoryOrRequireQuietAdmission(t *testing.T) {
	d := &phoneDriverStub{}
	c, memory, _ := protectedPhoneCoordinator(t, d)
	p := phonePayload()
	provisionPhone(t, c, p)
	memory.unavailable = true
	if _, err := executePhone(c, "start", p); err != nil || d.starts != 1 {
		t.Fatal("advance gate blocked start", err)
	}
	if _, err := executePhone(c, "start", p); err != nil || d.starts != 1 {
		t.Fatal("replay launched another runtime", err)
	}
	memory.unavailable = false
	memory.set("memory_pressure")
	if _, err := c.ProtectPhones(context.Background()); err != nil || d.live[p.Run.ID] {
		t.Fatal("real pressure protection failed", err)
	}
	if _, err := executePhone(c, "start", p); err == nil {
		t.Fatal("protected old run revived")
	}
}

type bootingPhoneDriver struct {
	phoneDriverStub
	entered chan struct{}
}

func (d *bootingPhoneDriver) StartPhone(ctx context.Context, p PhoneCommandPayload) (PhoneCommandResult, error) {
	_, _ = d.phoneDriverStub.StartPhone(ctx, p)
	close(d.entered)
	<-ctx.Done()
	return PhoneCommandResult{}, ctx.Err()
}
func TestPhoneProtectionInterruptsBootWithoutWaitingForReadinessDeadline(t *testing.T) {
	d := &bootingPhoneDriver{entered: make(chan struct{})}
	c, memory, _ := protectedPhoneCoordinator(t, d)
	p := phonePayload()
	provisionPhone(t, c, p)
	done := make(chan error, 1)
	go func() { _, err := executePhone(c, "start", p); done <- err }()
	select {
	case <-d.entered:
	case <-time.After(time.Second):
		t.Fatal("boot not entered")
	}
	memory.set("memory_pressure")
	_, _ = c.ProtectPhones(context.Background())
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("boot not interrupted")
		}
	case <-time.After(time.Second):
		t.Fatal("protection blocked behind boot")
	}
	_, err := c.ProtectPhones(context.Background())
	if err != nil || d.live[p.Run.ID] {
		t.Fatal("cancelled boot not confirmed stopped")
	}
}
