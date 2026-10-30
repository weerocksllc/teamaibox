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
	"strings"
	"sync"
	"time"
)

const (
	protectedSetTransitionJournalSchema     = 1
	protectedSetTransitionMaximumBytes      = 2 << 20
	protectedSetTransitionTargetStageFailed = "protected_set_transition_target_stage_failed"
)

type protectedSetTransitionJournal struct {
	SchemaVersion              int                           `json:"schemaVersion"`
	NodeID                     string                        `json:"nodeId"`
	NodeGeneration             int64                         `json:"nodeGeneration"`
	CommandDigest              string                        `json:"commandDigest"`
	PlanDigest                 string                        `json:"planDigest"`
	Payload                    ProtectedSetTransitionPayload `json:"payload"`
	Phase                      string                        `json:"phase"`
	NextOperation              int                           `json:"nextOperation"`
	FailureCode                string                        `json:"failureCode,omitempty"`
	FaultInjectionConsumed     bool                          `json:"faultInjectionConsumed,omitempty"`
	FaultInjectionStageOrder   int                           `json:"faultInjectionStageOrder,omitempty"`
	FaultInjectionTargetKey    string                        `json:"faultInjectionTargetKey,omitempty"`
	FaultInjectionAfterHealthy bool                          `json:"faultInjectionAfterHealthy,omitempty"`
	UpdatedAt                  time.Time                     `json:"updatedAt"`
}

// ProtectedSetTransitionCoordinator owns the node-local half of a complete
// protected office-set boot/cutover.  No runtime mutation happens before the
// signed plan is fsynced.  A stage failure always walks the complete plan in
// reverse, which also cleans an exact partially-created cold-boot identity.
type ProtectedSetTransitionCoordinator struct {
	nodeID         string
	nodeGeneration int64
	filename       string
	policy         Policy
	runtime        ProtectedSetTransitionRuntime
	mu             sync.Mutex
	journal        *protectedSetTransitionJournal
	staleAuthority bool
}

func NewProtectedSetTransitionCoordinator(nodeID string, nodeGeneration int64, filename string, policy Policy, runtime ProtectedSetTransitionRuntime) (*ProtectedSetTransitionCoordinator, error) {
	if !uuidPattern.MatchString(nodeID) || nodeGeneration < 1 || runtime == nil || !filepath.IsAbs(filename) || filepath.Clean(filename) == "/" {
		return nil, fmt.Errorf("protected_set_transition_configuration_invalid")
	}
	if !validProtectedMaintenancePolicy(policy) {
		return nil, fmt.Errorf("protected_set_transition_policy_invalid")
	}
	staleAuthority := false
	if policy.LegacyProtectedSetMigration != nil &&
		(policy.LegacyProtectedSetMigration.NodeID != nodeID || policy.LegacyProtectedSetMigration.NodeGeneration < 1 || policy.LegacyProtectedSetMigration.NodeGeneration > nodeGeneration) {
		return nil, fmt.Errorf("protected_set_transition_migration_node_drift")
	}
	if p := policy.LegacyProtectedSetMigration; p != nil && p.NodeGeneration < nodeGeneration {
		staleAuthority = true
	}
	if policy.ProtectedSetQualification != nil &&
		(policy.ProtectedSetQualification.NodeID != nodeID || policy.ProtectedSetQualification.NodeGeneration > nodeGeneration ||
			!policyIDPattern.MatchString(policy.ProtectedSetQualification.SourceDigest) ||
			validateProtectedSetQualificationPolicy(*policy.ProtectedSetQualification, policy) != nil) {
		return nil, fmt.Errorf("protected_set_transition_qualification_node_drift")
	}
	if p := policy.ProtectedSetQualification; p != nil && p.NodeGeneration < nodeGeneration {
		staleAuthority = true
	}
	directory := filepath.Dir(filename)
	info, err := os.Lstat(directory)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, fmt.Errorf("protected_set_transition_state_directory_invalid")
	}
	coordinator := &ProtectedSetTransitionCoordinator{
		nodeID: nodeID, nodeGeneration: nodeGeneration, filename: filename,
		policy: policy, runtime: runtime, staleAuthority: staleAuthority,
	}
	journal, err := coordinator.readJournal()
	if err != nil {
		return nil, err
	}
	coordinator.journal = journal
	return coordinator, nil
}

