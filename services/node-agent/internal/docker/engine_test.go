package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func TestEngineRuntimeUsesTheUnixAPIWithAConstrainedCreateDocument(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	spec.Network = "compute-internal"
	spec.Entrypoint = []string{"/opt/teamaibox/worker-entrypoint", "--fixed-mode"}
	spec.Limits.SharedMemoryBytes = 2 << 30
	spec.PublishedPorts = []agent.PublishedPort{{ContainerPort: 8000, HostPort: 18086, HostIP: "10.64.0.18"}}
	var create createRequest
	requests := []string{}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.Method+" "+request.URL.String())
		switch {
		case strings.Contains(request.URL.Path, "/images/"):
			// Docker Engine normalizes docker.io/library/node to node in
			// RepoDigests. The digest must remain exact across that alias.
			exposed := spec.Image
			if strings.HasPrefix(exposed, "docker.io/library/") {
				exposed = strings.TrimPrefix(exposed, "docker.io/library/")
			}
			body, _ := json.Marshal(map[string]any{"RepoDigests": []string{exposed}})
			return response(http.StatusOK, string(body)), nil
		case strings.HasSuffix(request.URL.Path, "/containers/create"):
			if err := json.NewDecoder(request.Body).Decode(&create); err != nil {
				t.Fatal(err)
			}
			return response(http.StatusCreated, `{"Id":"container-a"}`), nil
		case strings.HasSuffix(request.URL.Path, "/containers/container-a/start"):
			return response(http.StatusNoContent, ""), nil
		case strings.Contains(request.URL.Path, "/containers/teamaibox-worker-") && strings.HasSuffix(request.URL.Path, "/json"):
			document := map[string]any{
				"Id":     "container-a",
				"State":  map[string]any{"Status": "running", "StartedAt": "2026-08-11T00:00:00Z"},
				"Config": map[string]any{"Image": spec.Image, "Labels": engineLabels(ownership, spec)},
			}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		default:
			t.Fatalf("unexpected engine request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	state, err := runtime.StartWorker(context.Background(), spec, ownership)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != "running" || len(requests) != 4 {
		t.Fatalf("unexpected engine result/requests: %#v %#v", state, requests)
	}
	if !create.HostConfig.ReadonlyRootfs || create.User != "10001:10001" ||
		!slices.Equal(create.Entrypoint, spec.Entrypoint) ||
		len(create.HostConfig.CapDrop) != 1 || create.HostConfig.CapDrop[0] != "ALL" ||
		create.HostConfig.NetworkMode != "compute-internal" || create.HostConfig.MemorySwap != create.HostConfig.Memory ||
		create.HostConfig.ShmSize != spec.Limits.SharedMemoryBytes ||
		create.HostConfig.CPUPeriod != 100_000 || create.HostConfig.CPUQuota != spec.Limits.CPUQuotaMicros ||
		create.HostConfig.PidsLimit != 64 || create.HostConfig.Tmpfs["/tmp"] == "" ||
		len(create.HostConfig.DeviceRequests) != 1 {
		t.Fatalf("engine create document weakened isolation: %#v", create)
	}
	if !strings.Contains(create.HostConfig.Tmpfs["/tmp"], "uid=10001") ||
		!strings.Contains(create.HostConfig.Tmpfs["/tmp"], "gid=10001") ||
		!strings.Contains(create.HostConfig.Tmpfs["/tmp"], "mode=0700") {
		t.Fatalf("worker tmpfs is not owned by its non-root identity: %#v", create.HostConfig.Tmpfs)
	}
	bindings := create.HostConfig.PortBindings["8000/tcp"]
	if len(create.ExposedPorts) != 1 || len(bindings) != 1 || bindings[0].HostIP != "10.64.0.18" || bindings[0].HostPort != "18086" {
		t.Fatalf("engine did not preserve the exact approved management port: %#v", create)
	}
	if create.Labels["com.teamaibox.fencing-token"] != "9" || create.Labels["com.teamaibox.node-generation"] != "7" || create.Labels["com.teamaibox.image-digest"] != spec.Image ||
		create.Labels["com.teamaibox.start-command-id"] != ownership.CommandID ||
		create.Labels["com.teamaibox.start-command-digest"] != ownership.CommandDigest ||
		create.Labels["com.teamaibox.start-spec-digest"] != workerStartSpecDigest(spec) {
		t.Fatalf("engine ownership labels missing: %#v", create.Labels)
	}
}

func TestExactTransitionInspectionUsesExplicitEntrypointAndFallsBackOnlyWhenOmitted(t *testing.T) {
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
	if !exactDesiredWorkerRuntime(document, image, spec, target) {
		t.Fatal("explicit protected Worker entrypoint was not accepted")
	}

	asrImage := image
	asrImage.Config.ExposedPorts = map[string]struct{}{"8080/tcp": {}}
	asrDocument := document
	asrDocument.Config.ExposedPorts = map[string]struct{}{"8080/tcp": {}}
	assertImageExposedPortRemainsContainerLocal(t, asrDocument, func(candidate inspectDocument) bool {
		return exactDesiredWorkerRuntime(candidate, asrImage, spec, target)
	})

	drifted := document
	drifted.Config.Entrypoint = append([]string(nil), image.Config.Entrypoint...)
	if exactDesiredWorkerRuntime(drifted, image, spec, target) {
		t.Fatal("image-default entrypoint was accepted in place of the explicit protected Worker entrypoint")
	}

	fallbackSpec := spec
	fallbackSpec.Entrypoint = nil
	fallback := document
	fallback.Config.Entrypoint = append([]string(nil), image.Config.Entrypoint...)
	fallback.Config.Labels = map[string]string{
		"com.teamaibox.start-spec-digest": strings.TrimPrefix(agent.WorkerStartSpecDigest(fallbackSpec), "sha256:"),
	}
	if !exactDesiredWorkerRuntime(fallback, image, fallbackSpec, target) {
		t.Fatal("omitted entrypoint did not fall back to the immutable image entrypoint")
	}
}

func TestExactCompanionInspectionAcceptsOnlyImageInheritedExposedPorts(t *testing.T) {
	_, _, _, ownership := dockerFixture(t)
	spec := agent.ProtectedCompanionStartPayload{
		ContainerName:   "teamaibox-asr-provider-canonical",
		ParentWorkerID:  testWorkerID,
		Image:           "registry.local/asr-provider@sha256:" + strings.Repeat("a", 64),
		RequiredImageID: "sha256:" + strings.Repeat("b", 64),
		ConfigDigest:    "sha256:" + strings.Repeat("c", 64),
		Network:         "compute-internal",
		Limits: agent.ResourceLimits{
			MemoryBytes: 1 << 30, CPUQuotaMicros: 100_000, PidsLimit: 64,
			EphemeralBytes: 2 << 30, OpenFilesLimit: 4096,
		},
		Security: agent.SecurityProfile{
			RunAsUID: 10001, RunAsGID: 10001, ReadOnlyRoot: true,
			DropAllCaps: true, NoNewPrivileges: true,
		},
		Environment:    map[string]string{"ASR_MODE": "office"},
		Command:        []string{"serve", "--port", "8080"},
		HealthCheck:    &agent.ContainerHealthCheck{Test: []string{"CMD-SHELL", "test -r /proc/1/status"}, Interval: 10_000_000_000, Timeout: 2_000_000_000, StartPeriod: 30_000_000_000, Retries: 3},
		RequiredLabels: map[string]string{"com.teamaibox.office-companion": "asr"},
	}
	image := imageInspectDocument{}
	image.Config.Env = []string{"IMAGE_DEFAULT=present"}
	image.Config.Entrypoint = []string{"python", "/opt/teamaibox/server.py"}
	image.Config.Cmd = []string{"image-default"}
	image.Config.ExposedPorts = map[string]struct{}{"8080/tcp": {}}
	document := inspectDocument{Name: "/" + spec.ContainerName, Image: spec.RequiredImageID}
	document.Config.Image = spec.Image
	document.Config.User = "10001:10001"
	document.Config.Env = []string{"ASR_MODE=office", "IMAGE_DEFAULT=present"}
	document.Config.Cmd = append([]string(nil), spec.Command...)
	document.Config.Entrypoint = append([]string(nil), image.Config.Entrypoint...)
	document.Config.ExposedPorts = map[string]struct{}{"8080/tcp": {}}
	document.Config.Labels = companionLabels(spec, ownership)
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
	}{spec.Network: {IPAddress: "172.30.0.3"}}

	assertImageExposedPortRemainsContainerLocal(t, document, func(candidate inspectDocument) bool {
		return exactDesiredCompanionRuntime(candidate, image, spec)
	})

	exited := document
	exited.State.Status = "exited"
	exited.NetworkSettings.Networks = map[string]struct {
		IPAddress string `json:"IPAddress"`
	}{spec.Network: {}}
	if !exactDesiredCompanionRuntime(exited, image, spec) {
		t.Fatal("exact stopped companion was rejected only because Docker released its dynamic IP")
	}
	runningWithoutIP := exited
	runningWithoutIP.State.Status = "running"
	if exactDesiredCompanionRuntime(runningWithoutIP, image, spec) {
		t.Fatal("running companion without a live network endpoint was accepted")
	}
	exitedOnWrongNetwork := exited
	exitedOnWrongNetwork.NetworkSettings.Networks = map[string]struct {
		IPAddress string `json:"IPAddress"`
	}{"unexpected": {}}
	if exactDesiredCompanionRuntime(exitedOnWrongNetwork, image, spec) {
		t.Fatal("stopped companion on an unexpected network was accepted")
	}
}

