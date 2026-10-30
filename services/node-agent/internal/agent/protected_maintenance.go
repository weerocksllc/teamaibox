package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	protectedMaintenanceJournalSchema = 1
	protectedMaintenanceMaximumWindow = 15 * time.Minute
	protectedMaintenanceRecoveryBound = 35 * time.Minute
	protectedMaintenanceMaximumBytes  = 1 << 20
)

type protectedMaintenanceJournal struct {
	SchemaVersion  int                         `json:"schemaVersion"`
	NodeID         string                      `json:"nodeId"`
	NodeGeneration int64                       `json:"nodeGeneration"`
	CommandDigest  string                      `json:"commandDigest"`
	PlanDigest     string                      `json:"planDigest"`
	Payload        ProtectedMaintenancePayload `json:"payload"`
	Phase          string                      `json:"phase"`
	NextOperation  int                         `json:"nextOperation"`
	FailureCode    string                      `json:"failureCode,omitempty"`
	UpdatedAt      time.Time                   `json:"updatedAt"`
}

type ProtectedMaintenanceCoordinator struct {
	nodeID         string
	nodeGeneration int64
	filename       string
	policy         Policy
	runtime        ProtectedMaintenanceRuntime
	mu             sync.Mutex
	journal        *protectedMaintenanceJournal
}

func NewProtectedMaintenanceCoordinator(nodeID string, nodeGeneration int64, filename string, policy Policy, runtime ProtectedMaintenanceRuntime) (*ProtectedMaintenanceCoordinator, error) {
	if !uuidPattern.MatchString(nodeID) || nodeGeneration < 1 || runtime == nil || !filepath.IsAbs(filename) || filepath.Clean(filename) == "/" {
		return nil, fmt.Errorf("protected_maintenance_configuration_invalid")
	}
	if !validProtectedMaintenancePolicy(policy) {
		return nil, fmt.Errorf("protected_maintenance_policy_invalid")
	}
	directory := filepath.Dir(filename)
	info, err := os.Lstat(directory)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, fmt.Errorf("protected_maintenance_state_directory_invalid")
	}
	coordinator := &ProtectedMaintenanceCoordinator{
		nodeID: nodeID, nodeGeneration: nodeGeneration, filename: filename,
		policy: policy, runtime: runtime,
	}
	journal, err := coordinator.readJournal()
	if err != nil {
		return nil, err
	}
	coordinator.journal = journal
	return coordinator, nil
}

func validProtectedMaintenancePolicy(policy Policy) bool {
	targets := policy.ProtectedTargets()
	workers := make(map[string]ExclusiveDrainTarget, len(targets))
	stages := make(map[int]bool, len(targets))
	var generation int64
	for _, target := range targets {
		if !modelAliasPattern.MatchString(target.TargetKey) || !uuidPattern.MatchString(target.WorkerID) ||
			!uuidPattern.MatchString(target.ModelProfileID) || target.ContainerName == "" || target.MaintenanceGeneration < 1 || target.StageOrder < 1 ||
			stages[target.StageOrder] || !policyIDPattern.MatchString(target.RequiredImageID) ||
			!imagePattern.MatchString(target.RequiredImageDigest) || !policyIDPattern.MatchString(target.RequiredConfigDigest) ||
			workers[target.WorkerID].WorkerID != "" || len(target.DependsOnWorkerIDs) > 31 || len(target.DependentContainers) > 8 {
			return false
		}
		if generation == 0 {
			generation = target.MaintenanceGeneration
		} else if generation != target.MaintenanceGeneration {
			return false
		}
		seenDependencies := map[string]bool{}
		for _, dependencyWorkerID := range target.DependsOnWorkerIDs {
			if !uuidPattern.MatchString(dependencyWorkerID) || dependencyWorkerID == target.WorkerID || seenDependencies[dependencyWorkerID] {
				return false
			}
			seenDependencies[dependencyWorkerID] = true
		}
		for _, dependent := range target.DependentContainers {
			if dependent.ContainerName == "" || !policyIDPattern.MatchString(dependent.RequiredImageID) ||
				!imagePattern.MatchString(dependent.RequiredImageDigest) || !policyIDPattern.MatchString(dependent.RequiredConfigDigest) {
				return false
			}
		}
		workers[target.WorkerID] = target
		stages[target.StageOrder] = true
	}
	for _, target := range targets {
		for _, dependencyWorkerID := range target.DependsOnWorkerIDs {
			dependency, exists := workers[dependencyWorkerID]
			if !exists || dependency.StageOrder >= target.StageOrder {
				return false
			}
		}
	}
	return true
}

