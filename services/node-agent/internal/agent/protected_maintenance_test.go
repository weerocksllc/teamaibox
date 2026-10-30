package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	protectedWorkerA  = "00000000-0000-4000-8000-000000000811"
	protectedWorkerB  = "00000000-0000-4000-8000-000000000812"
	protectedProfileA = "00000000-0000-4000-8000-000000000821"
	protectedProfileB = "00000000-0000-4000-8000-000000000822"
)

func protectedTarget(key, worker, profile, suffix string, stageOrder int, dependencyWorkerIDs ...string) ExclusiveDrainTarget {
	return ExclusiveDrainTarget{
		TargetKey: key, WorkerID: worker, ModelProfileID: profile,
		ContainerName: "resident-worker-" + suffix, PlacementClass: PlacementProtectedResident,
		MaintenanceGeneration: 1,
		StageOrder:            stageOrder, DependsOnWorkerIDs: append([]string(nil), dependencyWorkerIDs...),
		RequiredImageID:      "sha256:" + strings.Repeat(suffix, 64),
		RequiredImageDigest:  "registry.local/resident-" + suffix + "@sha256:" + strings.Repeat(suffix, 64),
		RequiredConfigDigest: "sha256:" + strings.Repeat(suffix, 64),
		RequiredLabels:       map[string]string{"com.teamaibox.resident": suffix},
		DependentContainers: []ExclusiveDependentContainer{{
			ContainerName:        "resident-provider-" + suffix,
			RequiredImageID:      "sha256:" + strings.Repeat(string(suffix[0]+1), 64),
			RequiredImageDigest:  "registry.local/provider-" + suffix + "@sha256:" + strings.Repeat(string(suffix[0]+1), 64),
			RequiredConfigDigest: "sha256:" + strings.Repeat(string(suffix[0]+1), 64),
			RequiredLabels:       map[string]string{"com.teamaibox.companion": suffix},
		}},
	}
}

func protectedPolicy() (Policy, []ExclusiveDrainTarget) {
	targetA := protectedTarget("resident.alpha", protectedWorkerA, protectedProfileA, "a", 2, protectedWorkerB)
	targetB := protectedTarget("resident.beta", protectedWorkerB, protectedProfileB, "c", 1)
	policy := DefaultPolicy()
	policy.ExclusiveDrainTargets[targetA.TargetKey] = targetA
	policy.ExclusiveDrainTargets[targetB.TargetKey] = targetB
	return policy, []ExclusiveDrainTarget{targetA, targetB}
}

func protectedPayload(targets []ExclusiveDrainTarget, now time.Time) ProtectedMaintenancePayload {
	workers := make([]string, len(targets))
	for index, target := range targets {
		workers[index] = target.WorkerID
	}
	return ProtectedMaintenancePayload{
		TransactionID: leaseID, WorkerIDs: workers,
		AllowedOperations:     []string{ProtectedSetMaintenance},
		OperationOrder:        []string{ProtectedMaintenanceStop, ProtectedMaintenanceRestore, ProtectedMaintenanceVerify},
		MaintenanceGeneration: 1, IssuedAt: now.Add(-time.Second), ExpiresAt: now.Add(time.Minute),
		JournalRevision: 1, Targets: targets,
	}
}

func protectedOwnership(commandDigest string) Ownership {
	return Ownership{
		NodeID: nodeID, NodeGeneration: nodeGeneration,
		CommandID: "00000000-0000-4000-8000-000000000899", CommandDigest: commandDigest,
		LeaseID: leaseID, FencingToken: 1,
	}
}

type fakeProtectedMaintenanceRuntime struct {
	mu          sync.Mutex
	running     map[string]bool
	calls       []string
	stopEntered chan struct{}
	stopRelease chan struct{}
	restoreErr  bool
}

type disconnectedMaintenanceRuntime struct {
	*fakeProtectedMaintenanceRuntime
	cancel            context.CancelFunc
	stops             int
	recoveryDeadlines []time.Time
}

func (f *disconnectedMaintenanceRuntime) StopProtectedMaintenanceTarget(ctx context.Context, target ExclusiveDrainTarget) (ProtectedMaintenanceTargetState, error) {
	state, err := f.fakeProtectedMaintenanceRuntime.StopProtectedMaintenanceTarget(ctx, target)
	f.stops++
	if f.stops == 2 {
		f.cancel()
	}
	return state, err
}

func (f *disconnectedMaintenanceRuntime) RestoreProtectedMaintenanceTarget(ctx context.Context, target ExclusiveDrainTarget) (ProtectedMaintenanceTargetState, error) {
	if err := ctx.Err(); err != nil {
		return ProtectedMaintenanceTargetState{}, err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return ProtectedMaintenanceTargetState{}, context.DeadlineExceeded
	}
	f.recoveryDeadlines = append(f.recoveryDeadlines, deadline)
	return f.fakeProtectedMaintenanceRuntime.RestoreProtectedMaintenanceTarget(ctx, target)
}

