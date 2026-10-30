package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

const engineAPIVersion = "v1.48"

// A dependent container is a stateless companion whose lifecycle is coupled to
// the Worker (for example, a Provider sharing the Worker's network namespace).
// Its stop must leave enough of the protected Node Agent command deadline for
// the stateful Worker to consume its full graceful-stop budget.
const exclusiveDependentStopGraceSeconds = 5

const (
	protectedHealthWaitDefault = 2 * time.Minute
	protectedHealthWaitMargin  = 30 * time.Second
	protectedHealthWaitMaximum = 35 * time.Minute
)

var (
	managedWorkerID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	digestID        = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

func placementState(labels map[string]string) (string, int64, string, error) {
	placement := agent.EffectivePlacementClass(labels["com.teamaibox.placement-class"])
	if placement != agent.PlacementWarmOptional && placement != agent.PlacementExclusiveBatch && placement != agent.PlacementProtectedResident {
		return "", 0, "", fmt.Errorf("container placement labels do not match")
	}
	generation := int64(0)
	if raw := labels["com.teamaibox.maintenance-generation"]; raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			return "", 0, "", fmt.Errorf("container placement labels do not match")
		}
		generation = parsed
	}
	configDigest := labels["com.teamaibox.config-digest"]
	if configDigest != "" && !digestID.MatchString(configDigest) {
		return "", 0, "", fmt.Errorf("container placement labels do not match")
	}
	return placement, generation, configDigest, nil
}

type EngineRuntime struct {
	client                *http.Client
	applicationClient     *http.Client
	baseURL               string
	applianceImageDigest  string
	applianceConfigDigest string
}

type engineStatusError struct {
	method string
	status int
}

func (value *engineStatusError) Error() string {
	return fmt.Sprintf("docker engine rejected %s with status %d", value.method, value.status)
}

func NewEngineRuntime(socketPath string) (*EngineRuntime, error) {
	if socketPath == "" {
		socketPath = "/var/run/docker.sock"
	}
	dialer := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socketPath)
		},
		MaxIdleConns: 16, MaxIdleConnsPerHost: 16, IdleConnTimeout: 60 * time.Second,
	}
	return &EngineRuntime{
		client:            &http.Client{Transport: transport, Timeout: 30 * time.Second},
		applicationClient: applicationHTTPClient(), baseURL: "http://docker/" + engineAPIVersion,
		applianceImageDigest:  strings.TrimSpace(os.Getenv("TEAMAIBOX_APPLIANCE_IMAGE_DIGEST")),
		applianceConfigDigest: strings.TrimSpace(os.Getenv("TEAMAIBOX_APPLIANCE_CONFIGURATION_DIGEST")),
	}, nil
}

func (r *EngineRuntime) requestWithClient(ctx context.Context, client *http.Client, method, endpoint string, input any, output any, expected ...int) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("docker request encoding failed")
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, r.baseURL+endpoint, body)
	if err != nil {
		return fmt.Errorf("docker request construction failed")
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("docker engine is unavailable")
	}
	defer response.Body.Close()
	accepted := false
	for _, status := range expected {
		if response.StatusCode == status {
			accepted = true
			break
		}
	}
	if !accepted {
		_, _ = io.CopyN(io.Discard, response.Body, 64<<10)
		return &engineStatusError{method: method, status: response.StatusCode}
	}
	if output != nil {
		decoder := json.NewDecoder(io.LimitReader(response.Body, 4<<20))
		if err := decoder.Decode(output); err != nil {
			return fmt.Errorf("docker engine response is invalid")
		}
	}
	return nil
}

func (r *EngineRuntime) request(ctx context.Context, method, endpoint string, input any, output any, expected ...int) error {
	return r.requestWithClient(ctx, r.client, method, endpoint, input, output, expected...)
}

func (r *EngineRuntime) stopContainer(ctx context.Context, container string, grace int) error {
	stopClient := *r.client
	stopTimeout := time.Duration(grace)*time.Second + 15*time.Second
	if stopClient.Timeout > 0 && stopClient.Timeout < stopTimeout {
		stopClient.Timeout = stopTimeout
	}
	endpoint := "/containers/" + url.PathEscape(container) + "/stop?t=" + strconv.Itoa(grace)
	return r.requestWithClient(ctx, &stopClient, http.MethodPost, endpoint, nil, nil,
		http.StatusNoContent, http.StatusNotModified)
}

func (r *EngineRuntime) Ready(ctx context.Context) error {
	var version struct {
		Version string `json:"Version"`
	}
	if err := r.request(ctx, http.MethodGet, "/version", nil, &version, http.StatusOK); err != nil {
		return err
	}
	if version.Version == "" {
		return fmt.Errorf("docker engine version is unavailable")
	}
	return nil
}

func secureBootState() string {
	paths, err := filepath.Glob("/sys/firmware/efi/efivars/SecureBoot-*")
	if err != nil || len(paths) != 1 {
		return "unknown"
	}
	value, err := os.ReadFile(paths[0])
	if err != nil || len(value) < 5 {
		return "unknown"
	}
	if value[4] == 1 {
		return "enabled"
	}
	if value[4] == 0 {
		return "disabled"
	}
	return "unknown"
}

func dockerAPIVersionAtLeast(observed, minimum string) bool {
	parse := func(value string) (int, int, bool) {
		parts := strings.Split(value, ".")
		if len(parts) != 2 {
			return 0, 0, false
		}
		major, first := strconv.Atoi(parts[0])
		minor, second := strconv.Atoi(parts[1])
		return major, minor, first == nil && second == nil
	}
	observedMajor, observedMinor, observedOK := parse(observed)
	minimumMajor, minimumMinor, minimumOK := parse(minimum)
	return observedOK && minimumOK && (observedMajor > minimumMajor || observedMajor == minimumMajor && observedMinor >= minimumMinor)
}

// InspectMaintenancePreflight observes only closed, allowlisted host/runtime
// facts. It never proxies an arbitrary Docker request and performs no mutation.
func (r *EngineRuntime) InspectMaintenancePreflight(ctx context.Context, payload agent.MaintenancePreflightPayload, ownership agent.Ownership) (agent.MaintenancePreflightEvidence, error) {
	var version struct {
		Version         string `json:"Version"`
		APIVersion      string `json:"ApiVersion"`
		Architecture    string `json:"Arch"`
		OperatingSystem string `json:"Os"`
		KernelVersion   string `json:"KernelVersion"`
	}
	if err := r.request(ctx, http.MethodGet, "/version", nil, &version, http.StatusOK); err != nil {
		return agent.MaintenancePreflightEvidence{}, fmt.Errorf("maintenance_docker_version_unavailable")
	}
	var info struct {
		Architecture    string                     `json:"Architecture"`
		OperatingSystem string                     `json:"OperatingSystem"`
		OSType          string                     `json:"OSType"`
		KernelVersion   string                     `json:"KernelVersion"`
		Runtimes        map[string]json.RawMessage `json:"Runtimes"`
		CDISpecDirs     []string                   `json:"CDISpecDirs"`
	}
	if err := r.request(ctx, http.MethodGet, "/info", nil, &info, http.StatusOK); err != nil {
		return agent.MaintenancePreflightEvidence{}, fmt.Errorf("maintenance_docker_info_unavailable")
	}
	filters, _ := json.Marshal(map[string][]string{"label": {"com.teamaibox.managed=true"}})
	var containers []struct {
		State  string            `json:"State"`
		Labels map[string]string `json:"Labels"`
	}
	if err := r.request(ctx, http.MethodGet, "/containers/json?all=1&filters="+url.QueryEscape(string(filters)), nil, &containers, http.StatusOK); err != nil {
		return agent.MaintenancePreflightEvidence{}, fmt.Errorf("maintenance_workload_inventory_unavailable")
	}
	if len(containers) > 2048 {
		return agent.MaintenancePreflightEvidence{}, fmt.Errorf("maintenance_workload_inventory_invalid")
	}
	active := 0
	for _, container := range containers {
		if container.State == "running" && container.Labels["com.teamaibox.managed"] == "true" {
			active++
		}
	}
	architecture := info.Architecture
	if architecture == "" {
		architecture = version.Architecture
	}
	if architecture == "aarch64" {
		architecture = "arm64"
	}
	operatingSystem := info.OperatingSystem
	if operatingSystem == "" {
		operatingSystem = info.OSType
	}
	if operatingSystem == "" {
		operatingSystem = version.OperatingSystem
	}
	kernelVersion := info.KernelVersion
	if kernelVersion == "" {
		kernelVersion = version.KernelVersion
	}
	secureBoot := secureBootState()
	_, nvidiaRuntime := info.Runtimes["nvidia"]
	nvidiaMode := "unavailable"
	if nvidiaRuntime {
		nvidiaMode = "runtime"
	} else {
		for _, directory := range info.CDISpecDirs {
			if directory == "/etc/cdi" || directory == "/var/run/cdi" {
				nvidiaMode = "cdi"
				break
			}
		}
	}
	nvidiaIntegration := nvidiaMode != "unavailable"
	allowedSecureBoot := false
	for _, state := range payload.AllowedSecureBootStates {
		allowedSecureBoot = allowedSecureBoot || state == secureBoot
	}
	blockers := []string{}
	if architecture != payload.ExpectedArchitecture {
		blockers = append(blockers, "architecture_incompatible")
	}
	if !dockerAPIVersionAtLeast(version.APIVersion, payload.MinimumDockerAPIVersion) {
		blockers = append(blockers, "docker_api_incompatible")
	}
	if payload.RequireNvidiaContainerIntegration && !nvidiaIntegration {
		blockers = append(blockers, "nvidia_container_integration_unavailable")
	}
	if !allowedSecureBoot {
		blockers = append(blockers, "secure_boot_state_incompatible")
	}
	warnings := []string{}
	if active > 0 {
		warnings = append(warnings, "managed_workloads_require_drain")
	}
	if secureBoot == "unknown" {
		warnings = append(warnings, "secure_boot_state_unobservable")
	}
	evidence := agent.MaintenancePreflightEvidence{
		PlanID: payload.PlanID, NodeID: ownership.NodeID, NodeGeneration: ownership.NodeGeneration,
		Passed: len(blockers) == 0, Blockers: blockers, Warnings: warnings,
		Architecture: architecture, DockerVersion: version.Version, DockerAPIVersion: version.APIVersion,
		KernelVersion: kernelVersion, OperatingSystem: operatingSystem, SecureBootState: secureBoot,
		NvidiaContainerIntegrationAvailable: nvidiaIntegration, NvidiaContainerIntegrationMode: nvidiaMode,
		ActiveManagedWorkloads: active,
	}
	canonical, err := json.Marshal(evidence)
	if err != nil {
		return agent.MaintenancePreflightEvidence{}, fmt.Errorf("maintenance_preflight_evidence_invalid")
	}
	digest := sha256.Sum256(canonical)
	evidence.EvidenceDigest = fmt.Sprintf("sha256:%x", digest[:])
	return evidence, nil
}

// RemoveStaleNodeWorkers removes only exact compute-worker containers owned by
// an older, already fenced generation of this node. A future generation or an
// ownership/name mismatch fails closed before any container is removed.
func (r *EngineRuntime) RemoveStaleNodeWorkers(ctx context.Context, nodeID string, currentGeneration int64) ([]agent.WorkerState, error) {
	return r.removeStaleNodeWorkers(ctx, nodeID, currentGeneration, false)
}

// Reconnecting control services must not tear down resident office models.
// Preserving them does not transfer their old lease or permit stale commands.
func (r *EngineRuntime) RemoveStaleEphemeralNodeWorkers(ctx context.Context, nodeID string, currentGeneration int64) ([]agent.WorkerState, error) {
	return r.removeStaleNodeWorkers(ctx, nodeID, currentGeneration, true)
}

// Cache migration keeps the original container and failed candidates for
// rollback. Their immutable labels describe the original worker, but their
// exact retired names must never be interpreted as an active worker to adopt
// or delete. In particular, they must not prevent the Agent from booting.
func retainedCacheContainer(id, name, state, workerID string, labels map[string]string) bool {
	if len(id) != 64 || !digestID.MatchString("sha256:"+id) ||
		(state != "exited" && state != "created") {
		return false
	}
	placement, _, _, err := placementState(labels)
	if err != nil || !agent.IsProtectedPlacement(placement) {
		return false
	}
	canonical := "/teamaibox-worker-" + workerID
	return name == canonical+"-pre-cache-"+id[:8] ||
		(labels["org.teamaibox.compilation-cache"] == "persistent-v1" &&
			(name == "/cache-reverted-"+id[:16] || name == canonical+"-cache-candidate"))
}

func (r *EngineRuntime) removeStaleNodeWorkers(ctx context.Context, nodeID string, currentGeneration int64, preserveResidents bool) ([]agent.WorkerState, error) {
	if !managedWorkerID.MatchString(nodeID) || currentGeneration < 1 {
		return nil, fmt.Errorf("managed node generation cleanup identity is invalid")
	}
	filters, _ := json.Marshal(map[string][]string{"label": {
		"com.teamaibox.managed=true", "com.teamaibox.kind=compute-worker", "com.teamaibox.node-id=" + nodeID,
	}})
	var containers []struct {
		ID     string            `json:"Id"`
		Names  []string          `json:"Names"`
		Image  string            `json:"Image"`
		State  string            `json:"State"`
		Labels map[string]string `json:"Labels"`
	}
	endpoint := "/containers/json?all=1&filters=" + url.QueryEscape(string(filters))
	if err := r.request(ctx, http.MethodGet, endpoint, nil, &containers, http.StatusOK); err != nil {
		return nil, err
	}
	sort.Slice(containers, func(left, right int) bool {
		return containers[left].Labels["com.teamaibox.worker-id"] < containers[right].Labels["com.teamaibox.worker-id"]
	})
	stale := make([]agent.WorkerState, 0)
	for _, container := range containers {
		labels := container.Labels
		workerID := labels["com.teamaibox.worker-id"]
		generation, parseError := strconv.ParseInt(labels["com.teamaibox.node-generation"], 10, 64)
		expectedName := "/teamaibox-worker-" + workerID
		if labels["com.teamaibox.managed"] != "true" || labels["com.teamaibox.kind"] != "compute-worker" ||
			labels["com.teamaibox.node-id"] != nodeID || !managedWorkerID.MatchString(workerID) ||
			parseError != nil || generation < 1 || len(containers) > 1024 ||
			len(container.Names) != 1 || container.ID == "" {
			return nil, fmt.Errorf("managed stale Worker ownership inventory is invalid")
		}
		if retainedCacheContainer(container.ID, container.Names[0], container.State, workerID, labels) {
			continue
		}
		if container.Names[0] != expectedName {
			return nil, fmt.Errorf("managed stale Worker ownership inventory is invalid")
		}
		if generation > currentGeneration {
			return nil, fmt.Errorf("managed Worker belongs to an unexpected future node generation")
		}
		if generation == currentGeneration {
			continue
		}
		placement, maintenanceGeneration, configDigest, placementErr := placementState(labels)
		if placementErr != nil {
			return nil, fmt.Errorf("managed stale Worker placement inventory is invalid")
		}
		if agent.IsProtectedPlacement(placement) {
			if preserveResidents {
				continue
			}
			return nil, fmt.Errorf("protected_resident_generation_recovery_required")
		}
		stale = append(stale, agent.WorkerState{WorkerID: workerID, ContainerID: container.ID,
			Status: container.State, Image: container.Image, PlacementClass: placement,
			MaintenanceGeneration: maintenanceGeneration, ConfigDigest: configDigest})
	}
	for _, worker := range stale {
		if err := r.request(ctx, http.MethodDelete, "/containers/"+url.PathEscape(worker.ContainerID)+"?force=1", nil, nil,
			http.StatusNoContent); err != nil {
			return nil, fmt.Errorf("stale managed Worker cleanup failed")
		}
	}
	return stale, nil
}

