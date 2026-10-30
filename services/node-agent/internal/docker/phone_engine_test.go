package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func phoneObservedFixture(t *testing.T) (PhoneContainerPolicy, phoneEngineState) {
	t.Helper()
	policy, p := phoneRecipeFixture(t)
	expected, err := buildPhoneContainer(policy, p, strings.Repeat("b", 64))
	if err != nil {
		t.Fatal(err)
	}
	config := phoneNormalized(expected).(map[string]any)
	state := phoneEngineState{ID: strings.Repeat("c", 64), Image: policy.ImageID,
		Config: config, HostConfig: config["HostConfig"].(map[string]any)}
	state.State.Status = "created"
	return policy, state
}

func TestPhoneEngineRealDockerOmittedFalseMountField(t *testing.T) {
	policy, p := phoneRecipeFixture(t)
	_, state := phoneObservedFixture(t)
	mounts := state.HostConfig["Mounts"].([]any)
	delete(mounts[0].(map[string]any), "ReadOnly")
	if !exactPhoneContainer(state, policy, p, strings.Repeat("b", 64)) {
		t.Fatal("Docker omitted false rejected")
	}
	delete(mounts[1].(map[string]any), "ReadOnly")
	if exactPhoneContainer(state, policy, p, strings.Repeat("b", 64)) {
		t.Fatal("writable config mount accepted")
	}
}

func TestPhoneEngineExactInspectionRejectsForeignAndWidenedContainers(t *testing.T) {
	policy, p := phoneRecipeFixture(t)
	_, state := phoneObservedFixture(t)
	if !exactPhoneContainer(state, policy, p, strings.Repeat("b", 64)) {
		t.Fatal("valid recipe rejected")
	}
	for _, test := range []string{"owner", "run", "image", "root", "ports", "privileged", "gpu", "socket", "caps", "command", "proxy", "restart", "swap", "extra-device"} {
		t.Run(test, func(t *testing.T) {
			_, s := phoneObservedFixture(t)
			switch test {
			case "owner":
				s.Config["Labels"].(map[string]any)["com.teamaibox.owner-identity-id"] = "foreign"
			case "run":
				s.Config["Labels"].(map[string]any)["com.teamaibox.phone-run-id"] = "old-run"
			case "image":
				s.Image = "sha256:" + strings.Repeat("d", 64)
			case "root":
				s.Config["User"] = "0:0"
			case "ports":
				s.HostConfig["PortBindings"] = map[string]any{"6540/tcp": []any{}}
			case "privileged":
				s.HostConfig["Privileged"] = true
			case "gpu":
				s.HostConfig["DeviceRequests"] = []any{map[string]any{"Driver": "nvidia"}}
			case "socket":
				s.HostConfig["Binds"] = []any{"/var/run/docker.sock:/var/run/docker.sock"}
			case "caps":
				s.HostConfig["CapAdd"] = []any{"SYS_ADMIN"}
			case "command":
				s.Config["Cmd"] = []any{"/bin/sh"}
			case "proxy":
				s.Config["Env"] = []any{"HTTP_PROXY=http://host"}
			case "restart":
				s.HostConfig["RestartPolicy"] = map[string]any{"Name": "always"}
			case "swap":
				s.HostConfig["MemorySwap"] = float64(12 << 30)
			case "extra-device":
				s.HostConfig["Devices"] = append(s.HostConfig["Devices"].([]any), map[string]any{"PathOnHost": "/dev/sda"})
			}
			if exactPhoneContainer(s, policy, p, strings.Repeat("b", 64)) {
				t.Fatal("container drift accepted")
			}
		})
	}
}

func TestPhoneEngineLostReplyReusesCreatedRunAndRefusesExitedReplay(t *testing.T) {
	policy, p := phoneRecipeFixture(t)
	_, state := phoneObservedFixture(t)
	mutations := 0
	runtime := &EngineRuntime{baseURL: "http://docker/v1.48", client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/json") {
			raw, _ := json.Marshal(state)
			return response(http.StatusOK, string(raw)), nil
		}
		if request.Method == http.MethodPost && request.URL.Path == "/v1.48/containers/"+state.ID+"/start" {
			mutations++
			state.State.Running = true
			state.State.Status = "running"
			return response(http.StatusNoContent, ""), nil
		}
		t.Fatalf("unexpected request %s %s", request.Method, request.URL)
		return nil, nil
	})}}
	got, err := runtime.startPhoneContainer(context.Background(), policy, p, strings.Repeat("b", 64))
	if err != nil || got.ID != state.ID || mutations != 1 {
		t.Fatalf("%+v %v %d", got, err, mutations)
	}
	if _, err = runtime.startPhoneContainer(context.Background(), policy, p, strings.Repeat("b", 64)); err != nil || mutations != 1 {
		t.Fatal("running replay repeated start")
	}
	state.State.Status = "exited"
	state.State.Running = false
	if _, err = runtime.startPhoneContainer(context.Background(), policy, p, strings.Repeat("b", 64)); err == nil || mutations != 1 {
		t.Fatal("exited run restarted")
	}
}

