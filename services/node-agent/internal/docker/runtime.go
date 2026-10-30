package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

// Keep the sentinel text protocol-safe so authenticated health inspection can
// distinguish an absent Worker from an arbitrary Docker/runtime failure. The
// error remains a package sentinel for existing errors.Is callers.
var ErrNotFound = errors.New("managed_worker_not_found")
var errProtectedStartResume = errors.New("exact protected resident start requires resume")

type Runner interface {
	Run(ctx context.Context, arguments ...string) (string, error)
}

type CLIRunner struct{ Binary string }

func (r CLIRunner) Run(ctx context.Context, arguments ...string) (string, error) {
	binary := r.Binary
	if binary == "" {
		binary = "docker"
	}
	command := exec.CommandContext(ctx, binary, arguments...)
	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("docker command %q failed", arguments[0])
	}
	return strings.TrimSpace(string(output)), nil
}

type Runtime struct{ runner Runner }

func NewRuntime(runner Runner) (*Runtime, error) {
	if runner == nil {
		return nil, fmt.Errorf("docker command runner is required")
	}
	return &Runtime{runner: runner}, nil
}

func (r *Runtime) Ready(ctx context.Context) error {
	output, err := r.runner.Run(ctx, "version", "--format", "{{.Server.Version}}")
	if err != nil || strings.TrimSpace(output) == "" {
		return fmt.Errorf("docker service is unavailable")
	}
	return nil
}

func containerName(workerID string) string { return "teamaibox-worker-" + workerID }

func canonicalRepository(repository string) string {
	repository = strings.TrimPrefix(repository, "index.docker.io/")
	repository = strings.TrimPrefix(repository, "docker.io/")
	if !strings.Contains(repository, "/") {
		repository = "library/" + repository
	}
	if strings.HasPrefix(repository, "library/") {
		return "docker.io/" + repository
	}
	// A first path component containing a dot or port is an explicit registry;
	// all other slash-containing names are Docker Hub namespaces.
	first, _, _ := strings.Cut(repository, "/")
	if strings.ContainsAny(first, ".:") || first == "localhost" {
		return repository
	}
	return "docker.io/" + repository
}

func repositoryDigestMatches(requested, exposed string) bool {
	requestedRepository, requestedDigest, requestedOK := strings.Cut(requested, "@")
	exposedRepository, exposedDigest, exposedOK := strings.Cut(exposed, "@")
	return requestedOK && exposedOK && requestedDigest == exposedDigest &&
		canonicalRepository(requestedRepository) == canonicalRepository(exposedRepository)
}

func (r *Runtime) verifyImage(ctx context.Context, reference string) error {
	// Docker save/load can omit RepoDigests. Offline installations pin the full
	// local content ID instead; never accept a tag or fetch an absent image.
	if digestID.MatchString(reference) {
		output, err := r.runner.Run(ctx, "image", "inspect", "--format", "{{json .}}", reference)
		var image imageInspectDocument
		if err != nil || json.Unmarshal([]byte(output), &image) != nil || !localContentImageMatches(reference, image) {
			return fmt.Errorf("offline worker image content identity is unavailable")
		}
		return nil
	}
	output, err := r.runner.Run(ctx, "image", "inspect", "--format", "{{json .RepoDigests}}", reference)
	if err != nil {
		return fmt.Errorf("pinned worker image is not available: %w", err)
	}
	var digests []string
	if err := json.Unmarshal([]byte(output), &digests); err != nil {
		return fmt.Errorf("docker image digest evidence is invalid")
	}
	for _, digest := range digests {
		if repositoryDigestMatches(reference, digest) {
			return nil
		}
	}
	return fmt.Errorf("local worker image does not expose the requested repository digest")
}

