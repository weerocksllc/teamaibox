package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"teamaibox.local/node-agent/internal/agent"
	dockerruntime "teamaibox.local/node-agent/internal/docker"
	"teamaibox.local/node-agent/internal/phonepool"
)

// Installed by the node deployment, never populated from member request data.
type installedPhones struct {
	Version                int                             `json:"version"`
	NodeID                 string                          `json:"nodeId"`
	NodeGeneration         int64                           `json:"nodeGeneration"`
	PoolID                 string                          `json:"poolId"`
	ImageID                string                          `json:"imageId"`
	AdditionalImageDigests []string                        `json:"additionalImageDigests,omitempty"`
	RetiredImageDigests    []string                        `json:"retiredImageDigests,omitempty"`
	InstanceLimitByImage   map[string]int                  `json:"instanceLimitByImage,omitempty"`
	RuntimeMaintenance     []agent.PhoneRuntimeMaintenance `json:"runtimeMaintenance,omitempty"`
	DataRoot               string                          `json:"dataRoot"`
	ControlRoot            string                          `json:"controlRoot"`
	StorageSocket          string                          `json:"storageSocket"`
	UsbCameraSocket        string                          `json:"usbCameraSocket,omitempty"`
	KVMGroup               uint32                          `json:"kvmGroup"`
	VhostGroup             uint32                          `json:"vhostGroup"`
	SeccompFile            string                          `json:"seccompFile"`
	NetworkProfile         string                          `json:"networkProfile,omitempty"`
	MediaAddress           string                          `json:"mediaAddress,omitempty"`
	HostMediaStateFile     string                          `json:"hostMediaStateFile,omitempty"`
	ControlNetworkID       string                          `json:"controlNetworkId,omitempty"`
}

func installedPhonePolicy(path, nodeID string, generation int64) (installedPhones, dockerruntime.PhoneContainerPolicy, error) {
	var config installedPhones
	var policy dockerruntime.PhoneContainerPolicy
	read := func(name string, limit int64) ([]byte, error) {
		info, err := os.Lstat(name)
		if err != nil || !filepath.IsAbs(name) || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || limit > 0 && info.Size() > limit {
			return nil, errors.New("phone_installed_configuration_invalid")
		}
		return os.ReadFile(name)
	}
	raw, err := read(path, 0)
	if err != nil {
		return config, policy, err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	// Installation pins the node and a minimum generation. The current generation
	// comes from the locally configured appliance identity, not a phone request.
	if d.Decode(&config) != nil || !errors.Is(d.Decode(&struct{}{}), io.EOF) || config.Version != 1 || config.NodeID != nodeID || config.NodeGeneration < 1 || generation < config.NodeGeneration || !agent.ValidInstalledPhoneImages(config.ImageID, config.AdditionalImageDigests, config.RetiredImageDigests) || !agent.ValidPhoneRuntimeMaintenance(config.ImageID, config.AdditionalImageDigests, config.RuntimeMaintenance) {
		return config, policy, errors.New("phone_installed_configuration_invalid")
	}
	seccomp, err := read(config.SeccompFile, 65536)
	if err != nil {
		return config, policy, err
	}
	if !dockerruntime.ValidPhoneInstanceLimits(config.ImageID, config.AdditionalImageDigests, config.InstanceLimitByImage) {
		return config, policy, errors.New("phone_installed_configuration_invalid")
	}
	policy = dockerruntime.PhoneContainerPolicy{NodeID: nodeID, NodeGeneration: generation, PoolID: config.PoolID, ImageID: config.ImageID,
		DataRoot: config.DataRoot, ControlRoot: config.ControlRoot, KVMGroup: config.KVMGroup, VhostGroup: config.VhostGroup, Seccomp: seccomp,
		NetworkProfile: config.NetworkProfile, MediaAddress: config.MediaAddress, ControlNetworkID: config.ControlNetworkID, UsbCameraSocket: config.UsbCameraSocket, RetiredImageDigests: config.RetiredImageDigests, AdditionalImageDigests: config.AdditionalImageDigests, InstanceLimitByImage: config.InstanceLimitByImage}
	policy.HostMediaStateFile = config.HostMediaStateFile
	if config.ControlNetworkID != "" && !dockerruntime.ValidPhoneControlNetworkID(config.ControlNetworkID) {
		return config, policy, errors.New("phone_installed_configuration_invalid")
	}
	if config.UsbCameraSocket != "" && (filepath.Base(config.UsbCameraSocket) != "camera.sock" || filepath.Dir(config.UsbCameraSocket) != filepath.Dir(config.StorageSocket)) {
		return config, policy, errors.New("phone_installed_configuration_invalid")
	}
	return config, policy, nil
}

func configureInstalledPhones(path, nodeID string, generation int64, stateDirectory string,
	engine *dockerruntime.EngineRuntime, service *agent.Service, memory agent.PhoneMemorySource) (func(), error) {
	if path == "" {
		return func() {}, nil
	}
	if memory == nil {
		return nil, errors.New("phone_baseline_required")
	}
	config, policy, err := installedPhonePolicy(path, nodeID, generation)
	if err != nil {
		return nil, err
	}
	resources, err := dockerruntime.NewInstalledPhoneResources(engine, policy, config.StorageSocket)
	if err != nil {
		return nil, err
	}
	driver, err := dockerruntime.NewPhoneDriver(engine, policy, resources)
	if err != nil {
		resources.Close()
		return nil, err
	}
	directory := filepath.Join(stateDirectory, "android-phones")
	if err = os.Mkdir(directory, 0700); err != nil && !os.IsExist(err) {
		resources.Close()
		return nil, err
	}
	coordinator, err := agent.NewPhoneCoordinator(directory, agent.PhoneRuntimePolicy{NodeID: nodeID, NodeGeneration: generation, PoolID: policy.PoolID, ImageDigest: policy.ImageID, RetiredImageDigests: policy.RetiredImageDigests, AdditionalImageDigests: policy.AdditionalImageDigests, RuntimeMaintenance: config.RuntimeMaintenance}, driver)
	if err != nil {
		resources.Close()
		return nil, err
	}
	close := func() { coordinator.Close(); resources.Close() }
	if err = coordinator.ConfigurePhoneProtection(memory); err != nil {
		close()
		return nil, err
	}
	if err = service.ConfigurePhones(coordinator); err != nil {
		close()
		return nil, err
	}
	if err = service.ConfigurePhoneStorage(installedPhoneStorage{client: phonepool.Client{Socket: config.StorageSocket},
		poolID: config.PoolID, nodeID: nodeID, generation: generation}); err != nil {
		close()
		return nil, err
	}
	return close, nil
}
