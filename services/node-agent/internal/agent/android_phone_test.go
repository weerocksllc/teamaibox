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

func phonePayload() PhoneCommandPayload {
	return PhoneCommandPayload{PhoneIdentity: PhoneIdentity{PhoneID: workerID, OwnerID: attemptID, VolumeID: profileID,
		PoolID: "phones-luks", BaseBuildID: PhoneBaseBuild}, OperationID: leaseID, Generation: 1,
		Run: &PhoneRunIdentity{ID: "00000000-0000-4000-8000-000000000701", ReservationID: "00000000-0000-4000-8000-000000000702",
			ImageDigest: "sha256:" + strings.Repeat("a", 64), MemoryBytes: PhoneMemoryBytes, CPUMillis: PhoneCPUMillis}}
}

func phoneResult(p PhoneCommandPayload) PhoneCommandResult {
	r := PhoneCommandResult{PhoneIdentity: p.PhoneIdentity, OperationID: p.OperationID, Generation: p.Generation}
	if p.Run != nil {
		r.RunID = p.Run.ID
	}
	return r
}

type phoneDriverStub struct {
	calls             []string
	live              map[string]bool
	starts            int
	loseStartResponse bool
	stopFails         bool
	badResult         bool
}

func (d *phoneDriverStub) PreparePhoneData(_ context.Context, p PhoneCommandPayload) (PhoneCommandResult, error) {
	d.calls = append(d.calls, "provision")
	r := phoneResult(p)
	r.StorageReady, r.RuntimeStopped = true, true
	return r, nil
}
func (d *phoneDriverStub) StartPhone(_ context.Context, p PhoneCommandPayload) (PhoneCommandResult, error) {
	d.calls = append(d.calls, "start")
	if d.live == nil {
		d.live = map[string]bool{}
	}
	if !d.live[p.Run.ID] {
		d.starts++
		d.live[p.Run.ID] = true
	}
	if d.loseStartResponse {
		d.loseStartResponse = false
		return PhoneCommandResult{}, errors.New("phone_transport_lost")
	}
	r := phoneResult(p)
	r.StorageReady, r.AndroidReady, r.MediaReady, r.ContainerID = true, true, true, strings.Repeat("b", 64)
	if d.badResult {
		r.RunID = newUUID()
	}
	return r, nil
}
func (d *phoneDriverStub) InspectPhone(_ context.Context, p PhoneCommandPayload) (PhoneCommandResult, error) {
	d.calls = append(d.calls, "inspect")
	r := phoneResult(p)
	r.RuntimeStopped = !d.live[p.Run.ID]
	if !r.RuntimeStopped {
		r.ContainerID = strings.Repeat("b", 64)
		r.StorageReady, r.AndroidReady, r.MediaReady = true, true, true
	}
	return r, nil
}
func (d *phoneDriverStub) StopPhone(_ context.Context, p PhoneCommandPayload) (PhoneCommandResult, error) {
	d.calls = append(d.calls, "stop")
	if d.stopFails {
		return PhoneCommandResult{}, errors.New("phone_stop_unconfirmed")
	}
	if d.live != nil {
		d.live[p.Run.ID] = false
	}
	r := phoneResult(p)
	r.RuntimeStopped, r.CleanShutdown = true, true
	return r, nil
}
func (d *phoneDriverStub) DeletePhoneData(_ context.Context, p PhoneCommandPayload) (PhoneCommandResult, error) {
	d.calls = append(d.calls, "delete")
	r := phoneResult(p)
	r.RuntimeStopped, r.DataDeleted = true, true
	return r, nil
}