func protectedMaintenancePlanDigest(payload ProtectedMaintenancePayload) string {
	encoded, _ := json.Marshal(payload)
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func sameProtectedTarget(left, right ExclusiveDrainTarget) bool {
	first, firstErr := json.Marshal(left)
	second, secondErr := json.Marshal(right)
	return firstErr == nil && secondErr == nil && string(first) == string(second)
}

func (c *ProtectedMaintenanceCoordinator) payloadMatchesCurrentPolicy(payload ProtectedMaintenancePayload) bool {
	configured := c.policy.ProtectedTargets()
	if len(configured) != len(payload.Targets) || len(payload.WorkerIDs) != len(configured) {
		return false
	}
	for index := range configured {
		if configured[index].MaintenanceGeneration != payload.MaintenanceGeneration ||
			payload.WorkerIDs[index] != configured[index].WorkerID || !sameProtectedTarget(configured[index], payload.Targets[index]) {
			return false
		}
	}
	return true
}

func (c *ProtectedMaintenanceCoordinator) validatePayload(payload ProtectedMaintenancePayload, ownership Ownership, now time.Time) error {
	if ownership.NodeID != c.nodeID || ownership.NodeGeneration != c.nodeGeneration ||
		!uuidPattern.MatchString(ownership.CommandID) || ownership.FencingToken == 0 ||
		!uuidPattern.MatchString(payload.TransactionID) || payload.TransactionID != ownership.LeaseID ||
		payload.MaintenanceGeneration < 1 || payload.JournalRevision < 1 ||
		ownership.FencingToken != uint64(payload.JournalRevision) || payload.IssuedAt.After(now.Add(time.Second)) ||
		!payload.IssuedAt.Before(payload.ExpiresAt) || payload.ExpiresAt.Sub(payload.IssuedAt) > protectedMaintenanceMaximumWindow ||
		!payload.ExpiresAt.After(now) {
		return fmt.Errorf("protected_maintenance_identity_invalid")
	}
	if len(payload.AllowedOperations) != 1 || payload.AllowedOperations[0] != ProtectedSetMaintenance {
		return fmt.Errorf("protected_maintenance_operations_invalid")
	}
	expectedOperations := []string{ProtectedMaintenanceStop, ProtectedMaintenanceRestore, ProtectedMaintenanceVerify}
	if len(payload.OperationOrder) != len(expectedOperations) {
		return fmt.Errorf("protected_maintenance_operations_invalid")
	}
	for index, expected := range expectedOperations {
		if payload.OperationOrder[index] != expected {
			return fmt.Errorf("protected_maintenance_operations_invalid")
		}
	}
	configured := c.policy.ProtectedTargets()
	if len(configured) == 0 || len(payload.Targets) != len(configured) || len(payload.WorkerIDs) != len(configured) {
		return fmt.Errorf("protected_maintenance_set_drift")
	}
	seenWorkers := map[string]bool{}
	for index, target := range payload.Targets {
		if target.MaintenanceGeneration != payload.MaintenanceGeneration || configured[index].MaintenanceGeneration != payload.MaintenanceGeneration {
			return fmt.Errorf("protected_maintenance_generation_drift")
		}
		if target.TargetKey != configured[index].TargetKey || !sameProtectedTarget(target, configured[index]) ||
			payload.WorkerIDs[index] != target.WorkerID || !uuidPattern.MatchString(target.WorkerID) || seenWorkers[target.WorkerID] {
			return fmt.Errorf("protected_maintenance_set_drift")
		}
		seenWorkers[target.WorkerID] = true
	}
	if c.journal == nil {
		// JournalRevision is the authenticated node-wide fencing token, not
		// a maintenance-only ordinal. Other leases and pre-admission failures
		// consume tokens before the first successful maintenance transaction.
		// Positivity and exact envelope binding were checked above.
		return nil
	}
	if c.journal.Phase != "complete" && c.journal.Phase != "recovered" {
		return fmt.Errorf("protected_maintenance_recovery_incomplete")
	}
	// Persist a strict high-water mark, allowing gaps from other node work.
	// Equal/older commands still fail closed (except exact completed replay
	// in Execute); generation and exact target identity checks are unchanged.
	if payload.JournalRevision <= c.journal.Payload.JournalRevision ||
		payload.MaintenanceGeneration < c.journal.Payload.MaintenanceGeneration ||
		payload.MaintenanceGeneration > c.journal.Payload.MaintenanceGeneration+1 {
		return fmt.Errorf("protected_maintenance_generation_drift")
	}
	return nil
}

func validProtectedMaintenanceJournal(journal protectedMaintenanceJournal, nodeID string, nodeGeneration int64) bool {
	if journal.SchemaVersion != protectedMaintenanceJournalSchema || journal.NodeID != nodeID || journal.NodeGeneration != nodeGeneration ||
		!sha256Pattern.MatchString(journal.CommandDigest) || protectedMaintenancePlanDigest(journal.Payload) != journal.PlanDigest ||
		!uuidPattern.MatchString(journal.Payload.TransactionID) || journal.Payload.MaintenanceGeneration < 1 ||
		journal.Payload.JournalRevision < 1 || !journal.Payload.IssuedAt.Before(journal.Payload.ExpiresAt) ||
		journal.Payload.ExpiresAt.Sub(journal.Payload.IssuedAt) > protectedMaintenanceMaximumWindow ||
		journal.NextOperation < 0 || journal.NextOperation > len(journal.Payload.Targets) || journal.UpdatedAt.IsZero() {
		return false
	}
	expectedOperations := []string{ProtectedMaintenanceStop, ProtectedMaintenanceRestore, ProtectedMaintenanceVerify}
	if len(journal.Payload.AllowedOperations) != 1 || journal.Payload.AllowedOperations[0] != ProtectedSetMaintenance ||
		len(journal.Payload.OperationOrder) != len(expectedOperations) ||
		len(journal.Payload.WorkerIDs) != len(journal.Payload.Targets) || len(journal.Payload.Targets) == 0 {
		return false
	}
	seenWorkers := map[string]bool{}
	for index, operation := range journal.Payload.OperationOrder {
		if operation != expectedOperations[index] {
			return false
		}
	}
	for index, target := range journal.Payload.Targets {
		if !IsProtectedPlacement(target.PlacementClass) || target.MaintenanceGeneration != journal.Payload.MaintenanceGeneration ||
			!uuidPattern.MatchString(target.WorkerID) ||
			journal.Payload.WorkerIDs[index] != target.WorkerID || seenWorkers[target.WorkerID] {
			return false
		}
		seenWorkers[target.WorkerID] = true
	}
	switch journal.Phase {
	case "prepared":
		return journal.NextOperation == 0 && journal.FailureCode == ""
	case "stopping":
		return journal.NextOperation < len(journal.Payload.Targets) && journal.FailureCode == ""
	case "stopped":
		return journal.NextOperation == len(journal.Payload.Targets) && journal.FailureCode == ""
	case "restoring":
		return journal.NextOperation <= len(journal.Payload.Targets)
	case "verifying":
		return journal.NextOperation == 0
	case "complete":
		return journal.NextOperation == 0 && journal.FailureCode == ""
	case "recovery_required":
		return journal.FailureCode != ""
	case "recovered":
		return journal.NextOperation == 0
	default:
		return false
	}
}

func (c *ProtectedMaintenanceCoordinator) readJournal() (*protectedMaintenanceJournal, error) {
	info, err := os.Lstat(c.filename)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() < 2 || info.Size() > protectedMaintenanceMaximumBytes {
		return nil, fmt.Errorf("protected_maintenance_journal_invalid")
	}
	file, err := os.Open(c.filename)
	if err != nil {
		return nil, fmt.Errorf("protected_maintenance_journal_invalid")
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, protectedMaintenanceMaximumBytes))
	decoder.DisallowUnknownFields()
	var journal protectedMaintenanceJournal
	if err := decoder.Decode(&journal); err != nil {
		return nil, fmt.Errorf("protected_maintenance_journal_invalid")
	}
	// Completed maintenance is historical state, not permission to replay it.
	// A normal reconnect may advance the node generation; retain the journal
	// unchanged while still rejecting incomplete, future or malformed records.
	valid := validProtectedMaintenanceJournal(journal, c.nodeID, c.nodeGeneration)
	if journal.NodeGeneration > 0 && journal.NodeGeneration < c.nodeGeneration &&
		(journal.Phase == "complete" || journal.Phase == "recovered") {
		valid = validProtectedMaintenanceJournal(journal, c.nodeID, journal.NodeGeneration)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) || !valid {
		return nil, fmt.Errorf("protected_maintenance_journal_invalid")
	}
	return &journal, nil
}

