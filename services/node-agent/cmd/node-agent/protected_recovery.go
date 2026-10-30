package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"reflect"
	"strconv"
	"syscall"
	"time"

	"teamaibox.local/node-agent/internal/agent"
	dockerruntime "teamaibox.local/node-agent/internal/docker"
)

// A bounded heartbeat-only maintenance handoff. It has no command listener,
// Docker client, journal mutation or generation reconciler. Revocation/fencing
// still terminates it; an offline node is never made current by local edits.
func maintainApplianceHeartbeat() error {
	nodeID, generation, err := loadNodeIdentity()
	if err != nil {
		return err
	}
	certFile, err := requiredEnvironment("TEAMAIBOX_TLS_CERT_FILE")
	if err != nil {
		return err
	}
	keyFile, err := requiredEnvironment("TEAMAIBOX_TLS_KEY_FILE")
	if err != nil {
		return err
	}
	certificate, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return err
	}
	runner, err := applianceHeartbeatRunner(nodeID, generation, &certificate)
	if err != nil {
		return err
	}
	if runner == nil {
		return errors.New("maintenance_heartbeat_not_configured")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 45*time.Minute)
	defer cancel()
	var writeErr error
	err = runner.RunWithReady(ctx, func() {
		writeErr = json.NewEncoder(os.Stdout).Encode(struct {
			Status         string `json:"status"`
			NodeGeneration int64  `json:"nodeGeneration"`
		}{"heartbeat-accepted", generation})
		if writeErr != nil {
			cancel()
		}
	})
	return errors.Join(err, writeErr)
}

// This is an offline, one-command recovery entry point, not an HTTP listener.
// The operator must first quiesce the ordinary Agent and scheduling. It keeps
// authentication and complete-set transaction/rollback checks, but does not
// run ordinary startup cleanup against protected Workers from an older epoch.
type protectedRecoveryInput struct {
	Body      json.RawMessage `json:"body"`
	KeyID     string          `json:"keyId"`
	Nonce     string          `json:"nonce"`
	Signature string          `json:"signature"`
}

func decodeProtectedRecovery(raw []byte, expected string, nodeID string, generation int64) (agent.CommandEnvelope, agent.AuthProof, error) {
	return decodeProtectedRecoveryMode(raw, expected, nodeID, generation, false)
}

// A transport reconnect can advance the node epoch without restarting its
// protected models. Reconcile that actual state in one transaction rather than
// inventing intermediate deployments. The adjacent-generation entry remains
// unchanged; this entry requires a uniform, strictly older source epoch and
// otherwise identical targets, authenticated at the current epoch.
func decodeProtectedAuthorityReconciliation(raw []byte, expected string, nodeID string, generation int64) (agent.CommandEnvelope, agent.AuthProof, error) {
	return decodeProtectedRecoveryMode(raw, expected, nodeID, generation, true)
}

