package agent

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProtectedTransitionReconnectRetainsHistoryWithoutReplayingOldAuthority(t *testing.T) {
	base, _ := protectedPolicy()
	policy, payload := qualificationTransition(base)
	runtime := &fakeProtectedSetTransitionRuntime{current: map[string]string{protectedWorkerA: "prior", protectedWorkerB: "prior"}}
	filename := filepath.Join(t.TempDir(), "transition.json")
	old, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration, filename, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("d", 64)
	if _, err = old.Execute(context.Background(), payload, transitionOwnership(digest), digest, fixedNow); err == nil || old.journal.Phase != "recovered" {
		t.Fatal("fixture did not recover", err)
	}
	before, _ := os.ReadFile(filename)
	runtime.calls = nil
	current, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration+1, filename, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	if err = current.Recover(context.Background(), fixedNow); err != nil {
		t.Fatal(err)
	}
	for _, generation := range []int64{nodeGeneration, nodeGeneration + 1} {
		owner := transitionOwnership(digest)
		owner.NodeGeneration = generation
		if _, err = current.Execute(context.Background(), payload, owner, digest, fixedNow); err == nil || err.Error() != "protected_set_transition_authority_refresh_required" {
			t.Fatal("old policy allowed a command", err)
		}
	}
	after, _ := os.ReadFile(filename)
	if !bytes.Equal(before, after) || len(runtime.calls) != 0 {
		t.Fatal("reconnect changed history or models")
	}
	// An unfinished operation must never be silently treated as history.
	j := *old.journal
	j.Phase = "recovery_required"
	j.FailureCode = "protected_set_transition_rollback_failed"
	if err = old.writeJournal(j); err != nil {
		t.Fatal(err)
	}
	if _, err = NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration+1, filename, policy, runtime); err == nil {
		t.Fatal("unfinished old generation journal accepted")
	}
}

func TestProtectedTransitionReconnectRejectsFutureOrWrongNodePolicy(t *testing.T) {
	for _, wrongNode := range []bool{false, true} {
		base, _ := protectedPolicy()
		policy, _ := qualificationTransition(base)
		if wrongNode {
			policy.ProtectedSetQualification.NodeID = leaseID
		} else {
			policy.ProtectedSetQualification.NodeGeneration++
		}
		if _, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration, filepath.Join(t.TempDir(), "journal.json"), policy, &fakeProtectedSetTransitionRuntime{}); err == nil {
			t.Fatal("invalid policy accepted")
		}
	}
}

type fakeProtectedSetTransitionRuntime struct {
	current      map[string]string
	calls        []string
	failStage    string
	failRollback string
}

func (f *fakeProtectedSetTransitionRuntime) InspectProtectedSetTransitionTarget(_ context.Context, change ProtectedSetTransitionTarget, _ string, requireDesired bool) error {
	state := f.current[change.DesiredTarget.WorkerID]
	if requireDesired && state != "desired" {
		return context.DeadlineExceeded
	}
	if !requireDesired {
		if change.LegacyPreviousTarget != nil && state != "prior" && state != "desired" {
			return context.DeadlineExceeded
		}
		if change.LegacyPreviousTarget == nil && change.PreviousTarget == nil && state != "absent" {
			return context.DeadlineExceeded
		}
		if change.LegacyPreviousTarget == nil && change.PreviousTarget != nil && state != "prior" && state != "desired" {
			return context.DeadlineExceeded
		}
	}
	return nil
}

func (f *fakeProtectedSetTransitionRuntime) StageProtectedSetTransitionTarget(_ context.Context, change ProtectedSetTransitionTarget, _ Ownership, _ string) (WorkerState, error) {
	worker := change.DesiredTarget.WorkerID
	f.calls = append(f.calls, "stage:"+change.DesiredTarget.TargetKey)
	if f.failStage == worker {
		return WorkerState{}, context.DeadlineExceeded
	}
	f.current[worker] = "desired"
	return WorkerState{
		WorkerID: worker, ModelProfileID: change.DesiredTarget.ModelProfileID,
		Status: "running", Health: "healthy", Image: change.DesiredTarget.RequiredImageDigest,
		PlacementClass: PlacementProtectedResident, MaintenanceGeneration: change.DesiredTarget.MaintenanceGeneration,
		ConfigDigest: change.DesiredTarget.RequiredConfigDigest,
	}, nil
}

