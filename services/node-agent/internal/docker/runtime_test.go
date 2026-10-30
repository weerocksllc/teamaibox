package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

const (
	testNodeID   = "00000000-0000-4000-8000-000000000101"
	testWorkerID = "00000000-0000-4000-8000-000000000201"
	testAttempt  = "00000000-0000-4000-8000-000000000301"
	testLease    = "00000000-0000-4000-8000-000000000501"
)

type call struct{ arguments []string }

type scriptedRunner struct {
	calls        []call
	image        string
	labels       map[string]string
	wrongTag     bool
	createError  bool
	startError   bool
	status       string
	volumeName   string
	volumeLabels map[string]string
}

func (s *scriptedRunner) Run(_ context.Context, arguments ...string) (string, error) {
	s.calls = append(s.calls, call{arguments: append([]string(nil), arguments...)})
	joined := strings.Join(arguments, " ")
	switch {
	case strings.HasPrefix(joined, "image inspect"):
		if s.wrongTag {
			return `["registry.local/wrong@sha256:` + strings.Repeat("b", 64) + `"]`, nil
		}
		body, _ := json.Marshal([]string{s.image})
		return string(body), nil
	case strings.HasPrefix(joined, "volume inspect"):
		body, _ := json.Marshal([]map[string]any{{"Name": s.volumeName, "Labels": s.volumeLabels}})
		return string(body), nil
	case strings.HasPrefix(joined, "container create"):
		if s.createError {
			return "", fmt.Errorf("container name is already in use")
		}
		return "container-a", nil
	case strings.HasPrefix(joined, "container start "):
		if s.startError {
			return "", fmt.Errorf("start failed")
		}
		s.status = "running"
		return "container-a", nil
	case strings.HasPrefix(joined, "container inspect"):
		status := s.status
		if status == "" {
			status = "running"
		}
		document := []map[string]any{{
			"Id":     "container-a",
			"State":  map[string]any{"Status": status, "StartedAt": "2026-08-11T00:00:00Z", "Health": map[string]any{"Status": "healthy"}},
			"Config": map[string]any{"Image": s.image, "Labels": s.labels},
		}}
		body, _ := json.Marshal(document)
		return string(body), nil
	case strings.HasPrefix(joined, "container stop"):
		return testWorkerID, nil
	case strings.HasPrefix(joined, "container rm"):
		return testWorkerID, nil
	default:
		return "", fmt.Errorf("unexpected docker arguments: %s", joined)
	}
}

func dockerFixture(t *testing.T) (*Runtime, *scriptedRunner, agent.WorkerStartPayload, agent.Ownership) {
	t.Helper()
	image := "registry.local/worker@sha256:" + strings.Repeat("a", 64)
	ownership := agent.Ownership{NodeID: testNodeID, NodeGeneration: 7, CommandID: "command-a", CommandDigest: strings.Repeat("c", 64), LeaseID: testLease, FencingToken: 9, AttemptID: testAttempt}
	spec := agent.WorkerStartPayload{
		WorkerID: testWorkerID, AttemptID: testAttempt,
		ModelProfileID: "00000000-0000-4000-8000-000000000401",
		Image:          image, Network: "none",
		Limits:      agent.ResourceLimits{MemoryBytes: 1 << 30, CPUQuotaMicros: 100_000, PidsLimit: 64, EphemeralBytes: 10 << 30, OpenFilesLimit: 4096},
		Security:    agent.SecurityProfile{RunAsUID: 10001, RunAsGID: 10001, ReadOnlyRoot: true, DropAllCaps: true, NoNewPrivileges: true},
		Mounts:      []agent.VolumeMount{{Type: "volume", Source: "teamaibox-worker-data-a", Target: "/var/lib/teamaibox/worker/data", ReadOnly: true}},
		Devices:     []string{"nvidia.com/gpu=all", "nvidia.com/nvenc=all"},
		Environment: map[string]string{"TEAMAIBOX_MODEL_PROFILE_ID": specProfileID()},
		Command:     []string{"serve", "--port", "9000"},
	}
	runner := &scriptedRunner{image: image, labels: map[string]string{
		"com.teamaibox.managed": "true", "com.teamaibox.kind": "compute-worker",
		"com.teamaibox.node-id": testNodeID, "com.teamaibox.worker-id": testWorkerID,
		"com.teamaibox.node-generation": "7",
		"com.teamaibox.lease-id":        testLease, "com.teamaibox.fencing-token": "9",
		"com.teamaibox.start-command-id": ownership.CommandID, "com.teamaibox.start-command-digest": ownership.CommandDigest,
		"com.teamaibox.start-spec-digest": workerStartSpecDigest(spec),
		"com.teamaibox.attempt-id":        testAttempt, "com.teamaibox.model-profile-id": spec.ModelProfileID,
		"com.teamaibox.image-digest": image,
	}}
	runtime, err := NewRuntime(runner)
	if err != nil {
		t.Fatal(err)
	}
	return runtime, runner, spec, ownership
}