func (r *EngineRuntime) verifyImage(ctx context.Context, reference string) error {
	var image imageInspectDocument
	endpoint := "/images/" + url.PathEscape(reference) + "/json"
	if err := r.request(ctx, http.MethodGet, endpoint, nil, &image, http.StatusOK); err != nil {
		return fmt.Errorf("pinned worker image is not available: %w", err)
	}
	if digestID.MatchString(reference) {
		if localContentImageMatches(reference, image) {
			return nil
		}
		return fmt.Errorf("offline worker image content identity is unavailable")
	}
	for _, digest := range image.RepoDigests {
		if repositoryDigestMatches(reference, digest) {
			return nil
		}
	}
	return fmt.Errorf("local worker image does not expose the requested repository digest")
}

type imageInspectDocument struct {
	ID           string   `json:"Id"`
	Architecture string   `json:"Architecture"`
	OS           string   `json:"Os"`
	RepoDigests  []string `json:"RepoDigests"`
	Config       struct {
		Healthcheck  *engineHealthConfig `json:"Healthcheck"`
		Env          []string            `json:"Env"`
		Cmd          []string            `json:"Cmd"`
		Entrypoint   []string            `json:"Entrypoint"`
		ExposedPorts map[string]struct{} `json:"ExposedPorts"`
	} `json:"Config"`
}

func localContentImageMatches(reference string, image imageInspectDocument) bool {
	return digestID.MatchString(reference) && image.ID == reference &&
		image.Architecture == "arm64" && image.OS == "linux"
}

func (r *EngineRuntime) exactTransitionImage(ctx context.Context, spec agent.WorkerStartPayload, target agent.ExclusiveDrainTarget) (imageInspectDocument, error) {
	var image imageInspectDocument
	endpoint := "/images/" + url.PathEscape(spec.Image) + "/json"
	if err := r.request(ctx, http.MethodGet, endpoint, nil, &image, http.StatusOK); err != nil {
		return imageInspectDocument{}, fmt.Errorf("protected_set_transition_image_unavailable")
	}
	manifestMatched := localContentImageMatches(spec.Image, image)
	for _, digest := range image.RepoDigests {
		if repositoryDigestMatches(spec.Image, digest) {
			manifestMatched = true
			break
		}
	}
	if !manifestMatched || image.ID != target.RequiredImageID {
		return imageInspectDocument{}, fmt.Errorf("protected_set_transition_image_identity_drift")
	}
	if spec.HealthCheck == nil && (image.Config.Healthcheck == nil || len(image.Config.Healthcheck.Test) < 2) {
		return imageInspectDocument{}, fmt.Errorf("protected_set_transition_healthcheck_required")
	}
	return image, nil

}

func (r *EngineRuntime) inspectExactTransitionImage(ctx context.Context, spec agent.WorkerStartPayload, target agent.ExclusiveDrainTarget) error {
	_, err := r.exactTransitionImage(ctx, spec, target)
	return err
}

type engineMount struct {
	Type     string `json:"Type"`
	Source   string `json:"Source"`
	Target   string `json:"Target"`
	ReadOnly bool   `json:"ReadOnly"`
}

type engineDeviceRequest struct {
	Driver       string     `json:"Driver"`
	Count        int        `json:"Count"`
	Capabilities [][]string `json:"Capabilities"`
}

type engineUlimit struct {
	Name string `json:"Name"`
	Soft int64  `json:"Soft"`
	Hard int64  `json:"Hard"`
}

type enginePortBinding struct {
	HostIP   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

type engineHealthConfig struct {
	Test        []string `json:"Test"`
	Interval    int64    `json:"Interval"`
	Timeout     int64    `json:"Timeout"`
	StartPeriod int64    `json:"StartPeriod"`
	Retries     int      `json:"Retries"`
}

type createRequest struct {
	Image        string              `json:"Image"`
	Entrypoint   []string            `json:"Entrypoint,omitempty"`
	Cmd          []string            `json:"Cmd,omitempty"`
	Env          []string            `json:"Env,omitempty"`
	Labels       map[string]string   `json:"Labels"`
	User         string              `json:"User"`
	Healthcheck  *engineHealthConfig `json:"Healthcheck,omitempty"`
	ExposedPorts map[string]struct{} `json:"ExposedPorts,omitempty"`
	HostConfig   struct {
		ReadonlyRootfs bool                           `json:"ReadonlyRootfs"`
		CapDrop        []string                       `json:"CapDrop"`
		SecurityOpt    []string                       `json:"SecurityOpt"`
		PidsLimit      int64                          `json:"PidsLimit"`
		Memory         int64                          `json:"Memory"`
		MemorySwap     int64                          `json:"MemorySwap"`
		ShmSize        int64                          `json:"ShmSize,omitempty"`
		CPUPeriod      int64                          `json:"CpuPeriod"`
		CPUQuota       int64                          `json:"CpuQuota"`
		NetworkMode    string                         `json:"NetworkMode"`
		Mounts         []engineMount                  `json:"Mounts,omitempty"`
		DeviceRequests []engineDeviceRequest          `json:"DeviceRequests,omitempty"`
		PortBindings   map[string][]enginePortBinding `json:"PortBindings,omitempty"`
		Tmpfs          map[string]string              `json:"Tmpfs,omitempty"`
		Ulimits        []engineUlimit                 `json:"Ulimits"`
		RestartPolicy  struct {
			Name string `json:"Name"`
		} `json:"RestartPolicy"`
	} `json:"HostConfig"`
}

func engineLabels(ownership agent.Ownership, spec agent.WorkerStartPayload) map[string]string {
	kind := spec.WorkloadKind
	if kind == "" {
		kind = "compute-worker"
	}
	values := map[string]string{
		"com.teamaibox.managed": "true", "com.teamaibox.kind": kind,
		"com.teamaibox.node-id": ownership.NodeID, "com.teamaibox.worker-id": spec.WorkerID,
		"com.teamaibox.node-generation": strconv.FormatInt(ownership.NodeGeneration, 10),
		"com.teamaibox.attempt-id":      spec.AttemptID, "com.teamaibox.lease-id": ownership.LeaseID,
		"com.teamaibox.fencing-token":          strconv.FormatUint(ownership.FencingToken, 10),
		"com.teamaibox.image-digest":           spec.Image,
		"com.teamaibox.start-command-id":       ownership.CommandID,
		"com.teamaibox.start-command-digest":   ownership.CommandDigest,
		"com.teamaibox.start-spec-digest":      workerStartSpecDigest(spec),
		"com.teamaibox.model-profile-id":       spec.ModelProfileID,
		"com.teamaibox.placement-class":        agent.EffectivePlacementClass(spec.PlacementClass),
		"com.teamaibox.maintenance-generation": strconv.FormatInt(spec.MaintenanceGeneration, 10),
		"com.teamaibox.config-digest":          spec.ConfigDigest,
	}
	if spec.PluginID != "" {
		values["com.teamaibox.plugin-id"] = spec.PluginID
	}
	if spec.ApplicationPort > 0 {
		values["com.teamaibox.application-port"] = strconv.Itoa(spec.ApplicationPort)
	}
	if spec.NetworkPolicyID != "" {
		values["com.teamaibox.network-policy-id"] = spec.NetworkPolicyID
	}
	if spec.OwnerIdentityID != "" {
		values["com.teamaibox.owner-identity-id"] = spec.OwnerIdentityID
	}
	if spec.SandboxKey != "" {
		values["com.teamaibox.sandbox-key"] = spec.SandboxKey
	}
	if spec.Limits.WorkspaceBytes > 0 {
		values["com.teamaibox.workspace-quota-bytes"] = strconv.FormatInt(spec.Limits.WorkspaceBytes, 10)
	}
	return values
}

func (r *EngineRuntime) verifyAgentWorkspace(ctx context.Context, spec agent.WorkerStartPayload) error {
	if len(spec.Mounts) != 1 {
		return fmt.Errorf("Agent workspace declaration is invalid")
	}
	var volume struct {
		Name   string            `json:"Name"`
		Labels map[string]string `json:"Labels"`
	}
	endpoint := "/volumes/" + url.PathEscape(spec.Mounts[0].Source)
	if err := r.request(ctx, http.MethodGet, endpoint, nil, &volume, http.StatusOK); err != nil {
		return fmt.Errorf("assigned Agent workspace volume is unavailable")
	}
	if volume.Name != spec.Mounts[0].Source || volume.Labels["com.teamaibox.volume.class"] != "agent-workspace" ||
		volume.Labels["com.teamaibox.owner-identity-id"] != spec.OwnerIdentityID ||
		volume.Labels["com.teamaibox.sandbox-key"] != spec.SandboxKey ||
		volume.Labels["com.teamaibox.quota-bytes"] != strconv.FormatInt(spec.Limits.WorkspaceBytes, 10) {
		return fmt.Errorf("Agent workspace ownership or disk quota evidence does not match")
	}
	return nil
}

// WorkerCreateRequest is the single Docker create-time representation used by
// the Agent and the fresh-install spec compiler. It performs no Docker call;
// callers must validate policy, image and installation ownership first.
func WorkerCreateRequest(spec agent.WorkerStartPayload, ownership agent.Ownership) any {
	request := createRequest{
		Image: spec.Image, Entrypoint: append([]string(nil), spec.Entrypoint...), Cmd: append([]string(nil), spec.Command...),
		Labels: engineLabels(ownership, spec),
		User:   fmt.Sprintf("%d:%d", spec.Security.RunAsUID, spec.Security.RunAsGID),
	}
	if spec.HealthCheck != nil {
		request.Healthcheck = &engineHealthConfig{
			Test: append([]string(nil), spec.HealthCheck.Test...), Interval: spec.HealthCheck.Interval,
			Timeout: spec.HealthCheck.Timeout, StartPeriod: spec.HealthCheck.StartPeriod, Retries: spec.HealthCheck.Retries,
		}
	}
	request.HostConfig.ReadonlyRootfs = true
	request.HostConfig.CapDrop = []string{"ALL"}
	request.HostConfig.SecurityOpt = []string{"no-new-privileges:true"}
	seccompProfile := spec.Security.SeccompProfile
	if seccompProfile == "teamaibox-plugin-v1" {
		seccompProfile = "builtin"
	}
	if seccompProfile != "" {
		request.HostConfig.SecurityOpt = append(request.HostConfig.SecurityOpt, "seccomp="+seccompProfile)
	}
	request.HostConfig.PidsLimit = spec.Limits.PidsLimit
	request.HostConfig.Memory = spec.Limits.MemoryBytes
	request.HostConfig.MemorySwap = spec.Limits.MemoryBytes
	request.HostConfig.ShmSize = spec.Limits.SharedMemoryBytes
	request.HostConfig.CPUPeriod = 100_000
	request.HostConfig.CPUQuota = spec.Limits.CPUQuotaMicros
	request.HostConfig.NetworkMode = spec.Network
	execFlag := "noexec"
	if spec.TmpfsExecutable {
		execFlag = "exec"
	}
	request.HostConfig.Tmpfs = map[string]string{"/tmp": "rw," + execFlag + ",nosuid,nodev,size=" + strconv.FormatInt(spec.Limits.EphemeralBytes, 10) +
		",uid=" + strconv.FormatUint(uint64(spec.Security.RunAsUID), 10) + ",gid=" + strconv.FormatUint(uint64(spec.Security.RunAsGID), 10) + ",mode=0700"}
	if spec.WorkloadKind == "agent-sandbox" {
		request.HostConfig.Tmpfs["/run/secrets"] = "rw,noexec,nosuid,nodev,size=1048576,uid=0,gid=0,mode=0755"
		request.HostConfig.Tmpfs["/run/teamaibox"] = "rw,noexec,nosuid,nodev,size=1048576,uid=0,gid=0,mode=0755"
	}
	request.HostConfig.Ulimits = []engineUlimit{{Name: "nofile", Soft: spec.Limits.OpenFilesLimit, Hard: spec.Limits.OpenFilesLimit}}
	request.HostConfig.RestartPolicy.Name = "no"
	for _, mount := range spec.Mounts {
		request.HostConfig.Mounts = append(request.HostConfig.Mounts, engineMount(mount))
	}
	if len(spec.PublishedPorts) > 0 {
		request.ExposedPorts = map[string]struct{}{}
		request.HostConfig.PortBindings = map[string][]enginePortBinding{}
		for _, published := range spec.PublishedPorts {
			key := strconv.Itoa(published.ContainerPort) + "/tcp"
			request.ExposedPorts[key] = struct{}{}
			request.HostConfig.PortBindings[key] = []enginePortBinding{{
				HostIP: published.HostIP, HostPort: strconv.Itoa(published.HostPort),
			}}
		}
	}
	if len(spec.Devices) > 0 {
		request.HostConfig.DeviceRequests = []engineDeviceRequest{{Driver: "nvidia", Count: -1, Capabilities: [][]string{{"gpu"}}}}
	}
	for name, value := range spec.Environment {
		request.Env = append(request.Env, name+"="+value)
	}
	// The service policy has already bounded keys; sort makes the engine request
	// stable for audit/replay evidence.
	sortStrings(request.Env)
	return request
}

func (r *EngineRuntime) StartWorker(ctx context.Context, spec agent.WorkerStartPayload, ownership agent.Ownership) (agent.WorkerState, error) {
	if err := r.verifyImage(ctx, spec.Image); err != nil {
		return agent.WorkerState{}, err
	}
	if spec.WorkloadKind == "agent-sandbox" {
		if err := r.verifyAgentWorkspace(ctx, spec); err != nil {
			return agent.WorkerState{}, err
		}
	}
	request := WorkerCreateRequest(spec, ownership)
	var created struct {
		ID string `json:"Id"`
	}
	name := url.QueryEscape(containerName(spec.WorkerID))
	if err := r.request(ctx, http.MethodPost, "/containers/create?name="+name, request, &created, http.StatusCreated); err != nil {
		state, replayError := r.inspectStartReplay(ctx, spec, ownership)
		if replayError == nil {
			return state, nil
		}
		if errors.Is(replayError, errProtectedStartResume) {
			if startErr := r.startExclusiveContainer(ctx, containerName(spec.WorkerID)); startErr != nil {
				return agent.WorkerState{}, fmt.Errorf("protected_resident_start_recovery_required")
			}
			return r.inspectStartReplay(ctx, spec, ownership)
		}
		if !errors.Is(replayError, ErrNotFound) {
			return agent.WorkerState{}, replayError
		}
		return agent.WorkerState{}, err
	}
	if err := r.request(ctx, http.MethodPost, "/containers/"+url.PathEscape(created.ID)+"/start", nil, nil, http.StatusNoContent); err != nil {
		if agent.IsProtectedPlacement(spec.PlacementClass) {
			return agent.WorkerState{}, fmt.Errorf("protected_resident_start_recovery_required")
		}
		_ = r.request(context.Background(), http.MethodDelete, "/containers/"+url.PathEscape(created.ID)+"?force=1", nil, nil, http.StatusNoContent)
		return agent.WorkerState{}, err
	}
	return r.inspect(ctx, spec.WorkerID, ownership)
}

func (r *EngineRuntime) inspectStartReplay(ctx context.Context, spec agent.WorkerStartPayload, ownership agent.Ownership) (agent.WorkerState, error) {
	var document inspectDocument
	endpoint := "/containers/" + url.PathEscape(containerName(spec.WorkerID)) + "/json"
	if err := r.request(ctx, http.MethodGet, endpoint, nil, &document, http.StatusOK); err != nil {
		return agent.WorkerState{}, ErrNotFound
	}
	labels := document.Config.Labels
	kind := labels["com.teamaibox.kind"]
	placement, maintenanceGeneration, configDigest, placementErr := placementState(labels)
	if labels["com.teamaibox.managed"] != "true" ||
		(kind != "compute-worker" && kind != "application-plugin" && kind != "compute-plugin" && kind != "agent-sandbox") ||
		labels["com.teamaibox.node-id"] != ownership.NodeID || labels["com.teamaibox.worker-id"] != spec.WorkerID ||
		labels["com.teamaibox.node-generation"] != strconv.FormatInt(ownership.NodeGeneration, 10) ||
		labels["com.teamaibox.lease-id"] != ownership.LeaseID || labels["com.teamaibox.fencing-token"] != strconv.FormatUint(ownership.FencingToken, 10) ||
		labels["com.teamaibox.start-spec-digest"] != workerStartSpecDigest(spec) ||
		labels["com.teamaibox.attempt-id"] != spec.AttemptID || labels["com.teamaibox.model-profile-id"] != spec.ModelProfileID ||
		labels["com.teamaibox.image-digest"] != spec.Image || document.Config.Image != spec.Image ||
		placementErr != nil || placement != agent.EffectivePlacementClass(spec.PlacementClass) ||
		maintenanceGeneration != spec.MaintenanceGeneration || configDigest != spec.ConfigDigest ||
		(spec.OwnerIdentityID != "" && labels["com.teamaibox.owner-identity-id"] != spec.OwnerIdentityID) ||
		(spec.SandboxKey != "" && labels["com.teamaibox.sandbox-key"] != spec.SandboxKey) {
		return agent.WorkerState{}, fmt.Errorf("existing worker does not match the replayed start command")
	}
	health := "not_configured"
	if document.State.Health != nil {
		health = document.State.Health.Status
	}
	startedAt, _ := time.Parse(time.RFC3339Nano, document.State.StartedAt)
	if document.State.Status != "running" {
		if agent.IsProtectedPlacement(spec.PlacementClass) && (document.State.Status == "created" || document.State.Status == "exited") {
			return agent.WorkerState{WorkerID: spec.WorkerID, ContainerID: document.ID, Status: document.State.Status,
				ModelProfileID: spec.ModelProfileID, Health: health, Image: document.Config.Image, PlacementClass: placement,
				MaintenanceGeneration: maintenanceGeneration, ConfigDigest: configDigest, StartedAt: startedAt}, errProtectedStartResume
		}
		return agent.WorkerState{}, fmt.Errorf("existing worker is not running for the replayed start command")
	}
	return agent.WorkerState{WorkerID: spec.WorkerID, ModelProfileID: spec.ModelProfileID, ContainerID: document.ID, Status: document.State.Status, Health: health, Image: document.Config.Image,
		PlacementClass: placement, MaintenanceGeneration: maintenanceGeneration, ConfigDigest: configDigest, StartedAt: startedAt}, nil
}

func sortStrings(values []string) {
	for index := 1; index < len(values); index++ {
		for position := index; position > 0 && strings.Compare(values[position], values[position-1]) < 0; position-- {
			values[position], values[position-1] = values[position-1], values[position]
		}
	}
}

func (r *EngineRuntime) inspect(ctx context.Context, workerID string, ownership agent.Ownership) (agent.WorkerState, error) {
	var document inspectDocument
	endpoint := "/containers/" + url.PathEscape(containerName(workerID)) + "/json"
	if err := r.request(ctx, http.MethodGet, endpoint, nil, &document, http.StatusOK); err != nil {
		status := new(engineStatusError)
		if errors.As(err, &status) && status.status == http.StatusNotFound {
			return agent.WorkerState{}, ErrNotFound
		}
		return agent.WorkerState{}, err
	}
	labels := document.Config.Labels
	kind := labels["com.teamaibox.kind"]
	if ownership.ApplicationOnly && kind != "application-plugin" {
		return agent.WorkerState{}, fmt.Errorf("application_runtime_kind_mismatch")
	}
	if labels["com.teamaibox.managed"] != "true" ||
		(kind != "compute-worker" && kind != "application-plugin" && kind != "compute-plugin" && kind != "agent-sandbox") ||
		labels["com.teamaibox.node-id"] != ownership.NodeID || labels["com.teamaibox.worker-id"] != workerID ||
		!runtimeGenerationMatches(document, ownership) ||
		labels["com.teamaibox.lease-id"] != ownership.LeaseID ||
		labels["com.teamaibox.fencing-token"] != strconv.FormatUint(ownership.FencingToken, 10) {
		return agent.WorkerState{}, fmt.Errorf("container ownership or fencing labels do not match")
	}
	health := "not_configured"
	if document.State.Health != nil {
		health = document.State.Health.Status
	}
	startedAt, _ := time.Parse(time.RFC3339Nano, document.State.StartedAt)
	placement, maintenanceGeneration, configDigest, placementErr := placementState(document.Config.Labels)
	if placementErr != nil {
		return agent.WorkerState{}, placementErr
	}
	return agent.WorkerState{WorkerID: workerID, ModelProfileID: labels["com.teamaibox.model-profile-id"], ContainerID: document.ID, Status: document.State.Status, Health: health, Image: document.Config.Image,
		PlacementClass: placement, MaintenanceGeneration: maintenanceGeneration, ConfigDigest: configDigest, StartedAt: startedAt}, nil
}

func (r *EngineRuntime) StopWorker(ctx context.Context, workerID string, grace int, ownership agent.Ownership) (agent.WorkerState, error) {
	if ownership.RuntimeGeneration != 0 && !ownership.ApplicationOnly {
		return agent.WorkerState{}, fmt.Errorf("retained_runtime_lifecycle_denied")
	}
	state, err := r.inspect(ctx, workerID, ownership)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return agent.WorkerState{WorkerID: workerID, Status: "removed", Health: "stopped"}, nil
		}
		return agent.WorkerState{}, err
	}
	if agent.IsProtectedPlacement(state.PlacementClass) {
		return agent.WorkerState{}, fmt.Errorf("protected_resident_operation_denied")
	}
	if state.Status == "running" {
		if err := r.stopContainer(ctx, containerName(workerID), grace); err != nil {
			return agent.WorkerState{}, err
		}
	}
	if err := r.request(ctx, http.MethodDelete, "/containers/"+url.PathEscape(containerName(workerID)), nil, nil, http.StatusNoContent); err != nil {
		return agent.WorkerState{}, err
	}
	state.Status, state.Health = "removed", "stopped"
	return state, nil
}

