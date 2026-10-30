package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fakeApplianceRestartRuntime struct {
	identities            map[string]ApplianceContainerIdentity
	order                 []string
	journal               string
	scheduled             int
	err                   error
	cancelOnRestart       context.CancelFunc
	restartContext        context.Context
	contextLiveAtSchedule bool
	beforeInspect         func(ApplianceRestartTarget)
}

func (f *fakeApplianceRestartRuntime) InspectApplianceRestartTarget(_ context.Context,
	target ApplianceRestartTarget) (ApplianceContainerIdentity, error) {
	f.order = append(f.order, "inspect:"+target.ContainerName)
	if f.beforeInspect != nil {
		f.beforeInspect(target)
	}
	if f.err != nil {
		return ApplianceContainerIdentity{}, f.err
	}
	return f.identities[target.ContainerName], nil
}

func (f *fakeApplianceRestartRuntime) RestartAndVerifyApplianceTarget(ctx context.Context,
	target ApplianceRestartTarget, previous time.Time) (ApplianceContainerIdentity, error) {
	f.order = append(f.order, "restart:"+target.ContainerName)
	f.restartContext = ctx
	if f.cancelOnRestart != nil {
		f.cancelOnRestart()
	}
	if err := ctx.Err(); err != nil {
		return ApplianceContainerIdentity{}, err
	}
	if _, err := os.Stat(f.journal); err != nil {
		return ApplianceContainerIdentity{}, errors.New("journal_was_not_persisted_before_mutation")
	}
	identity := f.identities[target.ContainerName]
	identity.StartedAt = previous.Add(time.Minute)
	f.identities[target.ContainerName] = identity
	return identity, nil
}

func (f *fakeApplianceRestartRuntime) ScheduleApplianceSelfRestart(ctx context.Context,
	target ApplianceRestartTarget) error {
	f.contextLiveAtSchedule = ctx.Err() == nil
	if err := ctx.Err(); err != nil {
		return err
	}
	f.order = append(f.order, "schedule:"+target.ContainerName)
	f.scheduled++
	return f.err
}

func restartIdentity(character string, started time.Time) ApplianceContainerIdentity {
	return ApplianceContainerIdentity{ContainerID: strings.Repeat(character, 64), ImageID: "sha256:" + strings.Repeat(character, 64),
		ImageReference: "registry.example/teamaibox/" + character + ":pinned", ConfigurationDigest: "sha256:" + strings.Repeat(character, 64),
		StartedAt: started, Status: "running", Health: "healthy"}
}

func restartPolicyFixture() ApplianceRestartPolicy {
	policy := ApplianceRestartPolicy{SchemaVersion: 1, NodeID: "00000000-0000-4000-8000-000000000101", NodeGeneration: 7,
		Platform: ApplianceRestartTarget{ContainerName: "teamaibox-platform",
			ImageID: "sha256:" + strings.Repeat("a", 64), ImageReference: "registry.example/teamaibox/a:pinned",
			ConfigurationDigest: "sha256:" + strings.Repeat("a", 64), RequireHealthy: true},
		NodeAgent: ApplianceRestartTarget{ContainerName: "teamaibox-node-agent",
			ImageID: "sha256:" + strings.Repeat("b", 64), ImageReference: "registry.example/teamaibox/b:pinned",
			ConfigurationDigest: "sha256:" + strings.Repeat("b", 64), RequireHealthy: true}}
	semantic := policy
	semantic.PolicyDigest = ""
	policy.PolicyDigest = applianceRestartDigest(semantic)
	return policy
}

func restartPayload(commandID string, policy ApplianceRestartPolicy, revision uint64) ApplianceRuntimeRestartPayload {
	return ApplianceRuntimeRestartPayload{RestartID: commandID, JournalRevision: revision, PolicyDigest: policy.PolicyDigest,
		IdempotencyKey: "sha256:" + strings.Repeat("c", 64)}
}