func specProfileID() string { return "00000000-0000-4000-8000-000000000401" }

func TestStartUsesOnlyBoundedDockerArgumentsAndPinnedDigest(t *testing.T) {
	runtime, runner, spec, ownership := dockerFixture(t)
	spec.Entrypoint = []string{"/opt/teamaibox/worker-entrypoint"}
	state, err := runtime.StartWorker(context.Background(), spec, ownership)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != "running" || state.Health != "healthy" || state.ContainerID != "container-a" {
		t.Fatalf("unexpected state: %#v", state)
	}
	if len(runner.calls) != 4 {
		t.Fatalf("expected inspect/create/start/inspect, got %#v", runner.calls)
	}
	create := strings.Join(runner.calls[1].arguments, " ")
	required := []string{
		"--read-only", "--user 10001:10001", "--cap-drop ALL",
		"--security-opt no-new-privileges:true", "--pids-limit 64",
		"--memory 1073741824", "--memory-swap 1073741824",
		"--network none", "--restart no", "--gpus all",
		"--entrypoint /opt/teamaibox/worker-entrypoint",
		"type=volume,source=teamaibox-worker-data-a,target=/var/lib/teamaibox/worker/data,readonly",
		"com.teamaibox.fencing-token=9", "com.teamaibox.start-command-id=command-a",
		"com.teamaibox.start-command-digest=" + ownership.CommandDigest,
		spec.Image + " serve --port 9000",
	}
	for _, fragment := range required {
		if !strings.Contains(create, fragment) {
			t.Errorf("create arguments missing %q: %s", fragment, create)
		}
	}
	if strings.Count(create, "--gpus all") != 1 {
		t.Fatalf("GPU request was not deduplicated: %s", create)
	}
}

func TestCLIRuntimeRejectsAnUnrepresentableMultiArgumentEntrypointBeforeCreate(t *testing.T) {
	runtime, runner, spec, ownership := dockerFixture(t)
	spec.Entrypoint = []string{"/opt/teamaibox/worker-entrypoint", "--fixed-mode"}
	if _, err := runtime.StartWorker(context.Background(), spec, ownership); err == nil ||
		err.Error() != "multi-argument entrypoint requires Docker Engine API runtime" {
		t.Fatalf("CLI runtime silently weakened a multi-argument entrypoint: %v", err)
	}
	for _, call := range runner.calls {
		if strings.HasPrefix(strings.Join(call.arguments, " "), "container create") {
			t.Fatalf("unrepresentable entrypoint reached container creation: %#v", call.arguments)
		}
	}
}

func TestAgentSandboxUsesBuiltinSeccompOwnerLabelsAndNeverRequestsGPU(t *testing.T) {
	runtime, runner, spec, ownership := dockerFixture(t)
	spec.WorkloadKind = "agent-sandbox"
	spec.AttemptID, spec.ModelProfileID = "", ""
	spec.OwnerIdentityID = "00000000-0000-4000-8000-000000000701"
	spec.SandboxKey = "sandbox." + strings.Repeat("d", 32)
	spec.Security.SeccompProfile = "builtin"
	spec.Limits.WorkspaceBytes = 100 << 30
	spec.Mounts = []agent.VolumeMount{{Type: "volume", Source: "teamaibox-agent-" + strings.Repeat("d", 32) + "-workspace", Target: "/workspace"}}
	spec.Devices = nil
	runner.volumeName = spec.Mounts[0].Source
	runner.volumeLabels = map[string]string{
		"com.teamaibox.volume.class":      "agent-workspace",
		"com.teamaibox.owner-identity-id": spec.OwnerIdentityID,
		"com.teamaibox.sandbox-key":       spec.SandboxKey,
		"com.teamaibox.quota-bytes":       "107374182400",
	}
	runner.labels["com.teamaibox.kind"] = "agent-sandbox"
	runner.labels["com.teamaibox.attempt-id"] = ""
	runner.labels["com.teamaibox.model-profile-id"] = ""
	runner.labels["com.teamaibox.owner-identity-id"] = spec.OwnerIdentityID
	runner.labels["com.teamaibox.sandbox-key"] = spec.SandboxKey
	if _, err := runtime.StartWorker(context.Background(), spec, ownership); err != nil {
		t.Fatal(err)
	}
	create := strings.Join(runner.calls[2].arguments, " ")
	for _, expected := range []string{
		"--security-opt seccomp=builtin",
		"com.teamaibox.owner-identity-id=" + spec.OwnerIdentityID,
		"com.teamaibox.sandbox-key=" + spec.SandboxKey,
		"com.teamaibox.workspace-quota-bytes=107374182400",
	} {
		if !strings.Contains(create, expected) {
			t.Errorf("Agent sandbox create is missing %q: %s", expected, create)
		}
	}
	if strings.Contains(create, "--gpus") || strings.Contains(create, "docker.sock") {
		t.Fatalf("Agent sandbox received a forbidden capability: %s", create)
	}
}