func decodeProtectedRecoveryMode(raw []byte, expected string, nodeID string, generation int64, reconcile bool) (agent.CommandEnvelope, agent.AuthProof, error) {
	reason := "scope"
	fail := func() (agent.CommandEnvelope, agent.AuthProof, error) {
		if reconcile {
			return agent.CommandEnvelope{}, agent.AuthProof{}, errors.New("protected_authority_reconciliation_input_invalid_" + reason)
		}
		return agent.CommandEnvelope{}, agent.AuthProof{}, errors.New("protected_generation_recovery_input_invalid")
	}
	digest := sha256.Sum256(raw)
	reason = "digest"
	if len(raw) > 2<<20 || expected != "sha256:"+hex.EncodeToString(digest[:]) {
		return fail()
	}
	var input protectedRecoveryInput
	reason = "schema"
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || !errors.Is(decoder.Decode(new(any)), io.EOF) {
		return fail()
	}
	var envelope agent.CommandEnvelope
	reason = "envelope"
	decoder = json.NewDecoder(bytes.NewReader(input.Body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&envelope) != nil || !errors.Is(decoder.Decode(new(any)), io.EOF) ||
		envelope.Type != "protected-set.transaction.execute" || envelope.NodeID != nodeID ||
		envelope.NodeGeneration != generation || generation < 2 {
		return fail()
	}
	var payload agent.ProtectedSetTransitionPayload
	reason = "payload"
	decoder = json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || !errors.Is(decoder.Decode(new(any)), io.EOF) ||
		payload.SetID != "office.baseline" || len(payload.Targets) != 6 || payload.FaultInjection != nil ||
		payload.MigrationPlanID != "" || payload.QualificationID != "" {
		return fail()
	}
	seen := map[string]bool{}
	var sourceGeneration int64
	for _, change := range payload.Targets {
		reason = "target"
		prior := change.PreviousTarget
		if prior == nil || change.LegacyPreviousTarget != nil || len(change.DesiredCompanions) != 0 ||
			change.DesiredTarget.RequiredLabels["com.teamaibox.node-generation"] != strconv.FormatInt(generation, 10) ||
			prior.RequiredImageID != change.DesiredTarget.RequiredImageID ||
			prior.RequiredImageDigest != change.DesiredTarget.RequiredImageDigest ||
			prior.RequiredConfigDigest != change.DesiredTarget.RequiredConfigDigest ||
			prior.RequiredStartSpecDigest != change.DesiredTarget.RequiredStartSpecDigest {
			return fail()
		}
		priorText := prior.RequiredLabels["com.teamaibox.node-generation"]
		reason = "source_epoch"
		priorGeneration, err := strconv.ParseInt(priorText, 10, 64)
		if err != nil || priorGeneration < 1 || priorGeneration >= generation ||
			priorText != strconv.FormatInt(priorGeneration, 10) ||
			(!reconcile && priorGeneration != generation-1) ||
			(sourceGeneration != 0 && priorGeneration != sourceGeneration) {
			return fail()
		}
		sourceGeneration = priorGeneration
		// Recovery is not permission to change a model, profile, dependency,
		// companion or security label. Only the already-fenced epoch advances.
		reason = "normalization"
		if seen[prior.WorkerID] {
			return fail()
		}
		seen[prior.WorkerID] = true
		// Copy the label map directly. A JSON round-trip would turn an
		// explicitly empty optional slice into nil via omitempty, falsely
		// rejecting the otherwise identical deployed target.
		normalized := *prior
		normalized.RequiredLabels = make(map[string]string, len(prior.RequiredLabels))
		for key, value := range prior.RequiredLabels {
			normalized.RequiredLabels[key] = value
		}
		normalized.RequiredLabels["com.teamaibox.node-generation"] = strconv.FormatInt(generation, 10)
		if !reflect.DeepEqual(normalized, change.DesiredTarget) {
			return fail()
		}
	}
	return envelope, agent.AuthProof{KeyID: input.KeyID, Nonce: input.Nonce, Signature: input.Signature, SignedBody: input.Body}, nil
}

// Read-only input admission before quiescing the live Agent. This command
// neither opens Docker nor creates a recovery journal; it reports no payload.
func validateProtectedAuthorityReconciliationInput() error {
	nodeID, generation, err := loadNodeIdentity()
	if err != nil {
		return err
	}
	expected, err := requiredEnvironment("TEAMAIBOX_PROTECTED_RECOVERY_INPUT_DIGEST")
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, (2<<20)+1))
	if err != nil {
		return err
	}
	envelope, proof, err := decodeProtectedAuthorityReconciliation(raw, expected, nodeID, generation)
	if err != nil {
		return err
	}
	keyID, err := requiredEnvironment("TEAMAIBOX_COMMAND_KEY_ID")
	if err != nil {
		return err
	}
	keyFile, err := requiredEnvironment("TEAMAIBOX_COMMAND_KEY_FILE")
	if err != nil {
		return err
	}
	key, err := readBase64Key(keyFile)
	if err != nil {
		return err
	}
	auth, err := agent.NewAuthenticator(nodeID, map[string][]byte{keyID: key})
	for i := range key {
		key[i] = 0
	}
	if err != nil {
		return err
	}
	if err := auth.Verify(envelope, proof, time.Now().UTC()); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Status         string `json:"status"`
		NodeGeneration int64  `json:"nodeGeneration"`
	}{"valid", generation})
}

func executeProtectedGenerationRecovery() error {
	return executeProtectedRecoveryMode(false)
}

func executeProtectedAuthorityReconciliation() error {
	return executeProtectedRecoveryMode(true)
}

