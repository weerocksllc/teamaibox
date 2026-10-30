package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

func applianceRestartFixture(character, name string, started time.Time) (inspectDocument, agent.ApplianceRestartTarget) {
	document := inspectDocument{ID: strings.Repeat(character, 64), Name: "/" + name,
		Image: "sha256:" + strings.Repeat(character, 64)}
	document.Config.Image = "registry.example/teamaibox/" + character + ":pinned"
	document.Config.Labels = map[string]string{"com.teamaibox.managed": "true", "com.teamaibox.feature": "protected-office"}
	document.State.Status = "running"
	document.State.StartedAt = started.Format(time.RFC3339Nano)
	document.State.Health = &struct {
		Status string `json:"Status"`
	}{Status: "healthy"}
	target := agent.ApplianceRestartTarget{ContainerName: name, ImageID: document.Image,
		ImageReference: document.Config.Image, ConfigurationDigest: legacyRuntimeDigest(document), RequireHealthy: true}
	return document, target
}

func TestEngineApplianceRestartUsesOnlyExactEngineIdentityAndWaitsForHealth(t *testing.T) {
	started := time.Date(2026, 9, 5, 2, 0, 0, 0, time.UTC)
	document, target := applianceRestartFixture("a", "teamaibox-platform", started)
	requests := []string{}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.Method+" "+request.URL.RequestURI())
		switch request.Method {
		case http.MethodGet:
			body, _ := json.Marshal(document)
			return response(http.StatusOK, string(body)), nil
		case http.MethodPost:
			if request.URL.Path != "/"+engineAPIVersion+"/containers/teamaibox-platform/restart" || request.URL.Query().Get("t") != "30" {
				t.Fatalf("restart escaped the fixed Engine endpoint: %s", request.URL.RequestURI())
			}
			document.State.StartedAt = started.Add(time.Minute).Format(time.RFC3339Nano)
			return response(http.StatusNoContent, ""), nil
		default:
			t.Fatalf("unexpected Engine method: %s", request.Method)
			return nil, nil
		}
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	identity, err := runtime.RestartAndVerifyApplianceTarget(context.Background(), target, started)
	if err != nil || !identity.StartedAt.After(started) || identity.ContainerID != document.ID || len(requests) != 3 {
		t.Fatalf("exact appliance restart failed: identity=%#v requests=%#v error=%v", identity, requests, err)
	}
	if requests[0] != "GET /v1.48/containers/teamaibox-platform/json" ||
		requests[1] != "POST /v1.48/containers/teamaibox-platform/restart?t=30" ||
		requests[2] != "GET /v1.48/containers/teamaibox-platform/json" {
		t.Fatalf("unexpected Engine restart sequence: %#v", requests)
	}
}

func TestEngineApplianceRestartRejectsIdentityDriftBeforeMutation(t *testing.T) {
	started := time.Date(2026, 9, 5, 2, 0, 0, 0, time.UTC)
	document, target := applianceRestartFixture("a", "teamaibox-platform", started)
	document.Image = "sha256:" + strings.Repeat("b", 64)
	posts := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method == http.MethodPost {
			posts++
			t.Fatal("identity drift reached a Docker mutation")
		}
		body, _ := json.Marshal(document)
		return response(http.StatusOK, string(body)), nil
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	if _, err := runtime.RestartAndVerifyApplianceTarget(context.Background(), target, started); err == nil || posts != 0 {
		t.Fatalf("identity drift was not rejected: posts=%d error=%v", posts, err)
	}
}

func TestEngineSchedulesOnlyTheAlreadyVerifiedSelfIdentity(t *testing.T) {
	started := time.Date(2026, 9, 5, 2, 0, 0, 0, time.UTC)
	document, target := applianceRestartFixture("b", "teamaibox-node-agent", started)
	posted := make(chan struct{}, 1)
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method == http.MethodPost {
			if request.URL.Path != "/"+engineAPIVersion+"/containers/teamaibox-node-agent/restart" {
				t.Fatalf("self restart target drifted: %s", request.URL.Path)
			}
			posted <- struct{}{}
			return response(http.StatusNoContent, ""), nil
		}
		body, _ := json.Marshal(document)
		return response(http.StatusOK, string(body)), nil
	})}
	runtime := &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}
	if err := runtime.ScheduleApplianceSelfRestart(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	select {
	case <-posted:
	case <-time.After(2 * time.Second):
		t.Fatal("the exact self restart was not scheduled")
	}
}