func (r *EngineRuntime) WorkerHealth(ctx context.Context, workerID string, ownership agent.Ownership) (agent.WorkerState, error) {
	return r.inspect(ctx, workerID, ownership)
}

func (r *EngineRuntime) FetchApplication(ctx context.Context, payload agent.ApplicationFetchPayload, ownership agent.Ownership) (agent.ApplicationContent, error) {
	var document inspectDocument
	endpoint := "/containers/" + url.PathEscape(containerName(payload.WorkerID)) + "/json"
	if err := r.request(ctx, http.MethodGet, endpoint, nil, &document, http.StatusOK); err != nil {
		return agent.ApplicationContent{}, ErrNotFound
	}
	target, err := applicationTarget(document, payload.WorkerID, ownership)
	if err != nil {
		return agent.ApplicationContent{}, err
	}
	return fetchApplication(ctx, r.applicationClient, target, payload)
}

func (r *EngineRuntime) exclusiveTargetState(ctx context.Context, target agent.ExclusiveDrainTarget) (agent.ExclusiveConflictState, error) {
	return r.exclusiveContainerState(ctx, target.TargetKey, target.ContainerName,
		target.RequiredImageID, target.RequiredLabels)
}

func (r *EngineRuntime) exclusiveContainerState(ctx context.Context, key string, container string,
	requiredImageID string, requiredLabels map[string]string) (agent.ExclusiveConflictState, error) {
	var document inspectDocument
	endpoint := "/containers/" + url.PathEscape(container) + "/json"
	if err := r.request(ctx, http.MethodGet, endpoint, nil, &document, http.StatusOK); err != nil {
		return agent.ExclusiveConflictState{}, fmt.Errorf("exclusive drain target is unavailable")
	}
	if requiredImageID != "" && document.Image != requiredImageID {
		return agent.ExclusiveConflictState{}, fmt.Errorf("exclusive drain target identity changed")
	}
	for label, expected := range requiredLabels {
		if document.Config.Labels[label] != expected {
			return agent.ExclusiveConflictState{}, fmt.Errorf("exclusive drain target identity changed")
		}
	}
	placement, _, _, placementErr := placementState(document.Config.Labels)
	if placementErr != nil {
		return agent.ExclusiveConflictState{}, fmt.Errorf("exclusive drain target identity changed")
	}
	health := "not_configured"
	if document.State.Health != nil {
		health = document.State.Health.Status
	}
	return agent.ExclusiveConflictState{WorkerID: key, ContainerName: container,
		State: document.State.Status, Health: health, PlacementClass: placement, WasRunning: document.State.Status == "running",
		LeasesReleased: document.State.Status != "running"}, nil
}

func (r *EngineRuntime) dependentState(ctx context.Context, dependent agent.ExclusiveDependentContainer) (agent.ExclusiveConflictState, error) {
	return r.exclusiveContainerState(ctx, "dependent", dependent.ContainerName,
		dependent.RequiredImageID, dependent.RequiredLabels)
}

func (r *EngineRuntime) startExclusiveContainer(ctx context.Context, name string) error {
	endpoint := "/containers/" + url.PathEscape(name) + "/start"
	return r.request(ctx, http.MethodPost, endpoint, nil, nil, http.StatusNoContent, http.StatusNotModified)
}

func (r *EngineRuntime) ListExclusiveConflicts(ctx context.Context, targets []agent.ExclusiveDrainTarget) ([]agent.ExclusiveConflictState, error) {
	states := make([]agent.ExclusiveConflictState, 0, len(targets))
	for _, target := range targets {
		state, err := r.exclusiveTargetState(ctx, target)
		if err != nil {
			return nil, err
		}
		if agent.IsProtectedPlacement(state.PlacementClass) {
			return nil, fmt.Errorf("protected_resident_operation_denied")
		}
		if state.WasRunning {
			states = append(states, state)
		}
	}
	return states, nil
}

func (r *EngineRuntime) DrainExclusiveConflict(ctx context.Context, target agent.ExclusiveDrainTarget) (agent.ExclusiveConflictState, error) {
	if agent.IsProtectedPlacement(target.PlacementClass) {
		return agent.ExclusiveConflictState{}, fmt.Errorf("protected_resident_operation_denied")
	}
	state, err := r.exclusiveTargetState(ctx, target)
	if err != nil {
		return agent.ExclusiveConflictState{}, err
	}
	if agent.IsProtectedPlacement(state.PlacementClass) {
		return agent.ExclusiveConflictState{}, fmt.Errorf("protected_resident_operation_denied")
	}
	wasRunning := state.WasRunning
	stoppedDependents := []agent.ExclusiveDependentContainer{}
	for _, dependent := range target.DependentContainers {
		current, dependencyErr := r.dependentState(ctx, dependent)
		if dependencyErr != nil || current.State != "running" || agent.IsProtectedPlacement(current.PlacementClass) {
			return agent.ExclusiveConflictState{}, fmt.Errorf("exclusive drain dependent is unavailable")
		}
		if dependencyErr = r.stopContainer(ctx, dependent.ContainerName, exclusiveDependentStopGraceSeconds); dependencyErr != nil {
			for _, stopped := range stoppedDependents {
				_ = r.startExclusiveContainer(ctx, stopped.ContainerName)
			}
			return agent.ExclusiveConflictState{}, dependencyErr
		}
		stoppedDependents = append(stoppedDependents, dependent)
	}
	if wasRunning {
		if err := r.stopContainer(ctx, target.ContainerName, 30); err != nil {
			for _, dependent := range stoppedDependents {
				_ = r.startExclusiveContainer(ctx, dependent.ContainerName)
			}
			return agent.ExclusiveConflictState{}, err
		}
	}
	state, err = r.exclusiveTargetState(ctx, target)
	if err != nil || state.State == "running" {
		return agent.ExclusiveConflictState{}, fmt.Errorf("exclusive drain target did not stop")
	}
	state.WasRunning, state.LeasesReleased = wasRunning, true
	return state, nil
}

func (r *EngineRuntime) RestoreExclusiveConflict(ctx context.Context, target agent.ExclusiveDrainTarget) (agent.ExclusiveConflictState, error) {
	if agent.IsProtectedPlacement(target.PlacementClass) {
		return agent.ExclusiveConflictState{}, fmt.Errorf("protected_resident_operation_denied")
	}
	state, err := r.exclusiveTargetState(ctx, target)
	if err != nil {
		return agent.ExclusiveConflictState{}, err
	}
	if agent.IsProtectedPlacement(state.PlacementClass) {
		return agent.ExclusiveConflictState{}, fmt.Errorf("protected_resident_operation_denied")
	}
	if state.State != "running" {
		if err := r.startExclusiveContainer(ctx, target.ContainerName); err != nil {
			return agent.ExclusiveConflictState{}, err
		}
	}
	state, err = r.exclusiveTargetState(ctx, target)
	if err != nil || state.State != "running" {
		return agent.ExclusiveConflictState{}, fmt.Errorf("exclusive drain target did not restart")
	}
	for _, dependent := range target.DependentContainers {
		current, dependencyErr := r.dependentState(ctx, dependent)
		if dependencyErr != nil {
			return agent.ExclusiveConflictState{}, dependencyErr
		}
		if agent.IsProtectedPlacement(current.PlacementClass) {
			return agent.ExclusiveConflictState{}, fmt.Errorf("protected_resident_operation_denied")
		}
		if current.State != "running" {
			if dependencyErr = r.startExclusiveContainer(ctx, dependent.ContainerName); dependencyErr != nil {
				return agent.ExclusiveConflictState{}, dependencyErr
			}
		}
		current, dependencyErr = r.dependentState(ctx, dependent)
		if dependencyErr != nil || current.State != "running" {
			return agent.ExclusiveConflictState{}, fmt.Errorf("exclusive drain dependent did not restart")
		}
	}
	state.WasRunning, state.LeasesReleased = true, true
	return state, nil
}

func containerHealth(document inspectDocument) string {
	if document.State.Health == nil {
		return "not_configured"
	}
	return document.State.Health.Status
}

func exactProtectedContainerDocument(document inspectDocument, requiredImageID, requiredImageDigest,
	requiredConfigDigest string, expectedMaintenanceGeneration int64, requiredLabels map[string]string,
	workerID, profileID string) bool {
	labels := document.Config.Labels
	placement, maintenanceGeneration, labeledConfigDigest, placementErr := placementState(labels)
	if document.ID == "" || document.Image != requiredImageID || document.Config.Image != requiredImageDigest ||
		placementErr != nil || labeledConfigDigest != requiredConfigDigest {
		return false
	}
	for label, expected := range requiredLabels {
		if labels[label] != expected {
			return false
		}
	}
	return workerID == "" || (labels["com.teamaibox.managed"] == "true" &&
		labels["com.teamaibox.kind"] == "compute-worker" && labels["com.teamaibox.worker-id"] == workerID &&
		labels["com.teamaibox.model-profile-id"] == profileID &&
		labels["com.teamaibox.image-digest"] == requiredImageDigest && agent.IsProtectedPlacement(placement) &&
		maintenanceGeneration == expectedMaintenanceGeneration)
}

func (r *EngineRuntime) inspectProtectedContainer(ctx context.Context, key, container, requiredImageID, requiredImageDigest,
	requiredConfigDigest string, expectedMaintenanceGeneration int64, requiredLabels map[string]string, workerID, profileID string) (agent.ExclusiveConflictState, error) {
	var document inspectDocument
	endpoint := "/containers/" + url.PathEscape(container) + "/json"
	if err := r.request(ctx, http.MethodGet, endpoint, nil, &document, http.StatusOK); err != nil {
		return agent.ExclusiveConflictState{}, fmt.Errorf("protected_maintenance_target_unavailable")
	}
	if !exactProtectedContainerDocument(document, requiredImageID, requiredImageDigest, requiredConfigDigest,
		expectedMaintenanceGeneration, requiredLabels, workerID, profileID) {
		return agent.ExclusiveConflictState{}, fmt.Errorf("protected_maintenance_identity_drift")
	}
	placement, _, _, _ := placementState(document.Config.Labels)
	return agent.ExclusiveConflictState{
		WorkerID: key, ContainerName: container, State: document.State.Status, Health: containerHealth(document),
		PlacementClass: placement,
		WasRunning:     document.State.Status == "running", LeasesReleased: document.State.Status != "running",
	}, nil
}