func labels(ownership agent.Ownership, spec agent.WorkerStartPayload) []string {
	kind := spec.WorkloadKind
	if kind == "" {
		kind = "compute-worker"
	}
	values := []string{
		"--label", "com.teamaibox.managed=true",
		"--label", "com.teamaibox.kind=" + kind,
		"--label", "com.teamaibox.node-id=" + ownership.NodeID,
		"--label", "com.teamaibox.node-generation=" + strconv.FormatInt(ownership.NodeGeneration, 10),
		"--label", "com.teamaibox.worker-id=" + spec.WorkerID,
		"--label", "com.teamaibox.attempt-id=" + spec.AttemptID,
		"--label", "com.teamaibox.lease-id=" + ownership.LeaseID,
		"--label", "com.teamaibox.fencing-token=" + strconv.FormatUint(ownership.FencingToken, 10),
		"--label", "com.teamaibox.image-digest=" + spec.Image,
		"--label", "com.teamaibox.start-command-id=" + ownership.CommandID,
		"--label", "com.teamaibox.start-command-digest=" + ownership.CommandDigest,
		"--label", "com.teamaibox.start-spec-digest=" + workerStartSpecDigest(spec),
		"--label", "com.teamaibox.model-profile-id=" + spec.ModelProfileID,
		"--label", "com.teamaibox.placement-class=" + agent.EffectivePlacementClass(spec.PlacementClass),
		"--label", "com.teamaibox.maintenance-generation=" + strconv.FormatInt(spec.MaintenanceGeneration, 10),
		"--label", "com.teamaibox.config-digest=" + spec.ConfigDigest,
	}
	if spec.PluginID != "" {
		values = append(values, "--label", "com.teamaibox.plugin-id="+spec.PluginID)
	}
	if spec.ApplicationPort > 0 {
		values = append(values, "--label", "com.teamaibox.application-port="+strconv.Itoa(spec.ApplicationPort))
	}
	if spec.NetworkPolicyID != "" {
		values = append(values, "--label", "com.teamaibox.network-policy-id="+spec.NetworkPolicyID)
	}
	if spec.OwnerIdentityID != "" {
		values = append(values, "--label", "com.teamaibox.owner-identity-id="+spec.OwnerIdentityID)
	}
	if spec.SandboxKey != "" {
		values = append(values, "--label", "com.teamaibox.sandbox-key="+spec.SandboxKey)
	}
	if spec.Limits.WorkspaceBytes > 0 {
		values = append(values, "--label", "com.teamaibox.workspace-quota-bytes="+strconv.FormatInt(spec.Limits.WorkspaceBytes, 10))
	}
	return values
}

