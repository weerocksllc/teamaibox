package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestCacheBackupsDoNotBlockAgentBootOrBecomeCleanupTargets(t *testing.T) {
	worker := "00000000-0000-4000-8000-000000000204"
	labels := map[string]string{"com.teamaibox.managed": "true", "com.teamaibox.kind": "compute-worker",
		"com.teamaibox.node-id": testNodeID, "com.teamaibox.node-generation": "7", "com.teamaibox.worker-id": worker,
		"com.teamaibox.placement-class": "protected-resident", "com.teamaibox.maintenance-generation": "3",
		"com.teamaibox.config-digest": "sha256:" + strings.Repeat("c", 64), "org.teamaibox.compilation-cache": "persistent-v1"}
	canonical := "/teamaibox-worker-" + worker
	id := strings.Repeat("a", 64)
	for _, backup := range []string{canonical + "-pre-cache-" + id[:8], "/cache-reverted-" + id[:16], canonical + "-cache-candidate"} {
		t.Run(backup, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if req.Method != http.MethodGet {
					t.Fatalf("backup handling mutated Docker: %s", req.Method)
				}
				body, _ := json.Marshal([]map[string]any{
					{"Id": id, "Names": []string{backup}, "State": "exited", "Labels": labels},
					{"Id": strings.Repeat("b", 64), "Names": []string{canonical}, "State": "running", "Labels": labels},
				})
				return response(http.StatusOK, string(body)), nil
			})}
			runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
			removed, err := runtime.RemoveStaleEphemeralNodeWorkers(context.Background(), testNodeID, 8)
			if err != nil || len(removed) != 0 {
				t.Fatalf("backup blocked recovery: %v %v", removed, err)
			}
		})
	}
	for _, name := range []string{canonical + "-pre-cache-wrong", "/cache-reverted-wrong", "/other"} {
		if retainedCacheContainer(id, name, "exited", worker, labels) {
			t.Fatal("unrelated container treated as cache backup")
		}
	}
	if retainedCacheContainer(id, canonical+"-pre-cache-"+id[:8], "running", worker, labels) {
		t.Fatal("running container ignored")
	}
}