func assertImageExposedPortRemainsContainerLocal(t *testing.T, document inspectDocument, exact func(inspectDocument) bool) {
	t.Helper()
	if !exact(document) {
		t.Fatal("image-inherited ASR port was not accepted without a host publication")
	}

	unexpectedExposed := document
	unexpectedExposed.Config.ExposedPorts = map[string]struct{}{"8080/tcp": {}, "9090/tcp": {}}
	if exact(unexpectedExposed) {
		t.Fatal("unexpected container exposed port was accepted")
	}

	unexpectedPublished := document
	unexpectedPublished.HostConfig.PortBindings = map[string][]enginePortBinding{
		"8080/tcp": {{HostIP: "0.0.0.0", HostPort: "18080"}},
	}
	if exact(unexpectedPublished) {
		t.Fatal("image-inherited exposed port authorized an unexpected host publication")
	}
}

func TestEngineProtectedStartFailurePreservesAndResumesExactContainer(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	spec.PlacementClass = agent.PlacementProtectedResident
	spec.MaintenanceGeneration = 1
	spec.ConfigDigest = "sha256:" + strings.Repeat("d", 64)
	labels := engineLabels(ownership, spec)
	status := "created"
	createCalls := 0
	deleted := false
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(request.URL.Path, "/images/"):
			body, _ := json.Marshal(map[string]any{"RepoDigests": []string{spec.Image}})
			return response(http.StatusOK, string(body)), nil
		case strings.HasSuffix(request.URL.Path, "/containers/create"):
			createCalls++
			if createCalls == 1 {
				return response(http.StatusCreated, `{"Id":"container-protected"}`), nil
			}
			return response(http.StatusConflict, `{"message":"name in use"}`), nil
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/containers/container-protected/start"):
			return response(http.StatusInternalServerError, `{"message":"transient start failure"}`), nil
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/json"):
			document := map[string]any{
				"Id": "container-protected", "State": map[string]any{"Status": status, "StartedAt": "2026-09-04T00:00:00Z", "Health": map[string]any{"Status": "healthy"}},
				"Config": map[string]any{"Image": spec.Image, "Labels": labels},
			}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		case request.Method == http.MethodPost && strings.Contains(request.URL.Path, "/containers/teamaibox-worker-") && strings.HasSuffix(request.URL.Path, "/start"):
			status = "running"
			return response(http.StatusNoContent, ""), nil
		case request.Method == http.MethodDelete:
			deleted = true
			t.Fatalf("protected failed start reached forced deletion: %s", request.URL.String())
			return nil, nil
		default:
			t.Fatalf("unexpected protected start request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	if _, err := runtime.StartWorker(context.Background(), spec, ownership); err == nil || err.Error() != "protected_resident_start_recovery_required" {
		t.Fatalf("protected failed engine start was not preserved: %v", err)
	}
	state, err := runtime.StartWorker(context.Background(), spec, ownership)
	if err != nil || state.Status != "running" || state.PlacementClass != agent.PlacementProtectedResident || deleted {
		t.Fatalf("exact protected engine container was not resumed: %#v %v deleted=%t", state, err, deleted)
	}
}

func TestProtectedSetColdBootInspectionRejectsAnUnexpectedSameNameContainer(t *testing.T) {
	workerID := "00000000-0000-4000-8000-000000000205"
	target := agent.ExclusiveDrainTarget{
		TargetKey: "office.embedding", WorkerID: workerID,
		ModelProfileID: "00000000-0000-4000-8000-000000000215",
		ContainerName:  "teamaibox-worker-" + workerID,
		PlacementClass: agent.PlacementProtectedResident, MaintenanceGeneration: 4,
		StageOrder: 1, RequiredImageID: "sha256:" + strings.Repeat("1", 64),
		RequiredImageDigest:  "registry.local/embedding@sha256:" + strings.Repeat("a", 64),
		RequiredConfigDigest: "sha256:" + strings.Repeat("c", 64), RequiredLabels: map[string]string{},
	}
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.Method != http.MethodGet || !strings.HasSuffix(request.URL.Path, "/json") {
			t.Fatalf("cold-boot inspection reached mutation: %s %s", request.Method, request.URL.String())
		}
		if strings.Contains(request.URL.Path, "teamaibox-protected-prior-") {
			return response(http.StatusNotFound, `{"message":"not found"}`), nil
		}
		return response(http.StatusOK, `{"Id":"unowned-same-name-container"}`), nil
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	err := runtime.InspectProtectedSetTransitionTarget(context.Background(), agent.ProtectedSetTransitionTarget{
		DesiredTarget: target,
	}, "teamaibox-protected-prior-transaction-worker", false)
	if err == nil || err.Error() != "protected_set_transition_unowned_identity" || requests != 2 {
		t.Fatalf("unexpected same-name cold boot identity was adopted: err=%v requests=%d", err, requests)
	}
}

func TestProtectedTransitionSnapshotManifestIsPresentForPinnedPriorCompanions(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	for _, item := range []struct {
		name, image, startSpec string
		manifest, start        bool
	}{
		{"canonical-worker", "registry.local/worker@" + digest, digest, true, true},
		{"canonical-companion", "registry.local/provider@" + digest, "", true, false},
		{"legacy-tag", "registry.local/provider:legacy", "", false, false},
	} {
		t.Run(item.name, func(t *testing.T) {
			var document inspectDocument
			document.Config.Image = item.image
			body, err := json.Marshal(protectedTransitionSnapshot(document, item.startSpec))
			if err != nil {
				t.Fatal(err)
			}
			var value map[string]any
			if err := json.Unmarshal(body, &value); err != nil {
				t.Fatal(err)
			}
			manifest, present := value["imageManifestDigest"]
			if present != item.manifest || (present && manifest != digest) {
				t.Fatalf("manifest serialization mismatched: %s", body)
			}
			_, present = value["startSpecDigest"]
			if present != item.start {
				t.Fatalf("start specification serialization mismatched: %s", body)
			}
		})
	}
}