func (r *Runtime) StartWorker(ctx context.Context, spec agent.WorkerStartPayload, ownership agent.Ownership) (agent.WorkerState, error) {
	if err := r.verifyImage(ctx, spec.Image); err != nil {
		return agent.WorkerState{}, err
	}
	if spec.WorkloadKind == "agent-sandbox" {
		if err := r.verifyAgentWorkspace(ctx, spec); err != nil {
			return agent.WorkerState{}, err
		}
	}
	name := containerName(spec.WorkerID)
	arguments := []string{
		"container", "create", "--name", name,
		"--read-only", "--user", fmt.Sprintf("%d:%d", spec.Security.RunAsUID, spec.Security.RunAsGID),
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
		"--pids-limit", strconv.FormatInt(spec.Limits.PidsLimit, 10),
		"--memory", strconv.FormatInt(spec.Limits.MemoryBytes, 10),
		"--memory-swap", strconv.FormatInt(spec.Limits.MemoryBytes, 10),
		"--cpu-period", "100000", "--cpu-quota", strconv.FormatInt(spec.Limits.CPUQuotaMicros, 10),
		"--ulimit", fmt.Sprintf("nofile=%d:%d", spec.Limits.OpenFilesLimit, spec.Limits.OpenFilesLimit),
	}
	tmpExecFlag := "noexec"
	if spec.TmpfsExecutable {
		tmpExecFlag = "exec"
	}
	arguments = append(arguments,
		"--tmpfs", "/tmp:rw,"+tmpExecFlag+",nosuid,nodev,size="+strconv.FormatInt(spec.Limits.EphemeralBytes, 10),
		"--network", spec.Network,
		"--restart", "no",
	)
	if spec.HealthCheck != nil {
		if len(spec.HealthCheck.Test) != 2 || spec.HealthCheck.Test[0] != "CMD-SHELL" {
			return agent.WorkerState{}, fmt.Errorf("exact exec-form healthcheck requires Docker Engine API runtime")
		}
		arguments = append(arguments,
			"--health-cmd", spec.HealthCheck.Test[1],
			"--health-interval", strconv.FormatInt(spec.HealthCheck.Interval, 10)+"ns",
			"--health-timeout", strconv.FormatInt(spec.HealthCheck.Timeout, 10)+"ns",
			"--health-start-period", strconv.FormatInt(spec.HealthCheck.StartPeriod, 10)+"ns",
			"--health-retries", strconv.Itoa(spec.HealthCheck.Retries),
		)
	}
	if spec.WorkloadKind == "agent-sandbox" {
		arguments = append(arguments, "--tmpfs", "/run/secrets:rw,noexec,nosuid,nodev,size=1048576,uid=0,gid=0,mode=0755")
		arguments = append(arguments, "--tmpfs", "/run/teamaibox:rw,noexec,nosuid,nodev,size=1048576,uid=0,gid=0,mode=0755")
	}
	seccompProfile := spec.Security.SeccompProfile
	if seccompProfile == "teamaibox-plugin-v1" {
		seccompProfile = "builtin"
	}
	if seccompProfile != "" {
		arguments = append(arguments, "--security-opt", "seccomp="+seccompProfile)
	}
	arguments = append(arguments, labels(ownership, spec)...)
	for _, mount := range spec.Mounts {
		value := "type=volume,source=" + mount.Source + ",target=" + mount.Target
		if mount.ReadOnly {
			value += ",readonly"
		}
		arguments = append(arguments, "--mount", value)
	}
	requestsGPU := false
	for _, device := range spec.Devices {
		switch device {
		case "nvidia.com/gpu=all", "nvidia.com/nvenc=all", "nvidia.com/nvdec=all":
			requestsGPU = true
		}
	}
	if requestsGPU {
		arguments = append(arguments, "--gpus", "all")
	}
	if len(spec.Entrypoint) > 1 {
		return agent.WorkerState{}, fmt.Errorf("multi-argument entrypoint requires Docker Engine API runtime")
	}
	if len(spec.Entrypoint) == 1 {
		arguments = append(arguments, "--entrypoint", spec.Entrypoint[0])
	}
	environmentNames := make([]string, 0, len(spec.Environment))
	for name := range spec.Environment {
		environmentNames = append(environmentNames, name)
	}
	sort.Strings(environmentNames)
	for _, name := range environmentNames {
		value := spec.Environment[name]
		arguments = append(arguments, "--env", name+"="+value)
	}
	arguments = append(arguments, spec.Image)
	arguments = append(arguments, spec.Command...)
	containerID, err := r.runner.Run(ctx, arguments...)
	if err != nil {
		state, replayError := r.inspectStartReplay(ctx, spec, ownership)
		if replayError == nil {
			return state, nil
		}
		if errors.Is(replayError, errProtectedStartResume) {
			if _, startErr := r.runner.Run(ctx, "container", "start", name); startErr != nil {
				return agent.WorkerState{}, fmt.Errorf("protected_resident_start_recovery_required")
			}
			return r.inspectStartReplay(ctx, spec, ownership)
		}
		if !errors.Is(replayError, ErrNotFound) {
			return agent.WorkerState{}, replayError
		}
		return agent.WorkerState{}, err
	}
	if _, err := r.runner.Run(ctx, "container", "start", containerID); err != nil {
		if agent.IsProtectedPlacement(spec.PlacementClass) {
			return agent.WorkerState{}, fmt.Errorf("protected_resident_start_recovery_required")
		}
		_, _ = r.runner.Run(context.Background(), "container", "rm", "--force", containerID)
		return agent.WorkerState{}, err
	}
	return r.inspect(ctx, spec.WorkerID, ownership)
}

func (r *Runtime) verifyAgentWorkspace(ctx context.Context, spec agent.WorkerStartPayload) error {
	if len(spec.Mounts) != 1 {
		return fmt.Errorf("Agent workspace declaration is invalid")
	}
	output, err := r.runner.Run(ctx, "volume", "inspect", spec.Mounts[0].Source)
	if err != nil {
		return fmt.Errorf("assigned Agent workspace volume is unavailable")
	}
	var documents []struct {
		Name   string            `json:"Name"`
		Labels map[string]string `json:"Labels"`
	}
	if err := json.Unmarshal([]byte(output), &documents); err != nil || len(documents) != 1 {
		return fmt.Errorf("Agent workspace volume evidence is invalid")
	}
	labels := documents[0].Labels
	if documents[0].Name != spec.Mounts[0].Source || labels["com.teamaibox.volume.class"] != "agent-workspace" ||
		labels["com.teamaibox.owner-identity-id"] != spec.OwnerIdentityID ||
		labels["com.teamaibox.sandbox-key"] != spec.SandboxKey ||
		labels["com.teamaibox.quota-bytes"] != strconv.FormatInt(spec.Limits.WorkspaceBytes, 10) {
		return fmt.Errorf("Agent workspace ownership or disk quota evidence does not match")
	}
	return nil
}