func (f *fakeProtectedSetTransitionRuntime) RollbackProtectedSetTransitionTarget(_ context.Context, change ProtectedSetTransitionTarget, _ Ownership, _ string) error {
	worker := change.DesiredTarget.WorkerID
	f.calls = append(f.calls, "rollback:"+change.DesiredTarget.TargetKey)
	if f.failRollback == worker {
		return context.DeadlineExceeded
	}
	if change.LegacyPreviousTarget != nil || change.PreviousTarget != nil {
		f.current[worker] = "prior"
	} else {
		f.current[worker] = "absent"
	}
	return nil
}

func (f *fakeProtectedSetTransitionRuntime) CommitProtectedSetTransitionTarget(_ context.Context, change ProtectedSetTransitionTarget, _ Ownership, _ string) error {
	f.calls = append(f.calls, "commit:"+change.DesiredTarget.TargetKey)
	return nil
}

func (f *fakeProtectedSetTransitionRuntime) InspectProtectedSetTransitionRuntime(_ context.Context,
	payload ProtectedSetTransitionPayload, _ []string, requireDesired bool) ([]ProtectedSetTransitionTargetSnapshot, error) {
	result := make([]ProtectedSetTransitionTargetSnapshot, 0, len(payload.Targets))
	for _, change := range payload.Targets {
		wanted := "prior"
		runtimeState := "legacy-exact"
		if change.LegacyPreviousTarget == nil {
			runtimeState = "canonical-exact"
		}
		if requireDesired {
			wanted = "desired"
			runtimeState = "desired-exact"
		}
		if f.current[change.DesiredTarget.WorkerID] != wanted {
			return nil, context.DeadlineExceeded
		}
		result = append(result, ProtectedSetTransitionTargetSnapshot{
			TargetKey: change.DesiredTarget.TargetKey, StageOrder: change.DesiredTarget.StageOrder,
			WorkerID: change.DesiredTarget.WorkerID, ModelProfileID: change.DesiredTarget.ModelProfileID,
			RuntimeState: runtimeState, DesiredCompanions: []ProtectedSetTransitionContainerSnapshot{},
			LegacyDependents: []ProtectedSetTransitionContainerSnapshot{},
		})
	}
	return result, nil
}

func qualificationTransition(policy Policy) (Policy, ProtectedSetTransitionPayload) {
	policy.ProtectedTargetPolicyDigest = "sha256:" + strings.Repeat("a", 64)
	targets := policy.ProtectedTargetsDependencyOrder()
	fault := ProtectedSetTransitionFaultInjection{
		StageOrder: targets[len(targets)-1].StageOrder, TargetKey: targets[len(targets)-1].TargetKey,
		InjectionPoint: legacyProtectedSetFaultInjectionPoint,
		FailureCode:    legacyProtectedSetFaultFailureCode, OneShot: true,
	}
	policy.ProtectedSetQualification = &ProtectedSetQualificationPolicy{
		SchemaVersion: 1, NodeID: nodeID, NodeGeneration: nodeGeneration,
		QualificationID: "protected-office-set-v5", SetID: "office.baseline",
		ProtectedTargetPolicyDigest: policy.ProtectedTargetPolicyDigest,
		FaultInjection:              fault, SourceDigest: "sha256:" + strings.Repeat("b", 64),
	}
	payload := protectedTransitionPayload(policy, true)
	for index := range payload.Targets {
		previous := payload.Targets[index].DesiredTarget
		payload.Targets[index].PreviousTarget = &previous
	}
	payload.QualificationID = policy.ProtectedSetQualification.QualificationID
	payload.QualificationDigest = policy.ProtectedSetQualification.SourceDigest
	payload.FaultInjection = &fault
	return policy, payload
}