func TestProtectedSetQualificationInspectionReadsExactCanonicalPreviousIdentityOnly(t *testing.T) {
	workerID := "00000000-0000-4000-8000-000000000205"
	profileID := "00000000-0000-4000-8000-000000000215"
	imageID := "sha256:" + strings.Repeat("1", 64)
	image := "registry.local/embedding@sha256:" + strings.Repeat("a", 64)
	configDigest := "sha256:" + strings.Repeat("c", 64)
	startDigest := "sha256:" + strings.Repeat("d", 64)
	containerName := "teamaibox-worker-" + workerID
	labels := map[string]string{
		"com.teamaibox.managed": "true", "com.teamaibox.kind": "compute-worker",
		"com.teamaibox.worker-id": workerID, "com.teamaibox.model-profile-id": profileID,
		"com.teamaibox.image-digest": image, "com.teamaibox.placement-class": agent.PlacementProtectedResident,
		"com.teamaibox.maintenance-generation": "4", "com.teamaibox.config-digest": configDigest,
	}
	target := agent.ExclusiveDrainTarget{
		TargetKey: "office.embedding", WorkerID: workerID, ModelProfileID: profileID,
		ContainerName: containerName, PlacementClass: agent.PlacementProtectedResident,
		MaintenanceGeneration: 4, StageOrder: 1, RequiredImageID: imageID,
		RequiredImageDigest: image, RequiredConfigDigest: configDigest,
		RequiredStartSpecDigest: startDigest, RequiredLabels: labels,
	}
	requests := []string{}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.Method+" "+request.URL.RequestURI())
		if request.Method != http.MethodGet {
			t.Fatalf("read-only qualification inspection mutated Docker: %s", request.Method)
		}
		if strings.Contains(request.URL.Path, "teamaibox-protected-prior-") {
			return response(http.StatusNotFound, `{"message":"not found"}`), nil
		}
		document := map[string]any{
			"Id": strings.Repeat("2", 64), "Name": "/" + containerName, "Image": imageID,
			"State": map[string]any{"Status": "running", "StartedAt": "2026-09-04T00:00:00Z",
				"OOMKilled": false, "Health": map[string]any{"Status": "healthy"}},
			"Config":     map[string]any{"Image": image, "Labels": labels},
			"HostConfig": map[string]any{"NetworkMode": "compute-internal"},
		}
		body, _ := json.Marshal(document)
		return response(http.StatusOK, string(body)), nil
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	snapshots, err := runtime.InspectProtectedSetTransitionRuntime(context.Background(),
		agent.ProtectedSetTransitionPayload{Targets: []agent.ProtectedSetTransitionTarget{{
			DesiredTarget: target, PreviousTarget: &target,
		}}}, []string{"teamaibox-protected-prior-transaction-worker"}, false)
	if err != nil || len(snapshots) != 1 || snapshots[0].RuntimeState != "canonical-exact" ||
		snapshots[0].CanonicalPrevious == nil || snapshots[0].CanonicalPrevious.ContainerID != strings.Repeat("2", 64) ||
		snapshots[0].CanonicalPrevious.StartSpecDigest != startDigest {
		t.Fatalf("canonical qualification inspection drifted: %#v %v", snapshots, err)
	}
	if len(requests) != 4 {
		t.Fatalf("qualification inspection used an unexpected Docker surface: %v", requests)
	}
}

func TestProtectedSetQualificationInspectionRejectsIdentityDriftOnEvidenceRead(t *testing.T) {
	workerID := "00000000-0000-4000-8000-000000000205"
	profileID := "00000000-0000-4000-8000-000000000215"
	imageID := "sha256:" + strings.Repeat("1", 64)
	image := "registry.local/embedding@sha256:" + strings.Repeat("a", 64)
	configDigest := "sha256:" + strings.Repeat("c", 64)
	containerName := "teamaibox-worker-" + workerID
	labels := map[string]string{
		"com.teamaibox.managed": "true", "com.teamaibox.kind": "compute-worker",
		"com.teamaibox.worker-id": workerID, "com.teamaibox.model-profile-id": profileID,
		"com.teamaibox.image-digest": image, "com.teamaibox.placement-class": agent.PlacementProtectedResident,
		"com.teamaibox.maintenance-generation": "4", "com.teamaibox.config-digest": configDigest,
	}
	target := agent.ExclusiveDrainTarget{
		TargetKey: "office.embedding", WorkerID: workerID, ModelProfileID: profileID,
		ContainerName: containerName, PlacementClass: agent.PlacementProtectedResident,
		MaintenanceGeneration: 4, StageOrder: 1, RequiredImageID: imageID,
		RequiredImageDigest: image, RequiredConfigDigest: configDigest, RequiredLabels: labels,
	}
	canonicalReads := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet {
			t.Fatalf("read-only qualification inspection mutated Docker: %s", request.Method)
		}
		if strings.Contains(request.URL.Path, "teamaibox-protected-prior-") {
			return response(http.StatusNotFound, `{"message":"not found"}`), nil
		}
		canonicalReads++
		currentLabels := labels
		if canonicalReads == 3 {
			currentLabels = maps.Clone(labels)
			currentLabels["com.teamaibox.worker-id"] = "00000000-0000-4000-8000-000000000299"
		}
		document := map[string]any{
			"Id": strings.Repeat("2", 64), "Name": "/" + containerName, "Image": imageID,
			"State": map[string]any{"Status": "running", "StartedAt": "2026-09-04T00:00:00Z",
				"OOMKilled": false, "Health": map[string]any{"Status": "healthy"}},
			"Config": map[string]any{"Image": image, "Labels": currentLabels},
		}
		body, _ := json.Marshal(document)
		return response(http.StatusOK, string(body)), nil
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	_, err := runtime.InspectProtectedSetTransitionRuntime(context.Background(),
		agent.ProtectedSetTransitionPayload{Targets: []agent.ProtectedSetTransitionTarget{{
			DesiredTarget: target, PreviousTarget: &target,
		}}}, []string{"teamaibox-protected-prior-transaction-worker"}, false)
	if err == nil || err.Error() != "protected_set_transition_inspection_runtime_drift" || canonicalReads != 3 {
		t.Fatalf("qualification evidence read accepted identity drift: err=%v reads=%d", err, canonicalReads)
	}
}

func TestEngineRuntimeRemovesOnlyWorkersFromAnOlderFencedNodeGeneration(t *testing.T) {
	oldWorker := "00000000-0000-4000-8000-000000000201"
	currentWorker := "00000000-0000-4000-8000-000000000202"
	requests := []string{}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.Method+" "+request.URL.RequestURI())
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/containers/json"):
			body, _ := json.Marshal([]map[string]any{
				{"Id": "container-current", "Names": []string{"/teamaibox-worker-" + currentWorker}, "Image": "current-image", "State": "running", "Labels": map[string]string{
					"com.teamaibox.managed": "true", "com.teamaibox.kind": "compute-worker", "com.teamaibox.node-id": testNodeID,
					"com.teamaibox.node-generation": "8", "com.teamaibox.worker-id": currentWorker,
				}},
				{"Id": "container-old", "Names": []string{"/teamaibox-worker-" + oldWorker}, "Image": "old-image", "State": "running", "Labels": map[string]string{
					"com.teamaibox.managed": "true", "com.teamaibox.kind": "compute-worker", "com.teamaibox.node-id": testNodeID,
					"com.teamaibox.node-generation": "7", "com.teamaibox.worker-id": oldWorker,
				}},
			})
			return response(http.StatusOK, string(body)), nil
		case request.Method == http.MethodDelete && strings.HasSuffix(request.URL.Path, "/containers/container-old"):
			return response(http.StatusNoContent, ""), nil
		default:
			t.Fatalf("unexpected engine request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	removed, err := runtime.RemoveStaleNodeWorkers(context.Background(), testNodeID, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 1 || removed[0].WorkerID != oldWorker || removed[0].ContainerID != "container-old" ||
		len(requests) != 2 || !strings.Contains(requests[0], "com.teamaibox.node-id") ||
		!strings.Contains(requests[1], "force=1") {
		t.Fatalf("stale generation cleanup drifted: %#v %#v", removed, requests)
	}
}

func TestEngineRuntimeRejectsAFutureWorkerGenerationBeforeCleanup(t *testing.T) {
	workerID := "00000000-0000-4000-8000-000000000203"
	requestCount := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requestCount++
		body, _ := json.Marshal([]map[string]any{{
			"Id": "container-future", "Names": []string{"/teamaibox-worker-" + workerID}, "Image": "future-image", "State": "running",
			"Labels": map[string]string{"com.teamaibox.managed": "true", "com.teamaibox.kind": "compute-worker",
				"com.teamaibox.node-id": testNodeID, "com.teamaibox.node-generation": "9", "com.teamaibox.worker-id": workerID},
		}})
		return response(http.StatusOK, string(body)), nil
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	if _, err := runtime.RemoveStaleNodeWorkers(context.Background(), testNodeID, 8); err == nil || requestCount != 1 {
		t.Fatalf("future generation was not rejected before cleanup: %v requests=%d", err, requestCount)
	}
}

func TestEngineRuntimeRejectsProtectedResidentStaleCleanupBeforeMutation(t *testing.T) {
	workerID := "00000000-0000-4000-8000-000000000204"
	requests := []string{}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.Method+" "+request.URL.RequestURI())
		if request.Method != http.MethodGet || !strings.HasSuffix(request.URL.Path, "/containers/json") {
			t.Fatalf("protected stale cleanup reached mutation: %s %s", request.Method, request.URL.String())
		}
		body, _ := json.Marshal([]map[string]any{{
			"Id": "container-protected", "Names": []string{"/teamaibox-worker-" + workerID}, "Image": "resident-image", "State": "running",
			"Labels": map[string]string{
				"com.teamaibox.managed": "true", "com.teamaibox.kind": "compute-worker", "com.teamaibox.node-id": testNodeID,
				"com.teamaibox.node-generation": "7", "com.teamaibox.worker-id": workerID,
				"com.teamaibox.placement-class":        agent.PlacementProtectedResident,
				"com.teamaibox.maintenance-generation": "3", "com.teamaibox.config-digest": "sha256:" + strings.Repeat("c", 64),
			},
		}})
		return response(http.StatusOK, string(body)), nil
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	if _, err := runtime.RemoveStaleNodeWorkers(context.Background(), testNodeID, 8); err == nil || err.Error() != "protected_resident_generation_recovery_required" {
		t.Fatalf("protected stale generation was not fenced: %v", err)
	}
	if len(requests) != 1 {
		t.Fatalf("protected stale denial made unexpected requests: %v", requests)
	}
	requests = nil
	if removed, err := runtime.RemoveStaleEphemeralNodeWorkers(context.Background(), testNodeID, 8); err != nil || len(removed) != 0 || len(requests) != 1 {
		t.Fatalf("reconnecting Agent should preserve resident without taking its lease: %v %v %v", removed, err, requests)
	}
}