func TestProtectedMaintenanceRestoresExactJournalAfterCallerDisconnect(t *testing.T) {
	policy, targets := protectedPolicy()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime := &disconnectedMaintenanceRuntime{fakeProtectedMaintenanceRuntime: newFakeProtectedMaintenanceRuntime(targets, true), cancel: cancel}
	coordinator := newProtectedCoordinator(t, policy, runtime, filepath.Join(t.TempDir(), "maintenance.json"))
	digest := strings.Repeat("d", 64)
	state, err := coordinator.Execute(ctx, protectedPayload(targets, fixedNow), protectedOwnership(digest), digest, fixedNow)
	if err != nil || state.Phase != "complete" || coordinator.BlocksOrdinaryMutation() {
		t.Fatalf("disconnected caller stranded its authenticated prior set: state=%+v err=%v", state, err)
	}
	if ctx.Err() != context.Canceled || len(runtime.recoveryDeadlines) != len(targets) {
		t.Fatal("disconnect/recovery was not exercised")
	}
	for _, deadline := range runtime.recoveryDeadlines {
		if time.Until(deadline) <= 0 || time.Until(deadline) > protectedMaintenanceRecoveryBound {
			t.Fatal("recovery is not bounded")
		}
	}
	if err := coordinator.verifySet(context.Background(), targets, true); err != nil {
		t.Fatal(err)
	}

	// A canceled request that has not yet journaled or stopped anything cannot
	// use the safety restoration rule to initiate fresh maintenance.
	untouched := newFakeProtectedMaintenanceRuntime(targets, true)
	fresh := newProtectedCoordinator(t, policy, untouched, filepath.Join(t.TempDir(), "maintenance.json"))
	if _, err := fresh.Execute(ctx, protectedPayload(targets, fixedNow), protectedOwnership(digest), digest, fixedNow); err != context.Canceled {
		t.Fatal(err)
	}
	if len(untouched.recordedCalls()) != 0 || fresh.journal != nil {
		t.Fatal("canceled request mutated prior state")
	}
}

func newFakeProtectedMaintenanceRuntime(targets []ExclusiveDrainTarget, running bool) *fakeProtectedMaintenanceRuntime {
	states := map[string]bool{}
	for _, target := range targets {
		states[target.ContainerName] = running
		for _, dependency := range target.DependentContainers {
			states[dependency.ContainerName] = running
		}
	}
	return &fakeProtectedMaintenanceRuntime{running: states}
}

func maintenanceConflictState(key, container string, running bool) ExclusiveConflictState {
	state := "exited"
	if running {
		state = "running"
	}
	return ExclusiveConflictState{WorkerID: key, ContainerName: container, State: state, Health: "healthy", WasRunning: running, LeasesReleased: !running}
}

func (f *fakeProtectedMaintenanceRuntime) InspectProtectedMaintenanceTarget(_ context.Context, target ExclusiveDrainTarget) (ProtectedMaintenanceTargetState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	dependencies := make([]ExclusiveConflictState, 0, len(target.DependentContainers))
	for _, dependency := range target.DependentContainers {
		dependencies = append(dependencies, maintenanceConflictState("dependent", dependency.ContainerName, f.running[dependency.ContainerName]))
	}
	return ProtectedMaintenanceTargetState{
		Target:       maintenanceConflictState(target.TargetKey, target.ContainerName, f.running[target.ContainerName]),
		Dependencies: dependencies,
	}, nil
}

func (f *fakeProtectedMaintenanceRuntime) StopProtectedMaintenanceTarget(_ context.Context, target ExclusiveDrainTarget) (ProtectedMaintenanceTargetState, error) {
	if f.stopEntered != nil {
		select {
		case f.stopEntered <- struct{}{}:
		default:
		}
		<-f.stopRelease
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "stop:"+target.TargetKey)
	f.running[target.ContainerName] = false
	for _, dependency := range target.DependentContainers {
		f.running[dependency.ContainerName] = false
	}
	return ProtectedMaintenanceTargetState{Target: maintenanceConflictState(target.TargetKey, target.ContainerName, false)}, nil
}

func (f *fakeProtectedMaintenanceRuntime) RestoreProtectedMaintenanceTarget(_ context.Context, target ExclusiveDrainTarget) (ProtectedMaintenanceTargetState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "restore:"+target.TargetKey)
	if f.restoreErr {
		return ProtectedMaintenanceTargetState{}, context.DeadlineExceeded
	}
	f.running[target.ContainerName] = true
	dependencies := make([]ExclusiveConflictState, 0, len(target.DependentContainers))
	for _, dependency := range target.DependentContainers {
		f.running[dependency.ContainerName] = true
		dependencies = append(dependencies, maintenanceConflictState("dependent", dependency.ContainerName, true))
	}
	return ProtectedMaintenanceTargetState{Target: maintenanceConflictState(target.TargetKey, target.ContainerName, true), Dependencies: dependencies}, nil
}