func TestProtectedSetCanonicalQualificationFaultRollsBackAndSurvivesRestartReplay(t *testing.T) {
	policy, _ := protectedPolicy()
	policy, payload := qualificationTransition(policy)
	runtime := &fakeProtectedSetTransitionRuntime{current: map[string]string{
		protectedWorkerA: "prior", protectedWorkerB: "prior",
	}}
	filename := filepath.Join(t.TempDir(), "protected-transition.json")
	coordinator, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration, filename, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("d", 64)
	if _, err := coordinator.Execute(context.Background(), payload, transitionOwnership(digest), digest, fixedNow); err == nil || err.Error() != legacyProtectedSetFaultFailureCode {
		t.Fatalf("qualification fault was not observed: %v", err)
	}
	want := []string{"stage:resident.beta", "stage:resident.alpha", "rollback:resident.alpha", "rollback:resident.beta"}
	if strings.Join(runtime.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("canonical rollback order drifted: got %v want %v", runtime.calls, want)
	}
	state := coordinator.stateLocked()
	if state.Phase != "recovered" || !state.FaultInjectionConsumed || !state.FaultInjectionAfterHealthy ||
		state.FaultInjectionStageOrder != payload.FaultInjection.StageOrder || state.FaultInjectionTargetKey != payload.FaultInjection.TargetKey {
		t.Fatalf("qualification journal is incomplete: %#v", state)
	}
	inspection, err := coordinator.Inspect(context.Background(), ProtectedSetTransitionInspectionPayload{
		InspectionID: "00000000-0000-4000-8000-000000000944", TransactionID: payload.TransactionID,
		QualificationID: payload.QualificationID, QualificationDigest: payload.QualificationDigest, Mode: "fault",
	})
	if err != nil || inspection.RuntimeState != "canonical-exact" || inspection.Journal.Phase != "recovered" || inspection.OOMKilled {
		t.Fatalf("canonical inspection failed: %#v %v", inspection, err)
	}

	// Recreate the coordinator to prove the replay decision comes from the
	// fsynced journal, not the process-local command cache.
	runtime.calls = nil
	restarted, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration, filename, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Execute(context.Background(), payload, transitionOwnership(digest), digest, fixedNow); err == nil || err.Error() != legacyProtectedSetFaultFailureCode {
		t.Fatalf("durable qualification replay drifted: %v", err)
	}
	if len(runtime.calls) != 0 {
		t.Fatalf("durable replay repeated a Docker mutation: %v", runtime.calls)
	}
}