func TestEngineApplicationProxyAcceptsOnlyTheFencedInternalApplicationContainer(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	spec.WorkloadKind = "application-plugin"
	spec.PluginID = "example.team-notes"
	spec.AttemptID = ""
	spec.ModelProfileID = ""
	spec.Network = "plugin-ingress"
	spec.ApplicationPort = 8080
	labels := engineLabels(ownership, spec)
	dockerClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		document := map[string]any{
			"Id": "container-app", "State": map[string]any{"Status": "running", "StartedAt": "2026-08-11T00:00:00Z", "Health": map[string]any{"Status": "healthy"}},
			"Config": map[string]any{"Image": spec.Image, "Labels": labels}, "HostConfig": map[string]any{"NetworkMode": "plugin-ingress"},
		}
		body, _ := json.Marshal(document)
		return response(http.StatusOK, string(body)), nil
	})}
	applicationClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host != "teamaibox-worker-"+spec.WorkerID+":8080" || request.URL.RequestURI() != "/plugins/example.team-notes?theme=dark" ||
			request.Header.Get("Cookie") != "" || request.Header.Get("Authorization") != "" {
			t.Fatalf("application request escaped its credential-free target: %#v", request)
		}
		result := response(http.StatusOK, "<h1>ready</h1>")
		result.Header.Set("Content-Type", "text/html; charset=utf-8")
		result.Header.Set("Set-Cookie", "must-not-cross-boundary=true")
		return result, nil
	})}
	runtime := &EngineRuntime{client: dockerClient, applicationClient: applicationClient, baseURL: "http://docker/" + engineAPIVersion}
	content, err := runtime.FetchApplication(context.Background(), agent.ApplicationFetchPayload{
		WorkerID: spec.WorkerID, Method: "GET", Path: "/plugins/example.team-notes?theme=dark",
	}, ownership)
	if err != nil || content.Status != 200 || string(content.Body) != "<h1>ready</h1>" || content.Headers["content-type"] == "" {
		t.Fatalf("application proxy failed: %#v %v", content, err)
	}
	if _, leaked := content.Headers["set-cookie"]; leaked {
		t.Fatal("application Set-Cookie crossed the Node Agent boundary")
	}
	labels["com.teamaibox.fencing-token"] = "8"
	if _, err := runtime.FetchApplication(context.Background(), agent.ApplicationFetchPayload{
		WorkerID: spec.WorkerID, Method: "GET", Path: "/plugins/example.team-notes",
	}, ownership); err == nil {
		t.Fatal("stale application ownership was accepted")
	}
}

func TestEngineWorkerControlProxyAcceptsOnlyTheFencedInternalComputeContainer(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	spec.Network = workerControlNetwork
	labels := engineLabels(ownership, spec)
	dockerClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		document := map[string]any{
			"Id": "container-compute", "State": map[string]any{"Status": "running", "StartedAt": "2026-08-11T00:00:00Z", "Health": map[string]any{"Status": "starting"}},
			"Config": map[string]any{"Image": spec.Image, "Labels": labels}, "HostConfig": map[string]any{"NetworkMode": workerControlNetwork},
			"NetworkSettings": map[string]any{"Networks": map[string]any{workerControlNetwork: map[string]any{"IPAddress": "172.30.0.8"}}},
		}
		body, _ := json.Marshal(document)
		return response(http.StatusOK, string(body)), nil
	})}
	controlClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != "http://172.30.0.8:8080/v1/worker/control" || request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
			t.Fatalf("worker control request escaped its credential-free internal target: %#v", request)
		}
		body, _ := io.ReadAll(request.Body)
		if string(body) != `{"protocolVersion":1,"type":"worker.prepare.request"}` {
			t.Fatalf("worker control request changed: %s", body)
		}
		return response(http.StatusOK, `{"protocolVersion":1,"status":"ok"}`), nil
	})}
	runtime := &EngineRuntime{client: dockerClient, applicationClient: controlClient, baseURL: "http://docker/" + engineAPIVersion}
	value, err := runtime.ForwardWorkerControl(context.Background(), agent.WorkerControlPayload{
		WorkerID: spec.WorkerID, Request: json.RawMessage(`{"protocolVersion":1,"type":"worker.prepare.request"}`),
	}, ownership)
	if err != nil || string(value) != `{"protocolVersion":1,"status":"ok"}` {
		t.Fatalf("worker control proxy failed: %s %v", value, err)
	}
	if _, err := runtime.ForwardWorkerControl(context.Background(), agent.WorkerControlPayload{
		WorkerID: spec.WorkerID, Request: json.RawMessage(`{"protocolVersion":1,"type":"worker.execute.request"}`),
	}, ownership); err == nil || err.Error() != "worker control target is unhealthy" {
		t.Fatalf("non-prepare control reached a starting worker: %v", err)
	}
	labels["com.teamaibox.fencing-token"] = "8"
	if _, err := runtime.ForwardWorkerControl(context.Background(), agent.WorkerControlPayload{
		WorkerID: spec.WorkerID, Request: json.RawMessage(`{"protocolVersion":1,"type":"worker.prepare.request"}`),
	}, ownership); err == nil {
		t.Fatal("stale worker control ownership was accepted")
	}
}

func TestEngineOrdinaryStopAndUnloadRejectProtectedResidentBeforeMutation(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	spec.Network = workerControlNetwork
	spec.PlacementClass = agent.PlacementProtectedResident
	spec.MaintenanceGeneration = 4
	spec.ConfigDigest = "sha256:" + strings.Repeat("c", 64)
	labels := engineLabels(ownership, spec)
	dockerRequests := 0
	dockerClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		dockerRequests++
		if request.Method != http.MethodGet || !strings.HasSuffix(request.URL.Path, "/json") {
			t.Fatalf("protected ordinary operation reached Docker mutation: %s %s", request.Method, request.URL.String())
		}
		document := map[string]any{
			"Id": "container-protected", "State": map[string]any{"Status": "running", "StartedAt": "2026-08-11T00:00:00Z", "Health": map[string]any{"Status": "healthy"}},
			"Config": map[string]any{"Image": spec.Image, "Labels": labels}, "HostConfig": map[string]any{"NetworkMode": workerControlNetwork},
			"NetworkSettings": map[string]any{"Networks": map[string]any{workerControlNetwork: map[string]any{"IPAddress": "172.30.0.8"}}},
		}
		body, _ := json.Marshal(document)
		return response(http.StatusOK, string(body)), nil
	})}
	controlRequests := 0
	controlClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		controlRequests++
		return response(http.StatusOK, `{}`), nil
	})}
	runtime := &EngineRuntime{client: dockerClient, applicationClient: controlClient, baseURL: "http://docker/" + engineAPIVersion}
	if _, err := runtime.StopWorker(context.Background(), spec.WorkerID, 5, ownership); err == nil || err.Error() != "protected_resident_operation_denied" {
		t.Fatalf("protected resident stop was accepted: %v", err)
	}
	for _, requestType := range []string{"worker.unload.request", "worker.replace.request"} {
		request, _ := json.Marshal(map[string]any{"protocolVersion": 1, "type": requestType})
		if _, err := runtime.ForwardWorkerControl(context.Background(), agent.WorkerControlPayload{WorkerID: spec.WorkerID, Request: request}, ownership); err == nil || err.Error() != "protected_resident_operation_denied" {
			t.Fatalf("protected resident control %q was accepted: %v", requestType, err)
		}
	}
	if dockerRequests != 3 || controlRequests != 0 {
		t.Fatalf("protected denial crossed a mutation/control boundary: docker=%d control=%d", dockerRequests, controlRequests)
	}
}