func (f *fakeProtectedMaintenanceRuntime) recordedCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func newProtectedCoordinator(t *testing.T, policy Policy, runtime ProtectedMaintenanceRuntime, filename string) *ProtectedMaintenanceCoordinator {
	t.Helper()
	coordinator, err := NewProtectedMaintenanceCoordinator(nodeID, nodeGeneration, filename, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	return coordinator
}

func TestProtectedMaintenanceTransactionBindsExactSetAndRestoresInReverseOrder(t *testing.T) {
	policy, targets := protectedPolicy()
	runtime := newFakeProtectedMaintenanceRuntime(targets, true)
	filename := filepath.Join(t.TempDir(), "protected-maintenance.json")
	coordinator := newProtectedCoordinator(t, policy, runtime, filename)
	payload := protectedPayload(targets, fixedNow)
	if err := coordinator.validatePayload(payload, protectedOwnership(strings.Repeat("d", 64)), payload.ExpiresAt); err == nil || err.Error() != "protected_maintenance_identity_invalid" {
		t.Fatalf("maintenance was accepted at the exact expiry boundary: %v", err)
	}
	commandDigest := strings.Repeat("d", 64)
	state, err := coordinator.Execute(context.Background(), payload, protectedOwnership(commandDigest), commandDigest, fixedNow)
	if err != nil || state.Phase != "complete" || state.TransactionID != leaseID || state.MaintenanceGeneration != 1 || state.JournalRevision != 1 {
		t.Fatalf("protected maintenance transaction failed: %#v %v", state, err)
	}
	want := []string{"stop:resident.alpha", "stop:resident.beta", "restore:resident.beta", "restore:resident.alpha"}
	if got := runtime.recordedCalls(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("maintenance order drifted: got %v want %v", got, want)
	}
	info, err := os.Stat(filename)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("journal is not crash-safe owner-only state: %#v %v", info, err)
	}
	reloaded := newProtectedCoordinator(t, policy, runtime, filename)
	if reloaded.BlocksOrdinaryMutation() {
		t.Fatal("a complete verified transaction blocked ordinary non-protected work")
	}
	beforeReplay := runtime.recordedCalls()
	replayed, err := reloaded.Execute(context.Background(), payload, protectedOwnership(commandDigest), commandDigest, fixedNow.Add(time.Second))
	if err != nil || replayed.Phase != "complete" {
		t.Fatalf("exact completed transaction replay failed: %#v %v", replayed, err)
	}
	if got := runtime.recordedCalls(); strings.Join(got, ",") != strings.Join(beforeReplay, ",") {
		t.Fatalf("exact completed replay repeated runtime mutation: before %v after %v", beforeReplay, got)
	}
	successorPolicy := DefaultPolicy()
	for key, target := range policy.ExclusiveDrainTargets {
		target.MaintenanceGeneration = 2
		successorPolicy.ExclusiveDrainTargets[key] = target
	}
	successorCoordinator := newProtectedCoordinator(t, successorPolicy, runtime, filename)
	if _, err := successorCoordinator.Execute(context.Background(), payload, protectedOwnership(commandDigest), commandDigest, fixedNow.Add(time.Second)); err == nil || err.Error() != "protected_maintenance_generation_drift" {
		t.Fatalf("completed replay ignored current policy generation drift: %v", err)
	}

	next := protectedPayload(targets, fixedNow.Add(2*time.Minute))
	next.JournalRevision = 2
	nextOwnership := protectedOwnership(strings.Repeat("d", 64))
	nextOwnership.FencingToken = 2
	if err := reloaded.validatePayload(next, nextOwnership, fixedNow.Add(2*time.Minute)); err != nil {
		t.Fatalf("next exact generation was rejected: %v", err)
	}
	next.MaintenanceGeneration = 2
	if err := reloaded.validatePayload(next, nextOwnership, fixedNow.Add(2*time.Minute)); err == nil || err.Error() != "protected_maintenance_generation_drift" {
		t.Fatalf("generation drift was accepted: %v", err)
	}
}

func TestProtectedMaintenanceUsesNodeWideFenceWithGapsAndRejectsStaleAfterRestart(t *testing.T) {
	policy, targets := protectedPolicy()
	runtime := newFakeProtectedMaintenanceRuntime(targets, true)
	filename := filepath.Join(t.TempDir(), "maintenance.json")
	coordinator := newProtectedCoordinator(t, policy, runtime, filename)
	payload := protectedPayload(targets, fixedNow)
	payload.JournalRevision = 574 // ordinary node work consumed earlier tokens
	digest := strings.Repeat("b", 64)
	ownership := protectedOwnership(digest)
	ownership.FencingToken = 574
	state, err := coordinator.Execute(context.Background(), payload, ownership, digest, fixedNow)
	if err != nil || state.JournalRevision != 574 || state.Phase != "complete" {
		t.Fatalf("first authenticated node-wide fence rejected: %#v %v", state, err)
	}
	reloaded := newProtectedCoordinator(t, policy, runtime, filename)
	before := len(runtime.recordedCalls())
	for _, revision := range []int64{1, 573, 574} {
		stale := payload
		stale.JournalRevision = revision
		staleOwnership := ownership
		staleOwnership.FencingToken = uint64(revision)
		// A different command digest cannot claim the exact replay exception.
		if _, err := reloaded.Execute(context.Background(), stale, staleOwnership, strings.Repeat("c", 64), fixedNow); err == nil || err.Error() != "protected_maintenance_generation_drift" {
			t.Fatalf("stale/equal fence %d accepted: %v", revision, err)
		}
	}
	if len(runtime.recordedCalls()) != before {
		t.Fatal("rejected stale fence mutated a worker")
	}
	next := payload
	next.JournalRevision = 590 // independent node leases introduce another gap
	nextOwnership := ownership
	nextOwnership.FencingToken = 590
	if err := reloaded.validatePayload(next, nextOwnership, fixedNow); err != nil {
		t.Fatalf("strictly newer authenticated node-wide fence rejected: %v", err)
	}
	nextOwnership.FencingToken = 591
	if err := reloaded.validatePayload(next, nextOwnership, fixedNow); err == nil || err.Error() != "protected_maintenance_identity_invalid" {
		t.Fatalf("payload/envelope fence mismatch accepted: %v", err)
	}
}