func (r *EngineRuntime) InspectProtectedMaintenanceTarget(ctx context.Context, target agent.ExclusiveDrainTarget) (agent.ProtectedMaintenanceTargetState, error) {
	if !agent.IsProtectedPlacement(target.PlacementClass) {
		return agent.ProtectedMaintenanceTargetState{}, fmt.Errorf("protected_maintenance_target_denied")
	}
	primary, err := r.inspectProtectedContainer(ctx, target.TargetKey, target.ContainerName, target.RequiredImageID,
		target.RequiredImageDigest, target.RequiredConfigDigest, target.MaintenanceGeneration, target.RequiredLabels, target.WorkerID, target.ModelProfileID)
	if err != nil {
		return agent.ProtectedMaintenanceTargetState{}, err
	}
	dependencies := make([]agent.ExclusiveConflictState, 0, len(target.DependentContainers))
	for _, dependent := range target.DependentContainers {
		state, inspectErr := r.inspectProtectedContainer(ctx, "dependent", dependent.ContainerName, dependent.RequiredImageID,
			dependent.RequiredImageDigest, dependent.RequiredConfigDigest, 0, dependent.RequiredLabels, "", "")
		if inspectErr != nil {
			return agent.ProtectedMaintenanceTargetState{}, inspectErr
		}
		dependencies = append(dependencies, state)
	}
	return agent.ProtectedMaintenanceTargetState{Target: primary, Dependencies: dependencies}, nil
}

func protectedHealthWaitBound(health *agent.ContainerHealthCheck) time.Duration {
	if health == nil {
		return protectedHealthWaitDefault
	}
	// The immutable create-time health contract is also the cold-start budget.
	// Include every allowed retry and its command timeout, plus a bounded margin
	// for Engine scheduling. Policy validation caps every component, while this
	// final ceiling prevents a malformed in-memory caller from waiting forever.
	wait := time.Duration(health.StartPeriod) + time.Duration(health.Retries)*(time.Duration(health.Interval)+time.Duration(health.Timeout)) + protectedHealthWaitMargin
	if wait < protectedHealthWaitDefault {
		return protectedHealthWaitDefault
	}
	if wait > protectedHealthWaitMaximum {
		return protectedHealthWaitMaximum
	}
	return wait
}

func (r *EngineRuntime) waitProtectedContainerHealthy(ctx context.Context, key, container, requiredImageID, requiredImageDigest,
	requiredConfigDigest string, maintenanceGeneration int64, requiredLabels map[string]string, workerID, profileID string,
	wait time.Duration) (agent.ExclusiveConflictState, error) {
	if wait <= 0 || wait > protectedHealthWaitMaximum {
		return agent.ExclusiveConflictState{}, fmt.Errorf("protected_maintenance_health_wait_invalid")
	}
	deadline := time.Now().Add(wait)
	for {
		state, err := r.inspectProtectedContainer(ctx, key, container, requiredImageID, requiredImageDigest,
			requiredConfigDigest, maintenanceGeneration, requiredLabels, workerID, profileID)
		if err != nil {
			return agent.ExclusiveConflictState{}, err
		}
		if state.State == "running" && state.Health == "healthy" {
			return state, nil
		}
		if !time.Now().Before(deadline) {
			return agent.ExclusiveConflictState{}, fmt.Errorf("protected_maintenance_health_timeout")
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return agent.ExclusiveConflictState{}, ctx.Err()
		case <-timer.C:
		}
	}
}

// A restart retains the original container health contract. In particular,
// model preparation may include a retry after a failed cold start; the generic
// two-minute floor must not cut that authenticated, bounded contract short.
func (r *EngineRuntime) waitRestoredProtectedContainer(ctx context.Context, key, container, requiredImageID, requiredImageDigest,
	requiredConfigDigest string, maintenanceGeneration int64, requiredLabels map[string]string, workerID, profileID string) (agent.ExclusiveConflictState, error) {
	var document inspectDocument
	if err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(container)+"/json", nil, &document, http.StatusOK); err != nil {
		return agent.ExclusiveConflictState{}, fmt.Errorf("protected_maintenance_target_unavailable")
	}
	if !exactProtectedContainerDocument(document, requiredImageID, requiredImageDigest, requiredConfigDigest,
		maintenanceGeneration, requiredLabels, workerID, profileID) {
		return agent.ExclusiveConflictState{}, fmt.Errorf("protected_maintenance_identity_drift")
	}
	var health *agent.ContainerHealthCheck
	if value := document.Config.Healthcheck; value != nil {
		health = &agent.ContainerHealthCheck{Test: value.Test, Interval: value.Interval, Timeout: value.Timeout,
			StartPeriod: value.StartPeriod, Retries: value.Retries}
	}
	return r.waitProtectedContainerHealthy(ctx, key, container, requiredImageID, requiredImageDigest, requiredConfigDigest,
		maintenanceGeneration, requiredLabels, workerID, profileID, protectedHealthWaitBound(health))
}

func (r *EngineRuntime) StopProtectedMaintenanceTarget(ctx context.Context, target agent.ExclusiveDrainTarget) (agent.ProtectedMaintenanceTargetState, error) {
	state, err := r.InspectProtectedMaintenanceTarget(ctx, target)
	if err != nil {
		return agent.ProtectedMaintenanceTargetState{}, err
	}
	if state.Target.State != "running" || state.Target.Health != "healthy" {
		return agent.ProtectedMaintenanceTargetState{}, fmt.Errorf("protected_maintenance_prior_health_invalid")
	}
	for _, dependency := range state.Dependencies {
		if dependency.State != "running" || dependency.Health != "healthy" {
			return agent.ProtectedMaintenanceTargetState{}, fmt.Errorf("protected_maintenance_prior_health_invalid")
		}
	}
	stopped := 0
	for index, dependent := range target.DependentContainers {
		if err := r.stopContainer(ctx, dependent.ContainerName, exclusiveDependentStopGraceSeconds); err != nil {
			for restore := stopped - 1; restore >= 0; restore-- {
				_ = r.startExclusiveContainer(ctx, target.DependentContainers[restore].ContainerName)
			}
			return agent.ProtectedMaintenanceTargetState{}, err
		}
		stopped = index + 1
	}
	if err := r.stopContainer(ctx, target.ContainerName, 30); err != nil {
		for restore := stopped - 1; restore >= 0; restore-- {
			_ = r.startExclusiveContainer(ctx, target.DependentContainers[restore].ContainerName)
		}
		return agent.ProtectedMaintenanceTargetState{}, err
	}
	stoppedState, err := r.InspectProtectedMaintenanceTarget(ctx, target)
	if err != nil || stoppedState.Target.State == "running" {
		return agent.ProtectedMaintenanceTargetState{}, fmt.Errorf("protected_maintenance_target_did_not_stop")
	}
	return stoppedState, nil
}

func (r *EngineRuntime) RestoreProtectedMaintenanceTarget(ctx context.Context, target agent.ExclusiveDrainTarget) (agent.ProtectedMaintenanceTargetState, error) {
	state, err := r.InspectProtectedMaintenanceTarget(ctx, target)
	if err != nil {
		return agent.ProtectedMaintenanceTargetState{}, err
	}
	if state.Target.State != "running" {
		if err := r.startExclusiveContainer(ctx, target.ContainerName); err != nil {
			return agent.ProtectedMaintenanceTargetState{}, err
		}
	}
	if _, err := r.waitRestoredProtectedContainer(ctx, target.TargetKey, target.ContainerName, target.RequiredImageID,
		target.RequiredImageDigest, target.RequiredConfigDigest, target.MaintenanceGeneration, target.RequiredLabels, target.WorkerID, target.ModelProfileID,
	); err != nil {
		return agent.ProtectedMaintenanceTargetState{}, err
	}
	for index := len(target.DependentContainers) - 1; index >= 0; index-- {
		dependent := target.DependentContainers[index]
		current, inspectErr := r.inspectProtectedContainer(ctx, "dependent", dependent.ContainerName, dependent.RequiredImageID,
			dependent.RequiredImageDigest, dependent.RequiredConfigDigest, 0, dependent.RequiredLabels, "", "")
		if inspectErr != nil {
			return agent.ProtectedMaintenanceTargetState{}, inspectErr
		}
		if current.State != "running" {
			if err := r.startExclusiveContainer(ctx, dependent.ContainerName); err != nil {
				return agent.ProtectedMaintenanceTargetState{}, err
			}
		}
		if _, err := r.waitRestoredProtectedContainer(ctx, "dependent", dependent.ContainerName, dependent.RequiredImageID,
			dependent.RequiredImageDigest, dependent.RequiredConfigDigest, 0, dependent.RequiredLabels, "", ""); err != nil {
			return agent.ProtectedMaintenanceTargetState{}, err
		}
	}
	return r.InspectProtectedMaintenanceTarget(ctx, target)
}

func transitionTargetsEqual(left, right agent.ExclusiveDrainTarget) bool {
	first, firstErr := json.Marshal(left)
	second, secondErr := json.Marshal(right)
	return firstErr == nil && secondErr == nil && bytes.Equal(first, second)
}

func canonicalEngineDigest(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func normalizedInspectMounts(document inspectDocument) []agent.VolumeMount {
	values := make([]agent.VolumeMount, 0, len(document.Mounts))
	for _, mount := range document.Mounts {
		source := mount.Source
		if mount.Type == "volume" {
			source = mount.Name
		}
		values = append(values, agent.VolumeMount{Type: mount.Type, Source: source, Target: mount.Destination, ReadOnly: !mount.RW})
	}
	sort.Slice(values, func(left, right int) bool {
		if values[left].Target != values[right].Target {
			return values[left].Target < values[right].Target
		}
		if values[left].Type != values[right].Type {
			return values[left].Type < values[right].Type
		}
		return values[left].Source < values[right].Source
	})
	return values
}

func normalizedDeclaredMounts(values []agent.VolumeMount) []agent.VolumeMount {
	// Docker inspection deliberately represents zero mounts as a non-nil empty
	// array. Preserve that same canonical representation for the signed legacy
	// declaration; otherwise [] and null compare as different exact identities.
	result := make([]agent.VolumeMount, len(values))
	copy(result, values)
	sort.Slice(result, func(left, right int) bool {
		if result[left].Target != result[right].Target {
			return result[left].Target < result[right].Target
		}
		if result[left].Type != result[right].Type {
			return result[left].Type < result[right].Type
		}
		return result[left].Source < result[right].Source
	})
	return result
}

func legacyEnvironmentDigest(document inspectDocument) string {
	values := append([]string(nil), document.Config.Env...)
	seen := map[string]bool{}
	for _, value := range values {
		name, _, found := strings.Cut(value, "=")
		if !found || name == "" || seen[name] {
			return ""
		}
		seen[name] = true
	}
	sort.Strings(values)
	return canonicalEngineDigest(values)
}

func legacyCommandDigest(document inspectDocument) string {
	return canonicalEngineDigest(struct {
		Entrypoint []string `json:"entrypoint"`
		Command    []string `json:"command"`
	}{Entrypoint: document.Config.Entrypoint, Command: document.Config.Cmd})
}

func legacyHealthcheckDigest(document inspectDocument) string {
	return canonicalEngineDigest(document.Config.Healthcheck)
}

func legacyNetworkMembership(document inspectDocument) map[string]struct{} {
	if document.NetworkSettings.Networks == nil {
		return nil
	}
	result := make(map[string]struct{}, len(document.NetworkSettings.Networks))
	for name := range document.NetworkSettings.Networks {
		result[name] = struct{}{}
	}
	return result
}

func legacyRuntimeDigest(document inspectDocument) string {
	capDrop := append([]string(nil), document.HostConfig.CapDrop...)
	securityOpt := append([]string(nil), document.HostConfig.SecurityOpt...)
	ulimits := append([]engineUlimit(nil), document.HostConfig.Ulimits...)
	sort.Strings(capDrop)
	sort.Strings(securityOpt)
	sort.Slice(ulimits, func(left, right int) bool { return ulimits[left].Name < ulimits[right].Name })
	return canonicalEngineDigest(struct {
		User             string                         `json:"user"`
		Environment      string                         `json:"environmentDigest"`
		Command          string                         `json:"commandDigest"`
		Healthcheck      string                         `json:"healthcheckDigest"`
		Labels           map[string]string              `json:"labels"`
		NetworkMode      string                         `json:"networkMode"`
		IPCMode          string                         `json:"ipcMode"`
		PIDMode          string                         `json:"pidMode"`
		ShmSize          int64                          `json:"shmSize"`
		Networks         map[string]struct{}            `json:"networks"`
		Mounts           []agent.VolumeMount            `json:"mounts"`
		MountPropagation map[string]string              `json:"mountPropagation"`
		ReadonlyRootfs   bool                           `json:"readonlyRootfs"`
		Privileged       bool                           `json:"privileged"`
		CapDrop          []string                       `json:"capDrop"`
		SecurityOpt      []string                       `json:"securityOpt"`
		PidsLimit        int64                          `json:"pidsLimit"`
		Memory           int64                          `json:"memory"`
		MemorySwap       int64                          `json:"memorySwap"`
		CPUPeriod        int64                          `json:"cpuPeriod"`
		CPUQuota         int64                          `json:"cpuQuota"`
		PortBindings     map[string][]enginePortBinding `json:"portBindings"`
		ExposedPorts     map[string]struct{}            `json:"exposedPorts"`
		Tmpfs            map[string]string              `json:"tmpfs"`
		Ulimits          []engineUlimit                 `json:"ulimits"`
		DeviceRequests   []engineDeviceRequest          `json:"deviceRequests"`
		RestartPolicy    string                         `json:"restartPolicy"`
	}{
		User: document.Config.User, Environment: legacyEnvironmentDigest(document), Command: legacyCommandDigest(document),
		Healthcheck: legacyHealthcheckDigest(document), Labels: document.Config.Labels,
		NetworkMode: document.HostConfig.NetworkMode, IPCMode: document.HostConfig.IpcMode,
		PIDMode: document.HostConfig.PidMode, ShmSize: document.HostConfig.ShmSize,
		Networks: legacyNetworkMembership(document), Mounts: normalizedInspectMounts(document),
		MountPropagation: inspectMountPropagation(document),
		ReadonlyRootfs:   document.HostConfig.ReadonlyRootfs, Privileged: document.HostConfig.Privileged,
		CapDrop: capDrop, SecurityOpt: securityOpt, PidsLimit: document.HostConfig.PidsLimit,
		Memory: document.HostConfig.Memory, MemorySwap: document.HostConfig.MemorySwap,
		CPUPeriod: document.HostConfig.CPUPeriod, CPUQuota: document.HostConfig.CPUQuota,
		PortBindings: document.HostConfig.PortBindings, ExposedPorts: document.Config.ExposedPorts, Tmpfs: document.HostConfig.Tmpfs,
		Ulimits: ulimits, DeviceRequests: document.HostConfig.DeviceRequests,
		RestartPolicy: document.HostConfig.RestartPolicy.Name,
	})
}

func inspectMountPropagation(document inspectDocument) map[string]string {
	if len(document.Mounts) == 0 {
		return nil
	}
	result := map[string]string{}
	for _, mount := range document.Mounts {
		result[mount.Destination] = mount.Propagation
	}
	return result
}

func exactLegacyContainer(document inspectDocument, expected agent.LegacyContainerIdentity) bool {
	name := strings.TrimPrefix(document.Name, "/")
	if document.ID != expected.ContainerID || name != expected.ContainerName ||
		document.Image != expected.RequiredImageID || document.Config.Image != expected.RequiredImageReference ||
		document.HostConfig.NetworkMode != expected.RequiredNetworkMode ||
		legacyRuntimeDigest(document) != expected.RequiredRuntimeDigest ||
		legacyEnvironmentDigest(document) != expected.RequiredEnvironmentDigest ||
		legacyCommandDigest(document) != expected.RequiredCommandDigest ||
		legacyHealthcheckDigest(document) != expected.RequiredHealthcheckDigest ||
		!bytes.Equal(mustJSON(normalizedInspectMounts(document)), mustJSON(normalizedDeclaredMounts(expected.RequiredMounts))) {
		return false
	}
	for key, value := range expected.RequiredLabels {
		if document.Config.Labels[key] != value {
			return false
		}
	}
	return true
}

func mustJSON(value any) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}

