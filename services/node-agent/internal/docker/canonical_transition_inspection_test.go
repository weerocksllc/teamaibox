package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

// Full post-commit inspection must support a normal update, not only the
// historical migration. These Docker requests are all read-only.
func TestCanonicalPostCommitInspectionWithoutLegacyIdentity(t *testing.T) {
	spec := agent.WorkerStartPayload{
		WorkerID:       testWorkerID,
		AttemptID:      testAttempt,
		ModelProfileID: "00000000-0000-4000-8000-000000000401",
		Image:          "registry.local/worker@sha256:" + strings.Repeat("a", 64),
		Network:        "compute-internal",
		Limits: agent.ResourceLimits{
			MemoryBytes: 1 << 30, CPUQuotaMicros: 100_000, PidsLimit: 64,
			EphemeralBytes: 2 << 30, OpenFilesLimit: 4096,
		},
		Security: agent.SecurityProfile{
			RunAsUID: 10001, RunAsGID: 10001, ReadOnlyRoot: true,
			DropAllCaps: true, NoNewPrivileges: true,
		},
		Entrypoint:  []string{"/opt/teamaibox/worker-entrypoint", "--fixed-mode"},
		Command:     []string{"serve", "--port", "9000"},
		HealthCheck: &agent.ContainerHealthCheck{Test: []string{"CMD-SHELL", "test -r /proc/1/status"}, Interval: 10_000_000_000, Timeout: 2_000_000_000, StartPeriod: 30_000_000_000, Retries: 3},
	}
	target := agent.ExclusiveDrainTarget{ContainerName: "teamaibox-worker-" + spec.WorkerID}
	image := imageInspectDocument{}
	image.Config.Entrypoint = []string{"/image/default-entrypoint"}
	image.Config.Cmd = []string{"image-default"}
	document := inspectDocument{Name: "/" + target.ContainerName, Image: "sha256:" + strings.Repeat("b", 64)}
	document.Config.Image = spec.Image
	document.Config.User = "10001:10001"
	document.Config.Cmd = append([]string(nil), spec.Command...)
	document.Config.Entrypoint = append([]string(nil), spec.Entrypoint...)
	document.Config.Labels = map[string]string{
		"com.teamaibox.start-spec-digest": strings.TrimPrefix(agent.WorkerStartSpecDigest(spec), "sha256:"),
	}
	document.Config.Healthcheck = &engineHealthConfig{Test: append([]string(nil), spec.HealthCheck.Test...), Interval: spec.HealthCheck.Interval,
		Timeout: spec.HealthCheck.Timeout, StartPeriod: spec.HealthCheck.StartPeriod, Retries: spec.HealthCheck.Retries}
	document.HostConfig.NetworkMode = spec.Network
	document.HostConfig.IpcMode = "private"
	document.HostConfig.ReadonlyRootfs = true
	document.HostConfig.CapDrop = []string{"ALL"}
	document.HostConfig.SecurityOpt = []string{"no-new-privileges:true"}
	document.HostConfig.PidsLimit = spec.Limits.PidsLimit
	document.HostConfig.Memory = spec.Limits.MemoryBytes
	document.HostConfig.MemorySwap = spec.Limits.MemoryBytes
	document.HostConfig.CPUPeriod = 100_000
	document.HostConfig.CPUQuota = spec.Limits.CPUQuotaMicros
	document.HostConfig.Tmpfs = expectedTmpfs(spec.Limits, spec.Security, false)
	document.HostConfig.Ulimits = []engineUlimit{{Name: "nofile", Soft: spec.Limits.OpenFilesLimit, Hard: spec.Limits.OpenFilesLimit}}
	document.HostConfig.RestartPolicy.Name = "no"
	document.NetworkSettings.Networks = map[string]struct {
		IPAddress string `json:"IPAddress"`
	}{spec.Network: {IPAddress: "172.30.0.2"}}
	_, _, _, ownership := dockerFixture(t)
	spec.PlacementClass = agent.PlacementProtectedResident
	spec.MaintenanceGeneration = 2
	spec.ConfigDigest = "sha256:" + strings.Repeat("c", 64)
	target.WorkerID = spec.WorkerID
	target.ModelProfileID = spec.ModelProfileID
	target.PlacementClass = spec.PlacementClass
	target.MaintenanceGeneration = spec.MaintenanceGeneration
	target.RequiredImageID = document.Image
	target.RequiredImageDigest = spec.Image
	target.RequiredConfigDigest = spec.ConfigDigest
	target.RequiredStartSpecDigest = agent.WorkerStartSpecDigest(spec)
	document.ID = strings.Repeat("2", 64)
	document.Config.Labels = engineLabels(ownership, spec)
	if err := json.Unmarshal([]byte(`{"Status":"running","Health":{"Status":"healthy"}}`), &document.State); err != nil {
		t.Fatal(err)
	}
	image.ID = document.Image
	image.RepoDigests = []string{spec.Image}
	backupPresent := false
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.Method != http.MethodGet {
			t.Fatalf("inspection mutated Docker: %s", request.Method)
		}
		if strings.Contains(request.URL.Path, "teamaibox-protected-prior-") && !backupPresent {
			return response(http.StatusNotFound, `{"message":"not found"}`), nil
		}
		var raw []byte
		if strings.Contains(request.URL.Path, "/images/") {
			raw, _ = json.Marshal(image)
		} else {
			raw, _ = json.Marshal(document)
		}
		return response(http.StatusOK, string(raw)), nil
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	payload := agent.ProtectedSetTransitionPayload{Targets: []agent.ProtectedSetTransitionTarget{{
		DesiredWorker: spec, DesiredTarget: target, PreviousTarget: &target,
	}}}
	names := []string{"teamaibox-protected-prior-transaction-worker"}
	result, err := runtime.InspectProtectedSetTransitionRuntime(context.Background(), payload, names, true)
	if err != nil || len(result) != 1 || result[0].Desired == nil || result[0].RuntimeState != "desired-exact" ||
		result[0].LegacyHostNetworkRemoved || result[0].Desired.ContainerID != document.ID {
		t.Fatalf("normal post-commit inspection failed: %#v %v", result, err)
	}
	if requests == 0 {
		t.Fatal("no Docker inspection")
	}
	backupPresent = true
	if _, err := runtime.InspectProtectedSetTransitionRuntime(context.Background(), payload, names, true); err == nil {
		t.Fatal("accepted a leftover rollback container")
	}
	backupPresent = false
	document.State.OOMKilled = true
	if _, err := runtime.InspectProtectedSetTransitionRuntime(context.Background(), payload, names, true); err == nil {
		t.Fatal("accepted a container with OOM evidence")
	}
	document.State.OOMKilled = false
	document.Image = "sha256:" + strings.Repeat("f", 64)
	if _, err := runtime.InspectProtectedSetTransitionRuntime(context.Background(), payload, names, true); err == nil {
		t.Fatal("accepted changed image identity")
	}
}