func TestEngineWorkerControlPrepareWaitsForTheStartingServer(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	spec.Network = workerControlNetwork
	labels := engineLabels(ownership, spec)
	inspections := 0
	dockerClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		inspections++
		document := map[string]any{
			"Id": "container-compute", "State": map[string]any{"Status": "running", "StartedAt": "2026-08-11T00:00:00Z", "Health": map[string]any{"Status": "starting"}},
			"Config": map[string]any{"Image": spec.Image, "Labels": labels}, "HostConfig": map[string]any{"NetworkMode": workerControlNetwork},
			"NetworkSettings": map[string]any{"Networks": map[string]any{workerControlNetwork: map[string]any{"IPAddress": "172.30.0.8"}}},
		}
		body, _ := json.Marshal(document)
		return response(http.StatusOK, string(body)), nil
	})}
	requests := 0
	controlClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if requests == 1 {
			return nil, errors.New("worker server is still starting")
		}
		return response(http.StatusOK, `{"protocolVersion":1,"status":"ready"}`), nil
	})}
	runtime := &EngineRuntime{client: dockerClient, applicationClient: controlClient, baseURL: "http://docker/" + engineAPIVersion}
	value, err := runtime.ForwardWorkerControl(context.Background(), agent.WorkerControlPayload{
		WorkerID: spec.WorkerID, Request: json.RawMessage(`{"protocolVersion":1,"type":"worker.prepare.request"}`),
	}, ownership)
	if err != nil || string(value) != `{"protocolVersion":1,"status":"ready"}` || requests != 2 || inspections != 2 {
		t.Fatalf("starting worker prepare was not retried through the fenced boundary: %s %v requests=%d inspections=%d", value, err, requests, inspections)
	}
}

func TestEngineStartReplayAfterAgentRestartReturnsTheExactExistingContainer(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	requests := []string{}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.Method+" "+request.URL.String())
		switch {
		case strings.Contains(request.URL.Path, "/images/"):
			body, _ := json.Marshal(map[string]any{"RepoDigests": []string{spec.Image}})
			return response(http.StatusOK, string(body)), nil
		case strings.HasSuffix(request.URL.Path, "/containers/create"):
			return response(http.StatusConflict, `{}`), nil
		case strings.Contains(request.URL.Path, "/containers/teamaibox-worker-") && strings.HasSuffix(request.URL.Path, "/json"):
			document := map[string]any{
				"Id": "container-a", "State": map[string]any{"Status": "running", "StartedAt": "2026-08-11T00:00:00Z"},
				"Config": map[string]any{"Image": spec.Image, "Labels": engineLabels(ownership, spec)},
			}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		default:
			t.Fatalf("unexpected engine request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	state, err := runtime.StartWorker(context.Background(), spec, ownership)
	if err != nil {
		t.Fatal(err)
	}
	if state.ContainerID != "container-a" || state.Status != "running" || len(requests) != 3 {
		t.Fatalf("unexpected engine replay: %#v %#v", state, requests)
	}
}

func TestEngineStartReplayRejectsAChangedImmutableSpecification(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	labels := engineLabels(ownership, spec)
	labels["com.teamaibox.start-spec-digest"] = strings.Repeat("e", 64)
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(request.URL.Path, "/images/"):
			body, _ := json.Marshal(map[string]any{"RepoDigests": []string{spec.Image}})
			return response(http.StatusOK, string(body)), nil
		case strings.HasSuffix(request.URL.Path, "/containers/create"):
			return response(http.StatusConflict, `{}`), nil
		case strings.Contains(request.URL.Path, "/containers/teamaibox-worker-") && strings.HasSuffix(request.URL.Path, "/json"):
			document := map[string]any{
				"Id": "container-a", "State": map[string]any{"Status": "running", "StartedAt": "2026-08-11T00:00:00Z"},
				"Config": map[string]any{"Image": spec.Image, "Labels": labels},
			}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		default:
			t.Fatalf("unexpected engine request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	if _, err := runtime.StartWorker(context.Background(), spec, ownership); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected replay mismatch, got %v", err)
	}
}