func protectedSetTransitionPlanDigest(payload ProtectedSetTransitionPayload) string {
	encoded, _ := json.Marshal(payload)
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func protectedTransitionBackupName(transactionID, workerID string) string {
	transaction := strings.ReplaceAll(transactionID, "-", "")
	worker := strings.ReplaceAll(workerID, "-", "")
	return "teamaibox-protected-prior-" + transaction[:12] + "-" + worker[:12]
}

func sameWorkerStartPayload(left, right WorkerStartPayload) bool {
	first, firstErr := json.Marshal(left)
	second, secondErr := json.Marshal(right)
	return firstErr == nil && secondErr == nil && string(first) == string(second)
}

func targetIdentityEqual(left, right ExclusiveDrainTarget) bool {
	return left.WorkerID == right.WorkerID && left.ModelProfileID == right.ModelProfileID &&
		left.ContainerName == right.ContainerName && left.RequiredImageID == right.RequiredImageID &&
		left.RequiredImageDigest == right.RequiredImageDigest && left.RequiredConfigDigest == right.RequiredConfigDigest &&
		left.MaintenanceGeneration == right.MaintenanceGeneration && sameProtectedTarget(left, right)
}

func validPreviousTransitionTarget(previous ExclusiveDrainTarget, desired ExclusiveDrainTarget) bool {
	if !IsProtectedPlacement(previous.PlacementClass) || previous.WorkerID != desired.WorkerID ||
		previous.ContainerName != desired.ContainerName || previous.StageOrder != desired.StageOrder ||
		previous.MaintenanceGeneration < 1 || previous.MaintenanceGeneration > desired.MaintenanceGeneration ||
		!uuidPattern.MatchString(previous.ModelProfileID) || !policyIDPattern.MatchString(previous.RequiredImageID) ||
		!imagePattern.MatchString(previous.RequiredImageDigest) || !policyIDPattern.MatchString(previous.RequiredConfigDigest) ||
		(previous.RequiredStartSpecDigest != "" && !policyIDPattern.MatchString(previous.RequiredStartSpecDigest)) ||
		len(previous.DependsOnWorkerIDs) != len(desired.DependsOnWorkerIDs) || len(previous.DependentContainers) > 8 {
		return false
	}
	for index := range previous.DependsOnWorkerIDs {
		if previous.DependsOnWorkerIDs[index] != desired.DependsOnWorkerIDs[index] {
			return false
		}
	}
	for _, dependent := range previous.DependentContainers {
		if dependent.ContainerName == "" || !policyIDPattern.MatchString(dependent.RequiredImageID) ||
			!imagePattern.MatchString(dependent.RequiredImageDigest) || !policyIDPattern.MatchString(dependent.RequiredConfigDigest) {
			return false
		}
	}
	return true
}

func (c *ProtectedSetTransitionCoordinator) migrationTargetForWorker(workerID string) (LegacyProtectedSetMigrationTarget, bool) {
	if c.policy.LegacyProtectedSetMigration == nil {
		return LegacyProtectedSetMigrationTarget{}, false
	}
	for _, target := range c.policy.LegacyProtectedSetMigration.Targets {
		if target.DesiredWorkerID == workerID {
			return target, true
		}
	}
	return LegacyProtectedSetMigrationTarget{}, false
}

func (c *ProtectedSetTransitionCoordinator) payloadMatchesMigrationPolicy(payload ProtectedSetTransitionPayload) bool {
	migration := c.policy.LegacyProtectedSetMigration
	legacyCount := 0
	for _, change := range payload.Targets {
		if change.LegacyPreviousTarget != nil {
			legacyCount++
		}
	}
	if legacyCount == 0 {
		if payload.MigrationPlanID != "" || payload.MigrationPlanDigest != "" {
			return false
		}
		for _, change := range payload.Targets {
			if change.LegacyPreviousTarget != nil || !c.validCanonicalCompanions(change) {
				return false
			}
		}
		if payload.FaultInjection == nil {
			return payload.QualificationID == "" && payload.QualificationDigest == ""
		}
		qualification := c.policy.ProtectedSetQualification
		if qualification == nil || payload.QualificationID != qualification.QualificationID ||
			payload.QualificationDigest != qualification.SourceDigest || payload.SetID != qualification.SetID ||
			!stableJSONEqual(*payload.FaultInjection, qualification.FaultInjection) {
			return false
		}
		for _, change := range payload.Targets {
			// Canonical qualification is never a cold-boot or legacy authority:
			// every rollback identity must already be the exact desired identity.
			// A qualification policy therefore cannot double as migration authority.
			if change.PreviousTarget == nil || !targetIdentityEqual(*change.PreviousTarget, change.DesiredTarget) {
				return false
			}
		}
		return true
	}
	if migration == nil || payload.QualificationID != "" || payload.QualificationDigest != "" ||
		legacyCount != 6 || len(payload.Targets) != 6 || payload.MigrationPlanID != migration.PlanID ||
		payload.MigrationPlanDigest != migration.SourceDigest || payload.SetID != migration.SetID ||
		(payload.FaultInjection != nil && !stableJSONEqual(*payload.FaultInjection, migration.FaultInjection)) {
		return false
	}
	for _, change := range payload.Targets {
		expected, exists := c.migrationTargetForWorker(change.DesiredWorker.WorkerID)
		if !exists || change.PreviousTarget != nil || change.LegacyPreviousTarget == nil ||
			expected.TargetKey != change.DesiredTarget.TargetKey || expected.DesiredStartSpecDigest != WorkerStartSpecDigest(change.DesiredWorker) ||
			!stableJSONEqual(expected.LegacyPreviousTarget, *change.LegacyPreviousTarget) ||
			!stableJSONEqual(expected.DesiredCompanions, change.DesiredCompanions) {
			return false
		}
	}
	return true
}

// A normal update binds the full companion create specification to the local
// target policy, just as RequiredStartSpecDigest binds the Worker. It does not
// borrow the authority of an old migration plan.
func (c *ProtectedSetTransitionCoordinator) validCanonicalCompanions(change ProtectedSetTransitionTarget) bool {
	if len(change.DesiredCompanions) == 0 {
		// Existing maintenance can retain companions without creating them.
		return true
	}
	if len(change.DesiredCompanions) != len(change.DesiredTarget.DependentContainers) {
		return false
	}
	for index, spec := range change.DesiredCompanions {
		expected := change.DesiredTarget.DependentContainers[index]
		if !validCompanionStart(spec, c.policy.AllowedPublishedPorts) || spec.ParentWorkerID != change.DesiredTarget.WorkerID ||
			spec.ContainerName != expected.ContainerName || spec.RequiredImageID != expected.RequiredImageID ||
			spec.Image != expected.RequiredImageDigest || spec.ConfigDigest != expected.RequiredConfigDigest ||
			!stableJSONEqual(spec.RequiredLabels, expected.RequiredLabels) ||
			expected.RequiredStartSpecDigest != canonicalPolicyDigest(spec) {
			return false
		}
	}
	return true
}

func (c *ProtectedSetTransitionCoordinator) payloadMatchesCurrentPolicy(payload ProtectedSetTransitionPayload) bool {
	configured := c.policy.ProtectedTargetsDependencyOrder()
	if len(configured) != len(payload.Targets) || len(payload.WorkerIDs) != len(configured) {
		return false
	}
	for index := range configured {
		if payload.WorkerIDs[index] != configured[index].WorkerID ||
			!sameProtectedTarget(configured[index], payload.Targets[index].DesiredTarget) {
			return false
		}
	}
	return c.payloadMatchesMigrationPolicy(payload)
}

func (c *ProtectedSetTransitionCoordinator) validatePayload(payload ProtectedSetTransitionPayload, ownership Ownership, now time.Time) error {
	if ownership.NodeID != c.nodeID || ownership.NodeGeneration != c.nodeGeneration ||
		!uuidPattern.MatchString(ownership.CommandID) || ownership.FencingToken == 0 ||
		!uuidPattern.MatchString(payload.TransactionID) || payload.TransactionID != ownership.LeaseID ||
		!modelAliasPattern.MatchString(payload.SetID) || payload.DesiredStateRevision < 1 ||
		payload.MaintenanceGeneration < 1 || payload.JournalRevision < 1 ||
		ownership.FencingToken != uint64(payload.JournalRevision) || payload.IssuedAt.After(now.Add(time.Second)) ||
		!payload.IssuedAt.Before(payload.ExpiresAt) || payload.ExpiresAt.Sub(payload.IssuedAt) > protectedMaintenanceMaximumWindow ||
		!payload.ExpiresAt.After(now) {
		return fmt.Errorf("protected_set_transition_identity_invalid")
	}
	if len(payload.AllowedOperations) != 1 || payload.AllowedOperations[0] != ProtectedSetTransition {
		return fmt.Errorf("protected_set_transition_operations_invalid")
	}
	expectedOperations := []string{ProtectedTransitionInspect, ProtectedTransitionStage, ProtectedTransitionVerify, ProtectedTransitionCommit}
	if len(payload.OperationOrder) != len(expectedOperations) {
		return fmt.Errorf("protected_set_transition_operations_invalid")
	}
	for index, expected := range expectedOperations {
		if payload.OperationOrder[index] != expected {
			return fmt.Errorf("protected_set_transition_operations_invalid")
		}
	}
	configured := c.policy.ProtectedTargetsDependencyOrder()
	if len(configured) == 0 || len(payload.Targets) != len(configured) || len(payload.WorkerIDs) != len(configured) {
		return fmt.Errorf("protected_set_transition_set_drift")
	}
	seenWorkers := map[string]bool{}
	for index, change := range payload.Targets {
		desired := change.DesiredTarget
		worker := change.DesiredWorker
		if desired.MaintenanceGeneration != payload.MaintenanceGeneration || configured[index].MaintenanceGeneration != payload.MaintenanceGeneration {
			return fmt.Errorf("protected_set_transition_generation_drift")
		}
		if !sameProtectedTarget(configured[index], desired) || payload.WorkerIDs[index] != desired.WorkerID ||
			seenWorkers[desired.WorkerID] || c.policy.ValidateStart(worker) != nil ||
			worker.WorkerID != desired.WorkerID || worker.ModelProfileID != desired.ModelProfileID ||
			worker.Image != desired.RequiredImageDigest || worker.ConfigDigest != desired.RequiredConfigDigest ||
			worker.MaintenanceGeneration != desired.MaintenanceGeneration || !IsProtectedPlacement(worker.PlacementClass) ||
			(desired.RequiredStartSpecDigest != "" && desired.RequiredStartSpecDigest != WorkerStartSpecDigest(worker)) {
			return fmt.Errorf("protected_set_transition_set_drift")
		}
		if change.LegacyPreviousTarget != nil && (desired.ContainerName != "teamaibox-worker-"+desired.WorkerID ||
			desired.RequiredStartSpecDigest == "" || desired.RequiredStartSpecDigest != WorkerStartSpecDigest(worker)) {
			return fmt.Errorf("protected_set_transition_set_drift")
		}
		seenWorkers[desired.WorkerID] = true
		if change.PreviousTarget != nil && change.LegacyPreviousTarget != nil {
			return fmt.Errorf("protected_set_transition_prior_identity_invalid")
		}
		if change.PreviousTarget != nil && !validPreviousTransitionTarget(*change.PreviousTarget, desired) {
			return fmt.Errorf("protected_set_transition_prior_identity_invalid")
		}
	}
	if !c.payloadMatchesMigrationPolicy(payload) {
		return fmt.Errorf("protected_set_transition_migration_plan_drift")
	}
	if c.journal == nil {
		return nil
	}
	if c.journal.Phase != "complete" && c.journal.Phase != "recovered" {
		return fmt.Errorf("protected_set_transition_recovery_incomplete")
	}
	if payload.JournalRevision <= c.journal.Payload.JournalRevision ||
		payload.MaintenanceGeneration < c.journal.Payload.MaintenanceGeneration ||
		payload.MaintenanceGeneration > c.journal.Payload.MaintenanceGeneration+1 ||
		payload.DesiredStateRevision <= c.journal.Payload.DesiredStateRevision {
		return fmt.Errorf("protected_set_transition_generation_drift")
	}
	return nil
}

func validProtectedSetTransitionJournal(journal protectedSetTransitionJournal, nodeID string, nodeGeneration int64) bool {
	if journal.SchemaVersion != protectedSetTransitionJournalSchema || journal.NodeID != nodeID || journal.NodeGeneration != nodeGeneration ||
		!sha256Pattern.MatchString(journal.CommandDigest) || protectedSetTransitionPlanDigest(journal.Payload) != journal.PlanDigest ||
		!uuidPattern.MatchString(journal.Payload.TransactionID) || !modelAliasPattern.MatchString(journal.Payload.SetID) ||
		journal.Payload.DesiredStateRevision < 1 || journal.Payload.MaintenanceGeneration < 1 || journal.Payload.JournalRevision < 1 ||
		!journal.Payload.IssuedAt.Before(journal.Payload.ExpiresAt) ||
		journal.Payload.ExpiresAt.Sub(journal.Payload.IssuedAt) > protectedMaintenanceMaximumWindow ||
		journal.NextOperation < 0 || journal.NextOperation > len(journal.Payload.Targets) || journal.UpdatedAt.IsZero() ||
		len(journal.Payload.Targets) == 0 || len(journal.Payload.WorkerIDs) != len(journal.Payload.Targets) {
		return false
	}
	expectedOperations := []string{ProtectedTransitionInspect, ProtectedTransitionStage, ProtectedTransitionVerify, ProtectedTransitionCommit}
	if len(journal.Payload.AllowedOperations) != 1 || journal.Payload.AllowedOperations[0] != ProtectedSetTransition ||
		len(journal.Payload.OperationOrder) != len(expectedOperations) {
		return false
	}
	for index, operation := range journal.Payload.OperationOrder {
		if operation != expectedOperations[index] {
			return false
		}
	}
	for index, change := range journal.Payload.Targets {
		if journal.Payload.WorkerIDs[index] != change.DesiredTarget.WorkerID ||
			change.DesiredTarget.MaintenanceGeneration != journal.Payload.MaintenanceGeneration ||
			change.DesiredWorker.WorkerID != change.DesiredTarget.WorkerID {
			return false
		}
	}
	if journal.FaultInjectionConsumed {
		fault := journal.Payload.FaultInjection
		if fault == nil || journal.FaultInjectionStageOrder != fault.StageOrder ||
			journal.FaultInjectionTargetKey != fault.TargetKey || !journal.FaultInjectionAfterHealthy ||
			!validProtectedSetFaultInjection(*fault) || fault.StageOrder > len(journal.Payload.Targets) ||
			journal.Payload.Targets[fault.StageOrder-1].DesiredTarget.StageOrder != fault.StageOrder ||
			journal.Payload.Targets[fault.StageOrder-1].DesiredTarget.TargetKey != fault.TargetKey ||
			journal.FailureCode != fault.FailureCode ||
			(journal.Phase != "rolling_back" && journal.Phase != "recovery_required" && journal.Phase != "recovered") {
			return false
		}
	} else if journal.FaultInjectionStageOrder != 0 || journal.FaultInjectionTargetKey != "" || journal.FaultInjectionAfterHealthy {
		return false
	}
	if journal.Payload.FaultInjection != nil && !journal.FaultInjectionConsumed &&
		(journal.Phase == "verifying" || journal.Phase == "committed" ||
			journal.Phase == "cleaning" || journal.Phase == "complete") {
		return false
	}
	switch journal.Phase {
	case "prepared":
		return journal.NextOperation == 0 && journal.FailureCode == ""
	case "staging":
		return journal.NextOperation <= len(journal.Payload.Targets) && journal.FailureCode == ""
	case "verifying":
		return journal.NextOperation <= len(journal.Payload.Targets) && journal.FailureCode == ""
	case "committed", "cleaning":
		return journal.NextOperation <= len(journal.Payload.Targets) && journal.FailureCode == ""
	case "rolling_back":
		return journal.NextOperation <= len(journal.Payload.Targets) && journal.FailureCode != ""
	case "cleanup_required", "recovery_required":
		return journal.FailureCode != ""
	case "complete":
		return journal.NextOperation == 0 && journal.FailureCode == ""
	case "recovered":
		return journal.NextOperation == 0 && journal.FailureCode != ""
	default:
		return false
	}
}

func (c *ProtectedSetTransitionCoordinator) readJournal() (*protectedSetTransitionJournal, error) {
	info, err := os.Lstat(c.filename)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() < 2 || info.Size() > protectedSetTransitionMaximumBytes {
		return nil, fmt.Errorf("protected_set_transition_journal_invalid")
	}
	file, err := os.Open(c.filename)
	if err != nil {
		return nil, fmt.Errorf("protected_set_transition_journal_invalid")
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, protectedSetTransitionMaximumBytes))
	decoder.DisallowUnknownFields()
	var journal protectedSetTransitionJournal
	if err := decoder.Decode(&journal); err != nil {
		return nil, fmt.Errorf("protected_set_transition_journal_invalid")
	}
	// A completed journal is history, not permission to replay a previous
	// generation. Keep its bytes and revision unchanged across reconnects.
	valid := validProtectedSetTransitionJournal(journal, c.nodeID, c.nodeGeneration)
	if journal.NodeGeneration > 0 && journal.NodeGeneration < c.nodeGeneration &&
		(journal.Phase == "complete" || journal.Phase == "recovered") {
		valid = validProtectedSetTransitionJournal(journal, c.nodeID, journal.NodeGeneration)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) || !valid {
		return nil, fmt.Errorf("protected_set_transition_journal_invalid")
	}
	return &journal, nil
}