func TestApplianceRestartPersistsBeforeMutationAndCompletesOnlyAfterExactSelfRestart(t *testing.T) {
	policy := restartPolicyFixture()
	journal := filepath.Join(t.TempDir(), "restart.json")
	started := time.Date(2026, 9, 5, 1, 0, 0, 0, time.UTC)
	runtime := &fakeApplianceRestartRuntime{journal: journal, identities: map[string]ApplianceContainerIdentity{
		policy.Platform.ContainerName: restartIdentity("a", started), policy.NodeAgent.ContainerName: restartIdentity("b", started),
	}}
	coordinator, err := NewApplianceRestartCoordinator(policy.NodeID, policy.NodeGeneration, journal, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	coordinator.now = func() time.Time { return started.Add(2 * time.Minute) }
	commandID := "00000000-0000-4000-8000-000000000991"
	payload := restartPayload(commandID, policy, 11)
	state, err := coordinator.Execute(context.Background(), payload, commandID, strings.Repeat("d", 64), payload.IdempotencyKey, started)
	if err != nil {
		t.Fatal(err)
	}
	if state.Phase != "agent_restart_armed" || runtime.scheduled != 1 || state.Revisions.Prepared != 11 ||
		state.Revisions.AgentRestartArmed != 14 || state.Revisions.Complete != 0 {
		t.Fatalf("unexpected armed state: %#v", state)
	}
	if !reflect.DeepEqual(runtime.order, []string{"inspect:teamaibox-platform", "inspect:teamaibox-node-agent", "restart:teamaibox-platform", "schedule:teamaibox-node-agent"}) {
		t.Fatalf("restart order drifted: %#v", runtime.order)
	}
	info, err := os.Stat(journal)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("journal is not private and durable: mode=%v error=%v", info.Mode(), err)
	}

	// A reconstructed service observes the actual Docker StartedAt transition;
	// only then may the exact command replay become complete.
	runtime.identities[policy.NodeAgent.ContainerName] = restartIdentity("b", started.Add(3*time.Minute))
	reloaded, err := NewApplianceRestartCoordinator(policy.NodeID, policy.NodeGeneration, journal, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := reloaded.Execute(context.Background(), payload, commandID, strings.Repeat("d", 64), payload.IdempotencyKey, started.Add(4*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Phase != "complete" || replayed.Revisions.Complete != 15 ||
		!replayed.Post["platform"].StartedAt.After(replayed.Pre["platform"].StartedAt) ||
		!replayed.Post["nodeAgent"].StartedAt.After(replayed.Pre["nodeAgent"].StartedAt) {
		t.Fatalf("restart did not complete with exact post identities: %#v", replayed)
	}
}

func armedRestartForStartup(t *testing.T) (*ApplianceRestartCoordinator, *fakeApplianceRestartRuntime) {
	t.Helper()
	policy := restartPolicyFixture()
	started := time.Now().UTC().Add(-time.Hour)
	runtime := &fakeApplianceRestartRuntime{journal: filepath.Join(t.TempDir(), "restart.json"),
		identities: map[string]ApplianceContainerIdentity{
			policy.Platform.ContainerName:  restartIdentity("a", started),
			policy.NodeAgent.ContainerName: restartIdentity("b", started),
		}}
	coordinator, err := NewApplianceRestartCoordinator(policy.NodeID, policy.NodeGeneration, runtime.journal, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	commandID := "00000000-0000-4000-8000-000000000996"
	payload := restartPayload(commandID, policy, 1)
	if _, err := coordinator.Execute(context.Background(), payload, commandID, strings.Repeat("d", 64), payload.IdempotencyKey, started); err != nil {
		t.Fatal(err)
	}
	runtime.identities[policy.NodeAgent.ContainerName] = restartIdentity("b", started.Add(2*time.Minute))
	reloaded, err := NewApplianceRestartCoordinator(policy.NodeID, policy.NodeGeneration, runtime.journal, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	runtime.order = nil
	return reloaded, runtime
}

func TestApplianceRestartStartupCompletesWithoutCommandReplay(t *testing.T) {
	coordinator, runtime := armedRestartForStartup(t)
	state, err := coordinator.ReconcileAfterStart(context.Background())
	if err != nil || state.Phase != "complete" || state.Revisions.Complete != 5 || coordinator.BlocksOrdinaryMutation() {
		t.Fatalf("startup did not release completed restart: %#v %v", state, err)
	}
	if runtime.scheduled != 1 || !reflect.DeepEqual(runtime.order, []string{"inspect:teamaibox-platform", "inspect:teamaibox-node-agent"}) {
		t.Fatalf("startup mutated a container: %#v", runtime.order)
	}
	reloaded, err := NewApplianceRestartCoordinator(coordinator.nodeID, coordinator.nodeGeneration, runtime.journal, coordinator.policy, runtime)
	if err != nil || reloaded.BlocksOrdinaryMutation() {
		t.Fatalf("completion was not persisted: %v", err)
	}
	if _, err := reloaded.ReconcileAfterStart(context.Background()); err != nil || len(runtime.order) != 2 {
		t.Fatal("completed startup recovery was not a no-op")
	}
}

func TestApplianceRestartStartupWaitsForHealthcheckWithoutRestarting(t *testing.T) {
	coordinator, runtime := armedRestartForStartup(t)
	checks := 0
	runtime.beforeInspect = func(target ApplianceRestartTarget) {
		if target.ContainerName != coordinator.policy.NodeAgent.ContainerName {
			return
		}
		checks++
		identity := runtime.identities[target.ContainerName]
		identity.Health = "starting"
		if checks >= 3 {
			identity.Health = "healthy"
		}
		runtime.identities[target.ContainerName] = identity
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	state, err := coordinator.reconcileAfterStart(ctx, time.Millisecond)
	if err != nil || state.Phase != "complete" || checks != 3 || runtime.scheduled != 1 {
		t.Fatalf("health transition was not reconciled: %#v checks=%d err=%v", state, checks, err)
	}
}

func TestApplianceRestartStartupKeepsIncompleteOrChangedTargetsBlocked(t *testing.T) {
	for _, scenario := range []string{"agent-not-restarted", "agent-replaced", "platform-drift", "earlier-phase", "journal-write-failed"} {
		t.Run(scenario, func(t *testing.T) {
			coordinator, runtime := armedRestartForStartup(t)
			switch scenario {
			case "agent-not-restarted":
				runtime.identities[coordinator.policy.NodeAgent.ContainerName] = coordinator.journal.Pre["nodeAgent"]
			case "agent-replaced":
				identity := runtime.identities[coordinator.policy.NodeAgent.ContainerName]
				identity.ContainerID = strings.Repeat("f", 64)
				runtime.identities[coordinator.policy.NodeAgent.ContainerName] = identity
			case "platform-drift":
				identity := runtime.identities[coordinator.policy.Platform.ContainerName]
				identity.ConfigurationDigest = "sha256:" + strings.Repeat("f", 64)
				runtime.identities[coordinator.policy.Platform.ContainerName] = identity
			case "earlier-phase":
				if err := coordinator.setPhase(coordinator.journal, "platform_verified", time.Now()); err != nil {
					t.Fatal(err)
				}
			case "journal-write-failed":
				coordinator.journalFile = filepath.Join(t.TempDir(), "missing", "restart.json")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
			defer cancel()
			if _, err := coordinator.reconcileAfterStart(ctx, time.Millisecond); err == nil || !coordinator.BlocksOrdinaryMutation() {
				t.Fatalf("unsafe completion was accepted: %v", err)
			}
			if runtime.scheduled != 1 {
				t.Fatal("startup scheduled another restart")
			}
			for _, operation := range runtime.order {
				if !strings.HasPrefix(operation, "inspect:") {
					t.Fatalf("startup mutated runtime: %s", operation)
				}
			}
		})
	}
}

func TestApplianceRestartRejectsRequestSelectedTargetsAndIdentityDriftWithoutMutation(t *testing.T) {
	policy := restartPolicyFixture()
	journal := filepath.Join(t.TempDir(), "restart.json")
	started := time.Date(2026, 9, 5, 1, 0, 0, 0, time.UTC)
	runtime := &fakeApplianceRestartRuntime{journal: journal, identities: map[string]ApplianceContainerIdentity{
		policy.Platform.ContainerName: restartIdentity("f", started), policy.NodeAgent.ContainerName: restartIdentity("b", started),
	}}
	coordinator, err := NewApplianceRestartCoordinator(policy.NodeID, policy.NodeGeneration, journal, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	commandID := "00000000-0000-4000-8000-000000000992"
	payload := restartPayload(commandID, policy, 1)
	if _, err := coordinator.Execute(context.Background(), payload, commandID, strings.Repeat("d", 64), payload.IdempotencyKey, started); err == nil ||
		err.Error() != "appliance_restart_platform_identity_invalid" {
		t.Fatalf("identity drift was not denied: %v", err)
	}
	if runtime.scheduled != 0 {
		t.Fatal("identity drift reached mutation")
	}
	encoded, _ := json.Marshal(payload)
	encoded = append(encoded[:len(encoded)-1], []byte(`,"containerName":"attacker-selected"}`)...)
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.DisallowUnknownFields()
	var decoded ApplianceRuntimeRestartPayload
	if err := decoder.Decode(&decoded); err == nil {
		t.Fatal("request-selected container name was accepted")
	}
}

func TestApplianceRestartSurvivesItsOwnCallerDisconnectWithFixedDeadline(t *testing.T) {
	policy := restartPolicyFixture()
	started := time.Now().UTC().Add(-time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime := &fakeApplianceRestartRuntime{journal: filepath.Join(t.TempDir(), "restart.json"),
		cancelOnRestart: cancel, identities: map[string]ApplianceContainerIdentity{
			policy.Platform.ContainerName:  restartIdentity("a", started),
			policy.NodeAgent.ContainerName: restartIdentity("b", started),
		}}
	coordinator, err := NewApplianceRestartCoordinator(policy.NodeID, policy.NodeGeneration, runtime.journal, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	commandID := "00000000-0000-4000-8000-000000000993"
	payload := restartPayload(commandID, policy, 1)
	before := time.Now()
	state, err := coordinator.Execute(ctx, payload, commandID, strings.Repeat("d", 64), payload.IdempotencyKey, before)
	if err != nil || state.Phase != "agent_restart_armed" || runtime.scheduled != 1 || !runtime.contextLiveAtSchedule {
		t.Fatalf("caller disconnect aborted admitted restart: phase=%s schedules=%d err=%v", state.Phase, runtime.scheduled, err)
	}
	if ctx.Err() != context.Canceled {
		t.Fatal("test did not disconnect caller")
	}
	deadline, bounded := runtime.restartContext.Deadline()
	if !bounded || deadline.Before(before.Add(119*time.Second)) || deadline.After(time.Now().Add(120*time.Second)) {
		t.Fatal("restart lost the independent fixed 120-second execution bound")
	}
	if runtime.restartContext.Err() != context.Canceled {
		t.Fatal("execution context was not released on return")
	}
}

func TestApplianceRestartCancelledBeforeAdmissionDoesNotWriteIntent(t *testing.T) {
	policy := restartPolicyFixture()
	runtime := &fakeApplianceRestartRuntime{journal: filepath.Join(t.TempDir(), "restart.json")}
	coordinator, err := NewApplianceRestartCoordinator(policy.NodeID, policy.NodeGeneration, runtime.journal, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	commandID := "00000000-0000-4000-8000-000000000994"
	payload := restartPayload(commandID, policy, 1)
	_, err = coordinator.Execute(ctx, payload, commandID, strings.Repeat("d", 64), payload.IdempotencyKey, time.Now())
	if err == nil || err.Error() != "appliance_restart_request_cancelled" || len(runtime.order) != 0 {
		t.Fatalf("cancelled request reached admission: %v", err)
	}
	if _, err := os.Stat(runtime.journal); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cancelled request wrote restart intent")
	}
}

func TestApplianceRestartPolicyRequiresExactArtifactAndSemanticDigests(t *testing.T) {
	policy := restartPolicyFixture()
	encoded, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	filename := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(filename, encoded, 0o444); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(encoded)
	expected := "sha256:" + hex.EncodeToString(digest[:])
	loaded, err := LoadApplianceRestartPolicy(filename, expected, policy.NodeID, policy.NodeGeneration)
	if err != nil || loaded.PolicyDigest != policy.PolicyDigest {
		t.Fatalf("exact policy did not load: policy=%#v error=%v", loaded, err)
	}
	if _, err := LoadApplianceRestartPolicy(filename, expected, policy.NodeID, policy.NodeGeneration+1); !errors.Is(err, ErrApplianceRestartAuthorityExpired) {
		t.Fatalf("verified older restart policy should disable only restart: %v", err)
	}
	if _, err := LoadApplianceRestartPolicy(filename, "sha256:"+strings.Repeat("0", 64), policy.NodeID, policy.NodeGeneration+1); errors.Is(err, ErrApplianceRestartAuthorityExpired) || err == nil {
		t.Fatal("older policy with invalid digest accepted")
	}
	if _, err := LoadApplianceRestartPolicy(filename, "sha256:"+strings.Repeat("0", 64), policy.NodeID, policy.NodeGeneration); err == nil ||
		err.Error() != "appliance_restart_policy_digest_mismatch" {
		t.Fatalf("artifact digest drift was not rejected: %v", err)
	}
	policy.Platform.ContainerName = "drifted-platform"
	drift, _ := json.Marshal(policy)
	if err := os.Chmod(filename, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, append(drift, '\n'), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filename, 0o444); err != nil {
		t.Fatal(err)
	}
	driftDigest := sha256.Sum256(append(drift, '\n'))
	if _, err := LoadApplianceRestartPolicy(filename, "sha256:"+hex.EncodeToString(driftDigest[:]), policy.NodeID, policy.NodeGeneration); err == nil ||
		err.Error() != "appliance_restart_policy_invalid" {
		t.Fatalf("semantic digest drift was not rejected: %v", err)
	}
}