func TestEngineReadinessDoesNotNeedAWorkerOrImage(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(request.URL.Path, "/version") {
			t.Fatalf("unexpected readiness request: %s", request.URL.Path)
		}
		return response(http.StatusOK, `{"Version":"28.3.3"}`), nil
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	if err := runtime.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestEngineMaintenancePreflightObservesClosedFactsWithoutMutation(t *testing.T) {
	requests := []string{}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.Method+" "+request.URL.Path)
		if request.Method != http.MethodGet {
			t.Fatalf("maintenance preflight attempted mutation: %s", request.Method)
		}
		switch {
		case strings.HasSuffix(request.URL.Path, "/version"):
			return response(http.StatusOK, `{"Version":"28.3.3","ApiVersion":"1.51","Arch":"arm64","Os":"linux","KernelVersion":"6.14.0"}`), nil
		case strings.HasSuffix(request.URL.Path, "/info"):
			return response(http.StatusOK, `{"Architecture":"aarch64","OperatingSystem":"Ubuntu 24.04","KernelVersion":"6.14.0","Runtimes":{"io.containerd.runc.v2":{}},"CDISpecDirs":["/etc/cdi","/var/run/cdi"]}`), nil
		case strings.HasSuffix(request.URL.Path, "/containers/json"):
			if !strings.Contains(request.URL.Query().Get("filters"), "com.teamaibox.managed=true") {
				t.Fatalf("maintenance inventory was not label bounded: %s", request.URL.RawQuery)
			}
			return response(http.StatusOK, `[{"State":"running","Labels":{"com.teamaibox.managed":"true"}},{"State":"exited","Labels":{"com.teamaibox.managed":"true"}},{"State":"running","Labels":{"com.teamaibox.managed":"false"}}]`), nil
		default:
			t.Fatalf("unexpected maintenance request: %s", request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	planID := "00000000-0000-4000-8000-000000000710"
	evidence, err := runtime.InspectMaintenancePreflight(context.Background(), agent.MaintenancePreflightPayload{
		PlanID: planID, Kind: "host", CandidateDigest: "sha256:" + strings.Repeat("b", 64), ExpectedArchitecture: "arm64",
		MinimumDockerAPIVersion: "1.48", RequireNvidiaContainerIntegration: true, AllowedSecureBootStates: []string{"enabled", "disabled", "unknown"},
	}, agent.Ownership{NodeID: "00000000-0000-4000-8000-000000000101", NodeGeneration: 7})
	if err != nil || !evidence.Passed || evidence.ActiveManagedWorkloads != 1 || !evidence.NvidiaContainerIntegrationAvailable || evidence.NvidiaContainerIntegrationMode != "cdi" ||
		evidence.Architecture != "arm64" || !strings.HasPrefix(evidence.EvidenceDigest, "sha256:") || len(requests) != 3 {
		t.Fatalf("unexpected maintenance preflight evidence: %#v %v requests=%#v", evidence, err, requests)
	}
	if len(evidence.Warnings) < 1 || evidence.Warnings[0] != "managed_workloads_require_drain" {
		t.Fatalf("active managed workload drain warning is missing: %#v", evidence)
	}
}

func TestEngineMaintenancePreflightFailsClosedOnRuntimeMismatch(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch {
		case strings.HasSuffix(request.URL.Path, "/version"):
			return response(http.StatusOK, `{"Version":"24.0.0","ApiVersion":"1.43","Arch":"amd64","Os":"linux"}`), nil
		case strings.HasSuffix(request.URL.Path, "/info"):
			return response(http.StatusOK, `{"Architecture":"amd64","OperatingSystem":"Linux","KernelVersion":"6.8.0","Runtimes":{"runc":{}}}`), nil
		default:
			return response(http.StatusOK, `[]`), nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	evidence, err := runtime.InspectMaintenancePreflight(context.Background(), agent.MaintenancePreflightPayload{
		PlanID: "00000000-0000-4000-8000-000000000710", Kind: "host", CandidateDigest: "sha256:" + strings.Repeat("b", 64),
		ExpectedArchitecture: "arm64", MinimumDockerAPIVersion: "1.48", RequireNvidiaContainerIntegration: true, AllowedSecureBootStates: []string{"enabled"},
	}, agent.Ownership{NodeID: "00000000-0000-4000-8000-000000000101", NodeGeneration: 7})
	if err != nil || evidence.Passed || !contains(evidence.Blockers, "architecture_incompatible") ||
		!contains(evidence.Blockers, "docker_api_incompatible") || !contains(evidence.Blockers, "nvidia_container_integration_unavailable") ||
		!contains(evidence.Blockers, "secure_boot_state_incompatible") {
		t.Fatalf("runtime mismatch did not fail closed: %#v %v", evidence, err)
	}
}

func TestEngineStopTimeoutIncludesTheRequestedGracePeriod(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	client := &http.Client{Timeout: 30 * time.Millisecond, Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/json"):
			document := map[string]any{
				"Id": "container-a", "State": map[string]any{"Status": "running", "StartedAt": "2026-08-11T00:00:00Z"},
				"Config": map[string]any{"Image": spec.Image, "Labels": engineLabels(ownership, spec)},
			}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/stop"):
			time.Sleep(75 * time.Millisecond)
			return response(http.StatusNoContent, ""), nil
		case request.Method == http.MethodDelete:
			return response(http.StatusNoContent, ""), nil
		default:
			t.Fatalf("unexpected engine request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	state, err := runtime.StopWorker(context.Background(), spec.WorkerID, 1, ownership)
	if err != nil || state.Status != "removed" {
		t.Fatalf("grace-aware stop failed: %#v %v", state, err)
	}
	if client.Timeout != 30*time.Millisecond {
		t.Fatalf("shared Docker client timeout was mutated: %s", client.Timeout)
	}
}

func TestEngineStopIsIdempotentOnlyForAnExactDockerNotFoundResponse(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		return response(http.StatusNotFound, `{}`), nil
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	state, err := runtime.StopWorker(context.Background(), spec.WorkerID, 0, ownership)
	if err != nil || state.WorkerID != spec.WorkerID || state.Status != "removed" || state.Health != "stopped" || requests != 1 {
		t.Fatalf("not-found stop was not idempotent: state=%#v requests=%d error=%v", state, requests, err)
	}

	unavailable := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("socket unavailable")
	})}
	runtime = &EngineRuntime{client: unavailable, baseURL: "http://docker/" + engineAPIVersion}
	if _, err := runtime.StopWorker(context.Background(), spec.WorkerID, 0, ownership); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("Docker transport failure was mistaken for absence: %v", err)
	}
}

func TestEngineAgentSandboxVerifiesOwnerVolumeAndCreatesSecretTmpfs(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	spec.WorkloadKind = "agent-sandbox"
	spec.AttemptID, spec.ModelProfileID = "", ""
	spec.OwnerIdentityID = "00000000-0000-4000-8000-000000000701"
	spec.SandboxKey = "sandbox." + strings.Repeat("d", 32)
	spec.Security = agent.SecurityProfile{RunAsUID: 65532, RunAsGID: 65532, ReadOnlyRoot: true, DropAllCaps: true, NoNewPrivileges: true, SeccompProfile: "builtin"}
	spec.Limits.WorkspaceBytes = 100 << 30
	spec.Mounts = []agent.VolumeMount{{Type: "volume", Source: "teamaibox-agent-" + strings.Repeat("d", 32) + "-workspace", Target: "/workspace"}}
	spec.Devices = nil
	var create createRequest
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(request.URL.Path, "/images/"):
			body, _ := json.Marshal(map[string]any{"RepoDigests": []string{spec.Image}})
			return response(http.StatusOK, string(body)), nil
		case strings.Contains(request.URL.Path, "/volumes/"):
			body, _ := json.Marshal(map[string]any{"Name": spec.Mounts[0].Source, "Labels": map[string]string{
				"com.teamaibox.volume.class": "agent-workspace", "com.teamaibox.owner-identity-id": spec.OwnerIdentityID,
				"com.teamaibox.sandbox-key": spec.SandboxKey, "com.teamaibox.quota-bytes": "107374182400",
			}})
			return response(http.StatusOK, string(body)), nil
		case strings.HasSuffix(request.URL.Path, "/containers/create"):
			if err := json.NewDecoder(request.Body).Decode(&create); err != nil {
				t.Fatal(err)
			}
			return response(http.StatusCreated, `{"Id":"container-agent"}`), nil
		case strings.HasSuffix(request.URL.Path, "/containers/container-agent/start"):
			return response(http.StatusNoContent, ""), nil
		case strings.Contains(request.URL.Path, "/containers/teamaibox-worker-") && strings.HasSuffix(request.URL.Path, "/json"):
			document := map[string]any{
				"Id": "container-agent", "State": map[string]any{"Status": "running", "StartedAt": "2026-08-11T00:00:00Z"},
				"Config": map[string]any{"Image": spec.Image, "Labels": engineLabels(ownership, spec)},
			}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		default:
			t.Fatalf("unexpected engine request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	if _, err := runtime.StartWorker(context.Background(), spec, ownership); err != nil {
		t.Fatal(err)
	}
	if create.Labels["com.teamaibox.owner-identity-id"] != spec.OwnerIdentityID ||
		create.Labels["com.teamaibox.sandbox-key"] != spec.SandboxKey || create.HostConfig.Tmpfs["/run/secrets"] == "" ||
		create.HostConfig.Tmpfs["/run/teamaibox"] == "" {
		t.Fatalf("Agent ownership or ephemeral secret mount is missing: %#v", create)
	}
	if !strings.Contains(create.HostConfig.Tmpfs["/run/secrets"], "uid=0") || !strings.Contains(create.HostConfig.Tmpfs["/run/secrets"], "mode=0755") ||
		!strings.Contains(create.HostConfig.Tmpfs["/run/teamaibox"], "uid=0") || !strings.Contains(create.HostConfig.Tmpfs["/run/teamaibox"], "mode=0755") {
		t.Fatalf("Agent runtime roots must not be replaceable by the sandbox user: %#v", create.HostConfig.Tmpfs)
	}
	if !contains(create.HostConfig.SecurityOpt, "seccomp=builtin") {
		t.Fatalf("Agent builtin seccomp is missing: %#v", create.HostConfig.SecurityOpt)
	}
}

func TestSourceClientArchiveContainsOnlyInternalGatewayConfiguration(t *testing.T) {
	contents := []byte(`{"schemaVersion":1,"pipConf":"[global]\nindex-url = http://source-gateway:8080/pip/simple/\ntrusted-host = source-gateway\ndisable-pip-version-check = true\nno-input = true\n","npmrc":"registry=http://source-gateway:8080/npm/registry/\nalways-auth=false\naudit=false\nupdate-notifier=false\nfund=false\n","aptConf":"Dir::Etc::sourcelist \"/run/teamaibox/source-config/apt/sources.list\";\nDir::Etc::sourceparts \"-\";\nAPT::Architecture \"arm64\";\nAcquire::AllowInsecureRepositories \"false\";\nAcquire::AllowDowngradeToInsecureRepositories \"false\";\n","aptSources":"deb [arch=arm64 signed-by=/usr/share/keyrings/teamaibox-source-gateway.gpg] http://source-gateway:8080/apt teamaibox main\n"}`)
	parent, archive, err := sandboxArchive(agent.SandboxFileProjection{FileClass: "source-client-config", Contents: contents})
	if err != nil {
		t.Fatal(err)
	}
	if parent != "/run/teamaibox" {
		t.Fatalf("source configuration escaped ephemeral runtime state: %s", parent)
	}
	reader := tar.NewReader(bytes.NewReader(archive))
	files := map[string]string{}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		body, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		files[header.Name] = string(body)
		if header.Mode != 0o444 || header.Uid != 0 || header.Gid != 0 {
			t.Fatalf("source file permissions are unsafe: %#v", header)
		}
	}
	expected := []string{"source-config/apt/apt.conf", "source-config/apt/sources.list", "source-config/npmrc", "source-config/pip.conf"}
	actual := make([]string, 0, len(files))
	for name := range files {
		actual = append(actual, name)
	}
	sortStrings(actual)
	combined := files["source-config/apt/apt.conf"] + files["source-config/apt/sources.list"] + files["source-config/npmrc"] + files["source-config/pip.conf"]
	if strings.Join(actual, "\n") != strings.Join(expected, "\n") || strings.Contains(combined, "pypi.org") ||
		!strings.Contains(files["source-config/apt/sources.list"], "arch=arm64") {
		t.Fatalf("unexpected source configuration archive: %#v", files)
	}
}