func TestApplianceConfigurationDigestBreaksOnlyThePolicyLocatorCycle(t *testing.T) {
	started := time.Date(2026, 9, 5, 2, 0, 0, 0, time.UTC)
	document, _ := applianceRestartFixture("b", "teamaibox-node-agent", started)
	document.Config.Env = []string{
		"TEAMAIBOX_APPLIANCE_RESTART_POLICY_FILE=/run/config/a.json",
		"TEAMAIBOX_APPLIANCE_RESTART_POLICY_DIGEST=sha256:" + strings.Repeat("a", 64),
		"PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST=sha256:" + strings.Repeat("b", 64),
		"TEAMAIBOX_APPLIANCE_CONFIGURATION_DIGEST=sha256:" + strings.Repeat("c", 64),
		"TEAMAIBOX_APPLIANCE_IMAGE_DIGEST=sha256:" + strings.Repeat("d", 64),
		"TEAMAIBOX_NODE_ID=fixed",
	}
	document.Config.Labels["com.teamaibox.config-digest"] = "sha256:" + strings.Repeat("e", 64)
	baseline := applianceConfigurationDigest(document)
	document.Config.Env[0] = "TEAMAIBOX_APPLIANCE_RESTART_POLICY_FILE=/run/config/b.json"
	document.Config.Env[1] = "TEAMAIBOX_APPLIANCE_RESTART_POLICY_DIGEST=sha256:" + strings.Repeat("e", 64)
	document.Config.Env[2] = "PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST=sha256:" + strings.Repeat("f", 64)
	document.Config.Env[3] = "TEAMAIBOX_APPLIANCE_CONFIGURATION_DIGEST=sha256:" + strings.Repeat("0", 64)
	document.Config.Labels["com.teamaibox.config-digest"] = "sha256:" + strings.Repeat("f", 64)
	if applianceConfigurationDigest(document) != baseline {
		t.Fatal("policy locator or configuration-digest label created a circular configuration digest")
	}
	document.Config.Labels["com.teamaibox.feature"] = "drifted"
	if applianceConfigurationDigest(document) == baseline {
		t.Fatal("unrelated label drift was hidden by runtime normalization")
	}
	document.Config.Labels["com.teamaibox.feature"] = "protected-office"
	document.Config.Env[5] = "TEAMAIBOX_NODE_ID=drifted"
	if applianceConfigurationDigest(document) == baseline {
		t.Fatal("unrelated configuration drift was hidden by policy-value normalization")
	}
	document.Config.Env[5] = "TEAMAIBOX_NODE_ID=fixed"
	document.Config.Env[4] = "TEAMAIBOX_APPLIANCE_IMAGE_DIGEST=sha256:" + strings.Repeat("1", 64)
	if applianceConfigurationDigest(document) == baseline {
		t.Fatal("appliance image identity drift was hidden by runtime normalization")
	}
}

func TestComputeApplianceConfigurationDigestUsesDockerInspectJSON(t *testing.T) {
	document, _ := applianceRestartFixture("a", "platform-api", time.Now().UTC())
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := ComputeApplianceConfigurationDigest(raw)
	if err != nil || digest != applianceConfigurationDigest(document) {
		t.Fatalf("raw inspect digest mismatch: %q %v", digest, err)
	}
	for _, raw := range [][]byte{[]byte("{"), []byte(`{"Id":""}`)} {
		if _, err := ComputeApplianceConfigurationDigest(raw); err == nil {
			t.Fatal("invalid Docker inspect document was accepted")
		}
	}
}