func (c *ProtectedSetTransitionCoordinator) writeJournal(journal protectedSetTransitionJournal) error {
	encoded, err := json.Marshal(journal)
	if err != nil || len(encoded) > protectedSetTransitionMaximumBytes {
		return fmt.Errorf("protected_set_transition_journal_invalid")
	}
	directory := filepath.Dir(c.filename)
	temporary, err := os.CreateTemp(directory, ".protected-set-transition-journal-")
	if err != nil {
		return fmt.Errorf("protected_set_transition_journal_write_failed")
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
		return fmt.Errorf("protected_set_transition_journal_write_failed")
	}
	if _, err := temporary.Write(append(encoded, '\n')); err != nil || temporary.Sync() != nil || temporary.Close() != nil {
		return fmt.Errorf("protected_set_transition_journal_write_failed")
	}
	if err := os.Rename(temporaryName, c.filename); err != nil {
		return fmt.Errorf("protected_set_transition_journal_write_failed")
	}
	committed = true
	c.journal = &journal
	directoryFile, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("protected_set_transition_journal_write_failed")
	}
	syncErr := directoryFile.Sync()
	closeErr := directoryFile.Close()
	if syncErr != nil || closeErr != nil {
		return fmt.Errorf("protected_set_transition_journal_write_failed")
	}
	return nil
}