func TestOpenCodeConfigArchiveIsEphemeralRootOwnedAndReadOnly(t *testing.T) {
	parent, archive, err := sandboxArchive(agent.SandboxFileProjection{FileClass: "opencode-config", Contents: validOpenCodeConfigForArchive()})
	if err != nil {
		t.Fatal(err)
	}
	if parent != "/run/teamaibox" {
		t.Fatalf("OpenCode config escaped ephemeral runtime state: %s", parent)
	}
	reader := tar.NewReader(bytes.NewReader(archive))
	seenConfig := false
	seenSentinel := false
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if header.Typeflag == tar.TypeDir && (header.Mode != 0o555 || header.Uid != 0 || header.Gid != 0) {
			t.Fatalf("OpenCode config directory is mutable: %#v", header)
		}
		if header.Name == "xdg-config/opencode/opencode.json" {
			seenConfig = true
			if header.Typeflag != tar.TypeReg || header.Mode != 0o444 || header.Uid != 0 || header.Gid != 0 {
				t.Fatalf("OpenCode config is mutable: %#v", header)
			}
		}
		if header.Name == "xdg-config/opencode/.gitignore" {
			seenSentinel = true
			contents, err := io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			if header.Typeflag != tar.TypeReg || header.Mode != 0o444 || header.Uid != 0 || header.Gid != 0 ||
				string(contents) != "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n" {
				t.Fatalf("OpenCode config sentinel is unsafe: %#v", header)
			}
		}
	}
	if !seenConfig || !seenSentinel {
		t.Fatal("OpenCode configuration or immutable initialization sentinel was not included in the runtime archive")
	}
}

