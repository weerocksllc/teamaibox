package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

func officeInspectionFixture() (agent.ExclusiveDrainTarget, agent.Ownership, map[string]any) {
	target := agent.ExclusiveDrainTarget{TargetKey: "office.test", WorkerID: testWorkerID,
		ModelProfileID: "00000000-0000-4000-8000-000000000401", ContainerName: "teamaibox-worker-" + testWorkerID,
		PlacementClass: agent.PlacementProtectedResident, MaintenanceGeneration: 3,
		RequiredImageID:         "sha256:" + strings.Repeat("a", 64),
		RequiredImageDigest:     "registry.local/office@sha256:" + strings.Repeat("b", 64),
		RequiredConfigDigest:    "sha256:" + strings.Repeat("c", 64),
		RequiredStartSpecDigest: "sha256:" + strings.Repeat("e", 64)}
	ownership := agent.Ownership{NodeID: "00000000-0000-4000-8000-000000000101", NodeGeneration: 7}
	labels := map[string]string{"com.teamaibox.managed": "true", "com.teamaibox.kind": "compute-worker",
		"com.teamaibox.worker-id": target.WorkerID, "com.teamaibox.model-profile-id": target.ModelProfileID,
		"com.teamaibox.image-digest": target.RequiredImageDigest, "com.teamaibox.config-digest": target.RequiredConfigDigest,
		"com.teamaibox.start-spec-digest": target.RequiredStartSpecDigest,
		"com.teamaibox.placement-class":   target.PlacementClass, "com.teamaibox.maintenance-generation": "3",
		"com.teamaibox.node-id": ownership.NodeID, "com.teamaibox.node-generation": "7"}
	document := map[string]any{"Id": strings.Repeat("d", 64), "Image": target.RequiredImageID,
		"Config": map[string]any{"Image": target.RequiredImageDigest, "Labels": labels},
		"State":  map[string]any{"Status": "running", "StartedAt": "2026-10-16T00:00:00Z", "Health": map[string]string{"Status": "healthy"}}}
	return target, ownership, document
}

func officeInspectionRuntime(t *testing.T, target agent.ExclusiveDrainTarget, document map[string]any) *EngineRuntime {
	t.Helper()
	return &EngineRuntime{baseURL: "http://docker/" + engineAPIVersion,
		client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Method != http.MethodGet || !strings.HasSuffix(request.URL.Path, "/containers/"+target.ContainerName+"/json") {
				t.Fatalf("office inspection attempted an undeclared operation: %s %s", request.Method, request.URL.Path)
			}
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		})}}
}

func TestOfficeInspectionUsesExactPolicyWithoutWorkerLeaseAuthorityOrMutation(t *testing.T) {
	target, ownership, document := officeInspectionFixture()
	runtime := officeInspectionRuntime(t, target, document)
	state, err := runtime.InspectProtectedOfficeProfile(context.Background(), target, ownership)
	if err != nil || state.WorkerID != target.WorkerID || state.ModelProfileID != target.ModelProfileID ||
		state.Status != "running" || state.Health != "healthy" || state.ContainerID != strings.Repeat("d", 64) {
		t.Fatalf("exact installed identity was not observed: %#v %v", state, err)
	}
	// The new inspection does not weaken ordinary worker.health ownership.
	if _, err := runtime.WorkerHealth(context.Background(), target.WorkerID, ownership); err == nil {
		t.Fatal("ordinary worker health accepted missing lease/fence authority")
	}
	document["State"].(map[string]any)["Status"] = "exited"
	state, err = runtime.InspectProtectedOfficeProfile(context.Background(), target, ownership)
	if err != nil || state.Status != "exited" {
		t.Fatalf("stopped identity was hidden or reported running: %#v %v", state, err)
	}
}

func TestOfficeInspectionRejectsForeignOrChangedProtectedIdentities(t *testing.T) {
	for _, label := range []string{"com.teamaibox.node-id", "com.teamaibox.node-generation", "com.teamaibox.worker-id",
		"com.teamaibox.model-profile-id", "com.teamaibox.image-digest", "com.teamaibox.config-digest",
		"com.teamaibox.start-spec-digest", "com.teamaibox.placement-class", "com.teamaibox.maintenance-generation"} {
		t.Run(label, func(t *testing.T) {
			target, ownership, document := officeInspectionFixture()
			document["Config"].(map[string]any)["Labels"].(map[string]string)[label] = "different"
			if _, err := officeInspectionRuntime(t, target, document).InspectProtectedOfficeProfile(context.Background(), target, ownership); err == nil {
				t.Fatal("changed installed identity was accepted")
			}
		})
	}
	for _, field := range []string{"Id", "Image"} {
		t.Run(field, func(t *testing.T) {
			target, ownership, document := officeInspectionFixture()
			document[field] = "different"
			if _, err := officeInspectionRuntime(t, target, document).InspectProtectedOfficeProfile(context.Background(), target, ownership); err == nil {
				t.Fatal("changed container/image identity was accepted")
			}
		})
	}
}

func TestOfficeInspectionRetainsPolicyBoundGenerationAndNormalizesStartDigest(t *testing.T) {
	target, ownership, document := officeInspectionFixture()
	labels := document["Config"].(map[string]any)["Labels"].(map[string]string)
	target.RequiredLabels = map[string]string{"com.teamaibox.node-generation": "7"}
	ownership.NodeGeneration = 12
	labels["com.teamaibox.start-spec-digest"] = strings.TrimPrefix(target.RequiredStartSpecDigest, "sha256:")
	if _, err := officeInspectionRuntime(t, target, document).InspectProtectedOfficeProfile(context.Background(), target, ownership); err != nil {
		t.Fatalf("retained exact policy-bound worker was rejected: %v", err)
	}
	for _, generation := range []string{"0", "6", "13", "invalid"} {
		labels["com.teamaibox.node-generation"] = generation
		if _, err := officeInspectionRuntime(t, target, document).InspectProtectedOfficeProfile(context.Background(), target, ownership); err == nil {
			t.Fatalf("unbound or future generation %s accepted", generation)
		}
	}
	labels["com.teamaibox.node-generation"] = "7"
	target.RequiredLabels = nil
	if _, err := officeInspectionRuntime(t, target, document).InspectProtectedOfficeProfile(context.Background(), target, ownership); err == nil {
		t.Fatal("old worker without an installed generation binding accepted")
	}
}