func (r *EngineRuntime) inspectLegacyContainer(ctx context.Context, expected agent.LegacyContainerIdentity, name string) (inspectDocument, error) {
	var document inspectDocument
	if err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", nil, &document, http.StatusOK); err != nil {
		return inspectDocument{}, fmt.Errorf("legacy_protected_set_identity_unavailable")
	}
	comparison := expected
	comparison.ContainerName = name
	if !exactLegacyContainer(document, comparison) {
		return inspectDocument{}, fmt.Errorf("legacy_protected_set_identity_drift")
	}
	return document, nil
}

func expectedPortBindings(values []agent.PublishedPort) map[string][]enginePortBinding {
	if len(values) == 0 {
		return nil
	}
	result := map[string][]enginePortBinding{}
	for _, value := range values {
		key := strconv.Itoa(value.ContainerPort) + "/tcp"
		result[key] = []enginePortBinding{{HostIP: value.HostIP, HostPort: strconv.Itoa(value.HostPort)}}
	}
	return result
}

func expectedExposedPorts(image map[string]struct{}, values []agent.PublishedPort) map[string]struct{} {
	if len(image) == 0 && len(values) == 0 {
		return nil
	}
	result := map[string]struct{}{}
	for key := range image {
		result[key] = struct{}{}
	}
	for _, value := range values {
		result[strconv.Itoa(value.ContainerPort)+"/tcp"] = struct{}{}
	}
	return result
}

func exactHealthcheck(left *engineHealthConfig, right *agent.ContainerHealthCheck) bool {
	if right == nil {
		return left != nil && len(left.Test) >= 2
	}
	if left == nil {
		return false
	}
	return left.Interval == right.Interval && left.Timeout == right.Timeout && left.StartPeriod == right.StartPeriod &&
		left.Retries == right.Retries && bytes.Equal(mustJSON(left.Test), mustJSON(right.Test))
}

func environmentMap(values []string) (map[string]string, bool) {
	result := map[string]string{}
	for _, value := range values {
		name, entry, found := strings.Cut(value, "=")
		if !found || name == "" {
			return nil, false
		}
		if _, duplicate := result[name]; duplicate {
			return nil, false
		}
		result[name] = entry
	}
	return result, true
}

func expectedEnvironment(image imageInspectDocument, overrides map[string]string) (map[string]string, bool) {
	result, valid := environmentMap(image.Config.Env)
	if !valid {
		return nil, false
	}
	for name, value := range overrides {
		result[name] = value
	}
	return result, true
}

func expectedTmpfs(limits agent.ResourceLimits, security agent.SecurityProfile, executable bool) map[string]string {
	execFlag := "noexec"
	if executable {
		execFlag = "exec"
	}
	return map[string]string{"/tmp": "rw," + execFlag + ",nosuid,nodev,size=" + strconv.FormatInt(limits.EphemeralBytes, 10) +
		",uid=" + strconv.FormatUint(uint64(security.RunAsUID), 10) + ",gid=" + strconv.FormatUint(uint64(security.RunAsGID), 10) + ",mode=0700"}
}

func expectedSecurityOptions(security agent.SecurityProfile) []string {
	values := []string{"no-new-privileges:true"}
	if security.SeccompProfile != "" {
		profile := security.SeccompProfile
		if profile == "teamaibox-plugin-v1" {
			profile = "builtin"
		}
		values = append(values, "seccomp="+profile)
	}
	sort.Strings(values)
	return values
}

func expectedDeviceRequests(devices []string) []engineDeviceRequest {
	if len(devices) == 0 {
		return nil
	}
	return []engineDeviceRequest{{Driver: "nvidia", Count: -1, Capabilities: [][]string{{"gpu"}}}}
}

func exactDesiredWorkerRuntime(document inspectDocument, image imageInspectDocument, spec agent.WorkerStartPayload, target agent.ExclusiveDrainTarget) bool {
	actualEnvironment, actualEnvironmentValid := environmentMap(document.Config.Env)
	wantedEnvironment, wantedEnvironmentValid := expectedEnvironment(image, spec.Environment)
	wantedHealth := spec.HealthCheck
	if wantedHealth == nil && image.Config.Healthcheck != nil {
		wantedHealth = &agent.ContainerHealthCheck{Test: image.Config.Healthcheck.Test, Interval: image.Config.Healthcheck.Interval,
			Timeout: image.Config.Healthcheck.Timeout, StartPeriod: image.Config.Healthcheck.StartPeriod, Retries: image.Config.Healthcheck.Retries}
	}
	securityOptions := append([]string(nil), document.HostConfig.SecurityOpt...)
	sort.Strings(securityOptions)
	ulimits := append([]engineUlimit(nil), document.HostConfig.Ulimits...)
	sort.Slice(ulimits, func(left, right int) bool { return ulimits[left].Name < ulimits[right].Name })
	wantedCommand := spec.Command
	if len(wantedCommand) == 0 {
		wantedCommand = image.Config.Cmd
	}
	wantedEntrypoint := spec.Entrypoint
	if len(wantedEntrypoint) == 0 {
		wantedEntrypoint = image.Config.Entrypoint
	}
	if strings.TrimPrefix(document.Name, "/") != target.ContainerName || document.HostConfig.NetworkMode != spec.Network ||
		document.Config.User != fmt.Sprintf("%d:%d", spec.Security.RunAsUID, spec.Security.RunAsGID) ||
		!document.HostConfig.ReadonlyRootfs || document.HostConfig.Privileged ||
		document.HostConfig.IpcMode != "private" || (document.HostConfig.PidMode != "" && document.HostConfig.PidMode != "private") ||
		document.HostConfig.PidsLimit != spec.Limits.PidsLimit || document.HostConfig.Memory != spec.Limits.MemoryBytes ||
		document.HostConfig.MemorySwap != spec.Limits.MemoryBytes || document.HostConfig.CPUPeriod != 100_000 ||
		document.HostConfig.CPUQuota != spec.Limits.CPUQuotaMicros || document.HostConfig.RestartPolicy.Name != "no" ||
		!bytes.Equal(mustJSON(normalizedInspectMounts(document)), mustJSON(normalizedDeclaredMounts(spec.Mounts))) ||
		!bytes.Equal(mustJSON(document.HostConfig.PortBindings), mustJSON(expectedPortBindings(spec.PublishedPorts))) ||
		!bytes.Equal(mustJSON(document.Config.ExposedPorts), mustJSON(expectedExposedPorts(image.Config.ExposedPorts, spec.PublishedPorts))) ||
		!actualEnvironmentValid || !wantedEnvironmentValid || !bytes.Equal(mustJSON(actualEnvironment), mustJSON(wantedEnvironment)) ||
		!bytes.Equal(mustJSON(document.Config.Cmd), mustJSON(wantedCommand)) ||
		!bytes.Equal(mustJSON(document.Config.Entrypoint), mustJSON(wantedEntrypoint)) ||
		!bytes.Equal(mustJSON(document.HostConfig.Tmpfs), mustJSON(expectedTmpfs(spec.Limits, spec.Security, spec.TmpfsExecutable))) ||
		!bytes.Equal(mustJSON(ulimits), mustJSON([]engineUlimit{{Name: "nofile", Soft: spec.Limits.OpenFilesLimit, Hard: spec.Limits.OpenFilesLimit}})) ||
		!bytes.Equal(mustJSON(document.HostConfig.DeviceRequests), mustJSON(expectedDeviceRequests(spec.Devices))) ||
		!bytes.Equal(mustJSON(securityOptions), mustJSON(expectedSecurityOptions(spec.Security))) ||
		!exactHealthcheck(document.Config.Healthcheck, wantedHealth) ||
		document.Config.Labels["com.teamaibox.start-spec-digest"] != strings.TrimPrefix(agent.WorkerStartSpecDigest(spec), "sha256:") {
		return false
	}
	capDrop := append([]string(nil), document.HostConfig.CapDrop...)
	sort.Strings(capDrop)
	if !bytes.Equal(mustJSON(capDrop), mustJSON([]string{"ALL"})) {
		return false
	}
	return len(document.NetworkSettings.Networks) == 1 && document.NetworkSettings.Networks[spec.Network].IPAddress != ""
}

func companionSpecDigest(spec agent.ProtectedCompanionStartPayload) string {
	return canonicalEngineDigest(spec)
}

func companionLabels(spec agent.ProtectedCompanionStartPayload, ownership agent.Ownership) map[string]string {
	values := map[string]string{}
	for key, value := range spec.RequiredLabels {
		values[key] = value
	}
	values["com.teamaibox.managed"] = "true"
	values["com.teamaibox.kind"] = "protected-companion"
	values["com.teamaibox.parent-worker-id"] = spec.ParentWorkerID
	values["com.teamaibox.node-id"] = ownership.NodeID
	values["com.teamaibox.node-generation"] = strconv.FormatInt(ownership.NodeGeneration, 10)
	values["com.teamaibox.image-digest"] = spec.Image
	values["com.teamaibox.config-digest"] = spec.ConfigDigest
	values["com.teamaibox.start-command-id"] = ownership.CommandID
	values["com.teamaibox.start-command-digest"] = ownership.CommandDigest
	values["com.teamaibox.start-spec-digest"] = companionSpecDigest(spec)
	return values
}

func (r *EngineRuntime) exactCompanionImage(ctx context.Context, spec agent.ProtectedCompanionStartPayload) (imageInspectDocument, error) {
	var image imageInspectDocument
	endpoint := "/images/" + url.PathEscape(spec.Image) + "/json"
	if err := r.request(ctx, http.MethodGet, endpoint, nil, &image, http.StatusOK); err != nil {
		return imageInspectDocument{}, fmt.Errorf("protected_set_transition_companion_image_unavailable")
	}
	matched := localContentImageMatches(spec.Image, image)
	for _, digest := range image.RepoDigests {
		if repositoryDigestMatches(spec.Image, digest) {
			matched = true
		}
	}
	if !matched || image.ID != spec.RequiredImageID {
		return imageInspectDocument{}, fmt.Errorf("protected_set_transition_companion_image_identity_drift")
	}
	return image, nil
}

func (r *EngineRuntime) inspectExactCompanionImage(ctx context.Context, spec agent.ProtectedCompanionStartPayload) error {
	_, err := r.exactCompanionImage(ctx, spec)
	return err
}

func (r *EngineRuntime) startProtectedCompanion(ctx context.Context, spec agent.ProtectedCompanionStartPayload, ownership agent.Ownership) error {
	if err := r.inspectExactCompanionImage(ctx, spec); err != nil {
		return err
	}
	request := createRequest{Image: spec.Image, Cmd: append([]string(nil), spec.Command...), Labels: companionLabels(spec, ownership),
		User: fmt.Sprintf("%d:%d", spec.Security.RunAsUID, spec.Security.RunAsGID)}
	request.Healthcheck = &engineHealthConfig{Test: append([]string(nil), spec.HealthCheck.Test...), Interval: spec.HealthCheck.Interval,
		Timeout: spec.HealthCheck.Timeout, StartPeriod: spec.HealthCheck.StartPeriod, Retries: spec.HealthCheck.Retries}
	request.HostConfig.ReadonlyRootfs = true
	request.HostConfig.CapDrop = []string{"ALL"}
	request.HostConfig.SecurityOpt = []string{"no-new-privileges:true"}
	if spec.Security.SeccompProfile != "" {
		profile := spec.Security.SeccompProfile
		if profile == "teamaibox-plugin-v1" {
			profile = "builtin"
		}
		request.HostConfig.SecurityOpt = append(request.HostConfig.SecurityOpt, "seccomp="+profile)
	}
	request.HostConfig.PidsLimit = spec.Limits.PidsLimit
	request.HostConfig.Memory = spec.Limits.MemoryBytes
	request.HostConfig.MemorySwap = spec.Limits.MemoryBytes
	request.HostConfig.CPUPeriod = 100_000
	request.HostConfig.CPUQuota = spec.Limits.CPUQuotaMicros
	request.HostConfig.NetworkMode = spec.Network
	request.HostConfig.Tmpfs = map[string]string{"/tmp": "rw,noexec,nosuid,nodev,size=" + strconv.FormatInt(spec.Limits.EphemeralBytes, 10) +
		",uid=" + strconv.FormatUint(uint64(spec.Security.RunAsUID), 10) + ",gid=" + strconv.FormatUint(uint64(spec.Security.RunAsGID), 10) + ",mode=0700"}
	request.HostConfig.Ulimits = []engineUlimit{{Name: "nofile", Soft: spec.Limits.OpenFilesLimit, Hard: spec.Limits.OpenFilesLimit}}
	request.HostConfig.RestartPolicy.Name = "no"
	for _, mount := range spec.Mounts {
		request.HostConfig.Mounts = append(request.HostConfig.Mounts, engineMount(mount))
	}
	if len(spec.PublishedPorts) != 0 {
		request.ExposedPorts = map[string]struct{}{}
		request.HostConfig.PortBindings = expectedPortBindings(spec.PublishedPorts)
		for key := range request.HostConfig.PortBindings {
			request.ExposedPorts[key] = struct{}{}
		}
	}
	for name, value := range spec.Environment {
		request.Env = append(request.Env, name+"="+value)
	}
	sort.Strings(request.Env)
	var created struct {
		ID string `json:"Id"`
	}
	if err := r.request(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(spec.ContainerName), request, &created, http.StatusCreated); err != nil {
		return fmt.Errorf("protected_set_transition_companion_create_failed")
	}
	if err := r.request(ctx, http.MethodPost, "/containers/"+url.PathEscape(created.ID)+"/start", nil, nil, http.StatusNoContent); err != nil {
		return fmt.Errorf("protected_set_transition_companion_start_failed")
	}
	return nil
}