func (c *ProtectedSetTransitionCoordinator) setPhase(journal *protectedSetTransitionJournal, phase string, next int, failure string, now time.Time) error {
	journal.Phase = phase
	journal.NextOperation = next
	journal.FailureCode = failure
	journal.UpdatedAt = now.UTC()
	return c.writeJournal(*journal)
}

func desiredWorkerStateMatches(state WorkerState, target ProtectedSetTransitionTarget) bool {
	return state.WorkerID == target.DesiredWorker.WorkerID && state.ModelProfileID == target.DesiredWorker.ModelProfileID &&
		state.Image == target.DesiredWorker.Image && state.ConfigDigest == target.DesiredWorker.ConfigDigest &&
		state.MaintenanceGeneration == target.DesiredWorker.MaintenanceGeneration && IsProtectedPlacement(state.PlacementClass) &&
		state.Status == "running" && state.Health == "healthy"
}

func (c *ProtectedSetTransitionCoordinator) rollback(ctx context.Context, journal *protectedSetTransitionJournal, ownership Ownership, now time.Time) error {
	failure := journal.FailureCode
	if failure == "" {
		failure = "protected_set_transition_interrupted"
	}
	if err := c.setPhase(journal, "rolling_back", len(journal.Payload.Targets), failure, now); err != nil {
		return err
	}
	for index := len(journal.Payload.Targets) - 1; index >= 0; index-- {
		if err := c.setPhase(journal, "rolling_back", index, failure, now); err != nil {
			return err
		}
		change := journal.Payload.Targets[index]
		if err := c.runtime.RollbackProtectedSetTransitionTarget(ctx, change, ownership,
			protectedTransitionBackupName(journal.Payload.TransactionID, change.DesiredTarget.WorkerID)); err != nil {
			_ = c.setPhase(journal, "recovery_required", index, "protected_set_transition_rollback_failed", now)
			return fmt.Errorf("protected_set_transition_recovery_incomplete")
		}
	}
	return c.setPhase(journal, "recovered", 0, failure, now)
}