func executeProtectedRecoveryMode(reconcile bool) error {
	nodeID, generation, err := loadNodeIdentity()
	if err != nil {
		return err
	}
	expected, err := requiredEnvironment("TEAMAIBOX_PROTECTED_RECOVERY_INPUT_DIGEST")
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, (2<<20)+1))
	if err != nil {
		return err
	}
	envelope, proof, err := decodeProtectedRecoveryMode(raw, expected, nodeID, generation, reconcile)
	if err != nil {
		return err
	}
	keyID, err := requiredEnvironment("TEAMAIBOX_COMMAND_KEY_ID")
	if err != nil {
		return err
	}
	keyFile, err := requiredEnvironment("TEAMAIBOX_COMMAND_KEY_FILE")
	if err != nil {
		return err
	}
	key, err := readBase64Key(keyFile)
	if err != nil {
		return err
	}
	auth, err := agent.NewAuthenticator(nodeID, map[string][]byte{keyID: key})
	for i := range key {
		key[i] = 0
	}
	if err != nil {
		return err
	}
	// Authenticate before opening the Docker runtime or any recovery journal.
	if err := auth.Verify(envelope, proof, time.Now().UTC()); err != nil {
		return err
	}
	policy, err := nodeAgentPolicy(os.Getenv)
	if err != nil {
		return err
	}
	stateDir, err := requiredEnvironment("TEAMAIBOX_NODE_STATE_DIR")
	if err != nil || !filepath.IsAbs(stateDir) || filepath.Clean(stateDir) == "/" {
		return errors.New("protected_recovery_state_invalid")
	}
	journalPath := filepath.Join(stateDir, "protected-set-transition-journal.v1.json")
	if err := verifyRecoveryJournal(journalPath, envelope); err != nil {
		return err
	}
	runtime, err := dockerruntime.NewEngineRuntime("/var/run/docker.sock")
	if err != nil {
		return err
	}
	coordinator, err := agent.NewProtectedSetTransitionCoordinator(nodeID, generation,
		journalPath, policy, runtime)
	if err != nil {
		return err
	}
	// The signed command is admitted within its normal 15-minute window.
	// Six sequential cold starts have a separate bounded execution window;
	// expiry must not turn an in-progress rollback into a cancelled context.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	if err := coordinator.Recover(ctx, time.Now().UTC()); err != nil {
		return err
	}
	service, err := agent.NewService(nodeID, generation, auth, policy, runtime, &jsonEventSink{encoder: json.NewEncoder(os.Stderr)})
	if err != nil {
		return err
	}
	if err := service.ConfigureProtectedSetTransition(coordinator); err != nil {
		return err
	}
	result, err := service.Handle(ctx, envelope, proof)
	if err != nil || result.Status != "succeeded" {
		recoveryCtx, recoveryCancel := context.WithTimeout(context.Background(), 15*time.Minute)
		defer recoveryCancel()
		if recoveryErr := coordinator.Recover(recoveryCtx, time.Now().UTC()); recoveryErr != nil {
			return errors.Join(err, errors.New("protected_generation_recovery_rollback_incomplete"), recoveryErr)
		}
	}
	if err != nil {
		return err
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		return err
	}
	if result.Status != "succeeded" {
		return errors.New("protected_generation_recovery_failed")
	}
	return nil
}

// Never use authorization for one command to recover a different operation.
// The coordinator performs its own full schema and plan validation afterward.
func verifyRecoveryJournal(filename string, envelope agent.CommandEnvelope) error {
	metadata, err := os.Lstat(filename)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	fail := errors.New("protected_recovery_journal_identity_invalid")
	if err != nil || !metadata.Mode().IsRegular() || metadata.Mode().Perm()&0077 != 0 ||
		metadata.Size() < 2 || metadata.Size() > 2<<20 {
		return fail
	}
	raw, err := os.ReadFile(filename)
	if err != nil || int64(len(raw)) != metadata.Size() {
		return fail
	}
	var journal struct {
		NodeID         string          `json:"nodeId"`
		NodeGeneration int64           `json:"nodeGeneration"`
		Payload        json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(raw, &journal) != nil || journal.NodeID != envelope.NodeID ||
		journal.NodeGeneration != envelope.NodeGeneration {
		return fail
	}
	var saved, requested agent.ProtectedSetTransitionPayload
	if json.Unmarshal(journal.Payload, &saved) != nil || json.Unmarshal(envelope.Payload, &requested) != nil ||
		!reflect.DeepEqual(saved, requested) {
		return fail
	}
	return nil
}
