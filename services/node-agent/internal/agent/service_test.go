package agent

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	nodeID               = "00000000-0000-4000-8000-000000000101"
	nodeGeneration int64 = 7
	workerID             = "00000000-0000-4000-8000-000000000201"
	attemptID            = "00000000-0000-4000-8000-000000000301"
	profileID            = "00000000-0000-4000-8000-000000000401"
	leaseID              = "00000000-0000-4000-8000-000000000501"
)

var (
	fixedNow = time.Date(2026, 8, 11, 0, 0, 0, 0, time.UTC)
	testKey  = []byte("0123456789abcdef0123456789abcdef")
)

type fakeRuntime struct {
	mu                       sync.Mutex
	starts                   int
	stops                    int
	health                   int
	applicationFetches       int
	lastApplicationFetch     ApplicationFetchPayload
	workerControls           int
	lastWorkerControl        WorkerControlPayload
	workerControlError       error
	startError               error
	lastSpec                 WorkerStartPayload
	projections              int
	lastProjection           SandboxFileProjection
	conflictStates           []ExclusiveConflictState
	drained                  []string
	restored                 []string
	maintenancePreflights    int
	lastMaintenancePreflight MaintenancePreflightPayload
}

func (f *fakeRuntime) InspectAppliance(_ context.Context, ownership Ownership) (ApplianceIdentity, error) {
	return ApplianceIdentity{NodeID: ownership.NodeID, NodeGeneration: ownership.NodeGeneration,
		ImageDigest: "sha256:" + strings.Repeat("a", 64), ConfigurationDigest: "sha256:" + strings.Repeat("b", 64),
		Healthy: true, RuntimeIdentities: []json.RawMessage{}}, nil
}

func (f *fakeRuntime) InspectMaintenancePreflight(_ context.Context, payload MaintenancePreflightPayload, ownership Ownership) (MaintenancePreflightEvidence, error) {
	f.maintenancePreflights++
	f.lastMaintenancePreflight = payload
	return MaintenancePreflightEvidence{PlanID: payload.PlanID, NodeID: ownership.NodeID, NodeGeneration: ownership.NodeGeneration,
		Passed: true, Blockers: []string{}, Warnings: []string{"managed_workloads_require_drain"}, Architecture: "arm64",
		DockerVersion: "28.3.3", DockerAPIVersion: "1.51", KernelVersion: "6.14.0", OperatingSystem: "linux",
		SecureBootState: "enabled", NvidiaContainerIntegrationAvailable: true, NvidiaContainerIntegrationMode: "cdi", ActiveManagedWorkloads: 2,
		EvidenceDigest: "sha256:" + strings.Repeat("a", 64)}, nil
}

func (f *fakeRuntime) ListExclusiveConflicts(_ context.Context, _ []ExclusiveDrainTarget) ([]ExclusiveConflictState, error) {
	return append([]ExclusiveConflictState(nil), f.conflictStates...), nil
}

func (f *fakeRuntime) DrainExclusiveConflict(_ context.Context, target ExclusiveDrainTarget) (ExclusiveConflictState, error) {
	f.drained = append(f.drained, target.TargetKey)
	return ExclusiveConflictState{WorkerID: target.TargetKey, ContainerName: target.ContainerName, State: "exited", WasRunning: true, LeasesReleased: true}, nil
}

func (f *fakeRuntime) RestoreExclusiveConflict(_ context.Context, target ExclusiveDrainTarget) (ExclusiveConflictState, error) {
	f.restored = append(f.restored, target.TargetKey)
	return ExclusiveConflictState{WorkerID: target.TargetKey, ContainerName: target.ContainerName, State: "running", Health: "healthy", WasRunning: true, LeasesReleased: true}, nil
}

func (f *fakeRuntime) StartWorker(_ context.Context, spec WorkerStartPayload, _ Ownership) (WorkerState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts++
	f.lastSpec = spec
	if f.startError != nil {
		return WorkerState{}, f.startError
	}
	return WorkerState{WorkerID: spec.WorkerID, ContainerID: "container-a", Status: "running", Health: "healthy", Image: spec.Image}, nil
}

func (f *fakeRuntime) StopWorker(_ context.Context, id string, _ int, _ Ownership) (WorkerState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops++
	return WorkerState{WorkerID: id, ContainerID: "container-a", Status: "removed", Health: "stopped"}, nil
}

func (f *fakeRuntime) WorkerHealth(_ context.Context, id string, _ Ownership) (WorkerState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.health++
	return WorkerState{WorkerID: id, ContainerID: "container-a", Status: "running", Health: "healthy"}, nil
}

func (f *fakeRuntime) ForwardWorkerControl(_ context.Context, payload WorkerControlPayload, _ Ownership) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.workerControls++
	f.lastWorkerControl = payload
	if f.workerControlError != nil {
		return nil, f.workerControlError
	}
	return json.RawMessage(`{"protocolVersion":1,"status":"forwarded"}`), nil
}

func (f *fakeRuntime) FetchApplication(_ context.Context, payload ApplicationFetchPayload, _ Ownership) (ApplicationContent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.applicationFetches++
	f.lastApplicationFetch = payload
	return ApplicationContent{Status: 200, Headers: map[string]string{"content-type": "text/html; charset=utf-8"}, Body: []byte("ready")}, nil
}

func (f *fakeRuntime) ProjectSandboxFile(_ context.Context, projection SandboxFileProjection, _ Ownership) (SandboxFileState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.projections++
	f.lastProjection = projection
	f.lastProjection.Contents = append([]byte(nil), projection.Contents...)
	return SandboxFileState{WorkerID: projection.WorkerID, FileClass: projection.FileClass, ContentSHA256: projection.ContentSHA256, Bytes: len(projection.Contents)}, nil
}

type memoryEvents struct {
	mu     sync.Mutex
	events []WorkerEvent
}

func (m *memoryEvents) Publish(event WorkerEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append(m.events, event)
	return nil
}

