package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

type offlineImageRunner struct{ document imageInspectDocument }

func (r offlineImageRunner) Run(_ context.Context, args ...string) (string, error) {
	raw, _ := json.Marshal(r.document)
	return string(raw), nil
}

func TestOfflineImageContentIdentityRequiresExactARM64LinuxBytes(t *testing.T) {
	id := "sha256:" + strings.Repeat("a", 64)
	valid := imageInspectDocument{ID: id, Architecture: "arm64", OS: "linux"}
	for _, item := range []struct {
		name  string
		doc   imageInspectDocument
		valid bool
	}{
		{"no-repodigests", valid, true},
		{"wrong-id", imageInspectDocument{ID: "sha256:" + strings.Repeat("b", 64), Architecture: "arm64", OS: "linux"}, false},
		{"wrong-arch", imageInspectDocument{ID: id, Architecture: "amd64", OS: "linux"}, false},
		{"wrong-os", imageInspectDocument{ID: id, Architecture: "arm64", OS: "windows"}, false},
	} {
		t.Run(item.name, func(t *testing.T) {
			cli, _ := NewRuntime(offlineImageRunner{item.doc})
			if (cli.verifyImage(context.Background(), id) == nil) != item.valid {
				t.Fatal("CLI identity check differs")
			}
			client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if req.Method != "GET" || !strings.Contains(req.URL.Path, "/images/") {
					t.Fatal("unexpected mutation or pull")
				}
				raw, _ := json.Marshal(item.doc)
				return response(http.StatusOK, string(raw)), nil
			})}
			engine := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
			if (engine.verifyImage(context.Background(), id) == nil) != item.valid {
				t.Fatal("Engine identity check differs")
			}
		})
	}
	if localContentImageMatches("latest", valid) || localContentImageMatches(strings.TrimPrefix(id, "sha256:"), valid) {
		t.Fatal("mutable tag or short ID accepted")
	}
}

func TestOfflineImageProtectedTransitionPreservesBothIdentityChecks(t *testing.T) {
	id := "sha256:" + strings.Repeat("a", 64)
	doc := imageInspectDocument{ID: id, Architecture: "arm64", OS: "linux"}
	if transitionManifestDigest(id) != id {
		t.Fatal("offline snapshot lost content identity")
	}
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method != "GET" {
			t.Fatal("unexpected mutation")
		}
		raw, _ := json.Marshal(doc)
		return response(http.StatusOK, string(raw)), nil
	})}
	engine := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	spec := agent.WorkerStartPayload{Image: id, HealthCheck: &agent.ContainerHealthCheck{}}
	target := agent.ExclusiveDrainTarget{RequiredImageID: id}
	if _, err := engine.exactTransitionImage(context.Background(), spec, target); err != nil {
		t.Fatal(err)
	}
	target.RequiredImageID = "sha256:" + strings.Repeat("b", 64)
	if _, err := engine.exactTransitionImage(context.Background(), spec, target); err == nil {
		t.Fatal("target image drift accepted")
	}
}