func TestProtectedSetCanonicalFaultRequiresExactLocalQualificationAndEveryPreviousTarget(t *testing.T) {
	base, _ := protectedPolicy()
	policy, payload := qualificationTransition(base)
	digest := strings.Repeat("d", 64)
	for name, mutate := range map[string]func(*Policy, *ProtectedSetTransitionPayload){
		"no-local-policy": func(policy *Policy, _ *ProtectedSetTransitionPayload) { policy.ProtectedSetQualification = nil },
		"digest-drift": func(_ *Policy, payload *ProtectedSetTransitionPayload) {
			payload.QualificationDigest = "sha256:" + strings.Repeat("c", 64)
		},
		"fault-drift": func(_ *Policy, payload *ProtectedSetTransitionPayload) { payload.FaultInjection.StageOrder = 1 },
		"cold-boot":   func(_ *Policy, payload *ProtectedSetTransitionPayload) { payload.Targets[0].PreviousTarget = nil },
		"previous-identity-drift": func(_ *Policy, payload *ProtectedSetTransitionPayload) {
			previous := *payload.Targets[0].PreviousTarget
			previous.RequiredConfigDigest = "sha256:" + strings.Repeat("f", 64)
			payload.Targets[0].PreviousTarget = &previous
		},
	} {
		t.Run(name, func(t *testing.T) {
			candidatePolicy := policy
			candidatePayload := payload
			candidatePayload.Targets = append([]ProtectedSetTransitionTarget(nil), payload.Targets...)
			fault := *payload.FaultInjection
			candidatePayload.FaultInjection = &fault
			mutate(&candidatePolicy, &candidatePayload)
			runtime := &fakeProtectedSetTransitionRuntime{current: map[string]string{
				protectedWorkerA: "prior", protectedWorkerB: "prior",
			}}
			coordinator, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration,
				filepath.Join(t.TempDir(), "protected-transition.json"), candidatePolicy, runtime)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := coordinator.Execute(context.Background(), candidatePayload,
				transitionOwnership(digest), digest, fixedNow); err == nil || err.Error() != "protected_set_transition_migration_plan_drift" {
				t.Fatalf("unauthorized qualification fault was accepted: %v", err)
			}
			if len(runtime.calls) != 0 {
				t.Fatalf("rejected qualification mutated runtime: %v", runtime.calls)
			}
		})
	}
}

func transitionWorker(target ExclusiveDrainTarget, attempt string) WorkerStartPayload {
	value := validStart()
	value.WorkerID = target.WorkerID
	value.AttemptID = attempt
	value.ModelProfileID = target.ModelProfileID
	value.Image = target.RequiredImageDigest
	value.PlacementClass = PlacementProtectedResident
	value.MaintenanceGeneration = target.MaintenanceGeneration
	value.ConfigDigest = target.RequiredConfigDigest
	value.Environment["TEAMAIBOX_MODEL_PROFILE_ID"] = target.ModelProfileID
	return value
}

func protectedTransitionPayload(policy Policy, prior bool) ProtectedSetTransitionPayload {
	targets := policy.ProtectedTargetsDependencyOrder()
	changes := make([]ProtectedSetTransitionTarget, 0, len(targets))
	workers := make([]string, 0, len(targets))
	for index, target := range targets {
		worker := transitionWorker(target, []string{
			"00000000-0000-4000-8000-000000000831",
			"00000000-0000-4000-8000-000000000832",
		}[index])
		target.RequiredStartSpecDigest = WorkerStartSpecDigest(worker)
		policy.ExclusiveDrainTargets[target.TargetKey] = target
		change := ProtectedSetTransitionTarget{
			DesiredWorker: worker,
			DesiredTarget: target,
		}
		if prior {
			previous := target
			previous.RequiredImageID = "sha256:" + strings.Repeat("e", 64)
			previous.RequiredImageDigest = "registry.local/prior@sha256:" + strings.Repeat("e", 64)
			previous.RequiredConfigDigest = "sha256:" + strings.Repeat("f", 64)
			previous.RequiredLabels = map[string]string{"com.teamaibox.resident": "prior"}
			previous.DependentContainers = nil
			change.PreviousTarget = &previous
		}
		changes = append(changes, change)
		workers = append(workers, target.WorkerID)
	}
	return ProtectedSetTransitionPayload{
		TransactionID: leaseID, SetID: "office.baseline", DesiredStateRevision: 9,
		WorkerIDs: workers, AllowedOperations: []string{ProtectedSetTransition},
		OperationOrder:        []string{ProtectedTransitionInspect, ProtectedTransitionStage, ProtectedTransitionVerify, ProtectedTransitionCommit},
		MaintenanceGeneration: 1, IssuedAt: fixedNow.Add(-time.Second), ExpiresAt: fixedNow.Add(time.Minute),
		JournalRevision: 17, Targets: changes,
	}
}

func transitionOwnership(digest string) Ownership {
	return Ownership{
		NodeID: nodeID, NodeGeneration: nodeGeneration, CommandID: leaseID,
		CommandDigest: digest, LeaseID: leaseID, FencingToken: 17,
	}
}

