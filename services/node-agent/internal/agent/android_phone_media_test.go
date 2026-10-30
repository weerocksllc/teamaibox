package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

type phoneMediaDriverStub struct {
	phoneDriverStub
	mediaCalls int
	bad        bool
	beforeCall func(string, PhoneMediaPayload)
}

func (d *phoneMediaDriverStub) ControlPhoneMedia(_ context.Context, action string, p PhoneMediaPayload) (PhoneMediaResult, error) {
	d.mediaCalls++
	if d.beforeCall != nil {
		d.beforeCall(action, p)
	}
	r := PhoneMediaResult{PhoneMediaGrant: p.Grant()}
	if action == "close" {
		r.PeerClosed = true
	} else {
		r.PeerOpen = true
		r.LeaseExpiresAt = p.LeaseExpiresAt
	}
	if d.bad {
		r.RunID = newUUID()
	}
	return r, nil
}
func phoneMediaPayload() PhoneMediaPayload {
	p := phonePayload()
	p.OperationID = newUUID()
	return PhoneMediaPayload{PhoneCommandPayload: p, GrantID: p.OperationID, SessionID: newUUID(), Kind: "control", LeaseExpiresAt: time.Now().Add(4 * time.Second).UnixMilli()}
}
func mediaCoordinator(t *testing.T, d *phoneMediaDriverStub, p PhoneMediaPayload) *PhoneCoordinator {
	t.Helper()
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	c, err := NewPhoneCoordinator(directory, PhoneRuntimePolicy{NodeID: nodeID, NodeGeneration: nodeGeneration, PoolID: p.PoolID, ImageDigest: p.Run.ImageDigest}, d)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.ConfigurePhoneProtection(&phoneMemoryFixture{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	provisionPhone(t, c, p.PhoneCommandPayload)
	if _, err := executePhone(c, "start", p.PhoneCommandPayload); err != nil {
		t.Fatal(err)
	}
	return c
}
func TestPhoneMediaUsesCurrentJournalWithoutWaitingForOtherPhoneBoot(t *testing.T) {
	d := &phoneMediaDriverStub{}
	p := phoneMediaPayload()
	c := mediaCoordinator(t, d, p)
	c.mu.Lock() // A different phone's lifecycle holds this lock during boot.
	defer c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := c.ExecutePhoneMedia(ctx, "open", p, Ownership{NodeID: nodeID, NodeGeneration: nodeGeneration, LeaseID: p.PhoneID, FencingToken: p.Generation + 1})
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("media lease was blocked behind lifecycle")
	}
	if d.mediaCalls != 1 {
		t.Fatal("driver not reached")
	}
}
func TestPhoneMediaRejectsStaleIdentityAndStoppedRuns(t *testing.T) {
	d := &phoneMediaDriverStub{}
	p := phoneMediaPayload()
	c := mediaCoordinator(t, d, p)
	owner := Ownership{NodeID: nodeID, NodeGeneration: nodeGeneration, LeaseID: p.PhoneID, FencingToken: p.Generation + 1}
	for _, change := range []func(*PhoneMediaPayload){func(q *PhoneMediaPayload) { q.OwnerID = newUUID() }, func(q *PhoneMediaPayload) { q.VolumeID = newUUID() }, func(q *PhoneMediaPayload) { q.Generation++ }, func(q *PhoneMediaPayload) { q.Kind = "shell" }} {
		q := p
		change(&q)
		if _, err := c.ExecutePhoneMedia(context.Background(), "open", q, owner); err == nil {
			t.Fatal("inexact media binding accepted")
		}
	}
	if _, err := executePhone(c, "stop", p.PhoneCommandPayload); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ExecutePhoneMedia(context.Background(), "renew", p, owner); err == nil {
		t.Fatal("stopped phone renewed")
	}
	if d.mediaCalls != 0 {
		t.Fatal("invalid request reached media")
	}
}
func TestPhoneMediaSignedCommandsHaveNoPerRenewalHistoryAndValidateReplies(t *testing.T) {
	s, ordinary, _ := serviceFixture(t)
	s.SetClock(time.Now)
	d := &phoneMediaDriverStub{}
	p := phoneMediaPayload()
	c := mediaCoordinator(t, d, p)
	if err := s.ConfigurePhones(c); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 32; i++ {
		p.LeaseExpiresAt = time.Now().Add(4 * time.Second).UnixMilli()
		cmd := envelope(t, newUUID(), "android-phone.media.renew", p, p.Generation+1)
		cmd.LeaseID = p.PhoneID
		cmd.IssuedAt = time.Now()
		cmd.DeadlineAt = cmd.IssuedAt.Add(5 * time.Second)
		if _, err := s.Handle(context.Background(), cmd, AuthProof{}); !errors.Is(err, ErrAuthentication) {
			t.Fatal("unsigned request accepted")
		}
		if i == 31 {
			d.bad = true
		}
		result, err := s.Handle(context.Background(), cmd, proof(t, cmd, newUUID()))
		if err != nil {
			t.Fatal(err)
		}
		if i < 31 && result.Status != "succeeded" || i == 31 && result.ErrorCode != "phone_media_result_invalid" {
			t.Fatalf("unexpected media result %+v", result)
		}
	}
	if len(s.commands) != 0 || len(s.fences) != 0 || s.sequence != 0 || ordinary.starts != 0 || ordinary.stops != 0 {
		t.Fatal("renewal polluted command/event history or ordinary workers")
	}
}
func TestPhoneMediaRejectsUnknownPayloadAndLongLeaseBeforeDriver(t *testing.T) {
	for _, change := range []func(*PhoneMediaPayload){func(p *PhoneMediaPayload) { p.LeaseExpiresAt = time.Now().Add(6 * time.Second).UnixMilli() }, func(p *PhoneMediaPayload) { p.OperationID = newUUID() }, func(p *PhoneMediaPayload) { p.Kind = "shell" }} {
		s, _, _ := serviceFixture(t)
		s.SetClock(time.Now)
		p := phoneMediaPayload()
		d := &phoneMediaDriverStub{}
		c := mediaCoordinator(t, d, p)
		s.ConfigurePhones(c)
		change(&p)
		cmd := envelope(t, newUUID(), "android-phone.media.open", p, p.Generation+1)
		cmd.LeaseID = p.PhoneID
		cmd.IssuedAt = time.Now()
		cmd.DeadlineAt = cmd.IssuedAt.Add(5 * time.Second)
		r, err := s.Handle(context.Background(), cmd, proof(t, cmd, newUUID()))
		if err != nil || r.ErrorCode != "phone_media_payload_invalid" || d.mediaCalls != 0 {
			t.Fatal("bad media payload reached driver")
		}
	}
	p := phoneMediaPayload()
	raw, _ := json.Marshal(p)
	for _, bad := range []string{strings.TrimSuffix(string(raw), "}") + `,"grantId":"` + p.GrantID + `"}`, strings.Replace(string(raw), `"run":{`, `"run":{"cmd":"exec",`, 1)} {
		s, _, _ := serviceFixture(t)
		s.SetClock(time.Now)
		cmd := envelope(t, newUUID(), "android-phone.media.open", p, p.Generation+1)
		cmd.LeaseID = p.PhoneID
		cmd.IssuedAt = time.Now()
		cmd.DeadlineAt = cmd.IssuedAt.Add(5 * time.Second)
		cmd.Payload = json.RawMessage(bad)
		r, err := s.Handle(context.Background(), cmd, proof(t, cmd, newUUID()))
		if err != nil || r.ErrorCode != "phone_media_payload_invalid" {
			t.Fatal("ambiguous media payload accepted")
		}
	}
}

func TestPhoneDebugAndViewingLeasesDoNotReplaceEachOther(t *testing.T) {
	s, _, _ := serviceFixture(t)
	s.SetClock(time.Now)
	view := phoneMediaPayload()
	debug := view
	debug.Kind = "adb"
	debug.GrantID = newUUID()
	debug.OperationID = debug.GrantID
	s.recordPhoneSignal("open", view)
	s.recordPhoneSignal("open", debug)
	if !s.PhoneSignalLive(view) || !s.PhoneSignalLive(debug) {
		t.Fatal("view and debug must have independent leases")
	}
	if _, err := s.PhoneSignalEndpoint(context.Background(), debug); err == nil {
		t.Fatal("debug grant accepted as viewing grant")
	}
	if _, err := s.OpenPhoneADB(context.Background(), view); err == nil {
		t.Fatal("view grant accepted as debugging grant")
	}
	s.recordPhoneSignal("close", debug)
	if !s.PhoneSignalLive(view) || s.PhoneSignalLive(debug) {
		t.Fatal("debug revocation affected viewing")
	}
}

func TestPhoneCloseFencesProxyBeforeRuntimeConfirmationEvenOnFailure(t *testing.T) {
	s, _, _ := serviceFixture(t)
	s.SetClock(time.Now)
	p := phoneMediaPayload()
	d := &phoneMediaDriverStub{bad: true}
	c := mediaCoordinator(t, d, p)
	s.ConfigurePhones(c)
	s.recordPhoneSignal("open", p)
	debug := p
	debug.Kind = "adb"
	s.recordPhoneSignal("open", debug)
	d.beforeCall = func(action string, _ PhoneMediaPayload) {
		if action != "close" || s.PhoneSignalLive(p) || !s.PhoneSignalLive(debug) {
			t.Fatal("runtime confirmation must follow exact viewing proxy fencing")
		}
	}
	p.LeaseExpiresAt = 0
	cmd := envelope(t, newUUID(), "android-phone.media.close", p, p.Generation+1)
	cmd.LeaseID = p.PhoneID
	cmd.IssuedAt = time.Now()
	cmd.DeadlineAt = cmd.IssuedAt.Add(5 * time.Second)
	r, err := s.Handle(context.Background(), cmd, proof(t, cmd, newUUID()))
	if err != nil || r.ErrorCode != "phone_media_result_invalid" || s.PhoneSignalLive(p) || !s.PhoneSignalLive(debug) {
		t.Fatal("failed confirmation restored a closed proxy or revoked debug")
	}
}