func (r *Runtime) inspectStartReplay(ctx context.Context, spec agent.WorkerStartPayload, ownership agent.Ownership) (agent.WorkerState, error) {
	state, err := r.inspect(ctx, spec.WorkerID, ownership)
	if err != nil {
		return agent.WorkerState{}, err
	}
	output, err := r.runner.Run(ctx, "container", "inspect", containerName(spec.WorkerID))
	if err != nil {
		return agent.WorkerState{}, ErrNotFound
	}
	var documents []inspectDocument
	if err := json.Unmarshal([]byte(output), &documents); err != nil || len(documents) != 1 {
		return agent.WorkerState{}, fmt.Errorf("docker inspect response is invalid")
	}
	labels := documents[0].Config.Labels
	if labels["com.teamaibox.start-spec-digest"] != workerStartSpecDigest(spec) ||
		labels["com.teamaibox.attempt-id"] != spec.AttemptID ||
		labels["com.teamaibox.model-profile-id"] != spec.ModelProfileID ||
		labels["com.teamaibox.image-digest"] != spec.Image || documents[0].Config.Image != spec.Image ||
		(spec.OwnerIdentityID != "" && labels["com.teamaibox.owner-identity-id"] != spec.OwnerIdentityID) ||
		(spec.SandboxKey != "" && labels["com.teamaibox.sandbox-key"] != spec.SandboxKey) {
		return agent.WorkerState{}, fmt.Errorf("existing worker does not match the replayed start command")
	}
	if state.Status != "running" {
		if agent.IsProtectedPlacement(spec.PlacementClass) && (state.Status == "created" || state.Status == "exited") {
			return state, errProtectedStartResume
		}
		return agent.WorkerState{}, fmt.Errorf("existing worker is not running for the replayed start command")
	}
	return state, nil
}