func (c *ProtectedMaintenanceCoordinator) writeJournal(journal protectedMaintenanceJournal) error {
	encoded, err := json.Marshal(journal)
	if err != nil || len(encoded) > protectedMaintenanceMaximumBytes {
		return fmt.Errorf("protected_maintenance_journal_invalid")
	}
	directory := filepath.Dir(c.filename)
	temporary, err := os.CreateTemp(directory, ".protected-maintenance-journal-")
	if err != nil {
		return fmt.Errorf("protected_maintenance_journal_write_failed")
	}
	temporaryName := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryName)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("protected_maintenance_journal_write_failed")
	}
	if _, err := temporary.Write(append(encoded, '\n')); err != nil || temporary.Sync() != nil || temporary.Close() != nil {
		return fmt.Errorf("protected_maintenance_journal_write_failed")
	}
	if err := os.Rename(temporaryName, c.filename); err != nil {
		return fmt.Errorf("protected_maintenance_journal_write_failed")
	}
	// Once rename succeeds, the new state is authoritative in this process even
	// if directory fsync reports an error. This keeps subsequent ordinary
	// mutation fail-closed while the durability failure is handled; the prior
	// durable phase is still sufficient for crash recovery.
	committed = true
	c.journal = &journal
	directoryFile, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("protected_maintenance_journal_write_failed")
	}
	syncErr := directoryFile.Sync()
	closeErr := directoryFile.Close()
	if syncErr != nil || closeErr != nil {
		return fmt.Errorf("protected_maintenance_journal_write_failed")
	}
	return nil
}