func exactDesiredCompanionRuntime(document inspectDocument, image imageInspectDocument, spec agent.ProtectedCompanionStartPayload) bool {
	actualEnvironment, actualEnvironmentValid := environmentMap(document.Config.Env)
	wantedEnvironment, wantedEnvironmentValid := expectedEnvironment(image, spec.Environment)
	securityOptions := append([]string(nil), document.HostConfig.SecurityOpt...)
	sort.Strings(securityOptions)
	ulimits := append([]engineUlimit(nil), document.HostConfig.Ulimits...)
	sort.Slice(ulimits, func(left, right int) bool { return ulimits[left].Name < ulimits[right].Name })
	wantedCommand := spec.Command
	if len(wantedCommand) == 0 {
		wantedCommand = image.Config.Cmd
	}
	if strings.TrimPrefix(document.Name, "/") != spec.ContainerName || document.Image != spec.RequiredImageID ||
		document.Config.Image != spec.Image || document.HostConfig.NetworkMode != "compute-internal" ||
		document.Config.User != fmt.Sprintf("%d:%d", spec.Security.RunAsUID, spec.Security.RunAsGID) ||
		!document.HostConfig.ReadonlyRootfs || document.HostConfig.Privileged ||
		document.HostConfig.IpcMode != "private" || (document.HostConfig.PidMode != "" && document.HostConfig.PidMode != "private") ||
		document.HostConfig.PidsLimit != spec.Limits.PidsLimit || document.HostConfig.Memory != spec.Limits.MemoryBytes ||
		document.HostConfig.MemorySwap != spec.Limits.MemoryBytes || document.HostConfig.CPUPeriod != 100_000 ||
		document.HostConfig.CPUQuota != spec.Limits.CPUQuotaMicros || document.HostConfig.RestartPolicy.Name != "no" ||
		!bytes.Equal(mustJSON(normalizedInspectMounts(document)), mustJSON(normalizedDeclaredMounts(spec.Mounts))) ||
		!bytes.Equal(mustJSON(document.HostConfig.PortBindings), mustJSON(expectedPortBindings(spec.PublishedPorts))) ||
		!bytes.Equal(mustJSON(document.Config.ExposedPorts), mustJSON(expectedExposedPorts(image.Config.ExposedPorts, spec.PublishedPorts))) ||
		!actualEnvironmentValid || !wantedEnvironmentValid || !bytes.Equal(mustJSON(actualEnvironment), mustJSON(wantedEnvironment)) ||
		!bytes.Equal(mustJSON(document.Config.Cmd), mustJSON(wantedCommand)) ||
		!bytes.Equal(mustJSON(document.Config.Entrypoint), mustJSON(image.Config.Entrypoint)) ||
		!bytes.Equal(mustJSON(document.HostConfig.Tmpfs), mustJSON(expectedTmpfs(spec.Limits, spec.Security, false))) ||
		!bytes.Equal(mustJSON(ulimits), mustJSON([]engineUlimit{{Name: "nofile", Soft: spec.Limits.OpenFilesLimit, Hard: spec.Limits.OpenFilesLimit}})) ||
		len(document.HostConfig.DeviceRequests) != 0 || !bytes.Equal(mustJSON(securityOptions), mustJSON(expectedSecurityOptions(spec.Security))) ||
		!exactHealthcheck(document.Config.Healthcheck, spec.HealthCheck) ||
		document.Config.Labels["com.teamaibox.start-spec-digest"] != companionSpecDigest(spec) {
		return false
	}
	capDrop := append([]string(nil), document.HostConfig.CapDrop...)
	sort.Strings(capDrop)
	network, networkFound := document.NetworkSettings.Networks[spec.Network]
	// Docker removes a stopped container's dynamic IP while retaining its
	// immutable network membership.  Exact inspection must therefore accept an
	// owned created/exited companion with an empty IP so staging can resume or
	// rollback can delete it.  A running companion still needs a live endpoint;
	// subsequent health verification remains mandatory before it is accepted as
	// desired runtime.
	if !bytes.Equal(mustJSON(capDrop), mustJSON([]string{"ALL"})) ||
		len(document.NetworkSettings.Networks) != 1 || !networkFound ||
		(document.State.Status == "running" && network.IPAddress == "") {
		return false
	}
	for key, value := range spec.RequiredLabels {
		if document.Config.Labels[key] != value {
			return false
		}
	}
	return document.Config.Labels["com.teamaibox.managed"] == "true" && document.Config.Labels["com.teamaibox.kind"] == "protected-companion" &&
		document.Config.Labels["com.teamaibox.parent-worker-id"] == spec.ParentWorkerID &&
		document.Config.Labels["com.teamaibox.image-digest"] == spec.Image && document.Config.Labels["com.teamaibox.config-digest"] == spec.ConfigDigest
}

func (r *EngineRuntime) inspectDesiredCompanion(ctx context.Context, spec agent.ProtectedCompanionStartPayload) (inspectDocument, error) {
	image, err := r.exactCompanionImage(ctx, spec)
	if err != nil {
		return inspectDocument{}, err
	}
	var document inspectDocument
	if err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(spec.ContainerName)+"/json", nil, &document, http.StatusOK); err != nil {
		return inspectDocument{}, err
	}
	if !exactDesiredCompanionRuntime(document, image, spec) {
		return inspectDocument{}, fmt.Errorf("protected_set_transition_companion_identity_drift")
	}
	return document, nil
}

func transitionLegacyBackupName(primary string, dependentIndex int) string {
	if dependentIndex < 0 {
		return primary
	}
	return primary + "-d" + strconv.Itoa(dependentIndex+1)
}

func (r *EngineRuntime) inspectLegacyContainerOptional(ctx context.Context, expected agent.LegacyContainerIdentity, name string) (inspectDocument, bool, error) {
	exists, err := r.protectedTransitionContainerExists(ctx, name)
	if err != nil || !exists {
		return inspectDocument{}, false, err
	}
	document, err := r.inspectLegacyContainer(ctx, expected, name)
	return document, true, err
}

func healthyRunningDocument(document inspectDocument) bool {
	return document.State.Status == "running" && containerHealth(document) == "healthy"
}