func TestProtectedMaintenanceRecoveryIgnoresExpiryButRejectsSetDrift(t *testing.T) {
	policy, targets := protectedPolicy()
	runtime := newFakeProtectedMaintenanceRuntime(targets, false)
	directory := t.TempDir()
	filename := filepath.Join(directory, "protected-maintenance.json")
	coordinator := newProtectedCoordinator(t, policy, runtime, filename)
	payload := protectedPayload(targets, fixedNow)
	journal := protectedMaintenanceJournal{
		SchemaVersion: protectedMaintenanceJournalSchema, NodeID: nodeID, NodeGeneration: nodeGeneration,
		CommandDigest: strings.Repeat("e", 64), PlanDigest: protectedMaintenancePlanDigest(payload), Payload: payload,
		Phase: "stopped", NextOperation: len(targets), UpdatedAt: fixedNow,
	}
	if err := coordinator.writeJournal(journal); err != nil {
		t.Fatal(err)
	}
	reloaded := newProtectedCoordinator(t, policy, runtime, filename)
	if !reloaded.BlocksOrdinaryMutation() {
		t.Fatal("an incomplete recovery did not fail closed")
	}
	if err := reloaded.Recover(context.Background(), fixedNow.Add(24*time.Hour)); err != nil {
		t.Fatalf("expired authenticated recovery was not resumed: %v", err)
	}
	want := []string{"restore:resident.beta", "restore:resident.alpha"}
	if got := runtime.recordedCalls(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("crash recovery order drifted: got %v want %v", got, want)
	}
	if reloaded.BlocksOrdinaryMutation() || reloaded.stateLocked().Phase != "recovered" {
		t.Fatalf("successful recovery did not close the journal: %#v", reloaded.stateLocked())
	}

	// An incomplete journal can never be applied to a different protected set.
	runtime2 := newFakeProtectedMaintenanceRuntime(targets, false)
	coordinator2 := newProtectedCoordinator(t, policy, runtime2, filepath.Join(directory, "drift.json"))
	if err := coordinator2.writeJournal(journal); err != nil {
		t.Fatal(err)
	}
	drifted := policy
	target := drifted.ExclusiveDrainTargets[targets[0].TargetKey]
	target.RequiredConfigDigest = "sha256:" + strings.Repeat("f", 64)
	drifted.ExclusiveDrainTargets[targets[0].TargetKey] = target
	driftedCoordinator := newProtectedCoordinator(t, drifted, runtime2, filepath.Join(directory, "drift.json"))
	if err := driftedCoordinator.Recover(context.Background(), fixedNow); err == nil || err.Error() != "protected_maintenance_set_drift" {
		t.Fatalf("incomplete recovery accepted protected set drift: %v", err)
	}
}

func TestProtectedMaintenanceJournalAndInitialGenerationFailClosed(t *testing.T) {
	policy, targets := protectedPolicy()
	runtime := newFakeProtectedMaintenanceRuntime(targets, true)
	directory := t.TempDir()
	filename := filepath.Join(directory, "protected-maintenance.json")
	coordinator := newProtectedCoordinator(t, policy, runtime, filename)
	payload := protectedPayload(targets, fixedNow)
	payload.MaintenanceGeneration = 2
	if err := coordinator.validatePayload(payload, protectedOwnership(strings.Repeat("a", 64)), fixedNow); err == nil || err.Error() != "protected_maintenance_generation_drift" {
		t.Fatalf("unanchored initial generation was accepted: %v", err)
	}

	payload = protectedPayload(targets, fixedNow)
	payload.OperationOrder[0], payload.OperationOrder[1] = payload.OperationOrder[1], payload.OperationOrder[0]
	journal := protectedMaintenanceJournal{
		SchemaVersion: protectedMaintenanceJournalSchema, NodeID: nodeID, NodeGeneration: nodeGeneration,
		CommandDigest: strings.Repeat("a", 64), PlanDigest: protectedMaintenancePlanDigest(payload), Payload: payload,
		Phase: "stopped", NextOperation: 1, UpdatedAt: fixedNow,
	}
	encoded, err := json.Marshal(journal)
	if err != nil || os.WriteFile(filename, append(encoded, '\n'), 0o600) != nil {
		t.Fatal(err)
	}
	if _, err := NewProtectedMaintenanceCoordinator(nodeID, nodeGeneration, filename, policy, runtime); err == nil || err.Error() != "protected_maintenance_journal_invalid" {
		t.Fatalf("structurally invalid journal was accepted: %v", err)
	}
}

