package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"teamaibox.local/node-agent/internal/agent"
	"testing"
)

func TestEngineRuntimeRetainedGeneration(t *testing.T) {
	_, _, spec, old := dockerFixture(t)
	for _, kind := range []string{"application-plugin", "compute-worker", "compute-plugin", "agent-sandbox"} {
		for _, protected := range []bool{true, false} {
			labels := engineLabels(old, spec)
			labels["com.teamaibox.kind"] = kind
			if protected {
				labels["com.teamaibox.placement-class"] = agent.PlacementProtectedResident
			}
			var document inspectDocument
			document.Config.Labels = labels
			next := old
			next.NodeGeneration++
			next.RuntimeGeneration = old.NodeGeneration
			allowed := kind == "application-plugin" || (kind == "compute-worker" && protected)
			if runtimeGenerationMatches(document, next) != allowed {
				t.Fatalf("unexpected retained access %s protected=%v", kind, protected)
			}
			next.RuntimeGeneration = 0
			if runtimeGenerationMatches(document, next) {
				t.Fatal("implicitly accepted stale runtime")
			}
			next.RuntimeGeneration = next.NodeGeneration + 1
			if runtimeGenerationMatches(document, next) {
				t.Fatal("accepted future runtime")
			}
			next.RuntimeGeneration = -1
			if runtimeGenerationMatches(document, next) {
				t.Fatal("accepted invalid runtime")
			}
		}
	}
}

func TestEngineRuntimeRetainedGenerationHealthKeepsExactOwnership(t *testing.T) {
	_, _, spec, old := dockerFixture(t)
	labels := engineLabels(old, spec)
	labels["com.teamaibox.placement-class"] = agent.PlacementProtectedResident
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != "GET" {
			t.Fatal("reconnect mutated Docker")
		}
		body, _ := json.Marshal(map[string]any{"Id": "original-container", "Config": map[string]any{"Image": spec.Image, "Labels": labels}, "State": map[string]any{"Status": "running", "Health": map[string]any{"Status": "healthy"}}})
		return response(http.StatusOK, string(body)), nil
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	next := old
	next.NodeGeneration++
	next.RuntimeGeneration = old.NodeGeneration
	state, err := runtime.WorkerHealth(context.Background(), spec.WorkerID, next)
	if err != nil || state.ContainerID != "original-container" {
		t.Fatalf("retained health failed: %v", err)
	}
	if _, err = runtime.StopWorker(context.Background(), spec.WorkerID, 1, next); err == nil {
		t.Fatal("retained stop accepted")
	}
	for _, key := range []string{"com.teamaibox.node-id", "com.teamaibox.worker-id", "com.teamaibox.lease-id", "com.teamaibox.fencing-token", "com.teamaibox.node-generation"} {
		original := labels[key]
		labels[key] = strconv.Itoa(999)
		if _, err = runtime.WorkerHealth(context.Background(), spec.WorkerID, next); err == nil {
			t.Fatalf("accepted drift: %s", key)
		}
		labels[key] = original
	}
}

func TestEngineRuntimeRetainedGenerationApplicationRetirement(t *testing.T) {
	_, _, spec, old := dockerFixture(t)
	for _, kind := range []string{"application-plugin", "compute-worker", "compute-plugin", "agent-sandbox"} {
		t.Run(kind, func(t *testing.T) {
			labels := engineLabels(old, spec)
			labels["com.teamaibox.kind"] = kind
			mutations := 0
			runtime := &EngineRuntime{baseURL: "http://docker/" + engineAPIVersion, client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.Method != "GET" {
					mutations++
					return response(http.StatusNoContent, ""), nil
				}
				body, _ := json.Marshal(map[string]any{"Id": "original-app", "Config": map[string]any{"Image": spec.Image, "Labels": labels}, "State": map[string]any{"Status": "running"}})
				return response(http.StatusOK, string(body)), nil
			})}}
			next := old
			next.NodeGeneration++
			next.RuntimeGeneration = old.NodeGeneration
			next.ApplicationOnly = true
			state, err := runtime.StopWorker(context.Background(), spec.WorkerID, 1, next)
			if kind == "application-plugin" {
				if err != nil || state.Status != "removed" || mutations != 2 {
					t.Fatalf("app retirement failed: %v %+v mutations=%d", err, state, mutations)
				}
			} else if err == nil || mutations != 0 {
				t.Fatalf("application-only command modified %s", kind)
			}
		})
	}
}
