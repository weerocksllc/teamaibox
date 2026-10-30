package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type cameraFixture struct {
	phoneDriverStub
	calls atomic.Int64
	bad   bool
}

func (f *cameraFixture) ExecutePhone(context.Context, string, PhoneCommandPayload, Ownership) (PhoneCommandResult, error) {
	return PhoneCommandResult{}, nil
}
func (f *cameraFixture) ExecutePhoneCamera(ctx context.Context, p PhoneCameraPayload, input io.Reader) (PhoneCameraResult, error) {
	f.calls.Add(1)
	r := PhoneCameraResult{PhoneCameraGrant: p.Grant(), State: "waiting", ResourceScope: "phone-run"}
	switch p.Action {
	case "open", "renew":
		r.LeaseExpiresAt = p.LeaseExpiresAt
	case "image":
		_, _ = io.Copy(io.Discard, input)
		r.State = "receiving"
	case "close":
		z := int64(0)
		r.State = "stopped"
		r.RetainedFrameBytes = &z
	}
	if f.bad {
		r.OwnerID = newUUID()
	}
	return r, nil
}
func cameraPayload() PhoneCameraPayload {
	p := phoneMediaPayload()
	return PhoneCameraPayload{PhoneCommandPayload: p.PhoneCommandPayload, Action: "open", GrantID: p.GrantID,
		SourceID: newUUID(), SessionID: p.SessionID, SourceKind: "image", Deadline: time.Now().Add(4 * time.Second).UnixMilli(), LeaseExpiresAt: p.LeaseExpiresAt}
}
func TestCameraClosedContractAndResourceEnvelope(t *testing.T) {
	p := cameraPayload()
	if !validPhoneCamera(p, time.Now()) {
		t.Fatal("valid camera rejected")
	}
	for _, change := range []func(*PhoneCameraPayload){func(p *PhoneCameraPayload) { p.OwnerID = "fake" }, func(p *PhoneCameraPayload) { p.SourceKind = "unknown" }, func(p *PhoneCameraPayload) { p.Action = "exec" },
		func(p *PhoneCameraPayload) { p.LeaseExpiresAt = time.Now().Add(6 * time.Second).UnixMilli() }, func(p *PhoneCameraPayload) { p.SizeBytes = 1 }, func(p *PhoneCameraPayload) { p.OperationID = newUUID() },
		func(p *PhoneCameraPayload) { copy := *p.Run; p.Run = &copy; p.Run.MemoryBytes++ }} {
		q := p
		change(&q)
		if validPhoneCamera(q, time.Now()) {
			t.Fatal("invalid camera accepted")
		}
	}
	p.Action = "image"
	p.LeaseExpiresAt = 0
	p.Deadline = time.Now().Add(14 * time.Second).UnixMilli()
	p.SizeBytes = 16 << 20
	p.SHA256 = strings.Repeat("a", 64)
	if !validPhoneCamera(p, time.Now()) {
		t.Fatal("bounded image rejected")
	}
	p.SizeBytes = PhoneCameraMaximum + 1
	if validPhoneCamera(p, time.Now()) {
		t.Fatal("oversize accepted")
	}
}
func TestNetworkCameraPolicyAndWaiting(t *testing.T) {
	p := cameraPayload()
	p.Action = "udp"
	p.SourceKind = "udp"
	p.LeaseExpiresAt = 0
	p.UDPPolicy = &PhoneUDPPolicy{ListenAddress: "10.64.0.19", ListenPort: 24100, AllowedSources: []string{"192.168.0.0/16"}}
	if !validPhoneCamera(p, time.Now()) {
		t.Fatal("valid network input rejected")
	}
	for _, state := range []string{"waiting", "receiving"} {
		if !ValidPhoneCameraResult(p, PhoneCameraResult{PhoneCameraGrant: p.Grant(), State: state, ResourceScope: "phone-run"}) {
			t.Fatal("valid state rejected")
		}
	}
	for _, invalid := range []PhoneUDPPolicy{
		{ListenAddress: "0.0.0.0", ListenPort: 24100, AllowedSources: []string{"192.168.0.0/16"}},
		{ListenAddress: "10.64.0.19", ListenPort: 80, AllowedSources: []string{"192.168.0.0/16"}},
		{ListenAddress: "10.64.0.19", ListenPort: 24100, AllowedSources: []string{"0.0.0.0/0"}},
		{ListenAddress: "10.64.0.19", ListenPort: 24100, AllowedSources: []string{"192.168.1.1/24"}},
		{ListenAddress: "10.64.0.19", ListenPort: 24100, AllowedSources: []string{"224.0.0.0/24"}},
	} {
		q := p
		q.UDPPolicy = &invalid
		if validPhoneCamera(q, time.Now()) {
			t.Fatal("invalid network policy accepted")
		}
	}
	p.Action = "status"
	if validPhoneCamera(p, time.Now()) {
		t.Fatal("policy on unrelated action")
	}
}
func TestCameraSignedControlsDoNotRetainHistoryAndDoNotCloseViewer(t *testing.T) {
	key := bytes.Repeat([]byte{3}, 32)
	auth, _ := NewAuthenticator("00000000-0000-4000-8000-000000000101", map[string][]byte{"key": key})
	runtime := &cameraFixture{}
	s := &Service{nodeID: "00000000-0000-4000-8000-000000000101", nodeGeneration: 2, authenticator: auth, phones: runtime, now: time.Now}
	p := cameraPayload()
	call := func(p PhoneCameraPayload, bad bool) error {
		raw, _ := json.Marshal(p)
		e := CommandEnvelope{ProtocolVersion: 1, CommandID: newUUID(), NodeID: "00000000-0000-4000-8000-000000000101", NodeGeneration: 2, Type: "android-phone.camera.input", IssuedAt: time.Now(),
			DeadlineAt: time.UnixMilli(p.Deadline), LeaseID: p.PhoneID, FencingToken: p.Generation + 1, Idempotency: "keyed", Payload: raw}
		sig, _ := SignCommand(e, "key", e.CommandID, key)
		if bad {
			sig = "invalid"
		}
		_, err := s.ExecutePhoneCamera(context.Background(), e, AuthProof{KeyID: "key", Nonce: e.CommandID, Signature: sig}, strings.NewReader(""))
		return err
	}
	if call(p, true) == nil || runtime.calls.Load() != 0 {
		t.Fatal("bad signature reached runtime")
	}
	for i := 0; i < 30; i++ {
		p.Action = "renew"
		if err := call(p, false); err != nil {
			t.Fatal(err)
		}
	}
	// Exercise the signed JSON boundary, not just the decoded struct validator.
	udp := p
	udp.Action, udp.SourceKind, udp.LeaseExpiresAt = "udp", "udp", 0
	udp.Deadline = time.Now().Add(14 * time.Second).UnixMilli()
	udp.UDPPolicy = &PhoneUDPPolicy{ListenAddress: "10.64.0.19", ListenPort: 24100, AllowedSources: []string{"10.64.0.26/32"}}
	if err := call(udp, false); err != nil {
		t.Fatal("signed UDP policy rejected:", err)
	}
	// The completed source command is bounded ephemeral history, unlike renew.
	s.phoneCameraImages = nil
	if len(s.commands) != 0 || len(s.phoneSignals) != 0 || len(s.phoneCameraImages) != 0 {
		t.Fatal("camera created durable history or display access")
	}
	s.maintenanceGate.Lock()
	p.Action = "open"
	if call(p, false) == nil {
		t.Fatal("opened during maintenance")
	}
	p.Action = "close"
	p.LeaseExpiresAt = 0
	if err := call(p, false); err != nil {
		t.Fatal(err)
	}
	s.maintenanceGate.Unlock()
	runtime.bad = true
	if call(p, false) == nil {
		t.Fatal("incorrect owner reply accepted")
	}
}