func TestCompletedMaintenanceSurvivesNodeReconnectWithoutReplay(t *testing.T) {
	policy, targets := protectedPolicy()
	for _, phase := range []string{"complete", "recovered", "stopped", "restoring"} {
		runtime := newFakeProtectedMaintenanceRuntime(targets, true)
		filename := filepath.Join(t.TempDir(), "maintenance.json")
		payload := protectedPayload(targets, fixedNow)
		journal := protectedMaintenanceJournal{SchemaVersion: protectedMaintenanceJournalSchema,
			NodeID: nodeID, NodeGeneration: nodeGeneration, CommandDigest: strings.Repeat("a", 64),
			PlanDigest: protectedMaintenancePlanDigest(payload), Payload: payload,
			Phase: phase, NextOperation: 0, UpdatedAt: fixedNow}
		if phase == "stopped" {
			journal.NextOperation = len(targets)
		}
		encoded, _ := json.Marshal(journal)
		if err := os.WriteFile(filename, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
		c, err := NewProtectedMaintenanceCoordinator(nodeID, nodeGeneration+1, filename, policy, runtime)
		if phase != "complete" && phase != "recovered" {
			if err == nil {
				t.Fatal("incomplete prior generation was accepted")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if err = c.Recover(context.Background(), fixedNow); err != nil {
			t.Fatal(err)
		}
		after, _ := os.ReadFile(filename)
		if !bytes.Equal(encoded, after) {
			t.Fatal("historical journal changed")
		}
		if len(runtime.calls) != 0 {
			t.Fatalf("historical maintenance replayed: %v", runtime.calls)
		}
	}
}

func TestProtectedMaintenancePolicyAndJournalPhaseDriftFailClosed(t *testing.T) {
	policy, targets := protectedPolicy()
	runtime := newFakeProtectedMaintenanceRuntime(targets, true)

	unknownDependency := DefaultPolicy()
	for key, configured := range policy.ExclusiveDrainTargets {
		unknownDependency.ExclusiveDrainTargets[key] = configured
	}
	target := unknownDependency.ExclusiveDrainTargets[targets[0].TargetKey]
	target.DependsOnWorkerIDs = []string{"00000000-0000-4000-8000-000000000899"}
	unknownDependency.ExclusiveDrainTargets[target.TargetKey] = target
	if _, err := NewProtectedMaintenanceCoordinator(nodeID, nodeGeneration,
		filepath.Join(t.TempDir(), "protected-maintenance.json"), unknownDependency, runtime); err == nil || err.Error() != "protected_maintenance_policy_invalid" {
		t.Fatalf("unknown protected dependency was accepted: %v", err)
	}

	directory := t.TempDir()
	filename := filepath.Join(directory, "protected-maintenance.json")
	payload := protectedPayload(targets, fixedNow)
	journal := protectedMaintenanceJournal{
		SchemaVersion: protectedMaintenanceJournalSchema, NodeID: nodeID, NodeGeneration: nodeGeneration,
		CommandDigest: strings.Repeat("a", 64), PlanDigest: protectedMaintenancePlanDigest(payload), Payload: payload,
		Phase: "complete", NextOperation: len(targets), UpdatedAt: fixedNow,
	}
	encoded, err := json.Marshal(journal)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewProtectedMaintenanceCoordinator(nodeID, nodeGeneration, filename, policy, runtime); err == nil || err.Error() != "protected_maintenance_journal_invalid" {
		t.Fatalf("impossible complete journal phase was accepted: %v", err)
	}
}

func TestProtectedMaintenanceAuthorizationDriftFailsBeforeRuntime(t *testing.T) {
	policy, targets := protectedPolicy()
	runtime := newFakeProtectedMaintenanceRuntime(targets, true)
	coordinator := newProtectedCoordinator(t, policy, runtime, filepath.Join(t.TempDir(), "protected-maintenance.json"))
	commandDigest := strings.Repeat("b", 64)
	tests := map[string]func(*ProtectedMaintenancePayload){
		"oversized authorization window": func(payload *ProtectedMaintenancePayload) {
			payload.ExpiresAt = payload.IssuedAt.Add(protectedMaintenanceMaximumWindow + time.Second)
		},
		"expired authorization": func(payload *ProtectedMaintenancePayload) {
			payload.IssuedAt = fixedNow.Add(-2 * time.Minute)
			payload.ExpiresAt = fixedNow.Add(-time.Second)
		},
		"extra allowed operation": func(payload *ProtectedMaintenancePayload) {
			payload.AllowedOperations = append(payload.AllowedOperations, "worker.stop")
		},
		"operation order drift": func(payload *ProtectedMaintenancePayload) {
			payload.OperationOrder[0], payload.OperationOrder[1] = payload.OperationOrder[1], payload.OperationOrder[0]
		},
		"worker set order drift": func(payload *ProtectedMaintenancePayload) {
			payload.WorkerIDs[0], payload.WorkerIDs[1] = payload.WorkerIDs[1], payload.WorkerIDs[0]
		},
		"prior config identity drift": func(payload *ProtectedMaintenancePayload) {
			payload.Targets[0].RequiredConfigDigest = "sha256:" + strings.Repeat("9", 64)
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			payload := protectedPayload(targets, fixedNow)
			payload.Targets = append([]ExclusiveDrainTarget(nil), payload.Targets...)
			mutate(&payload)
			if _, err := coordinator.Execute(context.Background(), payload, protectedOwnership(commandDigest), commandDigest, fixedNow); err == nil {
				t.Fatal("drifted maintenance authorization was accepted")
			}
			if len(runtime.recordedCalls()) != 0 {
				t.Fatalf("authorization drift reached runtime mutation: %v", runtime.recordedCalls())
			}
		})
	}
	payload := protectedPayload(targets, fixedNow)
	driftedFence := protectedOwnership(commandDigest)
	driftedFence.FencingToken = 2
	if _, err := coordinator.Execute(context.Background(), payload, driftedFence, commandDigest, fixedNow); err == nil || err.Error() != "protected_maintenance_identity_invalid" {
		t.Fatalf("journal revision/fencing drift was accepted: %v", err)
	}
	if len(runtime.recordedCalls()) != 0 {
		t.Fatalf("fencing drift reached runtime mutation: %v", runtime.recordedCalls())
	}
}

func TestProtectedResidentStartRequiresTheExactStaticIdentity(t *testing.T) {
	policy, targets := protectedPolicy()
	target := targets[0]
	spec := validStart()
	spec.WorkerID = target.WorkerID
	spec.ModelProfileID = target.ModelProfileID
	spec.Image = target.RequiredImageDigest
	spec.Environment["TEAMAIBOX_MODEL_PROFILE_ID"] = target.ModelProfileID
	spec.PlacementClass = PlacementProtectedResident
	spec.MaintenanceGeneration = 1
	spec.ConfigDigest = target.RequiredConfigDigest
	target.RequiredStartSpecDigest = WorkerStartSpecDigest(spec)
	policy.ExclusiveDrainTargets[target.TargetKey] = target
	if err := policy.ValidateStart(spec); err != nil {
		t.Fatalf("exact protected start was rejected: %v", err)
	}
	cases := []struct {
		name string
		edit func(*WorkerStartPayload)
	}{
		{"ordinary class for reserved worker", func(value *WorkerStartPayload) {
			value.PlacementClass = PlacementWarmOptional
			value.MaintenanceGeneration = 0
			value.ConfigDigest = ""
		}},
		{"profile substitution", func(value *WorkerStartPayload) {
			value.ModelProfileID = profileID
			value.Environment["TEAMAIBOX_MODEL_PROFILE_ID"] = profileID
		}},
		{"image substitution", func(value *WorkerStartPayload) {
			value.Image = "registry.local/substitute@sha256:" + strings.Repeat("9", 64)
		}},
		{"config substitution", func(value *WorkerStartPayload) { value.ConfigDigest = "sha256:" + strings.Repeat("9", 64) }},
		{"missing generation", func(value *WorkerStartPayload) { value.MaintenanceGeneration = 0 }},
		{"start spec substitution", func(value *WorkerStartPayload) { value.Command = append(value.Command, "--drift") }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			changed := spec
			changed.Environment = map[string]string{}
			for key, value := range spec.Environment {
				changed.Environment[key] = value
			}
			testCase.edit(&changed)
			if err := policy.ValidateStart(changed); err == nil || err.Error() != "protected_resident_start_identity_denied" {
				t.Fatalf("protected identity drift was accepted: %v", err)
			}
		})
	}
	withoutStartDigest := target
	withoutStartDigest.RequiredStartSpecDigest = ""
	policy.ExclusiveDrainTargets[target.TargetKey] = withoutStartDigest
	if err := policy.ValidateStart(spec); err == nil || err.Error() != "protected_resident_start_identity_denied" {
		t.Fatalf("protected start without a bound start-spec digest was accepted: %v", err)
	}
	policy.ExclusiveDrainTargets[target.TargetKey] = target
	plugin := validPluginStart("compute-plugin")
	plugin.WorkerID = target.WorkerID
	if err := policy.ValidateStart(plugin); err == nil || err.Error() != "protected_resident_start_identity_denied" {
		t.Fatalf("plugin claimed a reserved protected Worker identity: %v", err)
	}
}

func TestEntrypointIsBoundedAndRestrictedToAnExactProtectedStart(t *testing.T) {
	ordinary := validStart()
	ordinary.Entrypoint = []string{"vllm"}
	if err := DefaultPolicy().ValidateStart(ordinary); err == nil || err.Error() != "worker_entrypoint_denied" {
		t.Fatalf("ordinary Worker supplied an entrypoint override: %v", err)
	}

	policy, _, workers := migrationPolicyFixture(t)
	spec := workers[0]
	target, found := policy.ProtectedTargetForWorker(spec.WorkerID)
	if !found || target.TargetKey != "office.embedding-qwen3" {
		t.Fatal("reviewed embedding target is missing")
	}
	spec.Entrypoint = []string{"vllm"}
	target.RequiredStartSpecDigest = WorkerStartSpecDigest(spec)
	policy.ExclusiveDrainTargets[target.TargetKey] = target
	if err := policy.ValidateStart(spec); err != nil {
		t.Fatalf("exact protected entrypoint was rejected: %v", err)
	}

	drifted := spec
	drifted.Entrypoint = append([]string(nil), spec.Entrypoint...)
	drifted.Entrypoint[0] = "python3"
	driftedTarget := target
	driftedTarget.RequiredStartSpecDigest = WorkerStartSpecDigest(drifted)
	policy.ExclusiveDrainTargets[driftedTarget.TargetKey] = driftedTarget
	if err := policy.ValidateStart(drifted); err == nil || err.Error() != "worker_entrypoint_denied" {
		t.Fatalf("digest-rebound protected entrypoint drift was accepted: %v", err)
	}
	if WorkerStartSpecDigest(spec) == WorkerStartSpecDigest(drifted) {
		t.Fatal("entrypoint drift was not bound by the WorkerStart spec digest")
	}
	policy.ExclusiveDrainTargets[target.TargetKey] = target

	invalid := []struct {
		name       string
		entrypoint []string
	}{
		{name: "empty element", entrypoint: []string{""}},
		{name: "too many elements", entrypoint: make([]string, 33)},
		{name: "oversized element", entrypoint: []string{strings.Repeat("x", 4097)}},
		{name: "NUL element", entrypoint: []string{"/opt/worker\x00shadow"}},
	}
	for _, testCase := range invalid {
		t.Run(testCase.name, func(t *testing.T) {
			changed := spec
			changed.Entrypoint = append([]string(nil), testCase.entrypoint...)
			if testCase.name == "too many elements" {
				for index := range changed.Entrypoint {
					changed.Entrypoint[index] = "/opt/worker"
				}
			}
			exactTarget := target
			exactTarget.RequiredStartSpecDigest = WorkerStartSpecDigest(changed)
			policy.ExclusiveDrainTargets[exactTarget.TargetKey] = exactTarget
			if err := policy.ValidateStart(changed); err == nil || err.Error() != "worker_entrypoint_invalid" {
				t.Fatalf("invalid protected entrypoint was accepted: %v", err)
			}
		})
	}
}

func TestOrdinaryWorkerStartCannotColdLoadAProtectedResident(t *testing.T) {
	policy, targets := protectedPolicy()
	target := targets[0]
	spec := validStart()
	spec.WorkerID = target.WorkerID
	spec.ModelProfileID = target.ModelProfileID
	spec.Image = target.RequiredImageDigest
	spec.Environment["TEAMAIBOX_MODEL_PROFILE_ID"] = target.ModelProfileID
	spec.PlacementClass = PlacementProtectedResident
	spec.MaintenanceGeneration = target.MaintenanceGeneration
	spec.ConfigDigest = target.RequiredConfigDigest
	target.RequiredStartSpecDigest = WorkerStartSpecDigest(spec)
	policy.ExclusiveDrainTargets[target.TargetKey] = target
	runtime := &fakeRuntime{}
	authenticator, err := NewAuthenticator(nodeID, map[string][]byte{"scheduler-a": testKey})
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(nodeID, nodeGeneration, authenticator, policy, runtime, &memoryEvents{})
	if err != nil {
		t.Fatal(err)
	}
	service.SetClock(func() time.Time { return fixedNow })
	command := envelope(t, "00000000-0000-4000-8000-000000000829", "worker.start", spec, 20)
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-protected-cold-start"))
	if err != nil || result.Status != "failed" || result.ErrorCode != "protected_resident_operation_denied" || runtime.starts != 0 {
		t.Fatalf("ordinary protected cold start reached runtime: %#v %v starts=%d", result, err, runtime.starts)
	}
}

type protectedServiceRuntime struct {
	*fakeRuntime
	*fakeProtectedMaintenanceRuntime
}

func TestSignedProtectedMaintenanceIsTheOnlyProtectedMutationPath(t *testing.T) {
	policy, targets := protectedPolicy()
	base := &fakeRuntime{}
	protected := newFakeProtectedMaintenanceRuntime(targets, true)
	runtime := &protectedServiceRuntime{fakeRuntime: base, fakeProtectedMaintenanceRuntime: protected}
	authenticator, err := NewAuthenticator(nodeID, map[string][]byte{"scheduler-a": testKey})
	if err != nil {
		t.Fatal(err)
	}
	events := &memoryEvents{}
	service, err := NewService(nodeID, nodeGeneration, authenticator, policy, runtime, events)
	if err != nil {
		t.Fatal(err)
	}
	service.SetClock(func() time.Time { return fixedNow })
	coordinator := newProtectedCoordinator(t, policy, protected, filepath.Join(t.TempDir(), "protected-maintenance.json"))
	if err := service.ConfigureProtectedMaintenance(coordinator); err != nil {
		t.Fatal(err)
	}
	payload := protectedPayload(targets, fixedNow)
	command := envelope(t, "00000000-0000-4000-8000-000000000831", "maintenance.transaction.execute", payload, 1)
	command.IssuedAt, command.DeadlineAt = payload.IssuedAt, payload.ExpiresAt
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-protected-maintenance"))
	if err != nil || result.Status != "succeeded" || !strings.Contains(string(result.Payload), `"phase":"complete"`) {
		t.Fatalf("signed exact maintenance transaction failed: %#v %v", result, err)
	}
	if len(events.events) != 1 || events.events[0].Type != "maintenance.protected_completed" || strings.Contains(string(events.events[0].Payload), "resident-provider") {
		t.Fatalf("protected completion event was missing or leaked configuration: %#v", events.events)
	}

	stop := envelope(t, "00000000-0000-4000-8000-000000000832", "worker.stop", WorkerStopPayload{WorkerID: protectedWorkerA, GracePeriodSeconds: 5}, 22)
	stopped, err := service.Handle(context.Background(), stop, proof(t, stop, "nonce-protected-stop"))
	if err != nil || stopped.Status != "failed" || stopped.ErrorCode != "protected_resident_operation_denied" || base.stops != 0 {
		t.Fatalf("ordinary protected stop reached the runtime: %#v %v stops=%d", stopped, err, base.stops)
	}
	request, _ := json.Marshal(map[string]any{
		"protocolVersion": 1, "type": "worker.unload.request", "workerId": protectedWorkerA,
		"leaseId": leaseID, "fencingToken": uint64(23),
	})
	control := envelope(t, "00000000-0000-4000-8000-000000000833", "worker.control", WorkerControlPayload{WorkerID: protectedWorkerA, Request: request}, 23)
	unloaded, err := service.Handle(context.Background(), control, proof(t, control, "nonce-protected-unload"))
	if err != nil || unloaded.Status != "failed" || unloaded.ErrorCode != "protected_resident_operation_denied" || base.workerControls != 0 {
		t.Fatalf("ordinary protected unload reached the runtime: %#v %v controls=%d", unloaded, err, base.workerControls)
	}
	drain := envelope(t, "00000000-0000-4000-8000-000000000834", "worker.conflict.drain", ExclusiveConflictWorkerPayload{
		ExclusiveJobID: "00000000-0000-4000-8000-000000000835", TargetKey: targets[0].TargetKey,
	}, 24)
	drained, err := service.Handle(context.Background(), drain, proof(t, drain, "nonce-protected-drain"))
	if err != nil || drained.Status != "failed" || drained.ErrorCode != "exclusive_drain_target_denied" || len(base.drained) != 0 {
		t.Fatalf("ordinary protected drain reached the runtime: %#v %v", drained, err)
	}
}

func TestProtectedMaintenanceSerializesOrdinaryWorkerCommands(t *testing.T) {
	policy, targets := protectedPolicy()
	base := &fakeRuntime{}
	protected := newFakeProtectedMaintenanceRuntime(targets, true)
	protected.stopEntered = make(chan struct{}, 1)
	protected.stopRelease = make(chan struct{})
	runtime := &protectedServiceRuntime{fakeRuntime: base, fakeProtectedMaintenanceRuntime: protected}
	authenticator, _ := NewAuthenticator(nodeID, map[string][]byte{"scheduler-a": testKey})
	service, _ := NewService(nodeID, nodeGeneration, authenticator, policy, runtime, &memoryEvents{})
	service.SetClock(func() time.Time { return fixedNow })
	coordinator := newProtectedCoordinator(t, policy, protected, filepath.Join(t.TempDir(), "protected-maintenance.json"))
	if err := service.ConfigureProtectedMaintenance(coordinator); err != nil {
		t.Fatal(err)
	}
	payload := protectedPayload(targets, fixedNow)
	maintenance := envelope(t, "00000000-0000-4000-8000-000000000841", "maintenance.transaction.execute", payload, 1)
	maintenance.IssuedAt, maintenance.DeadlineAt = payload.IssuedAt, payload.ExpiresAt
	maintenanceDone := make(chan struct{})
	go func() {
		_, _ = service.Handle(context.Background(), maintenance, proof(t, maintenance, "nonce-maintenance-gate"))
		close(maintenanceDone)
	}()
	<-protected.stopEntered

	ordinary := envelope(t, "00000000-0000-4000-8000-000000000842", "worker.start", validStart(), 32)
	ordinaryDone := make(chan struct{})
	go func() {
		_, _ = service.Handle(context.Background(), ordinary, proof(t, ordinary, "nonce-ordinary-gate"))
		close(ordinaryDone)
	}()
	select {
	case <-ordinaryDone:
		t.Fatal("ordinary mutation overlapped a protected maintenance transaction")
	case <-time.After(25 * time.Millisecond):
	}
	close(protected.stopRelease)
	select {
	case <-maintenanceDone:
	case <-time.After(time.Second):
		t.Fatal("protected maintenance did not finish")
	}
	select {
	case <-ordinaryDone:
	case <-time.After(time.Second):
		t.Fatal("ordinary command did not resume after verified restoration")
	}
	if base.starts != 1 {
		t.Fatalf("ordinary command did not execute exactly once after maintenance: %d", base.starts)
	}
}

func TestProtectedMaintenanceRevalidatesExpiryAfterWaitingForGate(t *testing.T) {
	policy, targets := protectedPolicy()
	base := &fakeRuntime{}
	protected := newFakeProtectedMaintenanceRuntime(targets, true)
	runtime := &protectedServiceRuntime{fakeRuntime: base, fakeProtectedMaintenanceRuntime: protected}
	authenticator, _ := NewAuthenticator(nodeID, map[string][]byte{"scheduler-a": testKey})
	service, _ := NewService(nodeID, nodeGeneration, authenticator, policy, runtime, &memoryEvents{})
	var clockNanos atomic.Int64
	clockNanos.Store(fixedNow.UnixNano())
	service.SetClock(func() time.Time { return time.Unix(0, clockNanos.Load()).UTC() })
	coordinator := newProtectedCoordinator(t, policy, protected, filepath.Join(t.TempDir(), "protected-maintenance.json"))
	if err := service.ConfigureProtectedMaintenance(coordinator); err != nil {
		t.Fatal(err)
	}
	payload := protectedPayload(targets, fixedNow)
	command := envelope(t, "00000000-0000-4000-8000-000000000851", "maintenance.transaction.execute", payload, 1)
	command.IssuedAt, command.DeadlineAt = payload.IssuedAt, payload.ExpiresAt

	// Hold an ordinary-operation reader so the already-authenticated
	// maintenance command must wait before it can acquire its exclusive gate.
	service.maintenanceGate.RLock()
	type outcome struct {
		result CommandResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-maintenance-expiry-gate"))
		done <- outcome{result: result, err: err}
	}()
	deadline := time.After(time.Second)
	for {
		service.mu.Lock()
		record, exists := service.commands[command.CommandID]
		service.mu.Unlock()
		if exists && record.inProgress {
			break
		}
		select {
		case <-deadline:
			service.maintenanceGate.RUnlock()
			t.Fatal("maintenance command did not reach the gate")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	clockNanos.Store(payload.ExpiresAt.Add(time.Second).UnixNano())
	service.maintenanceGate.RUnlock()

	select {
	case value := <-done:
		if value.err != nil || value.result.Status != "failed" || value.result.ErrorCode != "protected_maintenance_identity_invalid" {
			t.Fatalf("expired queued maintenance command did not fail closed: %#v %v", value.result, value.err)
		}
	case <-time.After(time.Second):
		t.Fatal("expired maintenance command did not return")
	}
	if calls := protected.recordedCalls(); len(calls) != 0 {
		t.Fatalf("expired queued maintenance reached runtime mutation: %v", calls)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(coordinator.filename), "protected-maintenance.json")); !os.IsNotExist(err) {
		t.Fatalf("expired queued maintenance created a journal: %v", err)
	}
}
