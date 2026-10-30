package agent

import (
	"context"
	"encoding/json"
	"testing"
)

type computerBaselineStub struct {
	computerRuntimeStub
	reads int
}

func (s *computerBaselineStub) ComputerBaseline(context.Context) (json.RawMessage, error) {
	s.reads++
	return json.RawMessage(`{"poolId":"windows-pool","encryption":"luks2"}`), nil
}
func TestComputerBaselineIsAuthenticatedReadOnly(t *testing.T) {
	for index, payload := range []any{map[string]any{}, map[string]any{"path": "/secret"}, nil} {
		s, engine, _ := serviceFixture(t)
		provider := &computerBaselineStub{computerRuntimeStub: computerRuntimeStub{protected: true}}
		if e := s.ConfigureComputers(provider); e != nil {
			t.Fatal(e)
		}
		command := envelope(t, newUUID(), "virtual-computer.baseline", payload, 1)
		if _, e := s.Handle(context.Background(), command, AuthProof{}); e == nil {
			t.Fatal("unsigned baseline accepted")
		}
		result, e := s.Handle(context.Background(), command, proof(t, command, "computer-baseline"))
		if e != nil {
			t.Fatal(e)
		}
		if index == 0 {
			if result.Status != "succeeded" || provider.reads != 1 {
				t.Fatalf("%+v", result)
			}
		} else if result.ErrorCode != "computer_baseline_payload_invalid" || provider.reads != 0 {
			t.Fatalf("%+v", result)
		}
		if engine.starts != 0 || engine.stops != 0 {
			t.Fatal("baseline changed workers")
		}
	}
}