func validStart() WorkerStartPayload {
	return WorkerStartPayload{
		WorkerID: workerID, AttemptID: attemptID, ModelProfileID: profileID,
		Image:   "registry.local/teamaibox/worker@sha256:" + strings.Repeat("a", 64),
		Network: "compute-internal",
		Limits: ResourceLimits{
			MemoryBytes: 1 << 30, CPUQuotaMicros: 100_000, PidsLimit: 128,
			EphemeralBytes: 10 << 30, OpenFilesLimit: 4096,
		},
		Security: SecurityProfile{
			RunAsUID: 10001, RunAsGID: 10001, ReadOnlyRoot: true,
			DropAllCaps: true, NoNewPrivileges: true,
		},
		Mounts:  []VolumeMount{{Type: "volume", Source: "teamaibox-worker-data-a", Target: "/var/lib/teamaibox/worker/data"}},
		Devices: []string{"nvidia.com/gpu=all"},
		Environment: map[string]string{
			"TEAMAIBOX_MODEL_PROFILE_ID":  profileID,
			"TEAMAIBOX_WORKER_TOKEN_FILE": "/run/secrets/worker-token",
		},
		Command: []string{"serve", "--port", "9000"},
	}
}

func TestWorkerSharedMemoryIsExplicitAndBoundedByMemory(t *testing.T) {
	valid := validStart()
	valid.Limits.SharedMemoryBytes = 256 << 20
	if err := DefaultPolicy().ValidateStart(valid); err != nil {
		t.Fatalf("valid shared-memory limit was rejected: %v", err)
	}
	for _, invalid := range []int64{1, 2 << 30} {
		changed := validStart()
		changed.Limits.SharedMemoryBytes = invalid
		if err := DefaultPolicy().ValidateStart(changed); err == nil || err.Error() != "worker shared memory limit is invalid" {
			t.Fatalf("invalid shared-memory limit %d was not rejected: %v", invalid, err)
		}
	}
}

func validPluginStart(kind string) WorkerStartPayload {
	pluginID := "example.team-notes"
	digest := sha256.Sum256([]byte(pluginID))
	prefix := "teamaibox-plugin-" + hex.EncodeToString(digest[:])[:32]
	spec := validStart()
	spec.WorkloadKind = kind
	spec.PluginID = pluginID
	spec.AttemptID = ""
	spec.ModelProfileID = ""
	spec.Network = "none"
	spec.NetworkPolicyID = ""
	spec.APIScopes = []string{"files:read", "files:write"}
	spec.EgressHosts = nil
	spec.Mounts = []VolumeMount{
		{Type: "volume", Source: prefix + "-data", Target: "/var/lib/teamaibox/plugin/data"},
		{Type: "volume", Source: prefix + "-cache", Target: "/var/cache/teamaibox/plugin"},
	}
	spec.Devices = nil
	spec.Security.SeccompProfile = "teamaibox-plugin-v1"
	spec.Environment = map[string]string{
		"TEAMAIBOX_PLUGIN_ID":         pluginID,
		"TEAMAIBOX_PLUGIN_TOKEN_FILE": "/run/secrets/plugin-token",
	}
	if kind == "application-plugin" {
		spec.Network = "plugin-ingress"
		spec.ApplicationPort = 8080
	}
	return spec
}

func validAgentSandboxStart() WorkerStartPayload {
	owner := "00000000-0000-4000-8000-000000000701"
	sandboxKey, workspaceVolume := agentSandboxIdentity(owner)
	hosts := []string{"compute-gateway", "source-gateway"}
	payload := owner + "\n" + strings.Join(hosts, "\n")
	digest := sha256.Sum256([]byte(payload))
	return WorkerStartPayload{
		WorkerID: workerID, OwnerIdentityID: owner, SandboxKey: sandboxKey,
		WorkloadKind: "agent-sandbox",
		Image:        "registry.local/teamaibox/agent-sandbox@sha256:" + strings.Repeat("b", 64),
		Network:      "agent-egress-proxy", NetworkPolicyID: "sha256:" + hex.EncodeToString(digest[:]),
		EgressHosts: hosts,
		Limits: ResourceLimits{
			MemoryBytes: 8 << 30, CPUQuotaMicros: 400_000, PidsLimit: 512,
			EphemeralBytes: 8 << 30, WorkspaceBytes: 100 << 30, OpenFilesLimit: 65536,
		},
		Security: SecurityProfile{
			RunAsUID: 65532, RunAsGID: 65532, ReadOnlyRoot: true,
			DropAllCaps: true, NoNewPrivileges: true, SeccompProfile: "builtin",
		},
		Mounts:  []VolumeMount{{Type: "volume", Source: workspaceVolume, Target: "/workspace"}},
		Devices: nil,
		Environment: map[string]string{
			"TEAMAIBOX_SANDBOX_KEY":         sandboxKey,
			"TEAMAIBOX_COMPUTE_GATEWAY_URL": "http://compute-gateway:8080",
			"TEAMAIBOX_PIP_INDEX_URL":       "http://source-gateway:8080/pip/simple/",
			"TEAMAIBOX_NPM_REGISTRY_URL":    "http://source-gateway:8080/npm/registry/",
			"TEAMAIBOX_APT_PROXY_URL":       "http://source-gateway:8080/apt",
			"PIP_CONFIG_FILE":               "/run/teamaibox/source-config/pip.conf",
			"PIP_INDEX_URL":                 "http://source-gateway:8080/pip/simple/",
			"PIP_EXTRA_INDEX_URL":           "",
			"PIP_TRUSTED_HOST":              "source-gateway",
			"NPM_CONFIG_USERCONFIG":         "/run/teamaibox/source-config/npmrc",
			"NPM_CONFIG_REGISTRY":           "http://source-gateway:8080/npm/registry/",
			"APT_CONFIG":                    "/run/teamaibox/source-config/apt/apt.conf",
			"HOME":                          "/workspace/.teamaibox/home", "XDG_CONFIG_HOME": "/run/teamaibox/xdg-config",
			"XDG_DATA_HOME": "/workspace/.teamaibox/data", "XDG_CACHE_HOME": "/workspace/.teamaibox/cache",
			"OPENCODE_CONFIG": "/run/teamaibox/xdg-config/opencode/opencode.json", "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
			"OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_SHARE": "1", "OPENCODE_AUTO_SHARE": "false",
			"OPENCODE_PURE": "1", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1", "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1",
			"OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_EMBEDDED_WEB_UI": "1", "OPENCODE_PERMISSION": `{"*":"ask"}`,
		},
		Command: []string{"/opt/opencode/opencode", "serve", "--hostname", "127.0.0.1", "--port", "4096"},
	}
}