type inspectDocument struct {
	ID     string `json:"Id"`
	Name   string `json:"Name"`
	Image  string `json:"Image"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		RW          bool   `json:"RW"`
		Propagation string `json:"Propagation"`
	} `json:"Mounts"`
	State struct {
		Status    string `json:"Status"`
		StartedAt string `json:"StartedAt"`
		OOMKilled bool   `json:"OOMKilled"`
		Health    *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	Config struct {
		Image        string              `json:"Image"`
		User         string              `json:"User"`
		Env          []string            `json:"Env"`
		Cmd          []string            `json:"Cmd"`
		Entrypoint   []string            `json:"Entrypoint"`
		ExposedPorts map[string]struct{} `json:"ExposedPorts"`
		Labels       map[string]string   `json:"Labels"`
		Healthcheck  *engineHealthConfig `json:"Healthcheck"`
	} `json:"Config"`
	HostConfig struct {
		NetworkMode       string                         `json:"NetworkMode"`
		IpcMode           string                         `json:"IpcMode"`
		PidMode           string                         `json:"PidMode"`
		ShmSize           int64                          `json:"ShmSize"`
		ReadonlyRootfs    bool                           `json:"ReadonlyRootfs"`
		Privileged        bool                           `json:"Privileged"`
		CapDrop           []string                       `json:"CapDrop"`
		SecurityOpt       []string                       `json:"SecurityOpt"`
		PidsLimit         int64                          `json:"PidsLimit"`
		Memory            int64                          `json:"Memory"`
		MemoryReservation int64                          `json:"MemoryReservation"`
		MemorySwap        int64                          `json:"MemorySwap"`
		CPUPeriod         int64                          `json:"CpuPeriod"`
		CPUQuota          int64                          `json:"CpuQuota"`
		PortBindings      map[string][]enginePortBinding `json:"PortBindings"`
		Tmpfs             map[string]string              `json:"Tmpfs"`
		Ulimits           []engineUlimit                 `json:"Ulimits"`
		DeviceRequests    []engineDeviceRequest          `json:"DeviceRequests"`
		RestartPolicy     struct {
			Name string `json:"Name"`
		} `json:"RestartPolicy"`
	} `json:"HostConfig"`
	NetworkSettings struct {
		Networks map[string]struct {
			IPAddress string `json:"IPAddress"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

func (r *Runtime) inspect(ctx context.Context, workerID string, ownership agent.Ownership) (agent.WorkerState, error) {
	output, err := r.runner.Run(ctx, "container", "inspect", containerName(workerID))
	if err != nil {
		return agent.WorkerState{}, ErrNotFound
	}
	var documents []inspectDocument
	if err := json.Unmarshal([]byte(output), &documents); err != nil || len(documents) != 1 {
		return agent.WorkerState{}, fmt.Errorf("docker inspect response is invalid")
	}
	document := documents[0]
	labels := document.Config.Labels
	kind := labels["com.teamaibox.kind"]
	if labels["com.teamaibox.managed"] != "true" ||
		(kind != "compute-worker" && kind != "application-plugin" && kind != "compute-plugin" && kind != "agent-sandbox") ||
		labels["com.teamaibox.node-id"] != ownership.NodeID ||
		labels["com.teamaibox.node-generation"] != strconv.FormatInt(ownership.NodeGeneration, 10) ||
		labels["com.teamaibox.worker-id"] != workerID ||
		labels["com.teamaibox.lease-id"] != ownership.LeaseID ||
		labels["com.teamaibox.fencing-token"] != strconv.FormatUint(ownership.FencingToken, 10) {
		return agent.WorkerState{}, fmt.Errorf("container ownership or fencing labels do not match")
	}
	health := "not_configured"
	if document.State.Health != nil {
		health = document.State.Health.Status
	}
	startedAt, _ := time.Parse(time.RFC3339Nano, document.State.StartedAt)
	placement, maintenanceGeneration, configDigest, placementErr := placementState(labels)
	if placementErr != nil {
		return agent.WorkerState{}, placementErr
	}
	return agent.WorkerState{
		WorkerID: workerID, ModelProfileID: labels["com.teamaibox.model-profile-id"], ContainerID: document.ID, Status: document.State.Status,
		Health: health, Image: document.Config.Image,
		PlacementClass: placement, MaintenanceGeneration: maintenanceGeneration, ConfigDigest: configDigest,
		StartedAt: startedAt,
	}, nil
}

func (r *Runtime) StopWorker(ctx context.Context, workerID string, gracePeriodSeconds int, ownership agent.Ownership) (agent.WorkerState, error) {
	state, err := r.inspect(ctx, workerID, ownership)
	if err != nil {
		return agent.WorkerState{}, err
	}
	if agent.IsProtectedPlacement(state.PlacementClass) {
		return agent.WorkerState{}, fmt.Errorf("protected_resident_operation_denied")
	}
	if state.Status == "running" {
		if _, err := r.runner.Run(ctx, "container", "stop", "--time", strconv.Itoa(gracePeriodSeconds), containerName(workerID)); err != nil {
			return agent.WorkerState{}, err
		}
	}
	if _, err := r.runner.Run(ctx, "container", "rm", containerName(workerID)); err != nil {
		return agent.WorkerState{}, err
	}
	state.Status = "removed"
	state.Health = "stopped"
	return state, nil
}

func (r *Runtime) WorkerHealth(ctx context.Context, workerID string, ownership agent.Ownership) (agent.WorkerState, error) {
	return r.inspect(ctx, workerID, ownership)
}

func (r *Runtime) FetchApplication(ctx context.Context, payload agent.ApplicationFetchPayload, ownership agent.Ownership) (agent.ApplicationContent, error) {
	output, err := r.runner.Run(ctx, "container", "inspect", containerName(payload.WorkerID))
	if err != nil {
		return agent.ApplicationContent{}, ErrNotFound
	}
	var documents []inspectDocument
	if json.Unmarshal([]byte(output), &documents) != nil || len(documents) != 1 {
		return agent.ApplicationContent{}, fmt.Errorf("docker inspect response is invalid")
	}
	target, err := applicationTarget(documents[0], payload.WorkerID, ownership)
	if err != nil {
		return agent.ApplicationContent{}, err
	}
	return fetchApplication(ctx, nil, target, payload)
}

func (r *Runtime) ProjectSandboxFile(_ context.Context, _ agent.SandboxFileProjection, _ agent.Ownership) (agent.SandboxFileState, error) {
	return agent.SandboxFileState{}, fmt.Errorf("Agent sandbox file projection requires the Docker Engine API runtime")
}
