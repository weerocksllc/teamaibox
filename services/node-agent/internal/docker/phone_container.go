package docker

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"teamaibox.local/node-agent/internal/agent"
)

const phoneSeccompSHA = "bde4d5209f24d3d3ed2126b9f608be96c2b37b71cea34971d237783d8ce38a09"

func phoneRuntimeEnvironment() []string {
	return []string{"PATH=/opt/cuttlefish/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"ANDROID_HOST_OUT=/opt/cuttlefish", "ANDROID_PRODUCT_OUT=/opt/cuttlefish", "HOME=/phone/home"}
}

var phoneExactContainerID = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Installed node configuration, never a member request. Storage/network drivers
// must verify these actual resources before using the generated Docker request.
// This builder does not claim that an arbitrary directory is an encrypted pool.
type PhoneContainerPolicy struct {
	NodeID                 string
	NodeGeneration         int64
	PoolID                 string
	ImageID                string
	AdditionalImageDigests []string
	RetiredImageDigests    []string
	// Optional compatibility range for old installed runtimes. New runtimes
	// allocate from the whole available port space; no product phone-count cap.
	InstanceLimitByImage map[string]int
	DataRoot             string
	ControlRoot          string
	KVMGroup             uint32
	VhostGroup           uint32
	Seccomp              []byte
	NetworkProfile       string
	MediaAddress         string
	// HostMediaStateFile is refreshed after host forwarding is applied. The
	// legacy address is retained only for verifying already-created containers.
	HostMediaStateFile string
	// ControlNetworkID is the exact, installation-owned Docker network shared
	// only by Node Agent and managed phones. Phone signalling uses this path;
	// the per-phone network remains the guest/media isolation boundary.
	ControlNetworkID string
	UsbCameraSocket  string
	// Filled from the Agent-owned run binding, never member input or the
	// installed node declaration. Zero keeps the legacy offline recipe.
	Instance int
}

func (p PhoneContainerPolicy) forBinding(b PhoneResourceBinding) PhoneContainerPolicy {
	p = p.forInstance(b.Instance)
	if b.NodeGeneration > 0 {
		p.NodeGeneration = b.NodeGeneration
	}
	return p
}

// Used only to verify retired records/containers before deletion, never start.
func (p PhoneContainerPolicy) forRetiredImage(image string) (PhoneContainerPolicy, error) {
	// A stopped run may belong to any currently installed ROM, not only the
	// default image. Retired ROMs remain cleanup-only; unknown images stay denied.
	if !agent.PhoneImageAllowed(p.ImageID, p.AdditionalImageDigests, image) && !slices.Contains(p.RetiredImageDigests, image) {
		return p, errors.New("phone_retired_image_unapproved")
	}
	p.ImageID = image
	return p, nil
}

func phoneContainerName(p agent.PhoneCommandPayload) string { return "teamaibox-phone-" + p.Run.ID }

func phoneContainerLabels(policy PhoneContainerPolicy, p agent.PhoneCommandPayload) map[string]string {
	labels := map[string]string{
		"com.teamaibox.managed": "true", "com.teamaibox.kind": "android-phone",
		"com.teamaibox.node-id": policy.NodeID, "com.teamaibox.node-generation": strconv.FormatInt(policy.NodeGeneration, 10),
		"com.teamaibox.phone-id": p.PhoneID, "com.teamaibox.owner-identity-id": p.OwnerID,
		"com.teamaibox.volume-id": p.VolumeID, "com.teamaibox.pool-id": p.PoolID,
		"com.teamaibox.phone-run-id": p.Run.ID, "com.teamaibox.phone-generation": strconv.FormatUint(p.Generation, 10),
		"com.teamaibox.reservation-id": p.Run.ReservationID, "com.teamaibox.base-build-id": p.BaseBuildID,
	}
	if policy.HostMediaStateFile != "" {
		labels["com.teamaibox.phone-media"] = "host-managed-v1"
	}
	return labels
}

func phonePrivateRoot(value string) bool {
	return filepath.IsAbs(value) && filepath.Clean(value) == value && value != "/" &&
		strings.Count(value, string(filepath.Separator)) >= 2 && !strings.ContainsAny(value, "\x00\n\r")
}

// A closed create recipe for the dedicated phone driver. It is deliberately
// separate from StartWorker: ordinary plugins still cannot request KVM/vsock.
// networkID names an already verified per-phone private network, with no raw
// operator/ADB port publication. Its guest egress policy is a separate live gate.
func buildPhoneContainer(policy PhoneContainerPolicy, p agent.PhoneCommandPayload, networkID string) (map[string]any, error) {
	bad := func() (map[string]any, error) { return nil, errors.New("phone_container_policy_invalid") }
	if p.Run == nil || !agent.PhoneImageAllowed(policy.ImageID, policy.AdditionalImageDigests, p.Run.ImageDigest) {
		return bad()
	}
	policy.ImageID = p.Run.ImageDigest
	digest := sha256.Sum256(policy.Seccomp)
	if !managedWorkerID.MatchString(policy.NodeID) || policy.NodeGeneration < 1 || !digestID.MatchString(policy.ImageID) ||
		!phonePrivateRoot(policy.DataRoot) || !phonePrivateRoot(policy.ControlRoot) || policy.DataRoot == policy.ControlRoot ||
		policy.KVMGroup == 0 || policy.VhostGroup == 0 || hex.EncodeToString(digest[:]) != phoneSeccompSHA ||
		!json.Valid(policy.Seccomp) || !phoneExactContainerID.MatchString(networkID) || p.Run == nil ||
		p.Run.ImageDigest != policy.ImageID || p.PoolID != policy.PoolID || p.BaseBuildID != agent.PhoneBaseBuild ||
		p.Generation < 1 || p.Generation > 9007199254740990 || p.Run.MemoryBytes != agent.PhoneMemoryBytes || p.Run.CPUMillis != agent.PhoneCPUMillis {
		return bad()
	}
	for _, value := range []string{p.PhoneID, p.OwnerID, p.VolumeID, p.OperationID, p.Run.ID, p.Run.ReservationID} {
		if !managedWorkerID.MatchString(value) {
			return bad()
		}
	}
	data := filepath.Join(policy.DataRoot, p.VolumeID, "phone")
	control := filepath.Join(policy.ControlRoot, p.Run.ID)
	mount := func(source, target string, readonly bool) map[string]any {
		return map[string]any{"Type": "bind", "Source": source, "Target": target, "ReadOnly": readonly,
			"BindOptions": map[string]any{"Propagation": "rprivate"}}
	}
	groups := []string{"1000", "1001", strconv.FormatUint(uint64(policy.KVMGroup), 10), strconv.FormatUint(uint64(policy.VhostGroup), 10)}
	config := map[string]any{
		"Image": policy.ImageID, "User": "10001:10001", "WorkingDir": "/phone",
		"Entrypoint": []string{"/usr/bin/python3", "/opt/teamaibox/phone_runtime.py"}, "Cmd": []string{"serve"},
		"Env": phoneRuntimeEnvironment(), "Labels": phoneContainerLabels(policy, p), "StopTimeout": 75,
		"HostConfig": map[string]any{
			"ReadonlyRootfs": true, "Privileged": false, "CapDrop": []string{"ALL"}, "CapAdd": []string{},
			"SecurityOpt": []string{"no-new-privileges", "seccomp=" + string(policy.Seccomp)},
			"NetworkMode": networkID, "IpcMode": "private", "PidMode": "", "Init": true,
			"Memory": agent.PhoneMemoryBytes, "MemorySwap": agent.PhoneMemoryBytes, "NanoCpus": int64(2_000_000_000),
			"PidsLimit": 1024, "ShmSize": int64(64 << 20), "GroupAdd": groups,
			"RestartPolicy": map[string]string{"Name": "no"}, "LogConfig": map[string]any{"Type": "none"},
			"Tmpfs":   map[string]string{"/tmp": "rw,nosuid,nodev,size=536870912,mode=1777"},
			"Ulimits": []map[string]any{{"Name": "core", "Soft": 0, "Hard": 0}, {"Name": "nofile", "Soft": 8192, "Hard": 8192}},
			"Mounts":  []map[string]any{mount(data, "/phone", false), mount(filepath.Join(control, "config.json"), "/run/phone/config.json", true), mount(filepath.Join(control, "certs"), "/run/phone/certs", true)},
			"Devices": []map[string]string{
				{"PathOnHost": "/dev/kvm", "PathInContainer": "/dev/kvm", "CgroupPermissions": "rw"},
				{"PathOnHost": "/dev/vhost-vsock", "PathInContainer": "/dev/vhost-vsock", "CgroupPermissions": "rw"}},
			"PortBindings": map[string]any{}, "DeviceRequests": []any{},
		},
	}
	if policy.ControlNetworkID != "" {
		config["Env"] = append(config["Env"].([]string), "TEAMAIBOX_PHONE_CONTROL_NETWORK=1")
	}
	if err := applyPhoneNetworkPolicy(config, policy); err != nil {
		return bad()
	}
	return config, nil
}
