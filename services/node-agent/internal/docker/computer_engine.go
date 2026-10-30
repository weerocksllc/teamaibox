package docker

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"reflect"

	"teamaibox.local/node-agent/internal/agent"
)

// Use the existing Docker client and inspection shape. Creation retries inspect
// an exact stable run name; an exited run is never automatically started again.
func exactComputerContainer(state phoneEngineState, p agent.ComputerCommand, b ComputerContainerBinding) bool {
	expected, err := buildComputerContainer(p, b)
	if err != nil || !phoneExactContainerID.MatchString(state.ID) || state.Image != p.RuntimeImage ||
		p.Run.ContainerID != nil && state.ID != *p.Run.ContainerID {
		return false
	}
	if !exactComputerSpec(state, expected) {
		return false
	}
	// Docker removes endpoint metadata when the exited run's bridge is
	// reclaimed. HostConfig.NetworkMode above still binds the original network.
	if !state.State.Running && state.State.Status == "exited" && len(state.NetworkSettings.Networks) == 0 {
		return true
	}
	return len(state.NetworkSettings.Networks) == 1 && func() bool {
		for _, network := range state.NetworkSettings.Networks {
			return network.NetworkID == b.NetworkID || network.NetworkID == "" && (state.State.Status == "created" || state.State.Status == "exited") && !state.State.Running
		}
		return false
	}()
}
func exactComputerSpec(state phoneEngineState, expected map[string]any) bool {
	if !phoneExactContainerID.MatchString(state.ID) || state.Image != expected["Image"] {
		return false
	}
	for _, key := range []string{"Image", "User", "WorkingDir", "Entrypoint", "Cmd", "Labels", "StopSignal", "StopTimeout", "Env"} {
		if !phoneRequiredEqual(phoneNormalized(expected[key]), state.Config[key]) {
			return false
		}
	}
	actual, ok := phoneNormalized(state.HostConfig).(map[string]any)
	if !ok {
		return false
	}
	// Docker omits an empty Sysctls map. This is equivalent only to no values;
	// nonempty additions must still fail the exact-map check below.
	if actual["Sysctls"] == nil {
		actual["Sysctls"] = map[string]any{}
	}
	if mounts, ok := actual["Mounts"].([]any); ok {
		for _, value := range mounts {
			if m, ok := value.(map[string]any); ok {
				if _, present := m["ReadOnly"]; !present {
					m["ReadOnly"] = false
				}
			}
		}
	}
	host := phoneNormalized(expected["HostConfig"]).(map[string]any)
	if !phoneRequiredEqual(host, actual) {
		return false
	}
	// These maps have no additional engine defaults; deny a published management
	// port or extra sysctl even if all expected keys are still present.
	for _, key := range []string{"PortBindings", "Sysctls", "Tmpfs"} {
		if !reflect.DeepEqual(host[key], actual[key]) {
			return false
		}
	}
	for _, key := range []string{"Binds", "VolumesFrom", "Links", "ExtraHosts", "DeviceCgroupRules", "DeviceRequests"} {
		if !phoneRequiredEqual([]any{}, actual[key]) {
			return false
		}
	}
	if state.HostConfig["UsernsMode"] == "host" {
		return false
	}
	return true
}

func (r *EngineRuntime) inspectComputerContainer(ctx context.Context, p agent.ComputerCommand, b ComputerContainerBinding) (phoneEngineState, bool, error) {
	var state phoneEngineState
	if _, err := buildComputerContainer(p, b); err != nil {
		return state, false, err
	}
	name := computerContainerName(p)
	if p.Run.ContainerID != nil {
		name = *p.Run.ContainerID
	}
	err := r.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", nil, &state, http.StatusOK)
	if err != nil {
		var status *engineStatusError
		if errors.As(err, &status) && status.status == http.StatusNotFound {
			return state, false, nil
		}
		return state, false, err
	}
	if !exactComputerContainer(state, p, b) {
		return state, true, errors.New("computer_container_identity_mismatch")
	}
	return state, true, nil
}

func (r *EngineRuntime) startComputerContainer(ctx context.Context, p agent.ComputerCommand, b ComputerContainerBinding) (phoneEngineState, error) {
	state, exists, err := r.inspectComputerContainer(ctx, p, b)
	if err != nil {
		return state, err
	}
	if !exists {
		// Once a container ID was persisted, missing means lost/removed, not a new
		// create request. Never substitute a new machine for the old runtime.
		if p.Run.ContainerID != nil {
			return state, errors.New("computer_runtime_missing")
		}
		var image struct {
			ID           string `json:"Id"`
			Architecture string `json:"Architecture"`
		}
		if err = r.request(ctx, http.MethodGet, "/images/"+url.PathEscape(p.RuntimeImage)+"/json", nil, &image, http.StatusOK); err != nil {
			return state, err
		}
		if image.ID != p.RuntimeImage || image.Architecture != "arm64" {
			return state, errors.New("computer_image_identity_mismatch")
		}
		spec, _ := buildComputerContainer(p, b)
		var created struct {
			ID string `json:"Id"`
		}
		if err = r.request(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(computerContainerName(p)), spec, &created, http.StatusCreated); err != nil {
			return state, err
		}
		state, exists, err = r.inspectComputerContainer(ctx, p, b)
		if err != nil || !exists || !phoneExactContainerID.MatchString(created.ID) || state.ID != created.ID {
			return state, errors.New("computer_container_identity_mismatch")
		}
	}
	if state.State.Status == "running" && state.State.Running {
		return state, nil
	}
	if state.State.Status != "created" {
		return state, errors.New("computer_run_already_stopped")
	}
	if err = r.request(ctx, http.MethodPost, "/containers/"+state.ID+"/start", nil, nil, http.StatusNoContent); err != nil {
		return state, err
	}
	state, exists, err = r.inspectComputerContainer(ctx, p, b)
	if err != nil {
		return state, err
	}
	if !exists || !state.State.Running {
		return state, errors.New("computer_start_unconfirmed")
	}
	return state, nil // Container running does not assert Windows ready.
}