func TestProtectedSetTransitionStagesDependencyFirstAndCommitsOnlyAfterCompleteVerification(t *testing.T) {
	policy, _ := protectedPolicy()
	payload := protectedTransitionPayload(policy, false)
	runtime := &fakeProtectedSetTransitionRuntime{current: map[string]string{
		protectedWorkerA: "absent", protectedWorkerB: "absent",
	}}
	coordinator, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration,
		filepath.Join(t.TempDir(), "protected-transition.json"), policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("d", 64)
	state, err := coordinator.Execute(context.Background(), payload, transitionOwnership(digest), digest, fixedNow)
	if err != nil || state.Phase != "complete" || coordinator.BlocksOrdinaryMutation() {
		t.Fatalf("transition did not commit cleanly: %#v %v", state, err)
	}
	want := []string{"stage:resident.beta", "stage:resident.alpha", "commit:resident.beta", "commit:resident.alpha"}
	if strings.Join(runtime.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("dependency order drifted: got %v want %v", runtime.calls, want)
	}
}

func TestProtectedSetTransitionPartiallyStartedColdBootIsRemovedInExactReverseOrder(t *testing.T) {
	policy, _ := protectedPolicy()
	payload := protectedTransitionPayload(policy, false)
	runtime := &fakeProtectedSetTransitionRuntime{
		current:   map[string]string{protectedWorkerA: "absent", protectedWorkerB: "absent"},
		failStage: protectedWorkerA,
	}
	coordinator, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration,
		filepath.Join(t.TempDir(), "protected-transition.json"), policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("d", 64)
	if _, err := coordinator.Execute(context.Background(), payload, transitionOwnership(digest), digest, fixedNow); err == nil || err.Error() != protectedSetTransitionTargetStageFailed {
		t.Fatalf("partial cold boot did not fail as expected: %v", err)
	}
	want := []string{"stage:resident.beta", "stage:resident.alpha", "rollback:resident.alpha", "rollback:resident.beta"}
	if strings.Join(runtime.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("rollback order drifted: got %v want %v", runtime.calls, want)
	}
	if runtime.current[protectedWorkerA] != "absent" || runtime.current[protectedWorkerB] != "absent" || coordinator.BlocksOrdinaryMutation() {
		t.Fatalf("partial cold identities survived rollback: %#v", runtime.current)
	}
	state := coordinator.stateLocked()
	if state.Phase != "recovered" || state.FailureCode != protectedSetTransitionTargetStageFailed ||
		state.FaultInjectionConsumed || state.FaultInjectionStageOrder != 0 ||
		state.FaultInjectionTargetKey != "" || state.FaultInjectionAfterHealthy {
		t.Fatalf("real target failure could impersonate a planned fault: %#v", state)
	}
}

func TestProtectedSetTransitionRestoresPriorExactIdentityAndFailsClosedWhenRecoveryIsIncomplete(t *testing.T) {
	policy, _ := protectedPolicy()
	payload := protectedTransitionPayload(policy, true)
	runtime := &fakeProtectedSetTransitionRuntime{
		current:   map[string]string{protectedWorkerA: "prior", protectedWorkerB: "prior"},
		failStage: protectedWorkerA, failRollback: protectedWorkerB,
	}
	coordinator, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration,
		filepath.Join(t.TempDir(), "protected-transition.json"), policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("d", 64)
	if _, err := coordinator.Execute(context.Background(), payload, transitionOwnership(digest), digest, fixedNow); err == nil || err.Error() != "protected_set_transition_recovery_incomplete" {
		t.Fatalf("incomplete exact recovery was not rejected: %v", err)
	}
	if !coordinator.BlocksOrdinaryMutation() || coordinator.stateLocked().Phase != "recovery_required" {
		t.Fatalf("incomplete recovery did not fail closed: %#v", coordinator.stateLocked())
	}
}