func newPhoneTestCoordinator(t *testing.T, dir string, d *phoneDriverStub) *PhoneCoordinator {
	t.Helper()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	c, err := NewPhoneCoordinator(dir, PhoneRuntimePolicy{NodeID: nodeID, NodeGeneration: nodeGeneration,
		PoolID: "phones-luks", ImageDigest: phonePayload().Run.ImageDigest}, d)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.ConfigurePhoneProtection(&phoneMemoryFixture{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func executePhone(c *PhoneCoordinator, action string, p PhoneCommandPayload) (PhoneCommandResult, error) {
	return c.ExecutePhone(context.Background(), action, p, Ownership{NodeID: nodeID, NodeGeneration: nodeGeneration,
		LeaseID: p.PhoneID, FencingToken: p.Generation + 1})
}
func provisionPhone(t *testing.T, c *PhoneCoordinator, p PhoneCommandPayload) {
	t.Helper()
	p.Run, p.Generation = nil, 0
	if _, err := executePhone(c, "provision", p); err != nil {
		t.Fatal(err)
	}
}

func TestPhonePayloadRejectsArbitraryRuntimeOptions(t *testing.T) {
	raw, _ := json.Marshal(phonePayload())
	if _, err := decodePhoneCommand(raw, "start"); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"command", "hostPath", "devices", "docker", "privileged", "network", "ownerIdentityId", "url"} {
		t.Run(key, func(t *testing.T) {
			invalid := strings.TrimSuffix(string(raw), "}") + `,"` + key + `":"injected"}`
			if _, err := decodePhoneCommand([]byte(invalid), "start"); err == nil {
				t.Fatal("unknown field accepted")
			}
		})
	}
	for _, invalid := range []string{
		strings.TrimSuffix(string(raw), "}") + `,"generation":1}`,
		strings.Replace(string(raw), `"cpuMillis":2000`, `"cpuMillis":2000,"cpuMillis":2000`, 1),
		strings.Replace(string(raw), `"cpuMillis":2000`, `"cpuMillis":2000,"cmd":"adb"`, 1),
		strings.Replace(string(raw), `"cpuMillis":2000`, `"cpuMillis":2001`, 1),
		strings.Replace(string(raw), `"generation":1`, `"generation":-1`, 1),
		string(raw) + ` {}`, `null`, `[]`,
	} {
		if _, err := decodePhoneCommand([]byte(invalid), "start"); err == nil {
			t.Fatalf("invalid payload accepted: %s", invalid)
		}
	}
}

func TestPhoneCommandRequiresAuthenticationExplicitDriverAndPhoneFence(t *testing.T) {
	for _, scenario := range []string{"configured", "absent", "bad_lease", "bad_fence"} {
		t.Run(scenario, func(t *testing.T) {
			s, ordinary, _ := serviceFixture(t)
			d := &phoneDriverStub{}
			c := newPhoneTestCoordinator(t, t.TempDir(), d)
			p := phonePayload()
			provisionPhone(t, c, p)
			if scenario != "absent" {
				if err := s.ConfigurePhones(c); err != nil {
					t.Fatal(err)
				}
			}
			cmd := envelope(t, newUUID(), "android-phone.start", p, p.Generation+1)
			cmd.LeaseID = p.PhoneID
			if scenario == "bad_lease" {
				cmd.LeaseID = leaseID
			}
			if scenario == "bad_fence" {
				cmd.FencingToken++
			}
			if _, err := s.Handle(context.Background(), cmd, AuthProof{}); err == nil {
				t.Fatal("unsigned command accepted")
			}
			result, err := s.Handle(context.Background(), cmd, proof(t, cmd, "nonce-phone-command-1"))
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "configured" {
				if result.Status != "succeeded" || d.starts != 1 {
					t.Fatalf("not started: %+v", result)
				}
			} else if result.Status != "failed" || d.starts != 0 {
				t.Fatalf("unsafe start: %+v", result)
			}
			if ordinary.starts != 0 || ordinary.stops != 0 {
				t.Fatal("phone reached generic worker interface")
			}
		})
	}
}

func TestPhoneRetryAfterAgentLossUsesSameRunAndRejectsOldStartAfterStop(t *testing.T) {
	d := &phoneDriverStub{loseStartResponse: true}
	dir := t.TempDir()
	c := newPhoneTestCoordinator(t, dir, d)
	p := phonePayload()
	provisionPhone(t, c, p)
	if _, err := executePhone(c, "start", p); err == nil {
		t.Fatal("lost response accepted")
	}
	_ = c.Close()
	c = newPhoneTestCoordinator(t, dir, d)
	if _, err := executePhone(c, "start", p); err != nil {
		t.Fatal(err)
	}
	if d.starts != 1 {
		t.Fatal("retry booted another guest")
	}
	if _, err := executePhone(c, "stop", p); err != nil {
		t.Fatal(err)
	}
	if _, err := executePhone(c, "start", p); err == nil {
		t.Fatal("stopped generation restarted")
	}
	_ = c.Close()
	c = newPhoneTestCoordinator(t, dir, d)
	if _, err := executePhone(c, "start", p); err == nil {
		t.Fatal("restart forgot stopped generation")
	}
	old := p
	p.Generation++
	r := *p.Run
	r.ID, r.ReservationID = newUUID(), newUUID()
	p.Run = &r
	p.OperationID = newUUID()
	if _, err := executePhone(c, "start", p); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"start", "stop", "inspect"} {
		if _, err := executePhone(c, action, old); err == nil {
			t.Fatalf("stale %s accepted", action)
		}
	}
}

func TestPhoneSignedRetryDoesNotReturnCachedSuccessAfterStop(t *testing.T) {
	s, _, _ := serviceFixture(t)
	d := &phoneDriverStub{}
	c := newPhoneTestCoordinator(t, t.TempDir(), d)
	p := phonePayload()
	provisionPhone(t, c, p)
	if err := s.ConfigurePhones(c); err != nil {
		t.Fatal(err)
	}
	start := envelope(t, newUUID(), "android-phone.start", p, 2)
	start.LeaseID = p.PhoneID
	if r, err := s.Handle(context.Background(), start, proof(t, start, "nonce-phone-retry-1")); err != nil || r.Status != "succeeded" {
		t.Fatalf("%+v %v", r, err)
	}
	stop := envelope(t, newUUID(), "android-phone.stop", p, 2)
	stop.LeaseID = p.PhoneID
	if r, err := s.Handle(context.Background(), stop, proof(t, stop, "nonce-phone-retry-2")); err != nil || r.Status != "succeeded" {
		t.Fatalf("%+v %v", r, err)
	}
	if r, err := s.Handle(context.Background(), start, proof(t, start, "nonce-phone-retry-3")); err != nil || r.ErrorCode != "phone_stale_run" {
		t.Fatalf("cached start: %+v %v", r, err)
	}
	if d.starts != 1 {
		t.Fatal("restarted stopped guest")
	}
}

func TestPhoneIdentityVolumeRunAndImageCannotBeRebound(t *testing.T) {
	d := &phoneDriverStub{}
	c := newPhoneTestCoordinator(t, t.TempDir(), d)
	p := phonePayload()
	provisionPhone(t, c, p)
	for _, field := range []string{"owner", "volume", "pool", "image", "generation"} {
		q := p
		run := *q.Run
		q.Run = &run
		switch field {
		case "owner":
			q.OwnerID = newUUID()
		case "volume":
			q.VolumeID = newUUID()
		case "pool":
			q.PoolID = "another-pool"
		case "image":
			q.Run.ImageDigest = "sha256:" + strings.Repeat("c", 64)
		case "generation":
			q.Generation = 0 // A start must be newer than provisioned data.
		}
		if _, err := executePhone(c, "start", q); err == nil {
			t.Fatalf("rebound %s", field)
		}
	}
	if d.starts != 0 {
		t.Fatal("invalid identity reached driver")
	}
	q := p
	q.PhoneID = newUUID()
	q.Generation, q.Run = 0, nil
	if _, err := executePhone(c, "provision", q); err == nil {
		t.Fatal("another phone reused private volume")
	}
	if _, err := executePhone(c, "start", p); err != nil {
		t.Fatal(err)
	}
	q = p
	q.PhoneID, q.VolumeID = newUUID(), newUUID()
	provisionPhone(t, c, q)
	if _, err := executePhone(c, "start", q); err == nil {
		t.Fatal("another phone reused run/reservation")
	}
}

func TestPhoneStopFailurePreventsDeleteOrNextRunAndDoesNotAffectOtherPhone(t *testing.T) {
	d := &phoneDriverStub{}
	c := newPhoneTestCoordinator(t, t.TempDir(), d)
	p := phonePayload()
	provisionPhone(t, c, p)
	if _, err := executePhone(c, "start", p); err != nil {
		t.Fatal(err)
	}
	other := p
	other.PhoneID, other.VolumeID = newUUID(), newUUID()
	otherRun := *p.Run
	otherRun.ID, otherRun.ReservationID = newUUID(), newUUID()
	other.Run = &otherRun
	provisionPhone(t, c, other)
	if _, err := executePhone(c, "start", other); err != nil {
		t.Fatal(err)
	}
	d.stopFails = true
	if _, err := executePhone(c, "stop", p); err == nil {
		t.Fatal("false stop")
	}
	deletion := p
	deletion.Run = nil
	if _, err := executePhone(c, "delete", deletion); err == nil {
		t.Fatal("deleted unconfirmed running data")
	}
	if !d.live[other.Run.ID] {
		t.Fatal("stopped another phone")
	}
	d.stopFails = false
	if _, err := executePhone(c, "stop", p); err != nil {
		t.Fatal(err)
	}
	if _, err := executePhone(c, "delete", deletion); err != nil {
		t.Fatal(err)
	}
	if _, err := executePhone(c, "delete", deletion); err != nil {
		t.Fatal("exact deletion retry failed", err)
	}
	if _, err := executePhone(c, "start", p); err == nil {
		t.Fatal("deleted phone revived")
	}
	if !d.live[other.Run.ID] {
		t.Fatal("deletion affected another phone")
	}
}

func TestPhoneBadReadinessReplyRetainsPendingRun(t *testing.T) {
	d := &phoneDriverStub{badResult: true}
	c := newPhoneTestCoordinator(t, t.TempDir(), d)
	p := phonePayload()
	provisionPhone(t, c, p)
	if _, err := executePhone(c, "start", p); err == nil {
		t.Fatal("accepted another run readiness")
	}
	j, err := c.read()
	if err != nil {
		t.Fatal(err)
	}
	if j.Phones[p.PhoneID].Phase != "starting" {
		t.Fatal("failed reply released or completed run")
	}
}

func TestPhoneJournalRejectsSecondProcessCorruptionAndSymlink(t *testing.T) {
	d := &phoneDriverStub{}
	dir := t.TempDir()
	c := newPhoneTestCoordinator(t, dir, d)
	if other, err := NewPhoneCoordinator(dir, c.policy, d); err == nil {
		other.Close()
		t.Fatal("two coordinators own same journal")
	}
	provisionPhone(t, c, phonePayload())
	_ = c.Close()
	if err := os.WriteFile(filepath.Join(dir, "phones.json"), []byte("{bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	if other, err := NewPhoneCoordinator(dir, c.policy, d); err == nil {
		other.Close()
		t.Fatal("corrupt journal became empty")
	}
	if err := os.Remove(filepath.Join(dir, "phones.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(t.TempDir(), "outside"), filepath.Join(dir, "phones.json")); err != nil {
		t.Fatal(err)
	}
	if other, err := NewPhoneCoordinator(dir, c.policy, d); err == nil {
		other.Close()
		t.Fatal("symlink journal accepted")
	}
}