func (c *ProtectedMaintenanceCoordinator) setPhase(journal *protectedMaintenanceJournal, phase string, next int, failure string, now time.Time) error {
	journal.Phase = phase
	journal.NextOperation = next
	journal.FailureCode = failure
	journal.UpdatedAt = now.UTC()
	return c.writeJournal(*journal)
}

func (c *ProtectedMaintenanceCoordinator) verifySet(ctx context.Context, targets []ExclusiveDrainTarget, requireRunning bool) error {
	for _, target := range targets {
		state, err := c.runtime.InspectProtectedMaintenanceTarget(ctx, target)
		if err != nil {
			return err
		}
		if requireRunning && (state.Target.State != "running" || state.Target.Health != "healthy") {
			return fmt.Errorf("protected_maintenance_prior_health_invalid")
		}
		for _, dependency := range state.Dependencies {
			if requireRunning && (dependency.State != "running" || dependency.Health != "healthy") {
				return fmt.Errorf("protected_maintenance_prior_health_invalid")
			}
		}
	}
	return nil
}

func (c *ProtectedMaintenanceCoordinator) restoreReverse(ctx context.Context, journal *protectedMaintenanceJournal, now time.Time) error {
	if err := c.setPhase(journal, "restoring", len(journal.Payload.Targets), journal.FailureCode, now); err != nil {
		return err
	}
	for index := len(journal.Payload.Targets) - 1; index >= 0; index-- {
		if err := c.setPhase(journal, "restoring", index, journal.FailureCode, now); err != nil {
			return err
		}
		if _, err := c.runtime.RestoreProtectedMaintenanceTarget(ctx, journal.Payload.Targets[index]); err != nil {
			_ = c.setPhase(journal, "recovery_required", index, "protected_maintenance_restore_failed", now)
			return fmt.Errorf("protected_maintenance_recovery_incomplete")
		}
	}
	if err := c.verifySet(ctx, journal.Payload.Targets, true); err != nil {
		_ = c.setPhase(journal, "recovery_required", 0, "protected_maintenance_verify_failed", now)
		return fmt.Errorf("protected_maintenance_recovery_incomplete")
	}
	return nil
}

// Once the authenticated prior identities have been durably journaled, their
// restoration is a safety obligation, not a new maintenance authorization.
// A disconnected caller must not strand stopped office Workers. Keep recovery
// independent of that request, but bounded; a real failure leaves the journal
// recovery_required and ordinary mutation blocked.
func (c *ProtectedMaintenanceCoordinator) restoreJournal(journal *protectedMaintenanceJournal, now time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), protectedMaintenanceRecoveryBound)
	defer cancel()
	return c.restoreReverse(ctx, journal, now)
}

// Recover restores the exact prior protected set after a process/host crash.
// Expiry prevents new mutation, but never prevents restoration of an already
// authenticated journaled transaction.
func (c *ProtectedMaintenanceCoordinator) Recover(ctx context.Context, now time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.journal == nil || c.journal.Phase == "complete" || c.journal.Phase == "recovered" {
		return nil
	}
	configured := c.policy.ProtectedTargets()
	if len(configured) != len(c.journal.Payload.Targets) {
		return fmt.Errorf("protected_maintenance_set_drift")
	}
	for index := range configured {
		if !sameProtectedTarget(configured[index], c.journal.Payload.Targets[index]) {
			return fmt.Errorf("protected_maintenance_set_drift")
		}
	}
	if err := c.restoreJournal(c.journal, now); err != nil {
		return err
	}
	return c.setPhase(c.journal, "recovered", 0, c.journal.FailureCode, now)
}