func (c *ProtectedSetTransitionCoordinator) cleanupCommitted(ctx context.Context, journal *protectedSetTransitionJournal, ownership Ownership, now time.Time) error {
	if err := c.setPhase(journal, "cleaning", journal.NextOperation, "", now); err != nil {
		return err
	}
	for index := journal.NextOperation; index < len(journal.Payload.Targets); index++ {
		change := journal.Payload.Targets[index]
		if err := c.runtime.CommitProtectedSetTransitionTarget(ctx, change, ownership,
			protectedTransitionBackupName(journal.Payload.TransactionID, change.DesiredTarget.WorkerID)); err != nil {
			_ = c.setPhase(journal, "cleanup_required", index, "protected_set_transition_cleanup_failed", now)
			return fmt.Errorf("protected_set_transition_recovery_incomplete")
		}
		if err := c.setPhase(journal, "cleaning", index+1, "", now); err != nil {
			return err
		}
	}
	return c.setPhase(journal, "complete", 0, "", now)
}

// Recover never uses an expired authorization to perform a new cutover.  It
// either restores the exact prior set or, after the fsynced commit point,
// finishes deleting stopped rollback containers.  Both paths are idempotent.
func (c *ProtectedSetTransitionCoordinator) Recover(ctx context.Context, now time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.journal == nil || c.journal.Phase == "complete" || c.journal.Phase == "recovered" {
		return nil
	}
	if c.staleAuthority {
		return fmt.Errorf("protected_set_transition_authority_refresh_required")
	}
	if !c.payloadMatchesCurrentPolicy(c.journal.Payload) {
		return fmt.Errorf("protected_set_transition_set_drift")
	}
	ownership := Ownership{
		NodeID: c.nodeID, NodeGeneration: c.nodeGeneration, CommandID: c.journal.Payload.TransactionID,
		CommandDigest: c.journal.CommandDigest, LeaseID: c.journal.Payload.TransactionID,
		FencingToken: uint64(c.journal.Payload.JournalRevision),
	}
	if c.journal.Phase == "committed" || c.journal.Phase == "cleaning" || c.journal.Phase == "cleanup_required" {
		return c.cleanupCommitted(ctx, c.journal, ownership, now)
	}
	return c.rollback(ctx, c.journal, ownership, now)
}

