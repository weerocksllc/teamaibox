package docker

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

func phoneRecipeFixture(t *testing.T) (PhoneContainerPolicy, agent.PhoneCommandPayload) {
	t.Helper()
	profile, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "android", "cuttlefish", "phone-seccomp.json"))
	if err != nil {
		t.Fatal(err)
	}
	policy := PhoneContainerPolicy{NodeID: "10000000-0000-4000-8000-000000000001", NodeGeneration: 2,
		PoolID: "phone.data", ImageID: "sha256:" + strings.Repeat("a", 64), DataRoot: "/srv/phone-data", ControlRoot: "/run/phone-control",
		KVMGroup: 108, VhostGroup: 108, Seccomp: profile}
	p := agent.PhoneCommandPayload{PhoneIdentity: agent.PhoneIdentity{PhoneID: "20000000-0000-4000-8000-000000000001",
		OwnerID: "30000000-0000-4000-8000-000000000001", VolumeID: "40000000-0000-4000-8000-000000000001",
		PoolID: policy.PoolID, BaseBuildID: agent.PhoneBaseBuild}, OperationID: "50000000-0000-4000-8000-000000000001", Generation: 1,
		Run: &agent.PhoneRunIdentity{ID: "60000000-0000-4000-8000-000000000001", ReservationID: "70000000-0000-4000-8000-000000000001",
			ImageDigest: policy.ImageID, MemoryBytes: agent.PhoneMemoryBytes, CPUMillis: agent.PhoneCPUMillis}}
	return policy, p
}

func TestPhoneRecipeNeverUsesGenericWorkerDevicePolicy(t *testing.T) {
	policy, p := phoneRecipeFixture(t)
	config, err := buildPhoneContainer(policy, p, strings.Repeat("b", 64))
	if err != nil {
		t.Fatal(err)
	}
	host := config["HostConfig"].(map[string]any)
	if config["User"] != "10001:10001" || host["ReadonlyRootfs"] != true || host["Privileged"] != false ||
		host["Memory"] != agent.PhoneMemoryBytes || host["MemorySwap"] != agent.PhoneMemoryBytes ||
		host["NanoCpus"] != int64(2_000_000_000) || len(host["DeviceRequests"].([]any)) != 0 || len(host["PortBindings"].(map[string]any)) != 0 {
		t.Fatalf("phone recipe widened access: %#v", config)
	}
	devices := host["Devices"].([]map[string]string)
	if len(devices) != 2 || devices[0]["PathOnHost"] != "/dev/kvm" || devices[1]["PathOnHost"] != "/dev/vhost-vsock" {
		t.Fatal(devices)
	}
	mounts := host["Mounts"].([]map[string]any)
	if len(mounts) != 3 || mounts[0]["Source"] != "/srv/phone-data/"+p.VolumeID+"/phone" || mounts[0]["ReadOnly"] != false ||
		mounts[1]["Source"] != "/run/phone-control/"+p.Run.ID+"/config.json" || mounts[1]["ReadOnly"] != true || mounts[2]["ReadOnly"] != true {
		t.Fatal("phone mount mismatch")
	}
	labels := config["Labels"].(map[string]string)
	if labels["com.teamaibox.phone-run-id"] != p.Run.ID || labels["com.teamaibox.owner-identity-id"] != p.OwnerID ||
		labels["com.teamaibox.reservation-id"] != p.Run.ReservationID {
		t.Fatal(labels)
	}
	encoded, _ := json.Marshal(config)
	if strings.Contains(string(encoded), "docker.sock") || strings.Contains(string(encoded), "nvidia") {
		t.Fatal("unrelated device access")
	}
}

func TestPhoneRecipeRejectsUnboundRuntimeAndPaths(t *testing.T) {
	for _, name := range []string{"relative", "root", "traversal", "same-root", "bad-device-group", "changed-seccomp", "wrong-image", "wrong-node", "foreign-pool", "host-network", "bad-volume", "no-run", "no-reservation", "wrong-memory", "old-generation"} {
		t.Run(name, func(t *testing.T) {
			policy, p := phoneRecipeFixture(t)
			network := strings.Repeat("b", 64)
			switch name {
			case "relative":
				policy.DataRoot = "phone-data"
			case "root":
				policy.DataRoot = "/"
			case "traversal":
				policy.DataRoot = "/srv/../etc"
			case "same-root":
				policy.ControlRoot = policy.DataRoot
			case "bad-device-group":
				policy.KVMGroup = 0
			case "changed-seccomp":
				policy.Seccomp = []byte(`{"defaultAction":"SCMP_ACT_ALLOW"}`)
			case "wrong-image":
				p.Run.ImageDigest = "sha256:" + strings.Repeat("c", 64)
			case "wrong-node":
				policy.NodeID = "10.64.0.19"
			case "foreign-pool":
				p.PoolID = "other.data"
			case "host-network":
				network = "host"
			case "bad-volume":
				p.VolumeID = "../../other"
			case "no-run":
				p.Run = nil
			case "no-reservation":
				p.Run.ReservationID = ""
			case "wrong-memory":
				p.Run.MemoryBytes = 12 << 30
			case "old-generation":
				p.Generation = 0
			}
			if _, err := buildPhoneContainer(policy, p, network); err == nil {
				t.Fatal("unsafe recipe accepted")
			}
		})
	}
}

func TestPhoneRecipeUsesOnlyTheRequestedInstalledROM(t *testing.T) {
	policy, p := phoneRecipeFixture(t)
	google := "sha256:" + strings.Repeat("c", 64)
	policy.AdditionalImageDigests = []string{google}
	p.Run.ImageDigest = google
	config, err := buildPhoneContainer(policy, p, strings.Repeat("b", 64))
	if err != nil || config["Image"] != google {
		t.Fatalf("requested installed ROM not selected: %v, %v", config["Image"], err)
	}
	host := config["HostConfig"].(map[string]any)
	if host["Memory"] != agent.PhoneMemoryBytes || host["MemorySwap"] != agent.PhoneMemoryBytes || host["Privileged"] != false {
		t.Fatal("additional ROM widened resource or privilege limits")
	}
	if policy.ImageID == google {
		t.Fatal("selection changed the default policy")
	}
	p.Run.ImageDigest = "sha256:" + strings.Repeat("d", 64)
	if _, err := buildPhoneContainer(policy, p, strings.Repeat("b", 64)); err == nil {
		t.Fatal("uninstalled ROM accepted")
	}
}
