package agent

import (
	"context"
	"encoding/json"
	"testing"
)

type baselineStub struct{ reads int }

func (p *baselineStub) PhoneBaseline(context.Context) (json.RawMessage, error) {
	p.reads++
	return json.RawMessage(`{"kvmApiVersion":12,"samples":[]}`), nil
}

func TestPhoneBaselineCommandIsAuthenticatedReadOnlyAndClosedPayload(t *testing.T) {
	for index, payload := range []any{map[string]any{}, map[string]any{"path": "/etc/shadow"}, map[string]any{"command": "start"}, nil} {
		s, runtime, _ := serviceFixture(t)
		provider := &baselineStub{}
		if err := s.ConfigurePhoneBaseline(provider); err != nil {
			t.Fatal(err)
		}
		command := envelope(t, "00000000-0000-4000-8000-000000000991", "android-phone.baseline", payload, 1)
		if _, err := s.Handle(context.Background(), command, AuthProof{}); err == nil {
			t.Fatal("unauthenticated baseline accepted")
		}
		result, err := s.Handle(context.Background(), command, proof(t, command, "nonce-phone-baseline-1"))
		if err != nil {
			t.Fatal(err)
		}
		if index == 0 {
			if result.Status != "succeeded" || provider.reads != 1 {
				t.Fatalf("baseline failed: %+v", result)
			}
		} else if result.ErrorCode != "phone_baseline_payload_invalid" || provider.reads != 0 {
			t.Fatalf("invalid payload reached provider: %+v", result)
		}
		if runtime.starts != 0 || runtime.stops != 0 {
			t.Fatal("baseline touched a worker")
		}
	}
}