func (c *ProtectedSetTransitionCoordinator) Execute(ctx context.Context, payload ProtectedSetTransitionPayload, ownership Ownership, commandDigest string, now time.Time) (ProtectedSetTransitionJournalState, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.staleAuthority {
		return ProtectedSetTransitionJournalState{}, fmt.Errorf("protected_set_transition_authority_refresh_required")
	}
	if err := c.validatePayload(payload, ownership, now); err != nil {
		if err.Error() == "protected_set_transition_generation_drift" && c.journal != nil && c.journal.NodeGeneration == c.nodeGeneration &&
			c.journal.CommandDigest == commandDigest && ownership.CommandDigest == commandDigest &&
			c.journal.PlanDigest == protectedSetTransitionPlanDigest(payload) && c.payloadMatchesCurrentPolicy(payload) {
			if c.journal.Phase == "complete" {
				return c.stateLocked(), nil
			}
			if c.journal.Phase == "recovered" && c.journal.FaultInjectionConsumed &&
				c.journal.Payload.FaultInjection != nil && c.journal.FailureCode == c.journal.Payload.FaultInjection.FailureCode {
				return ProtectedSetTransitionJournalState{}, fmt.Errorf("%s", c.journal.FailureCode)
			}
		}
		return ProtectedSetTransitionJournalState{}, err
	}
	if !sha256Pattern.MatchString(commandDigest) || ownership.CommandDigest != commandDigest {
		return ProtectedSetTransitionJournalState{}, fmt.Errorf("protected_set_transition_signature_binding_invalid")
	}
	for _, change := range payload.Targets {
		if err := c.runtime.InspectProtectedSetTransitionTarget(ctx, change,
			protectedTransitionBackupName(payload.TransactionID, change.DesiredTarget.WorkerID), false); err != nil {
			return ProtectedSetTransitionJournalState{}, fmt.Errorf("protected_set_transition_prior_identity_invalid")
		}
	}
	journal := &protectedSetTransitionJournal{
		SchemaVersion: protectedSetTransitionJournalSchema, NodeID: c.nodeID, NodeGeneration: c.nodeGeneration,
		CommandDigest: commandDigest, PlanDigest: protectedSetTransitionPlanDigest(payload), Payload: payload,
		Phase: "prepared", UpdatedAt: now.UTC(),
	}
	if err := c.writeJournal(*journal); err != nil {
		return ProtectedSetTransitionJournalState{}, err
	}
	for index, change := range payload.Targets {
		if err := c.setPhase(journal, "staging", index, "", now); err != nil {
			return ProtectedSetTransitionJournalState{}, err
		}
		state, err := c.runtime.StageProtectedSetTransitionTarget(ctx, change, ownership,
			protectedTransitionBackupName(payload.TransactionID, change.DesiredTarget.WorkerID))
		if err != nil || !desiredWorkerStateMatches(state, change) {
			// A real target start or health failure must remain distinguishable
			// from the plan-bound, stage-four after-health fault injection.  The
			// remote fault adapter treats only the latter as an expected result.
			journal.FailureCode = protectedSetTransitionTargetStageFailed
			_ = c.setPhase(journal, "rolling_back", index, journal.FailureCode, now)
			if rollbackErr := c.rollback(ctx, journal, ownership, now); rollbackErr != nil {
				return ProtectedSetTransitionJournalState{}, rollbackErr
			}
			return ProtectedSetTransitionJournalState{}, fmt.Errorf("%s", protectedSetTransitionTargetStageFailed)
		}
		if fault := payload.FaultInjection; fault != nil && fault.StageOrder == change.DesiredTarget.StageOrder &&
			fault.TargetKey == change.DesiredTarget.TargetKey && fault.InjectionPoint == legacyProtectedSetFaultInjectionPoint {
			// Reaching this branch proves Stage returned the exact desired healthy
			// Worker identity. Persist consumption and the health boundary before
			// beginning the complete reverse rollback.
			journal.FaultInjectionConsumed = true
			journal.FaultInjectionStageOrder = fault.StageOrder
			journal.FaultInjectionTargetKey = fault.TargetKey
			journal.FaultInjectionAfterHealthy = true
			journal.FailureCode = fault.FailureCode
			if err := c.setPhase(journal, "rolling_back", index, journal.FailureCode, now); err != nil {
				return ProtectedSetTransitionJournalState{}, err
			}
			if rollbackErr := c.rollback(ctx, journal, ownership, now); rollbackErr != nil {
				return ProtectedSetTransitionJournalState{}, rollbackErr
			}
			return ProtectedSetTransitionJournalState{}, fmt.Errorf("%s", fault.FailureCode)
		}
		if err := c.setPhase(journal, "staging", index+1, "", now); err != nil {
			return ProtectedSetTransitionJournalState{}, err
		}
	}
	for index, change := range payload.Targets {
		if err := c.setPhase(journal, "verifying", index, "", now); err != nil {
			return ProtectedSetTransitionJournalState{}, err
		}
		if err := c.runtime.InspectProtectedSetTransitionTarget(ctx, change,
			protectedTransitionBackupName(payload.TransactionID, change.DesiredTarget.WorkerID), true); err != nil {
			journal.FailureCode = "protected_set_transition_verify_failed"
			if rollbackErr := c.rollback(ctx, journal, ownership, now); rollbackErr != nil {
				return ProtectedSetTransitionJournalState{}, rollbackErr
			}
			return ProtectedSetTransitionJournalState{}, fmt.Errorf("protected_set_transition_verify_failed")
		}
	}
	if err := c.setPhase(journal, "committed", 0, "", now); err != nil {
		return ProtectedSetTransitionJournalState{}, err
	}
	if err := c.cleanupCommitted(ctx, journal, ownership, now); err != nil {
		return ProtectedSetTransitionJournalState{}, err
	}
	return c.stateLocked(), nil
}