func TestAgentSandboxIsOwnerBoundNonRootAndHasNoHostOrGPUAccess(t *testing.T) {
	valid := validAgentSandboxStart()
	if err := DefaultPolicy().ValidateStart(valid); err != nil {
		t.Fatalf("valid Agent sandbox was rejected: %v", err)
	}
	cases := []struct {
		name string
		code string
		edit func(*WorkerStartPayload)
	}{
		{"cross-user-volume", "agent_sandbox_host_mount_denied", func(spec *WorkerStartPayload) { spec.Mounts[0].Source = "teamaibox-agent-other-workspace" }},
		{"host-mount", "agent_sandbox_host_mount_denied", func(spec *WorkerStartPayload) {
			spec.Mounts[0] = VolumeMount{Type: "bind", Source: "/", Target: "/host"}
		}},
		{"docker-socket", "agent_sandbox_security_denied", func(spec *WorkerStartPayload) { spec.Security.DockerSocket = true }},
		{"gpu", "agent_sandbox_device_denied", func(spec *WorkerStartPayload) { spec.Devices = []string{"nvidia.com/gpu=all"} }},
		{"root", "agent_sandbox_security_denied", func(spec *WorkerStartPayload) { spec.Security.RunAsUID = 0 }},
		{"seccomp", "agent_sandbox_security_denied", func(spec *WorkerStartPayload) { spec.Security.SeccompProfile = "unconfined" }},
		{"quota", "agent_sandbox_resource_limit_denied", func(spec *WorkerStartPayload) { spec.Limits.PidsLimit = 0 }},
		{"password-env", "agent_sandbox_environment_denied", func(spec *WorkerStartPayload) { spec.Environment["OPENCODE_SERVER_PASSWORD"] = "raw-secret" }},
	}
	for _, testCase := range cases {
		spec := validAgentSandboxStart()
		testCase.edit(&spec)
		if err := DefaultPolicy().ValidateStart(spec); err == nil || err.Error() != testCase.code {
			t.Errorf("%s expected %s, got %v", testCase.name, testCase.code, err)
		}
	}
}

func TestApplicationPluginSandboxIsEnforcedAndAuditedBeforeDocker(t *testing.T) {
	service, runtime, events := serviceFixture(t)
	valid := validPluginStart("application-plugin")
	command := envelope(t, "00000000-0000-4000-8000-000000000641", "worker.start", valid, 1)
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-plugin-valid"))
	if err != nil || result.Status != "succeeded" || runtime.starts != 1 {
		t.Fatalf("valid plugin sandbox was rejected: %#v %v", result, err)
	}

	cases := []struct {
		name   string
		mutate func(*WorkerStartPayload)
		code   string
	}{
		{"root", func(spec *WorkerStartPayload) { spec.Security.RunAsUID = 0 }, "plugin_sandbox_security_denied"},
		{"host mount", func(spec *WorkerStartPayload) {
			spec.Mounts[0] = VolumeMount{Type: "bind", Source: "/etc", Target: "/host"}
		}, "plugin_sandbox_host_mount_denied"},
		{"docker socket", func(spec *WorkerStartPayload) { spec.Security.DockerSocket = true }, "plugin_sandbox_security_denied"},
		{"seccomp", func(spec *WorkerStartPayload) { spec.Security.SeccompProfile = "unconfined" }, "plugin_sandbox_security_denied"},
		{"scope", func(spec *WorkerStartPayload) { spec.APIScopes = []string{"admin:root"} }, "plugin_sandbox_api_scope_denied"},
		{"device", func(spec *WorkerStartPayload) { spec.Devices = []string{"nvidia.com/gpu=all"} }, "plugin_sandbox_device_denied"},
	}
	for index, testCase := range cases {
		spec := validPluginStart("application-plugin")
		testCase.mutate(&spec)
		commandID := []string{
			"00000000-0000-4000-8000-000000000642",
			"00000000-0000-4000-8000-000000000643",
			"00000000-0000-4000-8000-000000000644",
			"00000000-0000-4000-8000-000000000645",
			"00000000-0000-4000-8000-000000000646",
			"00000000-0000-4000-8000-000000000647",
		}[index]
		failed := envelope(t, commandID, "worker.start", spec, 1)
		denied, handleErr := service.Handle(context.Background(), failed, proof(t, failed, "nonce-plugin-"+testCase.name))
		if handleErr != nil || denied.Status != "failed" || denied.ErrorCode != testCase.code {
			t.Fatalf("%s denial was not stable: %#v %v", testCase.name, denied, handleErr)
		}
	}
	if runtime.starts != 1 {
		t.Fatalf("sandbox denials reached Docker: starts=%d", runtime.starts)
	}
	for _, event := range events.events[1:] {
		if event.Type != "worker.command_failed" || !strings.Contains(string(event.Payload), "plugin_sandbox_") || strings.Contains(string(event.Payload), "/etc") {
			t.Fatalf("sandbox denial audit event is unsafe: %#v", event)
		}
	}
}

func TestComputePluginEgressPolicyIDAndDeviceClassesAreBound(t *testing.T) {
	spec := validPluginStart("compute-plugin")
	spec.Network = "plugin-egress-proxy"
	spec.EgressHosts = []string{"api.example.test", "models.example.test"}
	payload := spec.PluginID + "\n" + strings.Join(spec.EgressHosts, "\n")
	digest := sha256.Sum256([]byte(payload))
	spec.NetworkPolicyID = "sha256:" + hex.EncodeToString(digest[:])
	spec.Devices = []string{"nvidia.com/gpu=all", "nvidia.com/nvdec=all", "nvidia.com/nvenc=all"}
	if err := DefaultPolicy().ValidateStart(spec); err != nil {
		t.Fatalf("valid compute plugin sandbox was rejected: %v", err)
	}
	spec.NetworkPolicyID = "sha256:" + strings.Repeat("0", 64)
	if err := DefaultPolicy().ValidateStart(spec); err == nil || err.Error() != "plugin_sandbox_network_policy_invalid" {
		t.Fatalf("network policy substitution was accepted: %v", err)
	}
}

