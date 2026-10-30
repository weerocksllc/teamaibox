package agent

import (
	"encoding/json"
	"testing"
	"time"
)

func TestAuthenticatorVerifiesTheExactTransportBody(t *testing.T) {
	now := time.Date(2026, 8, 11, 1, 2, 3, 0, time.UTC)
	envelope := CommandEnvelope{
		ProtocolVersion: 1,
		CommandID:       "00000000-0000-4000-8000-000000000601",
		NodeID:          "00000000-0000-4000-8000-000000000101",
		NodeGeneration:  7,
		Type:            "worker.health",
		IssuedAt:        now.Add(-time.Second),
		DeadlineAt:      now.Add(time.Minute),
		LeaseID:         "00000000-0000-4000-8000-000000000501",
		FencingToken:    1,
		Idempotency:     "replay_same_result",
		Payload:         json.RawMessage(`{"workerId":"00000000-0000-4000-8000-000000000201"}`),
	}
	canonical, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	transportBody := append([]byte(" \n"), canonical...)
	transportBody = append(transportBody, '\n')
	nonce := "transport-body-a"
	proof := AuthProof{
		KeyID: "scheduler-a", Nonce: nonce, SignedBody: transportBody,
		Signature: SignCommandBody(transportBody, "scheduler-a", nonce, testKey),
	}
	authenticator, err := NewAuthenticator(envelope.NodeID, map[string][]byte{"scheduler-a": testKey})
	if err != nil {
		t.Fatal(err)
	}
	if err := authenticator.Verify(envelope, proof, now); err != nil {
		t.Fatalf("exact transport-body signature failed: %v", err)
	}
	proof.SignedBody = canonical
	if err := authenticator.Verify(envelope, proof, now); err == nil {
		t.Fatal("a signature was accepted for different transport bytes")
	}
}