func validOpenCodeConfigForArchive() []byte {
	return []byte(`{"enabled_providers":["teamaibox"]}`)
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func TestEngineProjectsModelTokenOnlyIntoOwnedAgentSecretTmpfs(t *testing.T) {
	_, _, spec, ownership := dockerFixture(t)
	owner := "00000000-0000-4000-8000-000000000701"
	sandboxKey := "sandbox." + strings.Repeat("d", 32)
	token := []byte("scoped-agent-token-" + strings.Repeat("x", 48))
	digest := sha256.Sum256(token)
	projection := agent.SandboxFileProjection{
		WorkerID: spec.WorkerID, OwnerIdentityID: owner, SandboxKey: sandboxKey,
		FileClass: "model-token", ContentSHA256: hex.EncodeToString(digest[:]), Contents: token,
	}
	labels := engineLabels(ownership, spec)
	labels["com.teamaibox.kind"] = "agent-sandbox"
	labels["com.teamaibox.owner-identity-id"] = owner
	labels["com.teamaibox.sandbox-key"] = sandboxKey
	inspects := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/json"):
			inspects++
			document := map[string]any{
				"Id": "container-agent", "State": map[string]any{"Status": "running", "StartedAt": "2026-08-11T00:00:00Z"},
				"Config": map[string]any{"Image": spec.Image, "Labels": labels},
			}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		case request.Method == http.MethodPut && strings.HasSuffix(request.URL.Path, "/archive"):
			if request.URL.Query().Get("path") != "/run/secrets" {
				t.Fatalf("token archive escaped secret tmpfs: %s", request.URL.String())
			}
			archive, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatal(err)
			}
			reader := tar.NewReader(bytes.NewReader(archive))
			header, err := reader.Next()
			if err != nil {
				t.Fatal(err)
			}
			projected, err := io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			if header.Name != "teamaibox-model-token" || header.Mode != 0o400 || header.Uid != 65532 || header.Gid != 65532 || !bytes.Equal(projected, token) {
				t.Fatalf("unsafe token archive entry: %#v", header)
			}
			return response(http.StatusOK, ""), nil
		default:
			t.Fatalf("unexpected engine request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	state, err := runtime.ProjectSandboxFile(context.Background(), projection, ownership)
	if err != nil {
		t.Fatal(err)
	}
	if state.Bytes != len(token) || state.ContentSHA256 != projection.ContentSHA256 || inspects != 2 {
		t.Fatalf("unexpected projection state: %#v inspects=%d", state, inspects)
	}
}

func TestExclusiveDrainAndRestoreVerifyTargetLabelsBeforeDockerMutation(t *testing.T) {
	actualImageID := "sha256:" + strings.Repeat("a", 64)
	target := agent.ExclusiveDrainTarget{TargetKey: "ocr.vlm", ContainerName: "teamaibox-ocr-vlm", RequiredImageID: actualImageID, RequiredLabels: map[string]string{"com.teamaibox.component": "ocr-worker", "com.teamaibox.model": "PaddleOCR-VL-1.5"}}
	actualLabels := map[string]string{"com.teamaibox.component": "ocr-worker", "com.teamaibox.model": "PaddleOCR-VL-1.5"}
	running := true
	mutations := []string{}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/json"):
			document := map[string]any{"Id": "ocr-container", "Image": actualImageID, "State": map[string]any{"Status": map[bool]string{true: "running", false: "exited"}[running], "StartedAt": "2026-08-11T00:00:00Z", "Health": map[string]any{"Status": "healthy"}}, "Config": map[string]any{"Image": "pinned", "Labels": actualLabels}}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/stop"):
			mutations = append(mutations, "stop")
			running = false
			return response(http.StatusNoContent, ""), nil
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/start"):
			mutations = append(mutations, "start")
			running = true
			return response(http.StatusNoContent, ""), nil
		default:
			t.Fatalf("unexpected engine request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	drained, err := runtime.DrainExclusiveConflict(context.Background(), target)
	if err != nil || drained.State != "exited" || !drained.WasRunning || !drained.LeasesReleased {
		t.Fatalf("drain failed: %#v %v", drained, err)
	}
	restored, err := runtime.RestoreExclusiveConflict(context.Background(), target)
	if err != nil || restored.State != "running" || strings.Join(mutations, ",") != "stop,start" {
		t.Fatalf("restore failed: %#v %v %#v", restored, err, mutations)
	}
	target.RequiredLabels["com.teamaibox.model"] = "substituted"
	if _, err := runtime.DrainExclusiveConflict(context.Background(), target); err == nil || !strings.Contains(err.Error(), "identity changed") {
		t.Fatalf("changed target label was accepted: %v", err)
	}
	if strings.Join(mutations, ",") != "stop,start" {
		t.Fatalf("label denial reached Docker mutation: %#v", mutations)
	}
	target.RequiredLabels["com.teamaibox.model"] = "PaddleOCR-VL-1.5"
	target.RequiredImageID = "sha256:" + strings.Repeat("b", 64)
	if _, err := runtime.DrainExclusiveConflict(context.Background(), target); err == nil || !strings.Contains(err.Error(), "identity changed") {
		t.Fatalf("changed target image was accepted: %v", err)
	}
	if strings.Join(mutations, ",") != "stop,start" {
		t.Fatalf("image denial reached Docker mutation: %#v", mutations)
	}
}

func TestExclusiveLifecycleTrustsLiveProtectedPlacementOverOrdinaryPolicy(t *testing.T) {
	imageID := "sha256:" + strings.Repeat("a", 64)
	target := agent.ExclusiveDrainTarget{
		TargetKey: "resident.misclassified", ContainerName: "resident-worker",
		RequiredImageID: imageID, RequiredLabels: map[string]string{"com.teamaibox.component": "resident"},
	}
	mutations := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/json"):
			document := map[string]any{
				"Id": "resident-id", "Image": imageID,
				"State": map[string]any{"Status": "running", "StartedAt": "2026-09-04T00:00:00Z", "Health": map[string]any{"Status": "healthy"}},
				"Config": map[string]any{"Image": "pinned", "Labels": map[string]string{
					"com.teamaibox.component": "resident", "com.teamaibox.placement-class": agent.PlacementProtectedResident,
				}},
			}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		default:
			mutations++
			return response(http.StatusNoContent, ""), nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	if _, err := runtime.ListExclusiveConflicts(context.Background(), []agent.ExclusiveDrainTarget{target}); err == nil || err.Error() != "protected_resident_operation_denied" {
		t.Fatalf("ordinary inventory accepted a live protected target: %v", err)
	}
	if _, err := runtime.DrainExclusiveConflict(context.Background(), target); err == nil || err.Error() != "protected_resident_operation_denied" {
		t.Fatalf("ordinary drain accepted a live protected target: %v", err)
	}
	if _, err := runtime.RestoreExclusiveConflict(context.Background(), target); err == nil || err.Error() != "protected_resident_operation_denied" {
		t.Fatalf("ordinary restore accepted a live protected target: %v", err)
	}
	if mutations != 0 {
		t.Fatalf("live protected placement denial reached Docker mutation: %d", mutations)
	}
}

func TestExclusiveDrainRestoresNetworkNamespaceDependentAfterWorker(t *testing.T) {
	workerImage := "sha256:" + strings.Repeat("a", 64)
	providerImage := "sha256:" + strings.Repeat("b", 64)
	target := agent.ExclusiveDrainTarget{TargetKey: "drawing.flux", ContainerName: "flux-worker",
		RequiredImageID: workerImage, RequiredLabels: map[string]string{},
		DependentContainers: []agent.ExclusiveDependentContainer{{ContainerName: "flux-provider",
			RequiredImageID: providerImage, RequiredLabels: map[string]string{}}}}
	running := map[string]bool{"flux-worker": true, "flux-provider": true}
	mutations := []string{}
	stopGrace := map[string]string{}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		parts := strings.Split(strings.Trim(request.URL.Path, "/"), "/")
		containerIndex := slices.Index(parts, "containers")
		if containerIndex < 0 || containerIndex+1 >= len(parts) {
			t.Fatalf("unexpected engine path: %s", request.URL.Path)
		}
		name := parts[containerIndex+1]
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/json"):
			image := map[string]string{"flux-worker": workerImage, "flux-provider": providerImage}[name]
			document := map[string]any{"Id": name + "-id", "Image": image,
				"State":  map[string]any{"Status": map[bool]string{true: "running", false: "exited"}[running[name]], "StartedAt": "2026-09-02T00:00:00Z"},
				"Config": map[string]any{"Image": "pinned", "Labels": map[string]string{}}}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/stop"):
			mutations = append(mutations, "stop:"+name)
			stopGrace[name] = request.URL.Query().Get("t")
			running[name] = false
			return response(http.StatusNoContent, ""), nil
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/start"):
			mutations = append(mutations, "start:"+name)
			running[name] = true
			return response(http.StatusNoContent, ""), nil
		default:
			t.Fatalf("unexpected engine request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	if _, err := runtime.DrainExclusiveConflict(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.RestoreExclusiveConflict(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	expected := "stop:flux-provider,stop:flux-worker,start:flux-worker,start:flux-provider"
	if strings.Join(mutations, ",") != expected {
		t.Fatalf("dependent lifecycle order drifted: %#v", mutations)
	}
	if stopGrace["flux-provider"] != strconv.Itoa(exclusiveDependentStopGraceSeconds) || stopGrace["flux-worker"] != "30" {
		t.Fatalf("dependent/Worker stop budgets exceed the protected command deadline: %#v", stopGrace)
	}
}

func TestProtectedMaintenanceVerifiesExactIdentityAndRestoresDependenciesInReverse(t *testing.T) {
	workerID := "00000000-0000-4000-8000-000000000211"
	profileID := "00000000-0000-4000-8000-000000000411"
	workerImageID := "sha256:" + strings.Repeat("a", 64)
	providerAImageID := "sha256:" + strings.Repeat("b", 64)
	providerBImageID := "sha256:" + strings.Repeat("c", 64)
	workerDigest := "registry.local/resident@sha256:" + strings.Repeat("d", 64)
	providerADigest := "registry.local/provider-a@sha256:" + strings.Repeat("e", 64)
	providerBDigest := "registry.local/provider-b@sha256:" + strings.Repeat("f", 64)
	workerConfig := "sha256:" + strings.Repeat("1", 64)
	providerAConfig := "sha256:" + strings.Repeat("2", 64)
	providerBConfig := "sha256:" + strings.Repeat("3", 64)
	target := agent.ExclusiveDrainTarget{
		TargetKey: "resident.office", WorkerID: workerID, ModelProfileID: profileID,
		ContainerName: "resident-worker", PlacementClass: agent.PlacementProtectedResident, MaintenanceGeneration: 1,
		RequiredImageID: workerImageID, RequiredImageDigest: workerDigest, RequiredConfigDigest: workerConfig,
		RequiredLabels: map[string]string{"com.teamaibox.resident": "office"},
		DependentContainers: []agent.ExclusiveDependentContainer{
			{ContainerName: "provider-a", RequiredImageID: providerAImageID, RequiredImageDigest: providerADigest, RequiredConfigDigest: providerAConfig, RequiredLabels: map[string]string{"com.teamaibox.companion": "a"}},
			{ContainerName: "provider-b", RequiredImageID: providerBImageID, RequiredImageDigest: providerBDigest, RequiredConfigDigest: providerBConfig, RequiredLabels: map[string]string{"com.teamaibox.companion": "b"}},
		},
	}
	running := map[string]bool{"resident-worker": true, "provider-a": true, "provider-b": true}
	mutations := []string{}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		parts := strings.Split(strings.Trim(request.URL.Path, "/"), "/")
		containerIndex := slices.Index(parts, "containers")
		if containerIndex < 0 || containerIndex+1 >= len(parts) {
			t.Fatalf("unexpected protected maintenance path: %s", request.URL.Path)
		}
		name := parts[containerIndex+1]
		imageID := map[string]string{"resident-worker": workerImageID, "provider-a": providerAImageID, "provider-b": providerBImageID}[name]
		imageDigest := map[string]string{"resident-worker": workerDigest, "provider-a": providerADigest, "provider-b": providerBDigest}[name]
		configDigest := map[string]string{"resident-worker": workerConfig, "provider-a": providerAConfig, "provider-b": providerBConfig}[name]
		labels := map[string]string{"com.teamaibox.config-digest": configDigest}
		if name == "resident-worker" {
			labels["com.teamaibox.managed"] = "true"
			labels["com.teamaibox.kind"] = "compute-worker"
			labels["com.teamaibox.worker-id"] = workerID
			labels["com.teamaibox.model-profile-id"] = profileID
			labels["com.teamaibox.image-digest"] = workerDigest
			labels["com.teamaibox.placement-class"] = agent.PlacementProtectedResident
			labels["com.teamaibox.maintenance-generation"] = "1"
			labels["com.teamaibox.resident"] = "office"
		} else {
			labels["com.teamaibox.companion"] = strings.TrimPrefix(name, "provider-")
		}
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/json"):
			document := map[string]any{"Id": name + "-id", "Image": imageID,
				"State":  map[string]any{"Status": map[bool]string{true: "running", false: "exited"}[running[name]], "StartedAt": "2026-09-04T00:00:00Z", "Health": map[string]any{"Status": "healthy"}},
				"Config": map[string]any{"Image": imageDigest, "Labels": labels}}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/stop"):
			mutations = append(mutations, "stop:"+name)
			running[name] = false
			return response(http.StatusNoContent, ""), nil
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/start"):
			mutations = append(mutations, "start:"+name)
			running[name] = true
			return response(http.StatusNoContent, ""), nil
		default:
			t.Fatalf("unexpected protected maintenance request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	if _, err := runtime.StopProtectedMaintenanceTarget(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.RestoreProtectedMaintenanceTarget(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	want := "stop:provider-a,stop:provider-b,stop:resident-worker,start:resident-worker,start:provider-b,start:provider-a"
	if got := strings.Join(mutations, ","); got != want {
		t.Fatalf("protected dependency lifecycle order drifted: got %s want %s", got, want)
	}
	target.RequiredConfigDigest = "sha256:" + strings.Repeat("9", 64)
	if _, err := runtime.StopProtectedMaintenanceTarget(context.Background(), target); err == nil || err.Error() != "protected_maintenance_identity_drift" {
		t.Fatalf("protected config substitution was accepted: %v", err)
	}
	if got := strings.Join(mutations, ","); got != want {
		t.Fatalf("identity drift reached Docker mutation: %s", got)
	}
	if _, err := runtime.DrainExclusiveConflict(context.Background(), target); err == nil || err.Error() != "protected_resident_operation_denied" {
		t.Fatalf("ordinary exclusive drain accepted protected target: %v", err)
	}
}

func TestExclusiveDrainTimeoutIncludesItsThirtySecondGracePeriod(t *testing.T) {
	target := agent.ExclusiveDrainTarget{TargetKey: "asr.large", ContainerName: "teamaibox-asr", RequiredLabels: map[string]string{"com.teamaibox.component": "asr-worker"}}
	running := true
	client := &http.Client{Timeout: 30 * time.Millisecond, Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/json"):
			document := map[string]any{"Id": "asr-container", "State": map[string]any{"Status": map[bool]string{true: "running", false: "exited"}[running], "StartedAt": "2026-08-11T00:00:00Z"}, "Config": map[string]any{"Image": "pinned", "Labels": target.RequiredLabels}}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/stop"):
			time.Sleep(75 * time.Millisecond)
			running = false
			return response(http.StatusNoContent, ""), nil
		default:
			t.Fatalf("unexpected engine request: %s %s", request.Method, request.URL.String())
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	state, err := runtime.DrainExclusiveConflict(context.Background(), target)
	if err != nil || state.State != "exited" || !state.LeasesReleased {
		t.Fatalf("grace-aware exclusive drain failed: %#v %v", state, err)
	}
}