func envelope(t *testing.T, commandID, commandType string, payload any, fence uint64) CommandEnvelope {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return CommandEnvelope{
		ProtocolVersion: 1, CommandID: commandID, NodeID: nodeID, NodeGeneration: nodeGeneration, Type: commandType,
		IssuedAt: fixedNow.Add(-time.Second), DeadlineAt: fixedNow.Add(time.Minute),
		CorrelationID: "request-node-agent-0001", LeaseID: leaseID,
		FencingToken: fence, Idempotency: "keyed", Payload: body,
	}
}

func proof(t *testing.T, command CommandEnvelope, nonce string) AuthProof {
	t.Helper()
	signature, err := SignCommand(command, "scheduler-a", nonce, testKey)
	if err != nil {
		t.Fatal(err)
	}
	return AuthProof{KeyID: "scheduler-a", Nonce: nonce, Signature: signature}
}

func serviceFixture(t *testing.T) (*Service, *fakeRuntime, *memoryEvents) {
	t.Helper()
	authenticator, err := NewAuthenticator(nodeID, map[string][]byte{"scheduler-a": testKey})
	if err != nil {
		t.Fatal(err)
	}
	runtime := &fakeRuntime{}
	events := &memoryEvents{}
	policy := DefaultPolicy()
	policy.AllowedPublishedPorts[18086] = true
	service, err := NewService(nodeID, nodeGeneration, authenticator, policy, runtime, events)
	if err != nil {
		t.Fatal(err)
	}
	service.SetClock(func() time.Time { return fixedNow })
	return service, runtime, events
}

func TestExclusiveConflictCommandsUseOnlyFixedPolicyTargets(t *testing.T) {
	authenticator, err := NewAuthenticator(nodeID, map[string][]byte{"scheduler-a": testKey})
	if err != nil {
		t.Fatal(err)
	}
	runtime := &fakeRuntime{conflictStates: []ExclusiveConflictState{{WorkerID: "ocr.vlm", ContainerName: "ocr-vlm", State: "running", WasRunning: true}}}
	events := &memoryEvents{}
	policy := DefaultPolicy()
	policy.ExclusiveDrainTargets["ocr.vlm"] = ExclusiveDrainTarget{TargetKey: "ocr.vlm", ContainerName: "ocr-vlm", RequiredLabels: map[string]string{"com.teamaibox.component": "ocr-worker"}}
	service, err := NewService(nodeID, nodeGeneration, authenticator, policy, runtime, events)
	if err != nil {
		t.Fatal(err)
	}
	service.SetClock(func() time.Time { return fixedNow })
	job := "00000000-0000-4000-8000-000000000701"
	list := envelope(t, "00000000-0000-4000-8000-000000000702", "worker.conflicts.list", ExclusiveConflictListPayload{ExclusiveJobID: job}, 11)
	listed, err := service.Handle(context.Background(), list, proof(t, list, "nonce-exclusive-list"))
	if err != nil || listed.Status != "succeeded" || !strings.Contains(string(listed.Payload), `"workerId":"ocr.vlm"`) {
		t.Fatalf("conflict listing failed: %#v %v", listed, err)
	}
	drain := envelope(t, "00000000-0000-4000-8000-000000000703", "worker.conflict.drain", ExclusiveConflictWorkerPayload{ExclusiveJobID: job, TargetKey: "ocr.vlm"}, 11)
	drained, err := service.Handle(context.Background(), drain, proof(t, drain, "nonce-exclusive-drain"))
	if err != nil || drained.Status != "succeeded" || len(runtime.drained) != 1 || runtime.drained[0] != "ocr.vlm" {
		t.Fatalf("conflict drain failed: %#v %v", drained, err)
	}
	restore := envelope(t, "00000000-0000-4000-8000-000000000704", "worker.conflict.restore", ExclusiveConflictWorkerPayload{ExclusiveJobID: job, TargetKey: "ocr.vlm"}, 11)
	restored, err := service.Handle(context.Background(), restore, proof(t, restore, "nonce-exclusive-restore"))
	if err != nil || restored.Status != "succeeded" || len(runtime.restored) != 1 {
		t.Fatalf("conflict restore failed: %#v %v", restored, err)
	}
	denied := envelope(t, "00000000-0000-4000-8000-000000000705", "worker.conflict.drain", ExclusiveConflictWorkerPayload{ExclusiveJobID: job, TargetKey: "unlisted.worker"}, 11)
	result, err := service.Handle(context.Background(), denied, proof(t, denied, "nonce-exclusive-denied"))
	if err != nil || result.Status != "failed" || result.ErrorCode != "exclusive_drain_target_denied" || len(runtime.drained) != 1 {
		t.Fatalf("unlisted conflict target was not denied: %#v %v", result, err)
	}
}

func TestMaintenancePreflightIsReadOnlyFencedAndStrictlyBounded(t *testing.T) {
	service, runtime, events := serviceFixture(t)
	planID := "00000000-0000-4000-8000-000000000710"
	payload := MaintenancePreflightPayload{PlanID: planID, Kind: "host", CandidateDigest: "sha256:" + strings.Repeat("b", 64),
		ExpectedArchitecture: "arm64", MinimumDockerAPIVersion: "1.48", RequireNvidiaContainerIntegration: true,
		AllowedSecureBootStates: []string{"enabled"}}
	command := envelope(t, "00000000-0000-4000-8000-000000000711", "maintenance.preflight", payload, 12)
	command.LeaseID = planID
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-maintenance-preflight"))
	if err != nil || result.Status != "succeeded" || runtime.maintenancePreflights != 1 ||
		runtime.lastMaintenancePreflight.CandidateDigest != payload.CandidateDigest || !strings.Contains(string(result.Payload), `"passed":true`) {
		t.Fatalf("maintenance preflight failed: %#v %v runtime=%#v", result, err, runtime)
	}
	if len(events.events) != 1 || events.events[0].Type != "maintenance.preflight_observed" || strings.Contains(string(events.events[0].Payload), "KernelVersion") {
		t.Fatalf("maintenance preflight event was missing or overexposed: %#v", events.events)
	}

	invalid := payload
	invalid.AllowedSecureBootStates = []string{"enabled", "enabled"}
	command = envelope(t, "00000000-0000-4000-8000-000000000712", "maintenance.preflight", invalid, 13)
	command.LeaseID = planID
	result, err = service.Handle(context.Background(), command, proof(t, command, "nonce-maintenance-invalid"))
	if err != nil || result.Status != "failed" || result.ErrorCode != "invalid_maintenance_preflight_payload" || runtime.maintenancePreflights != 1 {
		t.Fatalf("invalid maintenance request reached the runtime: %#v %v", result, err)
	}
}

