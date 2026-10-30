package main

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

type cameraDelegateFixture struct {
	commandServiceFixture
	calls    int
	envelope agent.CommandEnvelope
	proof    agent.AuthProof
	input    string
	err      error
}

func (f *cameraDelegateFixture) ExecutePhoneCamera(_ context.Context, e agent.CommandEnvelope, p agent.AuthProof, input io.Reader) (agent.PhoneCameraResult, error) {
	f.calls++
	f.envelope, f.proof = e, p
	b, _ := io.ReadAll(input)
	f.input = string(b)
	return agent.PhoneCameraResult{State: "waiting", ResourceScope: "phone-run"}, f.err
}

func TestProductionRestrictedServiceCameraDelegation(t *testing.T) {
	for _, scenario := range []string{"allowed", "denied", "wrong-command", "delegate-error"} {
		t.Run(scenario, func(t *testing.T) {
			f := &cameraDelegateFixture{}
			raw := "android-phone.camera.input"
			if scenario == "denied" {
				raw = "android-phone.file.transfer"
			}
			s, err := restrictedCommandService(f, raw)
			if err != nil {
				t.Fatal(err)
			}
			bridge, ok := s.(phoneCameraDelegate)
			if !ok {
				t.Fatal("production wrapper lost camera interface")
			}
			e := agent.CommandEnvelope{Type: "android-phone.camera.input", CommandID: "fixture", NodeGeneration: 8}
			if scenario == "wrong-command" {
				e.Type = "android-phone.file.transfer"
			}
			p := agent.AuthProof{KeyID: "fixture", Nonce: "nonce", Signature: "signature", SignedBody: []byte("signed-envelope")}
			if scenario == "delegate-error" {
				f.err = errors.New("signed-command-rejected")
			}
			result, err := bridge.ExecutePhoneCamera(context.Background(), e, p, strings.NewReader("synthetic-image"))
			allowed := scenario == "allowed" || scenario == "delegate-error"
			if !allowed && (err == nil || f.calls != 0) {
				t.Fatal("forbidden delegation")
			}
			if allowed && (f.calls != 1 || !reflect.DeepEqual(f.envelope, e) || !reflect.DeepEqual(f.proof, p) || f.input != "synthetic-image" || !errors.Is(err, f.err) || result.State != "waiting") {
				t.Fatal("envelope, stream, result or error lost")
			}
		})
	}
	s, _ := restrictedCommandService(commandServiceFixture{}, "android-phone.camera.input")
	if _, err := s.(phoneCameraDelegate).ExecutePhoneCamera(context.Background(), agent.CommandEnvelope{Type: "android-phone.camera.input"}, agent.AuthProof{}, strings.NewReader("x")); err == nil {
		t.Fatal("missing delegate accepted")
	}
}
