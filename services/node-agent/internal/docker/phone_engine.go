package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"reflect"
	"strings"

	"teamaibox.local/node-agent/internal/agent"
)

type phoneEngineState struct {
	ID              string         `json:"Id"`
	Image           string         `json:"Image"`
	Config          map[string]any `json:"Config"`
	HostConfig      map[string]any `json:"HostConfig"`
	NetworkSettings struct {
		Networks map[string]struct {
			NetworkID string `json:"NetworkID"`
			IPAddress string `json:"IPAddress"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
	State struct {
		StartedAt string `json:"StartedAt"`
		Status    string `json:"Status"`
		Running   bool   `json:"Running"`
		ExitCode  int    `json:"ExitCode"`
		OOMKilled bool   `json:"OOMKilled"`
	} `json:"State"`
}

func phoneNormalized(value any) any {
	raw, _ := json.Marshal(value)
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}

// Docker expands optional fields/defaults within mounts and limits. Required
// keys must still match recursively; array length/order is exact, so an extra
// device, capability, port, bind or command argument cannot hide in this check.
func phoneRequiredEqual(expected, actual any) bool {
	if expected == nil {
		return actual == nil
	}
	switch want := expected.(type) {
	case map[string]any:
		got, ok := actual.(map[string]any)
		if !ok {
			return false
		}
		if len(want) == 0 {
			return len(got) == 0
		}
		for key, value := range want {
			if !phoneRequiredEqual(value, got[key]) {
				return false
			}
		}
		return true
	case []any:
		if len(want) == 0 && actual == nil {
			return true
		}
		got, ok := actual.([]any)
		if !ok || len(want) != len(got) {
			return false
		}
		for index, value := range want {
			if !phoneRequiredEqual(value, got[index]) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(expected, actual)
	}
}

func exactPhoneContainer(state phoneEngineState, policy PhoneContainerPolicy, p agent.PhoneCommandPayload, networkID string) bool {
	// Upgrading the host must not force guest recreation. Accept the exact old
	// recipe only when its original address remains explicitly installed.
	if policy.HostMediaStateFile != "" {
		labels, _ := state.Config["Labels"].(map[string]any)
		if labels["com.teamaibox.phone-media"] != "host-managed-v1" {
			policy.HostMediaStateFile = ""
		}
	}
	expected, err := buildPhoneContainer(policy, p, networkID)
	if err != nil || !phoneExactContainerID.MatchString(state.ID) || state.Image != p.Run.ImageDigest {
		return false
	}
	for _, key := range []string{"User", "WorkingDir", "Entrypoint", "Cmd", "Labels", "StopTimeout", "Env"} {
		if !phoneRequiredEqual(phoneNormalized(expected[key]), state.Config[key]) {
			return false
		}
	}
	// The fixed image's Android paths are explicit in the create recipe too;
	// inherited defaults cannot silently widen or contradict the allowlist.
	host := phoneNormalized(expected["HostConfig"]).(map[string]any)
	// Docker's mount JSON omits ReadOnly when false. Interpret only that
	// documented bool default; a missing true/read-only requirement still fails.
	actualHost, ok := phoneNormalized(state.HostConfig).(map[string]any)
	if !ok {
		return false
	}
	if mounts, ok := actualHost["Mounts"].([]any); ok {
		for _, value := range mounts {
			if mount, ok := value.(map[string]any); ok {
				if _, present := mount["ReadOnly"]; !present {
					mount["ReadOnly"] = false
				}
			}
		}
	}
	if !phoneRequiredEqual(host, actualHost) {
		return false
	}
	if policy.NetworkProfile != "" {
		// These maps have no Docker-added defaults. Additional ports or sysctls
		// must not be accepted by the recursive required-field comparison.
		for _, key := range []string{"PortBindings", "Sysctls"} {
			if !reflect.DeepEqual(host[key], actualHost[key]) {
				return false
			}
		}
		if !reflect.DeepEqual(phoneNormalized(expected["ExposedPorts"]), state.Config["ExposedPorts"]) {
			return false
		}
	}
	for _, key := range []string{"Binds", "VolumesFrom", "Links", "ExtraHosts", "DeviceCgroupRules", "DeviceRequests"} {
		value := state.HostConfig[key]
		if value != nil && !phoneRequiredEqual([]any{}, value) {
			return false
		}
	}
	for _, key := range []string{"CgroupnsMode", "UTSMode", "UsernsMode"} {
		if state.HostConfig[key] == "host" {
			return false
		}
	}
	return state.HostConfig["PublishAllPorts"] != true && state.HostConfig["AutoRemove"] != true
}

func (r *EngineRuntime) inspectPhoneContainer(ctx context.Context, policy PhoneContainerPolicy, p agent.PhoneCommandPayload, networkID string) (phoneEngineState, bool, error) {
	var value phoneEngineState
	if _, err := buildPhoneContainer(policy, p, networkID); err != nil {
		return value, false, err
	}
	err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(phoneContainerName(p))+"/json", nil, &value, http.StatusOK)
	if err != nil {
		var status *engineStatusError
		if errors.As(err, &status) && status.status == http.StatusNotFound {
			return value, false, nil
		}
		return value, false, err
	}
	if !exactPhoneContainer(value, policy, p, networkID) {
		return value, true, errors.New("phone_container_identity_mismatch")
	}
	return value, true, nil
}

// Storage and private network admission precede this call. The method never
// pulls an image, creates a network, allocates storage or restarts an exited run.
func (r *EngineRuntime) startPhoneContainer(ctx context.Context, policy PhoneContainerPolicy, p agent.PhoneCommandPayload, networkID string) (phoneEngineState, error) {
	state, exists, err := r.inspectPhoneContainer(ctx, policy, p, networkID)
	if err != nil {
		return state, err
	}
	if !exists {
		var image struct {
			ID           string `json:"Id"`
			Architecture string `json:"Architecture"`
		}
		if err = r.request(ctx, http.MethodGet, "/images/"+url.PathEscape(p.Run.ImageDigest)+"/json", nil, &image, http.StatusOK); err != nil {
			return state, err
		}
		if image.ID != p.Run.ImageDigest || image.Architecture != "arm64" {
			return state, errors.New("phone_image_identity_mismatch")
		}
		spec, _ := buildPhoneContainer(policy, p, networkID)
		var created struct {
			ID string `json:"Id"`
		}
		err = r.request(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(phoneContainerName(p)), spec, &created, http.StatusCreated)
		if err != nil {
			return state, err
		} // Lost replies are recovered by exact name/identity inspection on retry.
		if !phoneExactContainerID.MatchString(created.ID) {
			return state, errors.New("phone_container_identity_mismatch")
		}
		// The create recipe owns the per-phone network. Attach the separately
		// installed control network only after the exact container identity is
		// known; member input can never select either network.
		var createdState phoneEngineState
		if err = r.request(ctx, http.MethodGet, "/containers/"+created.ID+"/json", nil, &createdState, http.StatusOK); err != nil ||
			!exactPhoneContainer(createdState, policy, p, networkID) || createdState.ID != created.ID {
			return state, errors.New("phone_container_identity_mismatch")
		}
		if policy.ControlNetworkID != "" {
			if policy.ControlNetworkID == networkID || !ValidPhoneControlNetworkID(policy.ControlNetworkID) {
				return state, errors.New("phone_control_network_invalid")
			}
			if err = r.request(ctx, http.MethodPost, "/networks/"+policy.ControlNetworkID+"/connect", map[string]any{"Container": created.ID}, nil, http.StatusOK); err != nil {
				return state, err
			}
		}
		state, exists, err = r.inspectPhoneContainer(ctx, policy, p, networkID)
		if err != nil || !exists || state.ID != created.ID {
			return state, errors.New("phone_container_identity_mismatch")
		}
	}
	if state.State.Running && state.State.Status == "running" {
		return state, nil
	}
	if state.State.Status != "created" {
		return state, errors.New("phone_run_already_stopped")
	}
	if err = r.request(ctx, http.MethodPost, "/containers/"+state.ID+"/start", nil, nil, http.StatusNoContent); err != nil {
		return state, err
	}
	state, exists, err = r.inspectPhoneContainer(ctx, policy, p, networkID)
	if err != nil {
		return state, err
	}
	if !exists || !state.State.Running {
		return state, errors.New("phone_start_unconfirmed")
	}
	return state, nil // Running container is NOT Android/media readiness.
}

func (r *EngineRuntime) stopPhoneContainer(ctx context.Context, policy PhoneContainerPolicy, p agent.PhoneCommandPayload, networkID string) (phoneEngineState, error) {
	state, exists, err := r.inspectPhoneContainer(ctx, policy, p, networkID)
	if err != nil {
		return state, err
	}
	if !exists {
		return state, errors.New("phone_stop_unconfirmed")
	}
	if state.State.Running {
		if err = r.stopContainer(ctx, state.ID, 75); err != nil {
			return state, err
		}
		var present bool
		state, present, err = r.inspectPhoneContainer(ctx, policy, p, networkID)
		if err != nil {
			return state, err
		}
		if !present {
			return state, errors.New("phone_stop_unconfirmed")
		}
	}
	if state.State.Running || !strings.Contains("|created|exited|dead|", "|"+state.State.Status+"|") {
		return state, errors.New("phone_stop_unconfirmed")
	}
	return state, nil // Caller reads bound terminal status before recording cleanShutdown.
}

func (r *EngineRuntime) removeStoppedPhoneContainer(ctx context.Context, policy PhoneContainerPolicy, p agent.PhoneCommandPayload, networkID string) error {
	state, exists, err := r.inspectPhoneContainer(ctx, policy, p, networkID)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	if state.State.Running || state.State.Status != "exited" && state.State.Status != "created" {
		return errors.New("phone_stop_unconfirmed")
	}
	return r.request(ctx, http.MethodDelete, "/containers/"+state.ID, nil, nil, http.StatusNoContent)
}
