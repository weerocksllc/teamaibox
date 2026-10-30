package docker

import (
	"errors"
	"path/filepath"
	"strconv"
	"strings"

	"teamaibox.local/node-agent/internal/agent"
)

// Bound by installed profile/storage admission, never by a browser path or
// Docker option. Each run keeps its own immutable configuration directory.
type ComputerContainerBinding struct {
	GuestDirectory     string
	ControlDirectory   string
	ConfigDirectory    string
	FirmwareDirectory  string
	MediaDirectory     string
	InstallerDirectory string `json:",omitempty"`
	NetworkID          string
	CPUIds             []int
	MemoryBytes        int64 // Guest plus measured runtime overhead, not guest memory alone.
	KVMGroup           uint32
	ShutdownSeconds    int
}

func computerContainerName(p agent.ComputerCommand) string { return "teamaibox-computer-" + p.Run.ID }

func buildComputerContainer(p agent.ComputerCommand, b ComputerContainerBinding) (map[string]any, error) {
	return buildComputerContainerMode(p, b, false)
}
func buildComputerProvisionContainer(p agent.ComputerCommand, b ComputerContainerBinding) (map[string]any, error) {
	return buildComputerContainerMode(p, b, true)
}
func buildComputerContainerMode(p agent.ComputerCommand, b ComputerContainerBinding, provision bool) (map[string]any, error) {
	bad := func() (map[string]any, error) { return nil, errors.New("computer_container_binding_invalid") }
	for _, id := range []string{p.ComputerID, p.OwnerID, p.NodeID, p.VolumeID, p.FirmwareID, p.OperationID} {
		if !managedWorkerID.MatchString(id) {
			return bad()
		}
	}
	if !provision && (p.Run == nil || !managedWorkerID.MatchString(p.Run.ID) || p.Generation == 0 || p.Run.Generation != p.Generation ||
		!digestID.MatchString(p.RuntimeImage) || p.Run.RuntimeImage != p.RuntimeImage ||
		p.Resources.VCPUs <= 0 || p.Resources.MemoryBytes <= 0 || p.Resources.DiskBytes <= 0 ||
		int64(len(b.CPUIds)) != p.Resources.VCPUs || b.MemoryBytes <= p.Resources.MemoryBytes || b.KVMGroup == 0 || b.ShutdownSeconds <= 0 ||
		!phoneExactContainerID.MatchString(b.NetworkID)) {
		return bad()
	}
	if provision && (p.Run != nil || p.Generation != 0 || !digestID.MatchString(p.RuntimeImage) || b.MemoryBytes <= 0 || b.NetworkID != "" || len(b.CPUIds) != 0 || b.ShutdownSeconds <= 0) {
		return bad()
	}
	if p.Run != nil && p.Run.ContainerID != nil && !phoneExactContainerID.MatchString(*p.Run.ContainerID) {
		return bad()
	}
	paths := []string{b.GuestDirectory, b.ControlDirectory, b.ConfigDirectory, b.FirmwareDirectory, b.MediaDirectory}
	if b.InstallerDirectory != "" {
		paths = append(paths, b.InstallerDirectory)
	}
	for i, path := range paths {
		if !phonePrivateRoot(path) {
			return bad()
		}
		for j, other := range paths {
			if i != j && (path == other || strings.HasPrefix(path, other+string(filepath.Separator))) {
				return bad()
			}
		}
	}
	cpus := make([]string, len(b.CPUIds))
	seen := map[int]bool{}
	for i, cpu := range b.CPUIds {
		if cpu < 0 || seen[cpu] {
			return bad()
		}
		seen[cpu] = true
		cpus[i] = strconv.Itoa(cpu)
	}
	labels := map[string]string{"com.teamaibox.managed": "true", "com.teamaibox.kind": "windows-computer",
		"com.teamaibox.node-id": p.NodeID, "com.teamaibox.computer-id": p.ComputerID, "com.teamaibox.owner-identity-id": p.OwnerID,
		"com.teamaibox.volume-id": p.VolumeID, "com.teamaibox.firmware-id": p.FirmwareID, "com.teamaibox.pool-id": p.PoolID,
		"com.teamaibox.computer-generation": strconv.FormatUint(p.Generation, 10),
		"com.teamaibox.profile-id":          p.ProfileID}
	if p.Run != nil {
		labels["com.teamaibox.computer-run-id"] = p.Run.ID
	} else {
		labels["com.teamaibox.provision-id"] = p.OperationID
	}
	if p.TPMID != nil {
		if !managedWorkerID.MatchString(*p.TPMID) {
			return bad()
		}
		labels["com.teamaibox.tpm-id"] = *p.TPMID
	}
	mount := func(source, target string, readonly bool) map[string]any {
		return map[string]any{"Type": "bind", "Source": source, "Target": target, "ReadOnly": readonly}
	}
	spec := map[string]any{"Image": p.RuntimeImage, "User": "10001:10001", "WorkingDir": "/guest",
		"Entrypoint": []string{"python3", "/opt/teamaibox/runtime.py"}, "Cmd": []string{"serve"},
		"Env":    []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/tmp", "PYTHONDONTWRITEBYTECODE=1", "DEBIAN_FRONTEND=noninteractive"},
		"Labels": labels, "StopSignal": "SIGTERM", "StopTimeout": b.ShutdownSeconds,
		"ExposedPorts": map[string]any{}, "HostConfig": map[string]any{
			"ReadonlyRootfs": true, "Privileged": false, "CapDrop": []string{"ALL"}, "CapAdd": []string{},
			"SecurityOpt": []string{"no-new-privileges"}, "NetworkMode": b.NetworkID,
			"PortBindings": map[string]any{}, "PublishAllPorts": false, "AutoRemove": false,
			"RestartPolicy": map[string]any{"Name": "no", "MaximumRetryCount": 0},
			"PidMode":       "", "IpcMode": "private", "UTSMode": "", "CgroupnsMode": "private",
			"Memory": b.MemoryBytes, "MemorySwap": b.MemoryBytes, "NanoCpus": p.Resources.VCPUs * 1000000000,
			"CpusetCpus": strings.Join(cpus, ","), "GroupAdd": []string{strconv.FormatUint(uint64(b.KVMGroup), 10)},
			"Devices": []map[string]any{{"PathOnHost": "/dev/kvm", "PathInContainer": "/dev/kvm", "CgroupPermissions": "rw"}},
			"Mounts": []map[string]any{mount(b.GuestDirectory, "/guest", false), mount(b.ControlDirectory, "/control", false),
				mount(b.ConfigDirectory, "/run/computer", true), mount(b.FirmwareDirectory, "/firmware", true), mount(b.MediaDirectory, "/media", true)},
			"Tmpfs": map[string]string{"/tmp": "rw,nosuid,nodev,mode=1777"},
			"Binds": []string{}, "VolumesFrom": []string{}, "Links": []string{}, "ExtraHosts": []string{},
			"DeviceCgroupRules": []string{}, "DeviceRequests": []any{}, "Sysctls": map[string]string{},
		}}
	if b.InstallerDirectory != "" {
		host := spec["HostConfig"].(map[string]any)
		host["Mounts"] = append(host["Mounts"].([]map[string]any), mount(b.InstallerDirectory, "/media/installer", true))
	}
	if provision {
		spec["Cmd"] = []string{"provision"}
		host := spec["HostConfig"].(map[string]any)
		host["NetworkMode"] = "none"
		host["Devices"] = []map[string]any{}
		host["GroupAdd"] = []string{}
		host["NanoCpus"] = int64(1000000000)
	}
	return spec, nil
}
