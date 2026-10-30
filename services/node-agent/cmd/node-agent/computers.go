package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"

	"teamaibox.local/node-agent/internal/agent"
	dockerruntime "teamaibox.local/node-agent/internal/docker"
)

func (service commandTypeRestrictedService) OpenComputerDesktop(ctx context.Context, payload agent.ComputerCommand, kind string) (net.Conn, error) {
	delegate, ok := service.delegate.(agent.ComputerDesktopProvider)
	if !ok || !service.allowed["virtual-computer.inspect"] {
		return nil, errors.New("computer_desktop_unavailable")
	}
	return delegate.OpenComputerDesktop(ctx, payload, kind)
}

// Optional installed configuration. Enabling computers adds handlers to the
// existing authenticated Node Agent; it does not replace the Android runtime,
// restart a guest, or replace the configured appliance identity.
type installedComputers struct {
	Version               int                                  `json:"version"`
	NodeID                string                               `json:"nodeId"`
	MinimumNodeGeneration int64                                `json:"minimumNodeGeneration"`
	PoolID                string                               `json:"poolId"`
	DataRoot              string                               `json:"dataRoot"`
	StorageSocket         string                               `json:"storageSocket"`
	Resources             dockerruntime.ComputerResourcePolicy `json:"resources"`
}

func installedComputerPolicy(path, nodeID string, generation int64) (installedComputers, error) {
	var config installedComputers
	i, e := os.Lstat(path)
	if e != nil || !filepath.IsAbs(path) || !i.Mode().IsRegular() || i.Mode().Perm()&0022 != 0 {
		return config, errors.New("computer_installed_configuration_invalid")
	}
	f, e := os.Open(path)
	if e != nil {
		return config, e
	}
	defer f.Close()
	raw, e := io.ReadAll(io.LimitReader(f, 1<<20))
	if e != nil || len(raw) >= 1<<20 {
		return config, errors.New("computer_installed_configuration_invalid")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&config) != nil || !errors.Is(d.Decode(&struct{}{}), io.EOF) || config.Version != 1 || config.NodeID != nodeID || config.MinimumNodeGeneration < 1 || generation < config.MinimumNodeGeneration || len(config.Resources.Profiles) == 0 {
		return config, errors.New("computer_installed_configuration_invalid")
	}
	return config, nil
}
func configureInstalledComputers(path, nodeID string, generation int64, stateDirectory string, engine *dockerruntime.EngineRuntime, service *agent.Service, memory agent.PhoneMemorySource) (func(), error) {
	if path == "" {
		return func() {}, nil
	}
	if memory == nil {
		return nil, errors.New("computer_baseline_required")
	}
	config, e := installedComputerPolicy(path, nodeID, generation)
	if e != nil {
		return nil, e
	}
	storage, e := dockerruntime.NewInstalledComputerStorage(nodeID, config.PoolID, config.DataRoot, config.StorageSocket, engine)
	if e != nil {
		return nil, e
	}
	resources, e := dockerruntime.NewInstalledComputerResources(config.Resources, storage, memory)
	if e != nil {
		return nil, e
	}
	driver, e := dockerruntime.NewComputerDriver(engine, resources, 250*time.Millisecond, 10*time.Second)
	if e != nil {
		resources.Close()
		return nil, e
	}
	directory := filepath.Join(stateDirectory, "windows-computers")
	if e = os.Mkdir(directory, 0700); e != nil && !os.IsExist(e) {
		resources.Close()
		return nil, e
	}
	profiles := map[string]string{}
	for _, profile := range config.Resources.Profiles {
		profiles[profile.ProfileID] = profile.RuntimeImage
	}
	coordinator, e := agent.NewComputerCoordinator(directory, agent.ComputerRuntimePolicy{NodeID: nodeID, NodeGeneration: generation, PoolID: config.PoolID, InstalledProfiles: profiles}, driver)
	if e != nil {
		resources.Close()
		return nil, e
	}
	close := func() { coordinator.Close(); resources.Close() }
	if e = service.ConfigureComputers(coordinator); e != nil {
		close()
		return nil, e
	}
	return close, nil
}