func TestAgentSandboxRejectsCrossUserOrUnenforcedWorkspaceQuotaBeforeCreate(t *testing.T) {
	runtime, runner, spec, ownership := dockerFixture(t)
	spec.WorkloadKind = "agent-sandbox"
	spec.AttemptID, spec.ModelProfileID = "", ""
	spec.OwnerIdentityID = "00000000-0000-4000-8000-000000000701"
	spec.SandboxKey = "sandbox." + strings.Repeat("d", 32)
	spec.Limits.WorkspaceBytes = 100 << 30
	spec.Mounts = []agent.VolumeMount{{Type: "volume", Source: "teamaibox-agent-" + strings.Repeat("d", 32) + "-workspace", Target: "/workspace"}}
	runner.volumeName = spec.Mounts[0].Source
	runner.volumeLabels = map[string]string{
		"com.teamaibox.volume.class":      "agent-workspace",
		"com.teamaibox.owner-identity-id": "00000000-0000-4000-8000-000000000799",
		"com.teamaibox.sandbox-key":       spec.SandboxKey,
		"com.teamaibox.quota-bytes":       "107374182400",
	}
	if _, err := runtime.StartWorker(context.Background(), spec, ownership); err == nil || !strings.Contains(err.Error(), "ownership or disk quota") {
		t.Fatalf("cross-user workspace evidence was accepted: %v", err)
	}
	for _, call := range runner.calls {
		if len(call.arguments) >= 2 && call.arguments[0] == "container" && call.arguments[1] == "create" {
			t.Fatal("workspace ownership failure reached container create")
		}
	}
}

func TestStartReplayAfterAgentRestartReturnsTheExactExistingContainer(t *testing.T) {
	runtime, runner, spec, ownership := dockerFixture(t)
	runner.createError = true
	state, err := runtime.StartWorker(context.Background(), spec, ownership)
	if err != nil {
		t.Fatal(err)
	}
	if state.ContainerID != "container-a" || state.Status != "running" {
		t.Fatalf("unexpected replay state: %#v", state)
	}
	if len(runner.calls) != 4 {
		t.Fatalf("replay should verify image, attempt create, and inspect twice: %#v", runner.calls)
	}
	for _, call := range runner.calls {
		if len(call.arguments) >= 2 && call.arguments[0] == "container" && call.arguments[1] == "start" {
			t.Fatal("replayed start attempted to start the existing worker again")
		}
	}
}

func TestStartReplayAfterControllerRestartAcceptsANewCommandIdentity(t *testing.T) {
	runtime, runner, spec, ownership := dockerFixture(t)
	runner.createError = true
	ownership.CommandDigest = strings.Repeat("d", 64)
	ownership.CommandID = "command-after-controller-restart"
	if _, err := runtime.StartWorker(context.Background(), spec, ownership); err != nil {
		t.Fatalf("semantic replay failed after controller restart: %v", err)
	}
}

func TestStartReplayRejectsAChangedImmutableSpecification(t *testing.T) {
	runtime, runner, spec, ownership := dockerFixture(t)
	runner.createError = true
	spec.Limits.MemoryBytes += 1
	if _, err := runtime.StartWorker(context.Background(), spec, ownership); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected immutable specification mismatch, got %v", err)
	}
}

func TestStartReplayRejectsAnExitedExistingContainer(t *testing.T) {
	runtime, runner, spec, ownership := dockerFixture(t)
	runner.createError = true
	runner.status = "exited"
	if _, err := runtime.StartWorker(context.Background(), spec, ownership); err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("expected exited replay rejection, got %v", err)
	}
}

func TestImageMustExposeTheExactRequestedRepositoryDigest(t *testing.T) {
	runtime, runner, spec, ownership := dockerFixture(t)
	runner.wrongTag = true
	if _, err := runtime.StartWorker(context.Background(), spec, ownership); err == nil || !strings.Contains(err.Error(), "does not expose") {
		t.Fatalf("expected exact digest failure, got %v", err)
	}
	if len(runner.calls) != 1 {
		t.Fatal("digest failure reached container create")
	}
}