func (r *EngineRuntime) waitLegacyHealthy(ctx context.Context, expected agent.LegacyContainerIdentity, name string) error {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		document, err := r.inspectLegacyContainer(ctx, expected, name)
		if err == nil && healthyRunningDocument(document) {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("legacy_protected_set_health_timeout")
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (r *EngineRuntime) waitDesiredCompanionHealthy(ctx context.Context, spec agent.ProtectedCompanionStartPayload) error {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		document, err := r.inspectDesiredCompanion(ctx, spec)
		if err == nil && healthyRunningDocument(document) {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("protected_set_transition_companion_health_timeout")
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (r *EngineRuntime) verifyDesiredTransition(ctx context.Context, change agent.ProtectedSetTransitionTarget) (agent.WorkerState, error) {
	image, err := r.exactTransitionImage(ctx, change.DesiredWorker, change.DesiredTarget)
	if err != nil {
		return agent.WorkerState{}, err
	}
	state, err := r.protectedTransitionWorkerState(ctx, change.DesiredTarget)
	if err != nil {
		return agent.WorkerState{}, err
	}
	var document inspectDocument
	if err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(change.DesiredTarget.ContainerName)+"/json", nil, &document, http.StatusOK); err != nil ||
		!exactDesiredWorkerRuntime(document, image, change.DesiredWorker, change.DesiredTarget) {
		return agent.WorkerState{}, fmt.Errorf("protected_set_transition_desired_runtime_drift")
	}
	if len(change.DesiredCompanions) != len(change.DesiredTarget.DependentContainers) {
		return agent.WorkerState{}, fmt.Errorf("protected_set_transition_companion_identity_drift")
	}
	for _, companion := range change.DesiredCompanions {
		companionDocument, companionErr := r.inspectDesiredCompanion(ctx, companion)
		if companionErr != nil || !healthyRunningDocument(companionDocument) {
			return agent.WorkerState{}, fmt.Errorf("protected_set_transition_companion_unhealthy")
		}
	}
	return state, nil
}

func transitionRollbackTarget(target agent.ExclusiveDrainTarget, name string) agent.ExclusiveDrainTarget {
	value := target
	value.ContainerName = name
	return value
}

func engineNotFound(err error) bool {
	var status *engineStatusError
	return errors.As(err, &status) && status.status == http.StatusNotFound
}

func (r *EngineRuntime) protectedTransitionContainerExists(ctx context.Context, name string) (bool, error) {
	var document inspectDocument
	err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", nil, &document, http.StatusOK)
	if engineNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return document.ID != "", nil
}

func (r *EngineRuntime) inspectProtectedTransitionTargetOptional(ctx context.Context, target agent.ExclusiveDrainTarget) (agent.ProtectedMaintenanceTargetState, bool, error) {
	exists, err := r.protectedTransitionContainerExists(ctx, target.ContainerName)
	if err != nil || !exists {
		return agent.ProtectedMaintenanceTargetState{}, false, err
	}
	state, err := r.InspectProtectedMaintenanceTarget(ctx, target)
	return state, true, err
}

func (r *EngineRuntime) protectedTransitionWorkerState(ctx context.Context, target agent.ExclusiveDrainTarget) (agent.WorkerState, error) {
	state, err := r.InspectProtectedMaintenanceTarget(ctx, target)
	if err != nil || state.Target.State != "running" || state.Target.Health != "healthy" {
		return agent.WorkerState{}, fmt.Errorf("protected_set_transition_desired_unhealthy")
	}
	for _, dependency := range state.Dependencies {
		if dependency.State != "running" || dependency.Health != "healthy" {
			return agent.WorkerState{}, fmt.Errorf("protected_set_transition_desired_unhealthy")
		}
	}
	var document inspectDocument
	if err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(target.ContainerName)+"/json", nil, &document, http.StatusOK); err != nil {
		return agent.WorkerState{}, err
	}
	startedAt, _ := time.Parse(time.RFC3339Nano, document.State.StartedAt)
	return agent.WorkerState{
		WorkerID: target.WorkerID, ModelProfileID: target.ModelProfileID, ContainerID: document.ID,
		Status: document.State.Status, Health: containerHealth(document), Image: document.Config.Image,
		PlacementClass: agent.PlacementProtectedResident, MaintenanceGeneration: target.MaintenanceGeneration,
		ConfigDigest: target.RequiredConfigDigest, StartedAt: startedAt,
	}, nil
}

// InspectProtectedSetTransitionTarget accepts exactly two states: the healthy
// prior canonical identity before staging, or the healthy desired canonical
// identity with the exact stopped prior rollback container after staging.  It
// never treats an unrelated same-name container as absence.
func (r *EngineRuntime) InspectProtectedSetTransitionTarget(ctx context.Context, change agent.ProtectedSetTransitionTarget, rollbackContainerName string, requireDesired bool) error {
	if canonicalCompanionUpdate(change) {
		return r.inspectCanonicalCompanionUpdate(ctx, change, rollbackContainerName, requireDesired)
	}
	rollbackExists, rollbackErr := r.protectedTransitionContainerExists(ctx, rollbackContainerName)
	if rollbackErr != nil {
		return rollbackErr
	}
	if !requireDesired {
		if change.LegacyPreviousTarget != nil {
			if rollbackExists {
				return fmt.Errorf("protected_set_transition_unowned_identity")
			}
			if _, err := r.exactTransitionImage(ctx, change.DesiredWorker, change.DesiredTarget); err != nil {
				return err
			}
			for _, companion := range change.DesiredCompanions {
				if err := r.inspectExactCompanionImage(ctx, companion); err != nil {
					return err
				}
				if exists, err := r.protectedTransitionContainerExists(ctx, companion.ContainerName); err != nil || exists {
					return fmt.Errorf("protected_set_transition_unowned_identity")
				}
			}
			if exists, err := r.protectedTransitionContainerExists(ctx, change.DesiredTarget.ContainerName); err != nil || exists {
				return fmt.Errorf("protected_set_transition_unowned_identity")
			}
			legacy := change.LegacyPreviousTarget
			identities := append([]agent.LegacyContainerIdentity{legacy.Primary}, legacy.DependentContainers...)
			for index, identity := range identities {
				backup := transitionLegacyBackupName(rollbackContainerName, index-1)
				if exists, err := r.protectedTransitionContainerExists(ctx, backup); err != nil || exists {
					return fmt.Errorf("protected_set_transition_unowned_identity")
				}
				document, found, err := r.inspectLegacyContainerOptional(ctx, identity, identity.ContainerName)
				if err != nil || !found || !healthyRunningDocument(document) {
					return fmt.Errorf("legacy_protected_set_identity_drift")
				}
				if index > 0 && strings.HasPrefix(identity.RequiredNetworkMode, "container:") &&
					identity.RequiredNetworkMode != "container:"+legacy.Primary.ContainerID {
					return fmt.Errorf("legacy_protected_set_namespace_drift")
				}
			}
			return nil
		}
		// Before a fresh transaction is journaled the Docker state must match the
		// Scheduler-declared prior state exactly. In particular, an exact-looking
		// same-name container is not adoptable when the signed plan says cold boot;
		// accepting it would let a race bypass ownership of the prior identity.
		if rollbackExists {
			return fmt.Errorf("protected_set_transition_unowned_identity")
		}
		if change.PreviousTarget == nil {
			canonicalExists, err := r.protectedTransitionContainerExists(ctx, change.DesiredTarget.ContainerName)
			if err != nil {
				return err
			}
			if canonicalExists {
				return fmt.Errorf("protected_set_transition_unowned_identity")
			}
			return nil
		}
		prior, found, err := r.inspectProtectedTransitionTargetOptional(ctx, *change.PreviousTarget)
		if err != nil || !found || prior.Target.State != "running" || prior.Target.Health != "healthy" {
			return fmt.Errorf("protected_set_transition_prior_identity_drift")
		}
		for _, dependency := range prior.Dependencies {
			if dependency.State != "running" || dependency.Health != "healthy" {
				return fmt.Errorf("protected_set_transition_prior_identity_drift")
			}
		}
		return nil
	}
	if change.LegacyPreviousTarget != nil {
		if _, err := r.verifyDesiredTransition(ctx, change); err != nil {
			return err
		}
		legacy := change.LegacyPreviousTarget
		identities := append([]agent.LegacyContainerIdentity{legacy.Primary}, legacy.DependentContainers...)
		for index, identity := range identities {
			backup := transitionLegacyBackupName(rollbackContainerName, index-1)
			document, found, err := r.inspectLegacyContainerOptional(ctx, identity, backup)
			if err != nil || !found || document.State.Status == "running" {
				return fmt.Errorf("protected_set_transition_prior_identity_drift")
			}
			if exists, err := r.protectedTransitionContainerExists(ctx, identity.ContainerName); err != nil || exists {
				return fmt.Errorf("protected_set_transition_unowned_identity")
			}
		}
		return nil
	}

	desired, desiredFound, desiredErr := r.inspectProtectedTransitionTargetOptional(ctx, change.DesiredTarget)
	if desiredErr != nil || !desiredFound || desired.Target.State != "running" || desired.Target.Health != "healthy" {
		return fmt.Errorf("protected_set_transition_desired_unhealthy")
	}
	for _, dependency := range desired.Dependencies {
		if dependency.State != "running" || dependency.Health != "healthy" {
			return fmt.Errorf("protected_set_transition_desired_unhealthy")
		}
	}
	if change.PreviousTarget != nil && !transitionTargetsEqual(*change.PreviousTarget, change.DesiredTarget) {
		if !rollbackExists {
			return fmt.Errorf("protected_set_transition_prior_identity_drift")
		}
		rollback := transitionRollbackTarget(*change.PreviousTarget, rollbackContainerName)
		prior, found, err := r.inspectProtectedTransitionTargetOptional(ctx, rollback)
		if err != nil || !found || prior.Target.State == "running" {
			return fmt.Errorf("protected_set_transition_prior_identity_drift")
		}
		return nil
	}
	if rollbackExists {
		return fmt.Errorf("protected_set_transition_unowned_identity")
	}
	return nil
}

func (r *EngineRuntime) renameProtectedTransitionContainer(ctx context.Context, from, to string) error {
	endpoint := "/containers/" + url.PathEscape(from) + "/rename?name=" + url.QueryEscape(to)
	if err := r.request(ctx, http.MethodPost, endpoint, nil, nil, http.StatusNoContent); err != nil {
		return fmt.Errorf("protected_set_transition_rename_failed")
	}
	return nil
}

func (r *EngineRuntime) removeProtectedTransitionDesired(ctx context.Context, target agent.ExclusiveDrainTarget) error {
	exists, err := r.protectedTransitionContainerExists(ctx, target.ContainerName)
	if err != nil || !exists {
		return err
	}
	// Prove the canonical container is the exact desired identity before the
	// transition-only removal. A failed create/start is allowed to be unhealthy;
	// identity verification itself remains strict.
	primary, err := r.inspectProtectedContainer(ctx, target.TargetKey, target.ContainerName, target.RequiredImageID,
		target.RequiredImageDigest, target.RequiredConfigDigest, target.MaintenanceGeneration,
		target.RequiredLabels, target.WorkerID, target.ModelProfileID)
	if err != nil {
		return err
	}
	if primary.State == "running" {
		// When the whole desired target is healthy, use the dependency-aware stop
		// primitive. For a partially failed start, companions are still the stopped
		// prior identities and must not be guessed or mutated here.
		if _, stopErr := r.StopProtectedMaintenanceTarget(ctx, target); stopErr != nil {
			if err := r.stopContainer(ctx, target.ContainerName, 30); err != nil {
				return fmt.Errorf("protected_set_transition_desired_stop_failed")
			}
		}
	}
	if err := r.request(ctx, http.MethodDelete, "/containers/"+url.PathEscape(target.ContainerName)+"?force=1", nil, nil,
		http.StatusNoContent); err != nil {
		return fmt.Errorf("protected_set_transition_desired_remove_failed")
	}
	return nil
}

func (r *EngineRuntime) stopLegacyExact(ctx context.Context, expected agent.LegacyContainerIdentity, name string) error {
	document, err := r.inspectLegacyContainer(ctx, expected, name)
	if err != nil {
		return err
	}
	if document.State.Status != "running" {
		return nil
	}
	if containerHealth(document) != "healthy" {
		return fmt.Errorf("legacy_protected_set_health_invalid")
	}
	if err := r.stopContainer(ctx, name, 30); err != nil {
		return err
	}
	document, err = r.inspectLegacyContainer(ctx, expected, name)
	if err != nil || document.State.Status == "running" {
		return fmt.Errorf("legacy_protected_set_stop_failed")
	}
	return nil
}

func (r *EngineRuntime) backupLegacyIdentity(ctx context.Context, expected agent.LegacyContainerIdentity, backup string) error {
	original, originalFound, originalErr := r.inspectLegacyContainerOptional(ctx, expected, expected.ContainerName)
	stored, storedFound, storedErr := r.inspectLegacyContainerOptional(ctx, expected, backup)
	if originalErr != nil || storedErr != nil || (originalFound && storedFound) || (!originalFound && !storedFound) {
		return fmt.Errorf("legacy_protected_set_backup_identity_drift")
	}
	if storedFound {
		if stored.State.Status == "running" {
			return fmt.Errorf("legacy_protected_set_backup_identity_drift")
		}
		return nil
	}
	if original.State.Status == "running" {
		return fmt.Errorf("legacy_protected_set_backup_identity_drift")
	}
	return r.renameProtectedTransitionContainer(ctx, expected.ContainerName, backup)
}

func (r *EngineRuntime) stageLegacySet(ctx context.Context, change agent.ProtectedSetTransitionTarget, ownership agent.Ownership, rollbackContainerName string) (agent.WorkerState, error) {
	if state, err := r.verifyDesiredTransition(ctx, change); err == nil {
		return state, nil
	}
	legacy := change.LegacyPreviousTarget
	if legacy == nil {
		return agent.WorkerState{}, fmt.Errorf("legacy_protected_set_plan_missing")
	}
	if _, err := r.exactTransitionImage(ctx, change.DesiredWorker, change.DesiredTarget); err != nil {
		return agent.WorkerState{}, err
	}
	for _, companion := range change.DesiredCompanions {
		if err := r.inspectExactCompanionImage(ctx, companion); err != nil {
			return agent.WorkerState{}, err
		}
	}
	// A namespace-sharing Provider must stop before its Worker. All dependents
	// are stopped first, followed by the exact legacy primary.
	for index, identity := range legacy.DependentContainers {
		backup := transitionLegacyBackupName(rollbackContainerName, index)
		_, found, inspectErr := r.inspectLegacyContainerOptional(ctx, identity, backup)
		if inspectErr != nil {
			return agent.WorkerState{}, inspectErr
		}
		if !found {
			if err := r.stopLegacyExact(ctx, identity, identity.ContainerName); err != nil {
				return agent.WorkerState{}, err
			}
		}
	}
	_, primaryStored, inspectErr := r.inspectLegacyContainerOptional(ctx, legacy.Primary, rollbackContainerName)
	if inspectErr != nil {
		return agent.WorkerState{}, inspectErr
	}
	if !primaryStored {
		if err := r.stopLegacyExact(ctx, legacy.Primary, legacy.Primary.ContainerName); err != nil {
			return agent.WorkerState{}, err
		}
	}
	// Rename dependents before their Worker, preserving exact container IDs as
	// stopped rollback objects. Each operation accepts its already-renamed state
	// so a crash at any boundary is replayable from the fsynced transaction.
	for index, identity := range legacy.DependentContainers {
		if err := r.backupLegacyIdentity(ctx, identity, transitionLegacyBackupName(rollbackContainerName, index)); err != nil {
			return agent.WorkerState{}, err
		}
	}
	if err := r.backupLegacyIdentity(ctx, legacy.Primary, rollbackContainerName); err != nil {
		return agent.WorkerState{}, err
	}
	if _, err := r.StartWorker(ctx, change.DesiredWorker, ownership); err != nil {
		return agent.WorkerState{}, err
	}
	if _, err := r.waitProtectedContainerHealthy(ctx, change.DesiredTarget.TargetKey, change.DesiredTarget.ContainerName,
		change.DesiredTarget.RequiredImageID, change.DesiredTarget.RequiredImageDigest, change.DesiredTarget.RequiredConfigDigest,
		change.DesiredTarget.MaintenanceGeneration, change.DesiredTarget.RequiredLabels,
		change.DesiredTarget.WorkerID, change.DesiredTarget.ModelProfileID, protectedHealthWaitBound(change.DesiredWorker.HealthCheck)); err != nil {
		return agent.WorkerState{}, err
	}
	for _, companion := range change.DesiredCompanions {
		if document, found, err := r.inspectDesiredCompanionOptional(ctx, companion); err != nil {
			return agent.WorkerState{}, err
		} else if found {
			if document.State.Status != "running" {
				if err := r.startExclusiveContainer(ctx, companion.ContainerName); err != nil {
					return agent.WorkerState{}, err
				}
			}
		} else if err := r.startProtectedCompanion(ctx, companion, ownership); err != nil {
			return agent.WorkerState{}, err
		}
		if err := r.waitDesiredCompanionHealthy(ctx, companion); err != nil {
			return agent.WorkerState{}, err
		}
	}
	return r.verifyDesiredTransition(ctx, change)
}

func transitionManifestDigest(reference string) string {
	if digestID.MatchString(reference) {
		return reference
	}
	_, value, found := strings.Cut(reference, "@")
	if !found || !digestID.MatchString(value) {
		return ""
	}
	return value
}

func protectedTransitionSnapshot(document inspectDocument, startSpecDigest string) agent.ProtectedSetTransitionContainerSnapshot {
	return agent.ProtectedSetTransitionContainerSnapshot{
		ContainerName: strings.TrimPrefix(document.Name, "/"), ContainerID: document.ID,
		ImageReference: document.Config.Image, ImageID: document.Image,
		ImageManifestDigest: transitionManifestDigest(document.Config.Image),
		RuntimeDigest:       legacyRuntimeDigest(document), NetworkMode: document.HostConfig.NetworkMode,
		State: document.State.Status, Health: containerHealth(document), StartSpecDigest: startSpecDigest,
		OOMKilled: document.State.OOMKilled, Exact: true,
	}
}

func protectedModelMaterialMode(spec agent.WorkerStartPayload) (string, bool) {
	found := false
	for _, mount := range spec.Mounts {
		target := filepath.Clean(mount.Target)
		modelMaterial := target == "/model" || strings.HasPrefix(target, "/model/") ||
			target == "/model-cache" || strings.HasPrefix(target, "/model-cache/") ||
			target == "/runtime" || strings.HasPrefix(target, "/runtime/") ||
			target == "/runtime/auth" || strings.HasPrefix(target, "/runtime/auth/") ||
			target == "/run/secrets/auth" || strings.HasPrefix(target, "/run/secrets/auth/")
		if !modelMaterial {
			continue
		}
		found = true
		if !mount.ReadOnly {
			return "writable-model-material", false
		}
	}
	if !found {
		return "image-contained", true
	}
	return "read-only-mounts", true
}

// InspectProtectedSetTransitionRuntime performs only GET-by-exact-name Docker
// requests. The coordinator supplies every name from the already-fsynced
// migration journal; this method has no caller-selected container surface.
func (r *EngineRuntime) InspectProtectedSetTransitionRuntime(ctx context.Context,
	payload agent.ProtectedSetTransitionPayload, rollbackContainerNames []string,
	requireDesired bool) ([]agent.ProtectedSetTransitionTargetSnapshot, error) {
	if len(payload.Targets) == 0 || len(payload.Targets) != len(rollbackContainerNames) {
		return nil, fmt.Errorf("protected_set_transition_inspection_binding_invalid")
	}
	result := make([]agent.ProtectedSetTransitionTargetSnapshot, 0, len(payload.Targets))
	for index, change := range payload.Targets {
		if change.LegacyPreviousTarget == nil && change.PreviousTarget == nil {
			return nil, fmt.Errorf("protected_set_transition_inspection_binding_invalid")
		}
		rollbackName := rollbackContainerNames[index]
		snapshot := agent.ProtectedSetTransitionTargetSnapshot{
			TargetKey: change.DesiredTarget.TargetKey, StageOrder: change.DesiredTarget.StageOrder,
			WorkerID: change.DesiredTarget.WorkerID, ModelProfileID: change.DesiredTarget.ModelProfileID,
			DesiredCompanions:   []agent.ProtectedSetTransitionContainerSnapshot{},
			LegacyDependents:    []agent.ProtectedSetTransitionContainerSnapshot{},
			CanonicalDependents: []agent.ProtectedSetTransitionContainerSnapshot{},
		}
		legacy := change.LegacyPreviousTarget
		if !requireDesired {
			if err := r.InspectProtectedSetTransitionTarget(ctx, change, rollbackName, false); err != nil {
				return nil, err
			}
			if legacy == nil {
				previous := change.PreviousTarget
				var document inspectDocument
				if err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(previous.ContainerName)+"/json",
					nil, &document, http.StatusOK); err != nil ||
					!exactProtectedContainerDocument(document, previous.RequiredImageID, previous.RequiredImageDigest,
						previous.RequiredConfigDigest, previous.MaintenanceGeneration, previous.RequiredLabels,
						previous.WorkerID, previous.ModelProfileID) ||
					!healthyRunningDocument(document) || document.State.OOMKilled {
					return nil, fmt.Errorf("protected_set_transition_inspection_runtime_drift")
				}
				primary := protectedTransitionSnapshot(document, previous.RequiredStartSpecDigest)
				snapshot.CanonicalPrevious = &primary
				for _, dependent := range previous.DependentContainers {
					var dependentDocument inspectDocument
					if err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(dependent.ContainerName)+"/json",
						nil, &dependentDocument, http.StatusOK); err != nil ||
						!exactProtectedContainerDocument(dependentDocument, dependent.RequiredImageID,
							dependent.RequiredImageDigest, dependent.RequiredConfigDigest, 0,
							dependent.RequiredLabels, "", "") ||
						!healthyRunningDocument(dependentDocument) || dependentDocument.State.OOMKilled {
						return nil, fmt.Errorf("protected_set_transition_inspection_runtime_drift")
					}
					snapshot.CanonicalDependents = append(snapshot.CanonicalDependents,
						protectedTransitionSnapshot(dependentDocument, ""))
				}
				snapshot.RuntimeState = "canonical-exact"
				result = append(result, snapshot)
				continue
			}
			primary, err := r.inspectLegacyContainer(ctx, legacy.Primary, legacy.Primary.ContainerName)
			if err != nil || !healthyRunningDocument(primary) || primary.State.OOMKilled {
				return nil, fmt.Errorf("protected_set_transition_inspection_runtime_drift")
			}
			primarySnapshot := protectedTransitionSnapshot(primary, "")
			snapshot.LegacyPrimary = &primarySnapshot
			for _, expected := range legacy.DependentContainers {
				document, inspectErr := r.inspectLegacyContainer(ctx, expected, expected.ContainerName)
				if inspectErr != nil || !healthyRunningDocument(document) || document.State.OOMKilled {
					return nil, fmt.Errorf("protected_set_transition_inspection_runtime_drift")
				}
				snapshot.LegacyDependents = append(snapshot.LegacyDependents,
					protectedTransitionSnapshot(document, ""))
			}
			snapshot.RuntimeState = "legacy-exact"
			result = append(result, snapshot)
			continue
		}

		if _, err := r.verifyDesiredTransition(ctx, change); err != nil {
			return nil, err
		}
		if legacy != nil {
			identities := append([]agent.LegacyContainerIdentity{legacy.Primary}, legacy.DependentContainers...)
			for identityIndex, identity := range identities {
				backup := transitionLegacyBackupName(rollbackName, identityIndex-1)
				if exists, err := r.protectedTransitionContainerExists(ctx, identity.ContainerName); err != nil || exists {
					return nil, fmt.Errorf("protected_set_transition_inspection_runtime_drift")
				}
				if exists, err := r.protectedTransitionContainerExists(ctx, backup); err != nil || exists {
					return nil, fmt.Errorf("protected_set_transition_inspection_runtime_drift")
				}
			}
		} else {
			// A normal update keeps the canonical name. It has no legacy
			// identity to dereference or require absent after commit.
			for dependentIndex := -1; dependentIndex < len(change.PreviousTarget.DependentContainers); dependentIndex++ {
				backup := transitionLegacyBackupName(rollbackName, dependentIndex)
				if exists, err := r.protectedTransitionContainerExists(ctx, backup); err != nil || exists {
					return nil, fmt.Errorf("protected_set_transition_inspection_runtime_drift")
				}
			}
		}
		var desired inspectDocument
		if err := r.request(ctx, http.MethodGet,
			"/containers/"+url.PathEscape(change.DesiredTarget.ContainerName)+"/json",
			nil, &desired, http.StatusOK); err != nil || desired.State.OOMKilled {
			return nil, fmt.Errorf("protected_set_transition_inspection_runtime_drift")
		}
		desiredSnapshot := protectedTransitionSnapshot(desired, change.DesiredTarget.RequiredStartSpecDigest)
		snapshot.Desired = &desiredSnapshot
		snapshot.MountsExact = true
		snapshot.ModelMaterialMode, snapshot.ReadOnlyModelMount =
			protectedModelMaterialMode(change.DesiredWorker)
		snapshot.HealthcheckExact = true
		snapshot.RuntimeLimitsExact = true
		snapshot.LegacyHostNetworkRemoved = legacy != nil && legacy.Primary.RequiredNetworkMode == "host" &&
			change.DesiredWorker.Network == "compute-internal"
		snapshot.TmpfsExecutable = change.DesiredWorker.TmpfsExecutable
		for _, companion := range change.DesiredCompanions {
			document, err := r.inspectDesiredCompanion(ctx, companion)
			if err != nil || !healthyRunningDocument(document) || document.State.OOMKilled {
				return nil, fmt.Errorf("protected_set_transition_inspection_runtime_drift")
			}
			snapshot.DesiredCompanions = append(snapshot.DesiredCompanions,
				protectedTransitionSnapshot(document, companionSpecDigest(companion)))
		}
		snapshot.RuntimeState = "desired-exact"
		result = append(result, snapshot)
	}
	return result, nil
}

func (r *EngineRuntime) inspectDesiredCompanionOptional(ctx context.Context, spec agent.ProtectedCompanionStartPayload) (inspectDocument, bool, error) {
	exists, err := r.protectedTransitionContainerExists(ctx, spec.ContainerName)
	if err != nil || !exists {
		return inspectDocument{}, false, err
	}
	document, err := r.inspectDesiredCompanion(ctx, spec)
	return document, true, err
}

func (r *EngineRuntime) removeDesiredCompanions(ctx context.Context, companions []agent.ProtectedCompanionStartPayload) error {
	for index := len(companions) - 1; index >= 0; index-- {
		spec := companions[index]
		document, found, err := r.inspectDesiredCompanionOptional(ctx, spec)
		if err != nil {
			return err
		}
		if !found {
			continue
		}
		if document.State.Status == "running" {
			if err := r.stopContainer(ctx, spec.ContainerName, exclusiveDependentStopGraceSeconds); err != nil {
				return err
			}
		}
		if err := r.request(ctx, http.MethodDelete, "/containers/"+url.PathEscape(document.ID), nil, nil, http.StatusNoContent); err != nil {
			return fmt.Errorf("protected_set_transition_companion_remove_failed")
		}
	}
	return nil
}

func (r *EngineRuntime) restoreLegacyName(ctx context.Context, expected agent.LegacyContainerIdentity, backup string) (inspectDocument, error) {
	original, originalFound, originalErr := r.inspectLegacyContainerOptional(ctx, expected, expected.ContainerName)
	stored, storedFound, storedErr := r.inspectLegacyContainerOptional(ctx, expected, backup)
	if originalErr != nil || storedErr != nil || (originalFound && storedFound) || (!originalFound && !storedFound) {
		return inspectDocument{}, fmt.Errorf("legacy_protected_set_restore_identity_drift")
	}
	if originalFound {
		return original, nil
	}
	if stored.State.Status == "running" {
		return inspectDocument{}, fmt.Errorf("legacy_protected_set_restore_identity_drift")
	}
	if err := r.renameProtectedTransitionContainer(ctx, backup, expected.ContainerName); err != nil {
		return inspectDocument{}, err
	}
	return r.inspectLegacyContainer(ctx, expected, expected.ContainerName)
}

