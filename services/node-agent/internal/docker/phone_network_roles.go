package docker

import (
	"context"
	_ "embed"
	"errors"
	"net"
	"net/http"
	"strconv"
	"time"
)

// Fixed installation-owned code. There is no member-provided command or path.
//
//go:embed phone_network_roles.py
var phoneNetworkRolesProgram string

func (d *PhoneDriver) ensurePhoneNetworkRoles(ctx context.Context, container phoneEngineState, b PhoneResourceBinding) error {
	if d.policy.NetworkProfile != phoneLANProfile || d.policy.ControlNetworkID == "" {
		return nil
	}
	primary, ok := networkByID(container, b.NetworkID)
	control, controlOK := networkByID(container, d.policy.ControlNetworkID)
	if !ok || !controlOK || len(container.NetworkSettings.Networks) != 2 || !validPhoneInstance(b.Instance) || !container.State.Running {
		return errors.New("phone_network_role_identity_mismatch")
	}
	for _, value := range []string{primary.IPAddress, control.IPAddress} {
		ip := net.ParseIP(value)
		if ip == nil || ip.To4() == nil || !ip.IsPrivate() || ip.IsLoopback() || ip.IsUnspecified() {
			return errors.New("phone_network_role_identity_mismatch")
		}
	}
	d.networkRolesMu.Lock()
	defer d.networkRolesMu.Unlock()
	if verified, ok := d.networkRolesVerified[container.ID]; ok && verified == container.State.StartedAt {
		return nil
	}
	if err := d.engine.reconcilePhoneNetworkRoles(ctx, container.ID, b.Instance, primary.IPAddress, control.IPAddress); err != nil {
		return err
	}
	if d.networkRolesVerified == nil {
		d.networkRolesVerified = map[string]string{}
	}
	d.networkRolesVerified[container.ID] = container.State.StartedAt
	return nil
}

func (r *EngineRuntime) reconcilePhoneNetworkRoles(ctx context.Context, id string, instance int, primary, control string) error {
	if !phoneExactContainerID.MatchString(id) {
		return errors.New("phone_container_identity_mismatch")
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	var created struct {
		ID string `json:"Id"`
	}
	recipe := map[string]any{"AttachStdin": false, "AttachStdout": false, "AttachStderr": false, "Tty": false,
		"Privileged": false, "User": "0:0", "Cmd": []string{"/usr/bin/python3", "-c", phoneNetworkRolesProgram, strconv.Itoa(instance), primary, control}}
	if err := r.request(ctx, http.MethodPost, "/containers/"+id+"/exec", recipe, &created, http.StatusCreated); err != nil || !phoneExactContainerID.MatchString(created.ID) {
		return errors.New("phone_network_role_reconcile_failed")
	}
	if err := r.request(ctx, http.MethodPost, "/exec/"+created.ID+"/start", map[string]any{"Detach": true, "Tty": false}, nil, http.StatusOK); err != nil {
		return errors.New("phone_network_role_reconcile_failed")
	}
	for {
		var state struct {
			Running  bool `json:"Running"`
			ExitCode int  `json:"ExitCode"`
		}
		if err := r.request(ctx, http.MethodGet, "/exec/"+created.ID+"/json", nil, &state, http.StatusOK); err != nil {
			return errors.New("phone_network_role_reconcile_failed")
		}
		if !state.Running {
			if state.ExitCode != 0 {
				return errors.New("phone_network_role_reconcile_failed")
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("phone_network_role_reconcile_failed")
		case <-time.After(100 * time.Millisecond):
		}
	}
}