func TestAuthenticatedStartIsFencedIdempotentAndReported(t *testing.T) {
	service, runtime, events := serviceFixture(t)
	command := envelope(t, "00000000-0000-4000-8000-000000000601", "worker.start", validStart(), 4)
	auth := proof(t, command, "nonce-a")

	result, err := service.Handle(context.Background(), command, auth)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := service.Handle(context.Background(), command, auth)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || result.ContainerID != "container-a" || replay.ContainerID != result.ContainerID {
		t.Fatalf("unexpected command results: %#v %#v", result, replay)
	}
	if runtime.starts != 1 {
		t.Fatalf("idempotent replay started %d workers", runtime.starts)
	}
	if len(events.events) != 1 || events.events[0].Type != "worker.started" || events.events[0].FencingToken != 4 {
		t.Fatalf("worker event was not reported exactly once: %#v", events.events)
	}
}

func TestAuthenticatedCommandFromAnOldNodeGenerationIsRejectedBeforeRuntime(t *testing.T) {
	service, runtime, _ := serviceFixture(t)
	command := envelope(t, "00000000-0000-4000-8000-000000000611", "worker.start", validStart(), 4)
	command.NodeGeneration = nodeGeneration - 1
	if _, err := service.Handle(context.Background(), command, proof(t, command, "nonce-old-generation")); !errors.Is(err, ErrStaleNodeGeneration) {
		t.Fatalf("expected stale node generation, got %v", err)
	}
	if runtime.starts != 0 {
		t.Fatal("stale node generation reached the container runtime")
	}
}

func TestAuthenticationDeadlineAndNonceReplayFailClosed(t *testing.T) {
	service, runtime, _ := serviceFixture(t)
	command := envelope(t, "00000000-0000-4000-8000-000000000601", "worker.start", validStart(), 1)
	badProof := proof(t, command, "nonce-a")
	badProof.Signature = "not-a-valid-signature"
	if _, err := service.Handle(context.Background(), command, badProof); !errors.Is(err, ErrAuthentication) {
		t.Fatalf("expected authentication failure, got %v", err)
	}

	expired := command
	expired.CommandID = "00000000-0000-4000-8000-000000000602"
	expired.IssuedAt = fixedNow.Add(-2 * time.Minute)
	expired.DeadlineAt = fixedNow.Add(-time.Minute)
	if _, err := service.Handle(context.Background(), expired, proof(t, expired, "nonce-expired")); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected deadline failure, got %v", err)
	}

	if _, err := service.Handle(context.Background(), command, proof(t, command, "nonce-a")); err != nil {
		t.Fatalf("valid command used to reserve nonce failed: %v", err)
	}
	other := command
	other.CommandID = "00000000-0000-4000-8000-000000000603"
	if _, err := service.Handle(context.Background(), other, proof(t, other, "nonce-a")); !errors.Is(err, ErrReplay) {
		t.Fatalf("expected nonce replay failure, got %v", err)
	}
	if runtime.starts != 1 {
		t.Fatalf("authentication failures reached the runtime: starts=%d", runtime.starts)
	}
}

func TestImageSecurityMountAndEnvironmentPolicyRejectBeforeDocker(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*WorkerStartPayload)
	}{
		{"tagged image", func(spec *WorkerStartPayload) { spec.Image = "registry.local/worker:latest" }},
		{"root user", func(spec *WorkerStartPayload) { spec.Security.RunAsUID = 0 }},
		{"privileged", func(spec *WorkerStartPayload) { spec.Security.Privileged = true }},
		{"host network", func(spec *WorkerStartPayload) { spec.Network = "host" }},
		{"host mount", func(spec *WorkerStartPayload) {
			spec.Mounts[0] = VolumeMount{Type: "bind", Source: "/", Target: "/host"}
		}},
		{"docker socket", func(spec *WorkerStartPayload) { spec.Security.DockerSocket = true }},
		{"unknown device", func(spec *WorkerStartPayload) { spec.Devices = []string{"/dev/kvm"} }},
		{"raw secret", func(spec *WorkerStartPayload) { spec.Environment["DATABASE_PASSWORD"] = "plaintext" }},
		{"missing limits", func(spec *WorkerStartPayload) { spec.Limits.MemoryBytes = 0 }},
	}
	for index, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			service, runtime, _ := serviceFixture(t)
			spec := validStart()
			testCase.mutate(&spec)
			commandID := "00000000-0000-4000-8000-" + strings.Repeat("0", 11) + string(rune('1'+index))
			// Use explicit valid UUIDs because the last rune construction above is only for uniqueness.
			commandID = []string{
				"00000000-0000-4000-8000-000000000611", "00000000-0000-4000-8000-000000000612",
				"00000000-0000-4000-8000-000000000613", "00000000-0000-4000-8000-000000000614",
				"00000000-0000-4000-8000-000000000615", "00000000-0000-4000-8000-000000000616",
				"00000000-0000-4000-8000-000000000617", "00000000-0000-4000-8000-000000000618",
				"00000000-0000-4000-8000-000000000619",
			}[index]
			command := envelope(t, commandID, "worker.start", spec, 1)
			result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-policy-"+testCase.name))
			if err != nil {
				t.Fatal(err)
			}
			if result.Status != "failed" || result.ErrorCode == "" || runtime.starts != 0 {
				t.Fatalf("policy did not fail before runtime: %#v starts=%d", result, runtime.starts)
			}
		})
	}
}