func (r *EngineRuntime) rollbackLegacySet(ctx context.Context, change agent.ProtectedSetTransitionTarget, rollbackContainerName string) error {
	legacy := change.LegacyPreviousTarget
	if legacy == nil {
		return fmt.Errorf("legacy_protected_set_plan_missing")
	}
	if err := r.removeDesiredCompanions(ctx, change.DesiredCompanions); err != nil {
		return err
	}
	if err := r.removeProtectedTransitionDesired(ctx, change.DesiredTarget); err != nil {
		return err
	}
	primary, err := r.restoreLegacyName(ctx, legacy.Primary, rollbackContainerName)
	if err != nil {
		return err
	}
	if primary.State.Status != "running" {
		if err := r.startExclusiveContainer(ctx, legacy.Primary.ContainerName); err != nil {
			return err
		}
	}
	if err := r.waitLegacyHealthy(ctx, legacy.Primary, legacy.Primary.ContainerName); err != nil {
		return err
	}
	// Restore dependency names first, then start them in reverse declaration
	// order after the primary is healthy. This preserves Worker-before-Provider
	// recovery for the legacy OCR shared-namespace pair.
	for index := range legacy.DependentContainers {
		if _, err := r.restoreLegacyName(ctx, legacy.DependentContainers[index], transitionLegacyBackupName(rollbackContainerName, index)); err != nil {
			return err
		}
	}
	for index := len(legacy.DependentContainers) - 1; index >= 0; index-- {
		identity := legacy.DependentContainers[index]
		document, err := r.inspectLegacyContainer(ctx, identity, identity.ContainerName)
		if err != nil {
			return err
		}
		if document.State.Status != "running" {
			if err := r.startExclusiveContainer(ctx, identity.ContainerName); err != nil {
				return err
			}
		}
		if err := r.waitLegacyHealthy(ctx, identity, identity.ContainerName); err != nil {
			return err
		}
	}
	return nil
}

func (r *EngineRuntime) commitLegacySet(ctx context.Context, change agent.ProtectedSetTransitionTarget, rollbackContainerName string) error {
	if _, err := r.verifyDesiredTransition(ctx, change); err != nil {
		return err
	}
	legacy := change.LegacyPreviousTarget
	if legacy == nil {
		return fmt.Errorf("legacy_protected_set_plan_missing")
	}
	identities := append([]agent.LegacyContainerIdentity(nil), legacy.DependentContainers...)
	identities = append(identities, legacy.Primary)
	for index, identity := range identities {
		backupIndex := index
		if index == len(identities)-1 {
			backupIndex = -1
		}
		backup := transitionLegacyBackupName(rollbackContainerName, backupIndex)
		document, found, err := r.inspectLegacyContainerOptional(ctx, identity, backup)
		if err != nil {
			return err
		}
		if !found {
			continue // exact idempotent cleanup replay after a lost response
		}
		if document.State.Status == "running" {
			return fmt.Errorf("protected_set_transition_prior_identity_drift")
		}
		if exists, err := r.protectedTransitionContainerExists(ctx, identity.ContainerName); err != nil || exists {
			return fmt.Errorf("protected_set_transition_unowned_identity")
		}
		if err := r.request(ctx, http.MethodDelete, "/containers/"+url.PathEscape(document.ID), nil, nil, http.StatusNoContent); err != nil {
			return fmt.Errorf("protected_set_transition_prior_cleanup_failed")
		}
	}
	return nil
}

func (r *EngineRuntime) StageProtectedSetTransitionTarget(ctx context.Context, change agent.ProtectedSetTransitionTarget, ownership agent.Ownership, rollbackContainerName string) (agent.WorkerState, error) {
	if canonicalCompanionUpdate(change) {
		return r.stageCanonicalCompanionUpdate(ctx, change, ownership, rollbackContainerName)
	}
	if change.LegacyPreviousTarget != nil {
		return r.stageLegacySet(ctx, change, ownership, rollbackContainerName)
	}
	if state, err := r.protectedTransitionWorkerState(ctx, change.DesiredTarget); err == nil {
		if change.PreviousTarget != nil && !transitionTargetsEqual(*change.PreviousTarget, change.DesiredTarget) {
			rollback := transitionRollbackTarget(*change.PreviousTarget, rollbackContainerName)
			prior, found, inspectErr := r.inspectProtectedTransitionTargetOptional(ctx, rollback)
			if inspectErr != nil || !found || prior.Target.State == "running" {
				return agent.WorkerState{}, fmt.Errorf("protected_set_transition_prior_identity_drift")
			}
		}
		return state, nil
	}
	if change.PreviousTarget != nil && transitionTargetsEqual(*change.PreviousTarget, change.DesiredTarget) {
		return agent.WorkerState{}, fmt.Errorf("protected_set_transition_desired_unhealthy")
	}
	if change.PreviousTarget != nil {
		rollback := transitionRollbackTarget(*change.PreviousTarget, rollbackContainerName)
		_, backupFound, backupErr := r.inspectProtectedTransitionTargetOptional(ctx, rollback)
		if backupErr != nil {
			return agent.WorkerState{}, backupErr
		}
		if !backupFound {
			if _, err := r.StopProtectedMaintenanceTarget(ctx, *change.PreviousTarget); err != nil {
				return agent.WorkerState{}, err
			}
			if err := r.renameProtectedTransitionContainer(ctx, change.PreviousTarget.ContainerName, rollbackContainerName); err != nil {
				return agent.WorkerState{}, err
			}
		} else {
			prior, _, err := r.inspectProtectedTransitionTargetOptional(ctx, rollback)
			if err != nil || prior.Target.State == "running" {
				return agent.WorkerState{}, fmt.Errorf("protected_set_transition_prior_identity_drift")
			}
		}
	} else {
		exists, err := r.protectedTransitionContainerExists(ctx, change.DesiredTarget.ContainerName)
		if err != nil || exists {
			return agent.WorkerState{}, fmt.Errorf("protected_set_transition_unowned_identity")
		}
	}
	if _, err := r.StartWorker(ctx, change.DesiredWorker, ownership); err != nil {
		return agent.WorkerState{}, err
	}
	if _, err := r.RestoreProtectedMaintenanceTarget(ctx, change.DesiredTarget); err != nil {
		return agent.WorkerState{}, err
	}
	return r.protectedTransitionWorkerState(ctx, change.DesiredTarget)
}

func (r *EngineRuntime) RollbackProtectedSetTransitionTarget(ctx context.Context, change agent.ProtectedSetTransitionTarget, _ agent.Ownership, rollbackContainerName string) error {
	if canonicalCompanionUpdate(change) {
		return r.rollbackCanonicalCompanionUpdate(ctx, change, rollbackContainerName)
	}
	if change.LegacyPreviousTarget != nil {
		return r.rollbackLegacySet(ctx, change, rollbackContainerName)
	}
	if change.PreviousTarget != nil && transitionTargetsEqual(*change.PreviousTarget, change.DesiredTarget) {
		_, err := r.RestoreProtectedMaintenanceTarget(ctx, change.DesiredTarget)
		return err
	}
	rollbackExists := false
	if change.PreviousTarget != nil {
		rollback := transitionRollbackTarget(*change.PreviousTarget, rollbackContainerName)
		_, found, err := r.inspectProtectedTransitionTargetOptional(ctx, rollback)
		if err != nil {
			return err
		}
		rollbackExists = found
		if !rollbackExists {
			// This target was not reached, or failure happened before the prior
			// canonical container was renamed.  Never mistake that healthy prior
			// identity for a partially-created desired container.
			prior, priorFound, priorErr := r.inspectProtectedTransitionTargetOptional(ctx, *change.PreviousTarget)
			if priorErr == nil && priorFound {
				if prior.Target.State != "running" {
					_, priorErr = r.RestoreProtectedMaintenanceTarget(ctx, *change.PreviousTarget)
				}
				return priorErr
			}
			if priorErr != nil {
				return priorErr
			}
		}
	} else {
		exists, err := r.protectedTransitionContainerExists(ctx, change.DesiredTarget.ContainerName)
		if err != nil || !exists {
			return err
		}
	}
	if err := r.removeProtectedTransitionDesired(ctx, change.DesiredTarget); err != nil {
		return err
	}
	if change.PreviousTarget == nil {
		if rollbackExists {
			return fmt.Errorf("protected_set_transition_unowned_identity")
		}
		return nil
	}
	if rollbackExists {
		if err := r.renameProtectedTransitionContainer(ctx, rollbackContainerName, change.PreviousTarget.ContainerName); err != nil {
			return err
		}
	}
	_, err := r.RestoreProtectedMaintenanceTarget(ctx, *change.PreviousTarget)
	return err
}

func (r *EngineRuntime) CommitProtectedSetTransitionTarget(ctx context.Context, change agent.ProtectedSetTransitionTarget, _ agent.Ownership, rollbackContainerName string) error {
	if canonicalCompanionUpdate(change) {
		return r.commitCanonicalCompanionUpdate(ctx, change, rollbackContainerName)
	}
	if change.LegacyPreviousTarget != nil {
		return r.commitLegacySet(ctx, change, rollbackContainerName)
	}
	if _, err := r.protectedTransitionWorkerState(ctx, change.DesiredTarget); err != nil {
		return err
	}
	if change.PreviousTarget == nil || transitionTargetsEqual(*change.PreviousTarget, change.DesiredTarget) {
		exists, err := r.protectedTransitionContainerExists(ctx, rollbackContainerName)
		if err != nil || exists {
			return fmt.Errorf("protected_set_transition_unowned_identity")
		}
		return nil
	}
	rollback := transitionRollbackTarget(*change.PreviousTarget, rollbackContainerName)
	prior, found, err := r.inspectProtectedTransitionTargetOptional(ctx, rollback)
	if err != nil {
		return err
	}
	if !found {
		return nil // idempotent cleanup replay after a lost response
	}
	if prior.Target.State == "running" {
		return fmt.Errorf("protected_set_transition_prior_identity_drift")
	}
	if err := r.request(ctx, http.MethodDelete, "/containers/"+url.PathEscape(rollbackContainerName), nil, nil,
		http.StatusNoContent); err != nil {
		return fmt.Errorf("protected_set_transition_prior_cleanup_failed")
	}
	return nil
}

func sandboxArchive(projection agent.SandboxFileProjection) (string, []byte, error) {
	type archiveFile struct {
		name     string
		contents []byte
		mode     int64
		uid      int
		gid      int
	}
	parent := "/run/secrets"
	directories := []string{}
	files := []archiveFile{{name: "teamaibox-model-token", contents: projection.Contents, mode: 0o400, uid: 65532, gid: 65532}}
	if projection.FileClass == "opencode-config" {
		parent = "/run/teamaibox"
		directories = []string{"xdg-config", "xdg-config/opencode"}
		files = []archiveFile{
			{name: "xdg-config/opencode/opencode.json", contents: projection.Contents, mode: 0o444, uid: 0, gid: 0},
			// OpenCode always ensures this sibling file while it initializes an
			// instance. Pre-projecting the exact immutable sentinel lets the
			// unmodified upstream run with a root-owned read-only config directory.
			{name: "xdg-config/opencode/.gitignore", contents: []byte("node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n"), mode: 0o444, uid: 0, gid: 0},
		}
	} else if projection.FileClass == "source-client-config" {
		var config struct {
			PipConf    string `json:"pipConf"`
			NPMRC      string `json:"npmrc"`
			APTConf    string `json:"aptConf"`
			APTSources string `json:"aptSources"`
		}
		if err := json.Unmarshal(projection.Contents, &config); err != nil {
			return "", nil, fmt.Errorf("Agent source client configuration is invalid")
		}
		parent = "/run/teamaibox"
		directories = []string{"source-config", "source-config/apt"}
		files = []archiveFile{
			{name: "source-config/pip.conf", contents: []byte(config.PipConf), mode: 0o444, uid: 0, gid: 0},
			{name: "source-config/npmrc", contents: []byte(config.NPMRC), mode: 0o444, uid: 0, gid: 0},
			{name: "source-config/apt/apt.conf", contents: []byte(config.APTConf), mode: 0o444, uid: 0, gid: 0},
			{name: "source-config/apt/sources.list", contents: []byte(config.APTSources), mode: 0o444, uid: 0, gid: 0},
		}
	} else if projection.FileClass != "model-token" {
		return "", nil, fmt.Errorf("Agent sandbox file class is not supported")
	}
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	for _, directory := range directories {
		if err := writer.WriteHeader(&tar.Header{Name: directory, Typeflag: tar.TypeDir, Mode: 0o555, Uid: 0, Gid: 0, ModTime: time.Unix(0, 0).UTC()}); err != nil {
			return "", nil, fmt.Errorf("Agent sandbox archive could not be created")
		}
	}
	for _, file := range files {
		if err := writer.WriteHeader(&tar.Header{Name: file.name, Typeflag: tar.TypeReg, Mode: file.mode, Uid: file.uid, Gid: file.gid, Size: int64(len(file.contents)), ModTime: time.Unix(0, 0).UTC()}); err != nil {
			return "", nil, fmt.Errorf("Agent sandbox archive could not be created")
		}
		if _, err := writer.Write(file.contents); err != nil {
			return "", nil, fmt.Errorf("Agent sandbox archive could not be created")
		}
	}
	if err := writer.Close(); err != nil {
		return "", nil, fmt.Errorf("Agent sandbox archive could not be created")
	}
	return parent, buffer.Bytes(), nil
}

func (r *EngineRuntime) putArchive(ctx context.Context, containerID, parent string, contents []byte) error {
	endpoint := "/containers/" + url.PathEscape(containerID) + "/archive?path=" + url.QueryEscape(parent) + "&noOverwriteDirNonDir=1"
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, r.baseURL+endpoint, bytes.NewReader(contents))
	if err != nil {
		return fmt.Errorf("docker archive request construction failed")
	}
	request.Header.Set("Content-Type", "application/x-tar")
	response, err := r.client.Do(request)
	if err != nil {
		return fmt.Errorf("docker engine is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.CopyN(io.Discard, response.Body, 64<<10)
		return fmt.Errorf("docker engine rejected sandbox file projection with status %d", response.StatusCode)
	}
	return nil
}

func (r *EngineRuntime) ProjectSandboxFile(ctx context.Context, projection agent.SandboxFileProjection, ownership agent.Ownership) (agent.SandboxFileState, error) {
	state, err := r.inspect(ctx, projection.WorkerID, ownership)
	if err != nil {
		return agent.SandboxFileState{}, err
	}
	if state.Status != "running" {
		return agent.SandboxFileState{}, fmt.Errorf("Agent sandbox is not running")
	}
	var document inspectDocument
	endpoint := "/containers/" + url.PathEscape(containerName(projection.WorkerID)) + "/json"
	if err := r.request(ctx, http.MethodGet, endpoint, nil, &document, http.StatusOK); err != nil {
		return agent.SandboxFileState{}, ErrNotFound
	}
	labels := document.Config.Labels
	if labels["com.teamaibox.kind"] != "agent-sandbox" ||
		labels["com.teamaibox.owner-identity-id"] != projection.OwnerIdentityID ||
		labels["com.teamaibox.sandbox-key"] != projection.SandboxKey {
		return agent.SandboxFileState{}, fmt.Errorf("Agent sandbox file projection ownership does not match")
	}
	parent, archive, err := sandboxArchive(projection)
	if err != nil {
		return agent.SandboxFileState{}, err
	}
	defer func() {
		for index := range archive {
			archive[index] = 0
		}
	}()
	if err := r.putArchive(ctx, document.ID, parent, archive); err != nil {
		return agent.SandboxFileState{}, err
	}
	return agent.SandboxFileState{
		WorkerID: projection.WorkerID, FileClass: projection.FileClass,
		ContentSHA256: projection.ContentSHA256, Bytes: len(projection.Contents),
	}, nil
}