func (c *ProtectedMaintenanceCoordinator) Execute(ctx context.Context, payload ProtectedMaintenancePayload, ownership Ownership, commandDigest string, now time.Time) (ProtectedMaintenanceJournalState, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.validatePayload(payload, ownership, now); err != nil {
		// A completed command may have lost its mTLS response immediately before
		// an Agent restart. The stable transaction/command ID makes an exact retry
		// byte-identical; return the fsynced terminal journal without mutating the
		// runtime again. Every identity/set/window check above still ran first.
		if err.Error() == "protected_maintenance_generation_drift" && c.journal != nil && c.journal.Phase == "complete" &&
			c.journal.CommandDigest == commandDigest && ownership.CommandDigest == commandDigest &&
			c.journal.PlanDigest == protectedMaintenancePlanDigest(payload) && c.payloadMatchesCurrentPolicy(payload) {
			return c.stateLocked(), nil
		}
		return ProtectedMaintenanceJournalState{}, err
	}
	if !sha256Pattern.MatchString(commandDigest) || ownership.CommandDigest != commandDigest {
		return ProtectedMaintenanceJournalState{}, fmt.Errorf("protected_maintenance_signature_binding_invalid")
	}
	if err := ctx.Err(); err != nil {
		return ProtectedMaintenanceJournalState{}, err
	}
	if err := c.verifySet(ctx, payload.Targets, true); err != nil {
		return ProtectedMaintenanceJournalState{}, fmt.Errorf("protected_maintenance_prior_identity_invalid")
	}
	journal := &protectedMaintenanceJournal{
		SchemaVersion: protectedMaintenanceJournalSchema, NodeID: c.nodeID, NodeGeneration: c.nodeGeneration,
		CommandDigest: commandDigest, PlanDigest: protectedMaintenancePlanDigest(payload), Payload: payload,
		Phase: "prepared", UpdatedAt: now.UTC(),
	}
	if err := c.writeJournal(*journal); err != nil {
		return ProtectedMaintenanceJournalState{}, err
	}
	for index, target := range payload.Targets {
		if err := c.setPhase(journal, "stopping", index, "", now); err != nil {
			return ProtectedMaintenanceJournalState{}, err
		}
		if _, err := c.runtime.StopProtectedMaintenanceTarget(ctx, target); err != nil {
			journal.FailureCode = "protected_maintenance_stop_failed"
			_ = c.setPhase(journal, "recovery_required", index, journal.FailureCode, now)
			if recoveryErr := c.restoreJournal(journal, now); recoveryErr != nil {
				return ProtectedMaintenanceJournalState{}, recoveryErr
			}
			_ = c.setPhase(journal, "recovered", 0, journal.FailureCode, now)
			return ProtectedMaintenanceJournalState{}, fmt.Errorf("protected_maintenance_stop_failed")
		}
	}
	if err := c.setPhase(journal, "stopped", len(payload.Targets), "", now); err != nil {
		return ProtectedMaintenanceJournalState{}, err
	}
	if err := c.restoreJournal(journal, now); err != nil {
		return ProtectedMaintenanceJournalState{}, err
	}
	if err := c.setPhase(journal, "verifying", 0, "", now); err != nil {
		return ProtectedMaintenanceJournalState{}, err
	}
	// restoreJournal already verified every exact Worker and companion under
	// its recovery context; do not re-check with a possibly canceled caller.
	if err := c.setPhase(journal, "complete", 0, "", now); err != nil {
		return ProtectedMaintenanceJournalState{}, err
	}
	return c.stateLocked(), nil
}

func (c *ProtectedMaintenanceCoordinator) stateLocked() ProtectedMaintenanceJournalState {
	if c.journal == nil {
		return ProtectedMaintenanceJournalState{}
	}
	return ProtectedMaintenanceJournalState{
		TransactionID:         c.journal.Payload.TransactionID,
		MaintenanceGeneration: c.journal.Payload.MaintenanceGeneration,
		JournalRevision:       c.journal.Payload.JournalRevision,
		Phase:                 c.journal.Phase, NextOperation: c.journal.NextOperation,
		PlanDigest: c.journal.PlanDigest, UpdatedAt: c.journal.UpdatedAt,
	}
}

func (c *ProtectedMaintenanceCoordinator) BlocksOrdinaryMutation() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.journal != nil && c.journal.Phase != "complete" && c.journal.Phase != "recovered"
}