func TestVideoCameraBoundedContract(t *testing.T) {
	p := cameraPayload()
	loop := false
	p.Action, p.SourceKind, p.LeaseExpiresAt = "video", "video", 0
	p.SizeBytes, p.SHA256, p.Loop = PhoneCameraVideoMaximum, strings.Repeat("a", 64), &loop
	p.Deadline = time.Now().Add(14 * time.Second).UnixMilli()
	if !validPhoneCamera(p, time.Now()) {
		t.Fatal("bounded video rejected")
	}
	r := PhoneCameraResult{PhoneCameraGrant: p.Grant(), State: "receiving", ResourceScope: "phone-run"}
	if !ValidPhoneCameraResult(p, r) {
		t.Fatal("video reply rejected")
	}
	r.State = "waiting"
	if ValidPhoneCameraResult(p, r) {
		t.Fatal("video without first frame accepted")
	}
	for _, change := range []func(*PhoneCameraPayload){
		func(q *PhoneCameraPayload) { q.SizeBytes++ }, func(q *PhoneCameraPayload) { q.Loop = nil },
		func(q *PhoneCameraPayload) { q.SourceKind = "image" }, func(q *PhoneCameraPayload) { q.PeerAddress = "10.64.0.19" },
		func(q *PhoneCameraPayload) { q.LeaseExpiresAt = time.Now().Add(time.Second).UnixMilli() },
	} {
		q := p
		change(&q)
		if validPhoneCamera(q, time.Now()) {
			t.Fatal("invalid video accepted")
		}
	}
	q := cameraPayload()
	q.Loop = &loop
	if validPhoneCamera(q, time.Now()) {
		t.Fatal("loop on control accepted")
	}
}
func TestCameraCoordinatorRejectsOtherPhoneAndStaleRun(t *testing.T) {
	p := cameraPayload()
	c := mediaCoordinator(t, &phoneMediaDriverStub{}, PhoneMediaPayload{PhoneCommandPayload: p.PhoneCommandPayload})
	f := &cameraFixture{}
	c.driver = f
	for _, change := range []func(*PhoneCameraPayload){func(p *PhoneCameraPayload) { p.OwnerID = newUUID() }, func(p *PhoneCameraPayload) { p.PhoneID = newUUID() }, func(p *PhoneCameraPayload) { p.Generation++ },
		func(p *PhoneCameraPayload) { copy := *p.Run; p.Run = &copy; p.Run.ID = newUUID() }} {
		q := p
		change(&q)
		if _, err := c.ExecutePhoneCamera(context.Background(), q, strings.NewReader("")); err == nil {
			t.Fatal("foreign run accepted")
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock() // Another phone boot must not starve short renewals.
	if _, err := c.ExecutePhoneCamera(context.Background(), p, strings.NewReader("")); err != nil {
		t.Fatal(err)
	}
	if f.calls.Load() != 1 {
		t.Fatal("wrong driver calls")
	}
}

func TestBrowserCameraCommandAndResultUseOnlyExactPrivatePhoneRange(t *testing.T) {
	p := cameraPayload()
	p.Action, p.SourceKind, p.LeaseExpiresAt = "browser-offer", "browser", 0
	p.SizeBytes, p.SHA256, p.PeerAddress = 1024, strings.Repeat("a", 64), "10.64.0.8"
	p.Deadline = time.Now().Add(14 * time.Second).UnixMilli()
	if !validPhoneCamera(p, time.Now()) {
		t.Fatal("valid browser input rejected")
	}
	for _, change := range []func(*PhoneCameraPayload){
		func(q *PhoneCameraPayload) { q.SourceKind = "image" }, func(q *PhoneCameraPayload) { q.SizeBytes = 65537 },
		func(q *PhoneCameraPayload) { q.PeerAddress = "169.254.169.254" }, func(q *PhoneCameraPayload) { q.PeerAddress = "127.0.0.1" },
		func(q *PhoneCameraPayload) { q.PeerAddress = "camera.local" }, func(q *PhoneCameraPayload) { q.PeerAddress = "8.8.8.8" },
		func(q *PhoneCameraPayload) { q.PeerAddress = "::ffff:10.64.0.8" }, func(q *PhoneCameraPayload) { q.LeaseExpiresAt = time.Now().UnixMilli() + 4000 },
	} {
		q := p
		change(&q)
		if validPhoneCamera(q, time.Now()) {
			t.Fatal("invalid browser command accepted")
		}
	}
	r := PhoneCameraResult{PhoneCameraGrant: p.Grant(), State: "waiting", ResourceScope: "phone-run", AnswerSDP: "v=0\r\n",
		ContainerAddress: "172.18.0.2", NodeAddress: "10.64.0.19", FirstPort: 20040, LastPort: 20049}
	if !ValidPhoneCameraResult(p, r) {
		t.Fatal("valid browser reply rejected")
	}
	for _, change := range []func(*PhoneCameraResult){func(q *PhoneCameraResult) { q.NodeAddress = "8.8.8.8" }, func(q *PhoneCameraResult) { q.ContainerAddress = q.NodeAddress },
		func(q *PhoneCameraResult) { q.FirstPort = 20000 }, func(q *PhoneCameraResult) { q.LastPort = 20149 }, func(q *PhoneCameraResult) { q.AnswerSDP = strings.Repeat("x", 65537) },
		func(q *PhoneCameraResult) { q.OwnerID = newUUID() }, func(q *PhoneCameraResult) { q.ResourceScope = "host" }} {
		q := r
		change(&q)
		if ValidPhoneCameraResult(p, q) {
			t.Fatal("invalid browser reply accepted")
		}
	}
	p.Action = "status"
	if ValidPhoneCameraResult(p, r) {
		t.Fatal("status disclosed negotiation")
	}
}
