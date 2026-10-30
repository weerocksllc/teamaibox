package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

func recoveryFixture(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("../../internal/agent/testdata/synthetic_completed_maintenance.json")
	if err != nil {
		t.Fatal(err)
	}
	var journal map[string]any
	if err := json.Unmarshal(raw, &journal); err != nil {
		t.Fatal(err)
	}
	old := journal["payload"].(map[string]any)["targets"].([]any)
	targets := []any{}
	for _, target := range old {
		encoded, _ := json.Marshal(target)
		var prior, desired map[string]any
		json.Unmarshal(encoded, &prior)
		json.Unmarshal(encoded, &desired)
		prior["requiredLabels"].(map[string]any)["com.teamaibox.node-generation"] = "1"
		desired["requiredLabels"].(map[string]any)["com.teamaibox.node-generation"] = "2"
		targets = append(targets, map[string]any{"previousTarget": prior, "desiredTarget": desired})
	}
	return map[string]any{"protocolVersion": 1, "nodeId": journal["nodeId"], "nodeGeneration": 2,
		"type": "protected-set.transaction.execute", "payload": map[string]any{"setId": "office.baseline", "targets": targets}}
}

func recoveryBytes(t *testing.T, body map[string]any) ([]byte, string) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"body": body, "keyId": "test", "nonce": "test", "signature": "test"})
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(raw)
	return raw, "sha256:" + hex.EncodeToString(h[:])
}

func TestProtectedRecoveryScope(t *testing.T) {
	body := recoveryFixture(t)
	raw, digest := recoveryBytes(t, body)
	if _, _, err := decodeProtectedRecovery(raw, digest, body["nodeId"].(string), 2); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{"digest", "generation", "type", "image", "profile", "label", "dependency", "duplicate", "incomplete", "unknown"} {
		t.Run(mutation, func(t *testing.T) {
			b := recoveryFixture(t)
			p := b["payload"].(map[string]any)
			first := p["targets"].([]any)[0].(map[string]any)
			switch mutation {
			case "generation":
				b["nodeGeneration"] = 1
			case "type":
				b["type"] = "worker.start"
			case "image":
				first["desiredTarget"].(map[string]any)["requiredImageId"] = "sha256:changed"
			case "profile":
				first["desiredTarget"].(map[string]any)["modelProfileId"] = "018f6f18-24d7-7c21-9b62-8c0174199502"
			case "label":
				first["desiredTarget"].(map[string]any)["requiredLabels"].(map[string]any)["unexpected"] = "true"
			case "dependency":
				first["desiredTarget"].(map[string]any)["dependsOnWorkerIds"] = []string{"018f6f18-24d7-7c21-9b62-8c0174199502"}
			case "duplicate":
				p["targets"].([]any)[1] = first
			case "incomplete":
				p["targets"] = p["targets"].([]any)[:5]
			case "unknown":
				b["unexpected"] = true
			}
			raw, digest := recoveryBytes(t, b)
			if mutation == "digest" {
				digest = "sha256:wrong"
			}
			if _, _, err := decodeProtectedRecovery(raw, digest, b["nodeId"].(string), 2); err == nil {
				t.Fatal("unsafe recovery accepted")
			}
		})
	}
}

func TestProtectedRecoveryPreservesExplicitEmptyOptionalDependencies(t *testing.T) {
	body := recoveryFixture(t)
	for _, value := range body["payload"].(map[string]any)["targets"].([]any) {
		change := value.(map[string]any)
		for _, key := range []string{"previousTarget", "desiredTarget"} {
			change[key].(map[string]any)["dependentContainers"] = []any{}
		}
	}
	raw, digest := recoveryBytes(t, body)
	if _, _, err := decodeProtectedRecovery(raw, digest, body["nodeId"].(string), 2); err != nil {
		t.Fatal(err)
	}
	if _, _, err := decodeProtectedAuthorityReconciliation(raw, digest, body["nodeId"].(string), 2); err != nil {
		t.Fatal(err)
	}
}

func TestProtectedRecoveryAuthenticatesExactInput(t *testing.T) {
	body := recoveryFixture(t)
	now := time.Now().UTC()
	body["commandId"] = "018f6f18-24d7-7c21-9b62-8c0174199502"
	body["issuedAt"] = now.Format(time.RFC3339Nano)
	body["deadlineAt"] = now.Add(time.Minute).Format(time.RFC3339Nano)
	encoded, _ := json.Marshal(body)
	key := []byte("synthetic-recovery-test-key-32-bytes-only")
	signature := agent.SignCommandBody(encoded, "test", "test-nonce", key)
	raw, _ := json.Marshal(protectedRecoveryInput{Body: encoded, KeyID: "test", Nonce: "test-nonce", Signature: signature})
	digest := sha256.Sum256(raw)
	envelope, proof, err := decodeProtectedRecovery(raw, "sha256:"+hex.EncodeToString(digest[:]), body["nodeId"].(string), 2)
	if err != nil {
		t.Fatal(err)
	}
	auth, err := agent.NewAuthenticator(envelope.NodeID, map[string][]byte{"test": key})
	if err != nil {
		t.Fatal(err)
	}
	if err := auth.Verify(envelope, proof, now); err != nil {
		t.Fatal(err)
	}
	proof.Signature = "invalid"
	if err := auth.Verify(envelope, proof, now); err == nil {
		t.Fatal("invalid authentication accepted")
	}
}

func reconciliationFixture(t *testing.T) map[string]any {
	t.Helper()
	body := recoveryFixture(t)
	body["nodeGeneration"] = 8
	for _, target := range body["payload"].(map[string]any)["targets"].([]any) {
		change := target.(map[string]any)
		change["previousTarget"].(map[string]any)["requiredLabels"].(map[string]any)["com.teamaibox.node-generation"] = "5"
		change["desiredTarget"].(map[string]any)["requiredLabels"].(map[string]any)["com.teamaibox.node-generation"] = "8"
	}
	return body
}

