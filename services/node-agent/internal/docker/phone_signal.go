package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"

	"teamaibox.local/node-agent/internal/agent"
)

func (d *PhoneDriver) PhoneSignalEndpoint(ctx context.Context, p agent.PhoneMediaPayload) (agent.PhoneSignalEndpoint, error) {
	var endpoint agent.PhoneSignalEndpoint
	b, err := d.resources.ResolveRun(ctx, p.PhoneCommandPayload)
	if err != nil {
		return endpoint, err
	}
	if err = d.validateBinding(p.PhoneCommandPayload, b); err != nil {
		return endpoint, err
	}
	policy := d.policy.forBinding(b)
	container, exists, err := d.engine.inspectPhoneContainer(ctx, policy, p.PhoneCommandPayload, b.NetworkID)
	if err != nil || !exists || !container.State.Running {
		return endpoint, errors.New("phone_signal_not_ready")
	}
	primary, ok := networkByID(container, b.NetworkID)
	if !ok {
		return endpoint, errors.New("phone_signal_network_invalid")
	}
	if policy.ControlNetworkID != "" {
		control, found := networkByID(container, policy.ControlNetworkID)
		if !found || len(container.NetworkSettings.Networks) != 2 {
			return endpoint, errors.New("phone_signal_network_invalid")
		}
		endpoint.Host = control.IPAddress
	} else if len(container.NetworkSettings.Networks) == 1 {
		endpoint.Host = primary.IPAddress
	} else {
		return endpoint, errors.New("phone_signal_network_invalid")
	}
	for _, address := range []string{primary.IPAddress, endpoint.Host} {
		ip := net.ParseIP(address)
		if ip == nil || ip.To4() == nil || !ip.IsPrivate() {
			return endpoint, errors.New("phone_signal_network_invalid")
		}
	}
	root, err := os.OpenRoot(d.policy.ControlRoot)
	if err != nil {
		return endpoint, errors.New("phone_signal_config_invalid")
	}
	defer root.Close()
	read := func(path string) ([]byte, error) {
		// Never traverse another run through a symlink, even within ControlRoot.
		parts := strings.Split(path, string(filepath.Separator))
		for index := 1; index < len(parts); index++ {
			info, err := root.Lstat(filepath.Join(parts[:index]...))
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return nil, errors.New("phone_signal_config_invalid")
			}
		}
		info, err := root.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() > 8192 {
			return nil, errors.New("phone_signal_config_invalid")
		}
		f, err := root.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		raw, err := io.ReadAll(io.LimitReader(f, 8193))
		if err != nil || len(raw) > 8192 {
			return nil, errors.New("phone_signal_config_invalid")
		}
		return raw, nil
	}
	raw, err := read(filepath.Join(p.Run.ID, "config.json"))
	if err != nil {
		return endpoint, err
	}
	var config struct {
		Version    int    `json:"version"`
		PhoneID    string `json:"phoneId"`
		OwnerID    string `json:"ownerId"`
		VolumeID   string `json:"volumeId"`
		RunID      string `json:"runId"`
		Generation uint64 `json:"generation"`
		Instance   int    `json:"instance"`
		BuildID    string `json:"buildId"`
	}
	// The installed v1 declaration is a flat closed object. Duplicate keys do
	// not get a second interpretation here compared with the Python runtime.
	keys := json.NewDecoder(bytes.NewReader(raw))
	token, err := keys.Token()
	if err != nil || token != json.Delim('{') {
		return endpoint, errors.New("phone_signal_config_invalid")
	}
	seen := map[string]bool{}
	for keys.More() {
		key, err := keys.Token()
		name, ok := key.(string)
		if err != nil || !ok || seen[name] {
			return endpoint, errors.New("phone_signal_config_invalid")
		}
		seen[name] = true
		value, err := keys.Token()
		if _, nested := value.(json.Delim); err != nil || nested {
			return endpoint, errors.New("phone_signal_config_invalid")
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil || config.Version != 1 || config.PhoneID != p.PhoneID || config.OwnerID != p.OwnerID || config.VolumeID != p.VolumeID ||
		config.RunID != p.Run.ID || config.Generation != p.Generation || config.BuildID != agent.PhoneBaseBuild || !validPhoneInstance(config.Instance) {
		return endpoint, errors.New("phone_signal_config_invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return endpoint, errors.New("phone_signal_config_invalid")
	}
	endpoint.Certificate, err = read(filepath.Join(p.Run.ID, "certs", "server.crt"))
	if err != nil {
		return endpoint, err
	}
	endpoint.Port = 8443 + config.Instance - 1
	endpoint.ServerName = "127.0.0.1" // Fixed in the private runtime certificate SAN.
	if d.policy.NetworkProfile == phoneLANProfile {
		if b.Instance != config.Instance {
			return agent.PhoneSignalEndpoint{}, errors.New("phone_signal_config_invalid")
		}
		endpoint.MediaAddress = d.policy.MediaAddress
		endpoint.MediaContainerAddress = primary.IPAddress
		endpoint.MediaFirstPort = 20000 + (config.Instance-21)*100
		endpoint.MediaLastPort = endpoint.MediaFirstPort + 49
		if d.policy.HostMediaStateFile != "" {
			endpoint.MediaAddress, err = appliedPhoneMediaAddress(d.policy, container, p.Run.ID, primary.IPAddress, endpoint.MediaFirstPort)
			if err != nil {
				return agent.PhoneSignalEndpoint{}, err
			}
		}
		if err = d.ensurePhoneNetworkRoles(ctx, container, b); err != nil {
			return agent.PhoneSignalEndpoint{}, err
		}
	}
	return endpoint, nil
}

func networkByID(container phoneEngineState, id string) (struct {
	NetworkID string `json:"NetworkID"`
	IPAddress string `json:"IPAddress"`
}, bool) {
	for _, network := range container.NetworkSettings.Networks {
		if network.NetworkID == id {
			return network, true
		}
	}
	return struct {
		NetworkID string `json:"NetworkID"`
		IPAddress string `json:"IPAddress"`
	}{}, false
}