func TestComputeWorkerPublishedPortRequiresAnExactNodeAllowlist(t *testing.T) {
	spec := validStart()
	spec.Network = "compute-internal"
	spec.PublishedPorts = []PublishedPort{{ContainerPort: 8000, HostPort: 18086, HostIP: "10.64.0.18"}}
	if err := DefaultPolicy().ValidateStart(spec); err == nil || err.Error() != "worker published port is not allowed" {
		t.Fatalf("default-deny published port was accepted: %v", err)
	}
	policy := DefaultPolicy()
	policy.AllowedPublishedPorts[18086] = true
	if err := policy.ValidateStart(spec); err != nil {
		t.Fatalf("exact allowlisted management port was rejected: %v", err)
	}
	for _, attack := range []PublishedPort{
		{ContainerPort: 8000, HostPort: 18087, HostIP: "10.64.0.18"},
		{ContainerPort: 8000, HostPort: 18086, HostIP: "0.0.0.0"},
		{ContainerPort: 8000, HostPort: 18086, HostIP: "not-an-ip"},
	} {
		changed := spec
		changed.PublishedPorts = []PublishedPort{attack}
		if err := policy.ValidateStart(changed); err == nil {
			t.Fatalf("unsafe published port was accepted: %#v", attack)
		}
	}
	plugin := validPluginStart("compute-plugin")
	plugin.PublishedPorts = spec.PublishedPorts
	if err := policy.ValidateStart(plugin); err == nil {
		t.Fatal("compute plugin published a host port outside the application ingress boundary")
	}
	application := validPluginStart("application-plugin")
	if err := policy.ValidateStart(application); err != nil {
		t.Fatalf("Node-Agent-proxied isolated application ingress was rejected: %v", err)
	}
	application.ApplicationPort = 0
	if err := policy.ValidateStart(application); err == nil || err.Error() != "plugin_sandbox_ingress_denied" {
		t.Fatalf("application plugin without an internal port was accepted: %v", err)
	}
	application = validPluginStart("application-plugin")
	application.PublishedPorts = []PublishedPort{{ContainerPort: 8080, HostPort: 18086, HostIP: "10.64.0.18"}}
	if err := policy.ValidateStart(application); err == nil {
		t.Fatal("application plugin exposed an unauthenticated LAN port")
	}
}

func TestApplicationFetchIsFencedAuthenticatedAndPathBound(t *testing.T) {
	service, runtime, events := serviceFixture(t)
	payload := ApplicationFetchPayload{WorkerID: workerID, Method: "GET", Path: "/plugins/example.team-notes?locale=zh-CN&theme=dark"}
	command := envelope(t, "00000000-0000-4000-8000-000000000648", "worker.application.fetch", payload, 3)
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-plugin-fetch"))
	if err != nil || result.Status != "succeeded" || runtime.applicationFetches != 1 || runtime.lastApplicationFetch != payload {
		t.Fatalf("valid application fetch failed: %#v %#v %v", result, runtime.lastApplicationFetch, err)
	}
	var content ApplicationContent
	if json.Unmarshal(result.Payload, &content) != nil || content.Status != 200 || string(content.Body) != "ready" {
		t.Fatalf("application content result is invalid: %#v", content)
	}
	if len(events.events) != 1 || events.events[0].Type != "worker.application_fetched" || strings.Contains(string(events.events[0].Payload), "ready") {
		t.Fatalf("application body leaked into the event stream: %#v", events.events)
	}
	for index, invalid := range []ApplicationFetchPayload{
		{WorkerID: workerID, Method: "POST", Path: "/plugins/example.team-notes"},
		{WorkerID: workerID, Method: "GET", Path: "http://attacker.invalid/plugins/example.team-notes"},
		{WorkerID: workerID, Method: "GET", Path: "/health/ready"},
	} {
		commandID := []string{"00000000-0000-4000-8000-000000000649", "00000000-0000-4000-8000-000000000650", "00000000-0000-4000-8000-000000000653"}[index]
		deniedCommand := envelope(t, commandID, "worker.application.fetch", invalid, 3)
		denied, deniedErr := service.Handle(context.Background(), deniedCommand, proof(t, deniedCommand, "nonce-plugin-fetch-denied"+string(rune('a'+index))))
		if deniedErr != nil || denied.Status != "failed" || denied.ErrorCode != "invalid_application_fetch_payload" {
			t.Fatalf("invalid application fetch was not rejected: %#v %v", denied, deniedErr)
		}
	}
	if runtime.applicationFetches != 1 {
		t.Fatalf("invalid application fetch reached runtime: %d", runtime.applicationFetches)
	}
}

func TestWorkerControlIsFencedAuthenticatedAndContentSafe(t *testing.T) {
	service, runtime, events := serviceFixture(t)
	control := map[string]any{
		"protocolVersion": 1, "messageId": "00000000-0000-4000-8000-000000000801",
		"workerId": workerID, "type": "worker.execute.request", "leaseId": "00000000-0000-4000-8000-000000000809",
		"fencingToken": 19, "correlationId": "worker.control.test", "payload": map[string]any{"generation": 2},
	}
	request, _ := json.Marshal(control)
	command := envelope(t, "00000000-0000-4000-8000-000000000802", "worker.control", WorkerControlPayload{WorkerID: workerID, Request: request}, 6)
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-worker-control"))
	if err != nil || result.Status != "succeeded" || runtime.workerControls != 1 || runtime.lastWorkerControl.WorkerID != workerID {
		t.Fatalf("valid worker control failed: %#v %#v %v", result, runtime.lastWorkerControl, err)
	}
	if len(events.events) != 1 || events.events[0].Type != "worker.control_forwarded" || strings.Contains(string(events.events[0].Payload), "generation") {
		t.Fatalf("worker control content leaked into events: %#v", events.events)
	}

	control["fencingToken"] = 0
	stale, _ := json.Marshal(control)
	deniedCommand := envelope(t, "00000000-0000-4000-8000-000000000803", "worker.control", WorkerControlPayload{WorkerID: workerID, Request: stale}, 6)
	denied, deniedErr := service.Handle(context.Background(), deniedCommand, proof(t, deniedCommand, "nonce-worker-control-stale"))
	if deniedErr != nil || denied.Status != "failed" || denied.ErrorCode != "worker_control_fence_mismatch" || runtime.workerControls != 1 {
		t.Fatalf("stale worker control reached runtime: %#v %v calls=%d", denied, deniedErr, runtime.workerControls)
	}
}