func TestProtectedAuthorityReconciliationScope(t *testing.T) {
	body := reconciliationFixture(t)
	raw, digest := recoveryBytes(t, body)
	if _, _, err := decodeProtectedAuthorityReconciliation(raw, digest, body["nodeId"].(string), 8); err != nil {
		t.Fatal(err)
	}
	if _, _, err := decodeProtectedRecovery(raw, digest, body["nodeId"].(string), 8); err == nil {
		t.Fatal("legacy adjacent recovery accepted a skipped epoch")
	}
	for _, mutation := range []string{"same", "future", "zero", "noncanonical", "mixed", "current", "image", "config", "profile", "companion", "incomplete", "fault", "unknown", "digest"} {
		t.Run(mutation, func(t *testing.T) {
			body := reconciliationFixture(t)
			payload := body["payload"].(map[string]any)
			first := payload["targets"].([]any)[0].(map[string]any)
			prior := first["previousTarget"].(map[string]any)
			desired := first["desiredTarget"].(map[string]any)
			labels := prior["requiredLabels"].(map[string]any)
			switch mutation {
			case "same":
				labels["com.teamaibox.node-generation"] = "8"
			case "future":
				labels["com.teamaibox.node-generation"] = "9"
			case "zero":
				labels["com.teamaibox.node-generation"] = "0"
			case "noncanonical":
				labels["com.teamaibox.node-generation"] = "05"
			case "mixed":
				labels["com.teamaibox.node-generation"] = "6"
			case "current":
				body["nodeGeneration"] = 7
			case "image":
				desired["requiredImageId"] = "sha256:changed"
			case "config":
				desired["requiredConfigDigest"] = "sha256:changed"
			case "profile":
				desired["modelProfileId"] = "018f6f18-24d7-7c21-9b62-8c0174199502"
			case "companion":
				first["desiredCompanions"] = []any{map[string]any{"containerName": "foreign"}}
			case "incomplete":
				payload["targets"] = payload["targets"].([]any)[:5]
			case "fault":
				payload["faultInjection"] = map[string]any{"fault": "stop"}
			case "unknown":
				body["unexpected"] = true
			}
			raw, digest := recoveryBytes(t, body)
			if mutation == "digest" {
				digest = "sha256:wrong"
			}
			if _, _, err := decodeProtectedAuthorityReconciliation(raw, digest, body["nodeId"].(string), 8); err == nil {
				t.Fatal("unsafe reconciliation accepted")
			}
		})
	}
}

func TestProtectedAuthorityReconciliationAuthenticatesCurrentEpoch(t *testing.T) {
	body := reconciliationFixture(t)
	now := time.Now().UTC()
	body["commandId"] = "018f6f18-24d7-7c21-9b62-8c0174199502"
	body["issuedAt"] = now.Format(time.RFC3339Nano)
	body["deadlineAt"] = now.Add(time.Minute).Format(time.RFC3339Nano)
	encoded, _ := json.Marshal(body)
	key := []byte("synthetic-recovery-test-key-32-bytes-only")
	raw, _ := json.Marshal(protectedRecoveryInput{Body: encoded, KeyID: "test", Nonce: "reconcile-nonce", Signature: agent.SignCommandBody(encoded, "test", "reconcile-nonce", key)})
	digest := sha256.Sum256(raw)
	envelope, proof, err := decodeProtectedAuthorityReconciliation(raw, "sha256:"+hex.EncodeToString(digest[:]), body["nodeId"].(string), 8)
	if err != nil {
		t.Fatal(err)
	}
	auth, err := agent.NewAuthenticator(envelope.NodeID, map[string][]byte{"test": key})
	if err != nil {
		t.Fatal(err)
	}
	if err := auth.Verify(envelope, proof, now); err != nil {
		t.Fatal(err)
	}
	// Epoch matching belongs to the decoder/service, not the HMAC primitive.
	// A correctly signed command for an old epoch must still be rejected.
	if _, _, err := decodeProtectedAuthorityReconciliation(raw, "sha256:"+hex.EncodeToString(digest[:]), body["nodeId"].(string), 5); err == nil {
		t.Fatal("command admitted for a different current epoch")
	}
	proof.Signature = "invalid"
	if err := auth.Verify(envelope, proof, now); err == nil {
		t.Fatal("invalid signature accepted")
	}
}

func TestProtectedRecoveryCannotResumeAnotherJournal(t *testing.T) {
	body := recoveryFixture(t)
	encoded, _ := json.Marshal(body)
	var envelope agent.CommandEnvelope
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "journal.json")
	if err := verifyRecoveryJournal(path, envelope); err != nil {
		t.Fatal(err)
	}
	journal := map[string]any{"nodeId": envelope.NodeID, "nodeGeneration": 2, "payload": body["payload"]}
	write := func() {
		t.Helper()
		data, _ := json.Marshal(journal)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	if err := verifyRecoveryJournal(path, envelope); err != nil {
		t.Fatal(err)
	}
	journal["nodeGeneration"] = 1
	write()
	if err := verifyRecoveryJournal(path, envelope); err == nil {
		t.Fatal("old epoch journal accepted")
	}
	journal["nodeGeneration"] = 2
	journal["payload"].(map[string]any)["transactionId"] = "018f6f18-24d7-7c21-9b62-8c0174199502"
	write()
	if err := verifyRecoveryJournal(path, envelope); err == nil {
		t.Fatal("different transaction journal accepted")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if err := verifyRecoveryJournal(path, envelope); err == nil {
		t.Fatal("public journal accepted")
	}
}