func (c *ProtectedSetTransitionCoordinator) stateLocked() ProtectedSetTransitionJournalState {
	if c.journal == nil {
		return ProtectedSetTransitionJournalState{}
	}
	return ProtectedSetTransitionJournalState{
		TransactionID: c.journal.Payload.TransactionID, SetID: c.journal.Payload.SetID,
		DesiredStateRevision:  c.journal.Payload.DesiredStateRevision,
		MaintenanceGeneration: c.journal.Payload.MaintenanceGeneration,
		JournalRevision:       c.journal.Payload.JournalRevision, Phase: c.journal.Phase,
		NextOperation: c.journal.NextOperation, PlanDigest: c.journal.PlanDigest,
		FailureCode: c.journal.FailureCode, UpdatedAt: c.journal.UpdatedAt,
		FaultInjectionConsumed:     c.journal.FaultInjectionConsumed,
		FaultInjectionStageOrder:   c.journal.FaultInjectionStageOrder,
		FaultInjectionTargetKey:    c.journal.FaultInjectionTargetKey,
		FaultInjectionAfterHealthy: c.journal.FaultInjectionAfterHealthy,
	}
}

// Inspect reads one terminal, locally-authorized journal and asks the optional read-only
// runtime to re-check every Docker identity selected by that journal.  The
// caller cannot supply a target list or cause a recovery/mutation.
func (c *ProtectedSetTransitionCoordinator) Inspect(ctx context.Context, payload ProtectedSetTransitionInspectionPayload) (ProtectedSetTransitionInspection, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	legacyBound := c.journal != nil && c.journal.Payload.MigrationPlanID != ""
	qualificationBound := c.journal != nil && c.journal.Payload.QualificationID != ""
	if !uuidPattern.MatchString(payload.InspectionID) || !uuidPattern.MatchString(payload.TransactionID) ||
		(payload.Mode != "fault" && payload.Mode != "success") || c.journal == nil ||
		!c.payloadMatchesCurrentPolicy(c.journal.Payload) || payload.TransactionID != c.journal.Payload.TransactionID ||
		legacyBound == qualificationBound {
		return ProtectedSetTransitionInspection{}, fmt.Errorf("protected_set_transition_inspection_binding_invalid")
	}
	if legacyBound {
		migration := c.policy.LegacyProtectedSetMigration
		if migration == nil || payload.QualificationID != "" || payload.QualificationDigest != "" ||
			payload.MigrationPlanID != c.journal.Payload.MigrationPlanID ||
			payload.MigrationPlanDigest != c.journal.Payload.MigrationPlanDigest ||
			payload.MigrationPlanID != migration.PlanID || payload.MigrationPlanDigest != migration.SourceDigest {
			return ProtectedSetTransitionInspection{}, fmt.Errorf("protected_set_transition_inspection_binding_invalid")
		}
	} else {
		qualification := c.policy.ProtectedSetQualification
		if qualification == nil || payload.Mode != "fault" || payload.MigrationPlanID != "" || payload.MigrationPlanDigest != "" ||
			payload.QualificationID != c.journal.Payload.QualificationID ||
			payload.QualificationDigest != c.journal.Payload.QualificationDigest ||
			payload.QualificationID != qualification.QualificationID || payload.QualificationDigest != qualification.SourceDigest {
			return ProtectedSetTransitionInspection{}, fmt.Errorf("protected_set_transition_inspection_binding_invalid")
		}
	}
	requireDesired := payload.Mode == "success"
	if requireDesired {
		if c.journal.Phase != "complete" || c.journal.Payload.FaultInjection != nil ||
			c.journal.FaultInjectionConsumed || c.journal.FailureCode != "" {
			return ProtectedSetTransitionInspection{}, fmt.Errorf("protected_set_transition_inspection_phase_invalid")
		}
	} else if c.journal.Phase != "recovered" || c.journal.Payload.FaultInjection == nil ||
		!c.journal.FaultInjectionConsumed || !c.journal.FaultInjectionAfterHealthy ||
		c.journal.FailureCode != c.journal.Payload.FaultInjection.FailureCode {
		return ProtectedSetTransitionInspection{}, fmt.Errorf("protected_set_transition_inspection_phase_invalid")
	}
	runtime, ok := c.runtime.(ProtectedSetTransitionInspectionRuntime)
	if !ok {
		return ProtectedSetTransitionInspection{}, fmt.Errorf("protected_set_transition_inspection_not_configured")
	}
	rollbackNames := make([]string, 0, len(c.journal.Payload.Targets))
	for _, change := range c.journal.Payload.Targets {
		rollbackNames = append(rollbackNames,
			protectedTransitionBackupName(c.journal.Payload.TransactionID, change.DesiredTarget.WorkerID))
	}
	targets, err := runtime.InspectProtectedSetTransitionRuntime(ctx, c.journal.Payload,
		rollbackNames, requireDesired)
	if err != nil || len(targets) != len(c.journal.Payload.Targets) {
		return ProtectedSetTransitionInspection{}, fmt.Errorf("protected_set_transition_inspection_runtime_drift")
	}
	rollback := []string{}
	runtimeState := "desired-exact"
	if !requireDesired {
		runtimeState = "legacy-exact"
		if qualificationBound {
			runtimeState = "canonical-exact"
		}
		for index := len(c.journal.Payload.Targets) - 1; index >= 0; index-- {
			rollback = append(rollback, c.journal.Payload.Targets[index].DesiredTarget.TargetKey)
		}
	}
	result := ProtectedSetTransitionInspection{
		SchemaVersion: 1, ReadOnly: true, MutationCount: 0,
		NodeID: c.nodeID, NodeGeneration: c.nodeGeneration,
		TransactionID: c.journal.Payload.TransactionID, SetID: c.journal.Payload.SetID,
		MigrationPlanID:     c.journal.Payload.MigrationPlanID,
		MigrationPlanDigest: c.journal.Payload.MigrationPlanDigest,
		QualificationID:     c.journal.Payload.QualificationID,
		QualificationDigest: c.journal.Payload.QualificationDigest,
		RuntimeState:        runtimeState, Journal: c.stateLocked(), Targets: targets,
		RollbackTargetKeys: rollback, CanonicalContainersRemaining: []string{},
		RollbackContainersRemaining: []string{}, TransitionHelpersRemaining: []string{},
		OOMKilled: false, RestartPersistenceObserved: false,
	}
	if legacyBound {
		result.SourceSetDigest = c.policy.LegacyProtectedSetMigration.SourceSetDigest
		result.DesiredSetDigest = c.policy.LegacyProtectedSetMigration.DesiredSetDigest
	} else {
		result.ProtectedTargetPolicyDigest = c.policy.ProtectedSetQualification.ProtectedTargetPolicyDigest
	}
	return result, nil
}

func (c *ProtectedSetTransitionCoordinator) BlocksOrdinaryMutation() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.journal != nil && c.journal.Phase != "complete" && c.journal.Phase != "recovered"
}
