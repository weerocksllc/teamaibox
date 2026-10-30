package agent

import (
	"context"
	"encoding/json"
	"testing"
)

type storageStub struct{ reads int }

func (p *storageStub) PhoneStorage(context.Context) (json.RawMessage, error) {
	p.reads++
	return json.RawMessage(`{"poolId":"phone.pool"}`), nil
}

func TestPhoneStorageCommandUsesSignedIdentityAndRejectsCallerSelectedTargets(t *testing.T) {
	for i, payload := range []any{map[string]any{}, map[string]any{"poolId": "another.pool"}, map[string]any{"path": "/etc/shadow"}, nil} {
		s, runtime, _ := serviceFixture(t)
		provider := &storageStub{}
		if err := s.ConfigurePhoneStorage(provider); err != nil {
			t.Fatal(err)
		}
		command := envelope(t, "00000000-0000-4000-8000-000000000992", "android-phone.storage", payload, 1)
		if _, err := s.Handle(context.Background(), command, AuthProof{}); err == nil {
			t.Fatal("unsigned storage request accepted")
		}
		result, err := s.Handle(context.Background(), command, proof(t, command, "nonce-phone-storage-1"))
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			if result.Status != "succeeded" || provider.reads != 1 {
				t.Fatalf("read failed: %+v", result)
			}
		} else if result.ErrorCode != "phone_storage_payload_invalid" || provider.reads != 0 {
			t.Fatalf("invalid target reached helper: %+v", result)
		}
		if runtime.starts != 0 || runtime.stops != 0 {
			t.Fatal("observation changed workers")
		}
		if err := s.ConfigurePhoneStorage(provider); err == nil {
			t.Fatal("provider changed after requests")
		}
	}
}