func TestWorkerControlRuntimeErrorsUseAStableContentSafeCode(t *testing.T) {
	service, runtime, events := serviceFixture(t)
	runtime.workerControlError = errors.New("worker control target is unhealthy")
	control := map[string]any{
		"protocolVersion": 1, "messageId": "00000000-0000-4000-8000-000000000811",
		"workerId": workerID, "type": "worker.prepare.request", "leaseId": leaseID,
		"fencingToken": 6, "correlationId": "worker.control.failure", "payload": map[string]any{"generation": 2},
	}
	request, _ := json.Marshal(control)
	command := envelope(t, "00000000-0000-4000-8000-000000000812", "worker.control", WorkerControlPayload{WorkerID: workerID, Request: request}, 6)
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-worker-control-failure"))
	if err != nil || result.Status != "failed" || result.ErrorCode != "worker_control_failed" {
		t.Fatalf("runtime error was not normalized: %#v %v", result, err)
	}
	if len(events.events) != 1 || strings.Contains(string(events.events[0].Payload), "unhealthy") {
		t.Fatalf("runtime detail leaked into the event: %#v", events.events)
	}
}

func TestStaleFenceAndCommandIdentityConflictAreRejected(t *testing.T) {
	service, runtime, _ := serviceFixture(t)
	high := envelope(t, "00000000-0000-4000-8000-000000000621", "worker.health", WorkerHealthPayload{WorkerID: workerID}, 8)
	if _, err := service.Handle(context.Background(), high, proof(t, high, "nonce-high")); err != nil {
		t.Fatal(err)
	}
	low := envelope(t, "00000000-0000-4000-8000-000000000622", "worker.health", WorkerHealthPayload{WorkerID: workerID}, 7)
	if _, err := service.Handle(context.Background(), low, proof(t, low, "nonce-low")); err == nil || err.Error() != "stale_fencing_token" {
		t.Fatalf("expected stale fence, got %v", err)
	}

	changed := high
	changed.Type = "worker.stop"
	changed.Payload, _ = json.Marshal(WorkerStopPayload{WorkerID: workerID, GracePeriodSeconds: 5})
	if _, err := service.Handle(context.Background(), changed, proof(t, changed, "nonce-changed")); err == nil || err.Error() != "command_id_conflict" {
		t.Fatalf("expected command identity conflict, got %v", err)
	}
	if runtime.health != 1 || runtime.stops != 0 {
		t.Fatalf("unexpected runtime calls: health=%d stop=%d", runtime.health, runtime.stops)
	}
}

func TestRuntimeFailureIsDurablyIdempotentWithinAgentLifetime(t *testing.T) {
	service, runtime, events := serviceFixture(t)
	runtime.startError = errors.New("worker_start_failed")
	command := envelope(t, "00000000-0000-4000-8000-000000000631", "worker.start", validStart(), 2)
	auth := proof(t, command, "nonce-failure")
	first, err := service.Handle(context.Background(), command, auth)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Handle(context.Background(), command, auth)
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "failed" || first.ErrorCode != "worker_start_failed" || second.ErrorCode != first.ErrorCode {
		t.Fatalf("unexpected failure result: %#v %#v", first, second)
	}
	if runtime.starts != 1 || len(events.events) != 1 || events.events[0].Type != "worker.command_failed" {
		t.Fatalf("failed command was not idempotent/reported: starts=%d events=%#v", runtime.starts, events.events)
	}
}

func sandboxProjectionPayload(fileClass string, contents []byte) SandboxFileProjectPayload {
	owner := "00000000-0000-4000-8000-000000000701"
	sandboxKey, _ := agentSandboxIdentity(owner)
	digest := sha256.Sum256(contents)
	value := SandboxFileProjectPayload{
		WorkerID: workerID, OwnerIdentityID: owner, SandboxKey: sandboxKey,
		FileClass: fileClass, ContentBase64: base64.StdEncoding.EncodeToString(contents),
		ContentSHA256: hex.EncodeToString(digest[:]),
	}
	if fileClass == "model-token" {
		value.TokenID = "00000000-0000-4000-8000-000000000702"
		value.ExpiresAt = fixedNow.Add(5 * time.Minute)
	}
	return value
}

func TestSandboxModelTokenProjectionIsScopedFencedAndNeverEmitted(t *testing.T) {
	service, runtime, events := serviceFixture(t)
	token := []byte("scoped-agent-token-" + strings.Repeat("x", 48))
	payload := sandboxProjectionPayload("model-token", token)
	command := envelope(t, "00000000-0000-4000-8000-000000000651", "sandbox.file.project", payload, 7)
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-project-token"))
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || runtime.projections != 1 ||
		string(runtime.lastProjection.Contents) != string(token) || runtime.lastProjection.OwnerIdentityID != payload.OwnerIdentityID {
		t.Fatalf("unexpected sandbox projection: %#v %#v", result, runtime.lastProjection)
	}
	if len(events.events) != 1 || events.events[0].Type != "sandbox.file_projected" {
		t.Fatalf("projection event is missing: %#v", events.events)
	}
	secret := string(token)
	if strings.Contains(string(result.Payload), secret) || strings.Contains(string(events.events[0].Payload), secret) {
		t.Fatal("sandbox token leaked into a result or event")
	}
}

func TestSandboxOpenCodeConfigRejectsAnyNonPlatformProvider(t *testing.T) {
	service, runtime, _ := serviceFixture(t)
	config := []byte(`{"enabled_providers":["public"],"provider":{"public":{"options":{"baseURL":"https://example.test/v1","apiKey":"raw"}}}}`)
	payload := sandboxProjectionPayload("opencode-config", config)
	command := envelope(t, "00000000-0000-4000-8000-000000000652", "sandbox.file.project", payload, 7)
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-project-config"))
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "failed" || result.ErrorCode != "agent_sandbox_config_invalid" || runtime.projections != 0 {
		t.Fatalf("non-platform provider reached the runtime: %#v projections=%d", result, runtime.projections)
	}
}

func validOpenCodeConfigContents() []byte {
	return []byte(`{"$schema":"https://opencode.ai/config.json","autoupdate":false,"share":"disabled","autoshare":false,"plugin":[],"permission":"ask","enabled_providers":["teamaibox"],"model":"teamaibox/agent.default","small_model":"teamaibox/agent.default","provider":{"teamaibox":{"name":"Team AI Box","npm":"@ai-sdk/openai-compatible","env":[],"models":{"agent.default":{"id":"agent.default","name":"Team Default","tool_call":true,"limit":{"context":32768,"output":8192}}},"options":{"apiKey":"{file:/run/secrets/teamaibox-model-token}","baseURL":"http://compute-gateway:8080/v1"}}}}`)
}