func TestPhoneEngineUnavailableIsNotPermissionToCreate(t *testing.T) {
	policy, p := phoneRecipeFixture(t)
	runtime := &EngineRuntime{baseURL: "http://docker/v1.48", client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet {
			t.Fatal("mutation after uncertain inspect")
		}
		return response(http.StatusServiceUnavailable, ""), nil
	})}}
	if _, err := runtime.startPhoneContainer(context.Background(), policy, p, strings.Repeat("b", 64)); err == nil {
		t.Fatal("unavailable accepted")
	}
}

func TestPhoneEngineNewRunChecksImageAndCreationBeforeStart(t *testing.T) {
	policy, p := phoneRecipeFixture(t)
	_, state := phoneObservedFixture(t)
	created := false
	calls := 0
	runtime := &EngineRuntime{baseURL: "http://docker/v1.48", client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls++
		switch {
		case strings.Contains(request.URL.Path, "/images/"):
			return response(http.StatusOK, `{"Id":"`+policy.ImageID+`","Architecture":"arm64"}`), nil
		case strings.HasSuffix(request.URL.Path, "/containers/create"):
			var document map[string]any
			if err := json.NewDecoder(io.LimitReader(request.Body, 64<<10)).Decode(&document); err != nil {
				t.Fatal(err)
			}
			if document["Image"] != policy.ImageID || document["User"] != "10001:10001" {
				t.Fatal("wrong recipe")
			}
			created = true
			return response(http.StatusCreated, `{"Id":"`+state.ID+`"}`), nil
		case request.Method == http.MethodGet:
			if !created {
				return response(http.StatusNotFound, ""), nil
			}
			raw, _ := json.Marshal(state)
			return response(http.StatusOK, string(raw)), nil
		case strings.HasSuffix(request.URL.Path, "/start"):
			state.State.Status = "running"
			state.State.Running = true
			return response(http.StatusNoContent, ""), nil
		default:
			t.Fatal("unexpected Docker call")
			return nil, nil
		}
	})}}
	if got, err := runtime.startPhoneContainer(context.Background(), policy, p, strings.Repeat("b", 64)); err != nil || !got.State.Running || calls != 7 {
		t.Fatalf("%+v %v %d", got, err, calls)
	}
}

func TestPhoneEngineNewRunAttachesInstalledControlNetwork(t *testing.T) {
	policy, p := phoneRecipeFixture(t)
	policy.ControlNetworkID = strings.Repeat("d", 64)
	_, state := phoneObservedFixture(t)
	expected, err := buildPhoneContainer(policy, p, strings.Repeat("b", 64))
	if err != nil {
		t.Fatal(err)
	}
	config := phoneNormalized(expected).(map[string]any)
	state.Config, state.HostConfig = config, config["HostConfig"].(map[string]any)
	state.NetworkSettings.Networks = map[string]struct {
		NetworkID string `json:"NetworkID"`
		IPAddress string `json:"IPAddress"`
	}{"phone": {strings.Repeat("b", 64), "172.28.40.2"}}
	created, connected := false, false
	runtime := &EngineRuntime{baseURL: "http://docker/v1.48", client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(request.URL.Path, "/images/"):
			return response(http.StatusOK, `{"Id":"`+policy.ImageID+`","Architecture":"arm64"}`), nil
		case strings.HasSuffix(request.URL.Path, "/containers/create"):
			created = true
			return response(http.StatusCreated, `{"Id":"`+state.ID+`"}`), nil
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/networks/"+policy.ControlNetworkID+"/connect"):
			if !created {
				t.Fatal("control network attached before exact create")
			}
			connected = true
			state.NetworkSettings.Networks["control"] = struct {
				NetworkID string `json:"NetworkID"`
				IPAddress string `json:"IPAddress"`
			}{policy.ControlNetworkID, "10.252.120.2"}
			return response(http.StatusOK, ""), nil
		case request.Method == http.MethodGet:
			if !created {
				return response(http.StatusNotFound, ""), nil
			}
			raw, _ := json.Marshal(state)
			return response(http.StatusOK, string(raw)), nil
		case strings.HasSuffix(request.URL.Path, "/start"):
			if !connected {
				t.Fatal("phone started before control network attachment")
			}
			state.State.Status, state.State.Running = "running", true
			return response(http.StatusNoContent, ""), nil
		default:
			t.Fatalf("unexpected Docker call %s %s", request.Method, request.URL.Path)
			return nil, nil
		}
	})}}
	if got, err := runtime.startPhoneContainer(context.Background(), policy, p, strings.Repeat("b", 64)); err != nil || !got.State.Running || !connected {
		t.Fatalf("%+v %v connected=%v", got, err, connected)
	}
}
