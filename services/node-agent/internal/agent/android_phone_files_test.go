package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

type phoneFilesFixture struct{ calls int }

func (f *phoneFilesFixture) ExecutePhone(context.Context, string, PhoneCommandPayload, Ownership) (PhoneCommandResult, error) {
	return PhoneCommandResult{}, nil
}
func (f *phoneFilesFixture) TransferPhoneFile(_ context.Context, p PhoneFilePayload, r io.Reader, w io.Writer) error {
	f.calls++
	_, err := io.Copy(w, r)
	return err
}

func TestPhoneFileSignedBindingAndOneUse(t *testing.T) {
	now := time.Now().UTC()
	p := PhoneFilePayload{PhoneCommandPayload: phoneMediaPayload().PhoneCommandPayload, Action: "list", Deadline: now.Add(time.Minute).UnixMilli()}
	key := bytes.Repeat([]byte{3}, 32)
	auth, err := NewAuthenticator("00000000-0000-4000-8000-000000000101", map[string][]byte{"key": key})
	if err != nil {
		t.Fatal(err)
	}
	runtime := &phoneFilesFixture{}
	s := &Service{nodeID: "00000000-0000-4000-8000-000000000101", nodeGeneration: 2, authenticator: auth, phones: runtime, now: time.Now}
	// Other phones transferring files must not create a node-wide two-user cap.
	s.phoneFiles = map[string]time.Time{}
	s.phoneFileActive = map[string]bool{"other-phone-a": true, "other-phone-b": true}
	raw, _ := json.Marshal(p)
	e := CommandEnvelope{ProtocolVersion: 1, CommandID: p.OperationID, NodeID: "00000000-0000-4000-8000-000000000101", NodeGeneration: 2, Type: "android-phone.file.transfer", IssuedAt: now, DeadlineAt: time.UnixMilli(p.Deadline), LeaseID: p.PhoneID, FencingToken: p.Generation + 1, Idempotency: "keyed", Payload: raw}
	proof := func(e CommandEnvelope) AuthProof {
		sig, _ := SignCommand(e, "key", e.CommandID, key)
		return AuthProof{KeyID: "key", Nonce: e.CommandID, Signature: sig}
	}
	wrong := e
	wrong.NodeGeneration = 3
	if s.TransferPhoneFile(context.Background(), wrong, proof(wrong), strings.NewReader("secret"), io.Discard) == nil {
		t.Fatal("wrong generation accepted")
	}
	wrong = e
	wrong.FencingToken++
	if s.TransferPhoneFile(context.Background(), wrong, proof(wrong), strings.NewReader("secret"), io.Discard) == nil {
		t.Fatal("wrong run fence accepted")
	}
	if runtime.calls != 0 {
		t.Fatal("untrusted request reached runtime")
	}
	var output bytes.Buffer
	if err = s.TransferPhoneFile(context.Background(), e, proof(e), strings.NewReader("synthetic"), &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "synthetic" || runtime.calls != 1 {
		t.Fatal("wrong transfer")
	}
	if s.TransferPhoneFile(context.Background(), e, proof(e), strings.NewReader("x"), io.Discard) == nil || runtime.calls != 1 {
		t.Fatal("replayed transfer ran again")
	}
}

func TestPhoneFileOnlyFixedActionsAndMetadata(t *testing.T) {
	p := PhoneFilePayload{PhoneCommandPayload: phoneMediaPayload().PhoneCommandPayload, Action: "upload", Deadline: time.Now().Add(time.Minute).UnixMilli(), Name: "会议.txt", SizeBytes: 5, SHA256: strings.Repeat("a", 64)}
	if !validPhoneFile(p, time.Now()) {
		t.Fatal("valid file rejected")
	}
	for _, name := range []string{"../x", "/etc/passwd", "a\\b", "..", "bad\x00", ".transfer-x", " a"} {
		bad := p
		bad.Name = name
		if validPhoneFile(bad, time.Now()) {
			t.Fatal("unsafe name accepted")
		}
	}
	for _, action := range []string{"shell", "exec", "adb", "list", "download"} {
		bad := p
		bad.Action = action
		if validPhoneFile(bad, time.Now()) {
			t.Fatal("unsafe fields/action accepted")
		}
	}
	p.SizeBytes = PhoneFileMaximum + 1
	if validPhoneFile(p, time.Now()) {
		t.Fatal("unbounded upload accepted")
	}
}