func TestSandboxOpenCodeConfigAcceptsOnlyTheImmutablePlatformShape(t *testing.T) {
	service, runtime, _ := serviceFixture(t)
	payload := sandboxProjectionPayload("opencode-config", validOpenCodeConfigContents())
	command := envelope(t, "00000000-0000-4000-8000-000000000655", "sandbox.file.project", payload, 7)
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-project-valid-config"))
	if err != nil || result.Status != "succeeded" || runtime.projections != 1 {
		t.Fatalf("valid platform OpenCode configuration was rejected: %#v %v", result, err)
	}

	for name, replacement := range map[string]string{
		"public-share": strings.Replace(string(validOpenCodeConfigContents()), `"share":"disabled"`, `"share":"manual"`, 1),
		"plugin":       strings.Replace(string(validOpenCodeConfigContents()), `"plugin":[]`, `"plugin":["file:///workspace/plugin.mjs"]`, 1),
		"mcp":          strings.Replace(string(validOpenCodeConfigContents()), `"permission":"ask"`, `"mcp":{},"permission":"ask"`, 1),
		"permission":   strings.Replace(string(validOpenCodeConfigContents()), `"permission":"ask"`, `"permission":"allow"`, 1),
	} {
		service, runtime, _ = serviceFixture(t)
		payload = sandboxProjectionPayload("opencode-config", []byte(replacement))
		command = envelope(t, "00000000-0000-4000-8000-000000000656", "sandbox.file.project", payload, 7)
		result, err = service.Handle(context.Background(), command, proof(t, command, "nonce-project-config-"+name))
		if err != nil || result.Status != "failed" || result.ErrorCode != "agent_sandbox_config_invalid" || runtime.projections != 0 {
			t.Errorf("%s configuration was not rejected: %#v %v", name, result, err)
		}
	}
}

func sourceClientContents(t *testing.T, pipURL string) []byte {
	t.Helper()
	value := sourceClientConfig{
		SchemaVersion: 1,
		PipConf:       "[global]\nindex-url = " + pipURL + "\ntrusted-host = source-gateway\ndisable-pip-version-check = true\nno-input = true\n",
		NPMRC:         "registry=http://source-gateway:8080/npm/registry/\nalways-auth=false\naudit=false\nupdate-notifier=false\nfund=false\n",
		APTConf:       "Dir::Etc::sourcelist \"/run/teamaibox/source-config/apt/sources.list\";\nDir::Etc::sourceparts \"-\";\nAPT::Architecture \"arm64\";\nAcquire::AllowInsecureRepositories \"false\";\nAcquire::AllowDowngradeToInsecureRepositories \"false\";\n",
		APTSources:    "deb [arch=arm64 signed-by=/usr/share/keyrings/teamaibox-source-gateway.gpg] http://source-gateway:8080/apt teamaibox main\n",
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestSandboxSourceClientsArePinnedToInternalArm64Gateways(t *testing.T) {
	service, runtime, _ := serviceFixture(t)
	contents := sourceClientContents(t, "http://source-gateway:8080/pip/simple/")
	payload := sandboxProjectionPayload("source-client-config", contents)
	command := envelope(t, "00000000-0000-4000-8000-000000000653", "sandbox.file.project", payload, 7)
	result, err := service.Handle(context.Background(), command, proof(t, command, "nonce-project-sources"))
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || runtime.projections != 1 || runtime.lastProjection.FileClass != "source-client-config" {
		t.Fatalf("internal source configuration was not projected: %#v", result)
	}

	service, runtime, _ = serviceFixture(t)
	contents = sourceClientContents(t, "https://pypi.org/simple")
	payload = sandboxProjectionPayload("source-client-config", contents)
	command = envelope(t, "00000000-0000-4000-8000-000000000654", "sandbox.file.project", payload, 7)
	result, err = service.Handle(context.Background(), command, proof(t, command, "nonce-project-external-source"))
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "failed" || result.ErrorCode != "agent_sandbox_source_config_invalid" || runtime.projections != 0 {
		t.Fatalf("external package source reached the runtime: %#v", result)
	}
}

func TestAgentPackageInstallationCannotModifyTheApplianceHost(t *testing.T) {
	valid := validAgentSandboxStart()
	if err := DefaultPolicy().ValidateStart(valid); err != nil {
		t.Fatalf("valid Agent sandbox was rejected: %v", err)
	}
	if !valid.Security.ReadOnlyRoot || valid.Security.Privileged || valid.Security.HostPID || valid.Security.HostIPC || valid.Security.HostNetwork ||
		valid.Security.DockerSocket || len(valid.Devices) != 0 || len(valid.Mounts) != 1 || valid.Mounts[0].Type != "volume" || valid.Mounts[0].Target != "/workspace" {
		t.Fatalf("Agent APT confinement invariants are incomplete: %#v", valid)
	}
	if valid.Environment["APT_CONFIG"] != "/run/teamaibox/source-config/apt/apt.conf" || valid.Environment["TEAMAIBOX_APT_PROXY_URL"] != "http://source-gateway:8080/apt" {
		t.Fatalf("Agent APT escaped its internal configuration: %#v", valid.Environment)
	}
	for name, mutate := range map[string]func(*WorkerStartPayload){
		"host-root-bind": func(spec *WorkerStartPayload) {
			spec.Mounts = append(spec.Mounts, VolumeMount{Type: "bind", Source: "/", Target: "/host"})
		},
		"host-network":    func(spec *WorkerStartPayload) { spec.Security.HostNetwork = true },
		"host-apt-config": func(spec *WorkerStartPayload) { spec.Environment["APT_CONFIG"] = "/etc/apt/apt.conf" },
	} {
		attacked := validAgentSandboxStart()
		mutate(&attacked)
		if err := DefaultPolicy().ValidateStart(attacked); err == nil {
			t.Errorf("%s would let Agent package installation reach host state", name)
		}
	}
}