func TestRepositoryDigestMatchingOnlyNormalizesDockerHubNames(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	for _, exposed := range []string{"node@" + digest, "library/node@" + digest, "docker.io/library/node@" + digest} {
		if !repositoryDigestMatches("docker.io/library/node@"+digest, exposed) {
			t.Fatalf("Docker Hub normalization rejected %q", exposed)
		}
	}
	if repositoryDigestMatches("docker.io/library/node@"+digest, "registry.local/node@"+digest) {
		t.Fatal("registry substitution was accepted")
	}
	if repositoryDigestMatches("docker.io/library/node@"+digest, "node@sha256:"+strings.Repeat("b", 64)) {
		t.Fatal("digest substitution was accepted")
	}
}

func TestStopAndHealthRequireManagedOwnershipAndExactFenceLabels(t *testing.T) {
	runtime, runner, _, ownership := dockerFixture(t)
	state, err := runtime.WorkerHealth(context.Background(), testWorkerID, ownership)
	if err != nil || state.Health != "healthy" {
		t.Fatalf("health failed: %#v %v", state, err)
	}
	runner.labels["com.teamaibox.fencing-token"] = "8"
	if _, err := runtime.StopWorker(context.Background(), testWorkerID, 5, ownership); err == nil || !strings.Contains(err.Error(), "fencing") {
		t.Fatalf("expected ownership fence failure, got %v", err)
	}
	for _, call := range runner.calls {
		if len(call.arguments) >= 2 && call.arguments[0] == "container" && call.arguments[1] == "stop" {
			t.Fatal("ownership failure reached docker stop")
		}
	}
}

func TestCLIStopRejectsProtectedResidentBeforeDockerMutation(t *testing.T) {
	runtime, runner, _, ownership := dockerFixture(t)
	runner.labels["com.teamaibox.placement-class"] = agent.PlacementProtectedResident
	runner.labels["com.teamaibox.maintenance-generation"] = "4"
	runner.labels["com.teamaibox.config-digest"] = "sha256:" + strings.Repeat("d", 64)
	if _, err := runtime.StopWorker(context.Background(), testWorkerID, 5, ownership); err == nil || err.Error() != "protected_resident_operation_denied" {
		t.Fatalf("protected resident CLI stop was accepted: %v", err)
	}
	for _, call := range runner.calls {
		joined := strings.Join(call.arguments, " ")
		if strings.HasPrefix(joined, "container stop") || strings.HasPrefix(joined, "container rm") {
			t.Fatalf("protected denial reached Docker mutation: %s", joined)
		}
	}
}

func configureProtectedStartFixture(spec *agent.WorkerStartPayload, runner *scriptedRunner) {
	spec.PlacementClass = agent.PlacementProtectedResident
	spec.MaintenanceGeneration = 1
	spec.ConfigDigest = "sha256:" + strings.Repeat("d", 64)
	runner.labels["com.teamaibox.placement-class"] = spec.PlacementClass
	runner.labels["com.teamaibox.maintenance-generation"] = "1"
	runner.labels["com.teamaibox.config-digest"] = spec.ConfigDigest
	runner.labels["com.teamaibox.start-spec-digest"] = workerStartSpecDigest(*spec)
}

func TestCLIProtectedStartFailurePreservesAndResumesExactContainer(t *testing.T) {
	runtime, runner, spec, ownership := dockerFixture(t)
	configureProtectedStartFixture(&spec, runner)
	runner.startError = true
	if _, err := runtime.StartWorker(context.Background(), spec, ownership); err == nil || err.Error() != "protected_resident_start_recovery_required" {
		t.Fatalf("protected failed start was not preserved: %v", err)
	}
	for _, call := range runner.calls {
		if strings.HasPrefix(strings.Join(call.arguments, " "), "container rm") {
			t.Fatal("protected failed start was evicted")
		}
	}

	runner.calls = nil
	runner.startError = false
	runner.createError = true
	runner.status = "exited"
	state, err := runtime.StartWorker(context.Background(), spec, ownership)
	if err != nil || state.Status != "running" || state.PlacementClass != agent.PlacementProtectedResident {
		t.Fatalf("exact protected stopped container was not resumed: %#v %v", state, err)
	}
	for _, call := range runner.calls {
		if strings.HasPrefix(strings.Join(call.arguments, " "), "container rm") {
			t.Fatal("protected resume evicted the prior exact identity")
		}
	}
}
