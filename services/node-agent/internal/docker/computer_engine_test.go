package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

func computerFixture(t *testing.T) (agent.ComputerCommand, ComputerContainerBinding, phoneEngineState) {
	t.Helper()
	id := func(n string) string { return "11111111-1111-4111-8111-11111111111" + n }
	tpm := id("6")
	p := agent.ComputerCommand{ComputerIdentity: agent.ComputerIdentity{ComputerID: id("1"), OwnerID: id("2"), NodeID: id("3"), VolumeID: id("4"), FirmwareID: id("5"), TPMID: &tpm, OperationID: id("7"), Generation: 1},
		PoolID: "windows-pool", ProfileID: "windows11-arm64", RuntimeImage: "sha256:" + strings.Repeat("a", 64), Resources: agent.ComputerResources{VCPUs: 4, MemoryBytes: 8 << 30, DiskBytes: 128 << 30}}
	p.Run = &agent.ComputerRun{ID: id("8"), Generation: 1, RuntimeImage: p.RuntimeImage}
	b := ComputerContainerBinding{GuestDirectory: "/srv/windows/guest", ControlDirectory: "/srv/windows/control", ConfigDirectory: "/srv/windows/config",
		FirmwareDirectory: "/srv/windows/firmware", MediaDirectory: "/srv/windows/media", NetworkID: strings.Repeat("b", 64), CPUIds: []int{0, 1, 2, 3}, MemoryBytes: 10 << 30, KVMGroup: 108, ShutdownSeconds: 120}
	spec, err := buildComputerContainer(p, b)
	if err != nil {
		t.Fatal(err)
	}
	config := phoneNormalized(spec).(map[string]any)
	s := phoneEngineState{ID: strings.Repeat("c", 64), Image: p.RuntimeImage, Config: config, HostConfig: config["HostConfig"].(map[string]any)}
	raw := `{"Networks":{"private":{"NetworkID":"` + b.NetworkID + `","IPAddress":"172.31.0.2"}}}`
	if err = json.Unmarshal([]byte(raw), &s.NetworkSettings); err != nil {
		t.Fatal(err)
	}
	s.State.Status = "created"
	return p, b, s
}

func TestComputerContainerUsesSelectedResourcesAndNoHostManagementPorts(t *testing.T) {
	p, b, s := computerFixture(t)
	if !exactComputerContainer(s, p, b) {
		t.Fatal("valid fixture rejected")
	}
	p.Resources.VCPUs = 6
	p.Resources.MemoryBytes = 24 << 30
	p.Resources.DiskBytes = 512 << 30
	b.CPUIds = []int{10, 11, 12, 13, 14, 15}
	b.MemoryBytes = 27 << 30
	spec, err := buildComputerContainer(p, b)
	if err != nil {
		t.Fatal(err)
	}
	h := spec["HostConfig"].(map[string]any)
	if h["Memory"] != int64(27<<30) || h["MemorySwap"] != h["Memory"] || h["CpusetCpus"] != "10,11,12,13,14,15" || len(h["PortBindings"].(map[string]any)) != 0 {
		t.Fatal("wrong allocation")
	}
	if h["RestartPolicy"].(map[string]any)["Name"] != "no" {
		t.Fatal("uncontrolled restart")
	}
	for _, change := range []func(*ComputerContainerBinding){
		func(b *ComputerContainerBinding) { b.CPUIds = []int{1, 1, 2, 3, 4, 5} },
		func(b *ComputerContainerBinding) { b.ControlDirectory = b.GuestDirectory + "/nested" },
		func(b *ComputerContainerBinding) { b.MediaDirectory = "/" },
		func(b *ComputerContainerBinding) { b.MemoryBytes = p.Resources.MemoryBytes },
	} {
		bad := b
		change(&bad)
		if _, err = buildComputerContainer(p, bad); err == nil {
			t.Fatal("invalid binding accepted")
		}
	}
}

func TestComputerInspectionRejectsChangedIdentityOrExpandedHostAccess(t *testing.T) {
	for _, key := range []string{"owner", "disk", "image", "run", "swap", "privileged", "port", "device", "bind", "network", "extra-network", "command"} {
		t.Run(key, func(t *testing.T) {
			p, b, s := computerFixture(t)
			switch key {
			case "owner":
				s.Config["Labels"].(map[string]any)["com.teamaibox.owner-identity-id"] = "other"
			case "disk":
				s.HostConfig["Mounts"].([]any)[0].(map[string]any)["Source"] = "/srv/other/guest"
			case "image":
				s.Image = "sha256:" + strings.Repeat("d", 64)
			case "run":
				v := strings.Repeat("d", 64)
				p.Run.ContainerID = &v
			case "swap":
				s.HostConfig["MemorySwap"] = float64(32 << 30)
			case "privileged":
				s.HostConfig["Privileged"] = true
			case "port":
				s.HostConfig["PortBindings"] = map[string]any{"5900/tcp": []any{map[string]any{"HostPort": "5900"}}}
			case "device":
				s.HostConfig["Devices"] = append(s.HostConfig["Devices"].([]any), map[string]any{"PathOnHost": "/dev/sda"})
			case "bind":
				s.HostConfig["Binds"] = []any{"/var/run/docker.sock:/var/run/docker.sock"}
			case "network":
				s.HostConfig["NetworkMode"] = "host"
			case "extra-network":
				s.NetworkSettings.Networks["other"] = s.NetworkSettings.Networks["private"]
			case "command":
				s.Config["Cmd"] = []any{"sh"}
			}
			if exactComputerContainer(s, p, b) {
				t.Fatal("container drift accepted")
			}
		})
	}
}

func TestComputerCreatedRunStartsOnceAndExitedRunIsNeverRevived(t *testing.T) {
	p, b, s := computerFixture(t)
	starts := 0
	engine := &EngineRuntime{baseURL: "http://docker/v1.48", client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodGet {
			raw, _ := json.Marshal(s)
			return response(http.StatusOK, string(raw)), nil
		}
		if strings.HasSuffix(r.URL.Path, "/start") {
			starts++
			s.State.Status = "running"
			s.State.Running = true
			return response(http.StatusNoContent, ""), nil
		}
		t.Fatalf("unexpected %s", r.URL.Path)
		return nil, nil
	})}}
	for i := 0; i < 2; i++ {
		if _, err := engine.startComputerContainer(context.Background(), p, b); err != nil {
			t.Fatal(err)
		}
	}
	if starts != 1 {
		t.Fatal("duplicate start")
	}
	s.State.Running = false
	s.State.Status = "exited"
	if _, err := engine.startComputerContainer(context.Background(), p, b); err == nil || starts != 1 {
		t.Fatal("exited run revived")
	}
}

func TestComputerUncertainInspectionAndMissingRecordedContainerNeverCreate(t *testing.T) {
	for _, code := range []int{http.StatusServiceUnavailable, http.StatusNotFound} {
		p, b, s := computerFixture(t)
		if code == http.StatusNotFound {
			p.Run.ContainerID = &s.ID
		}
		engine := &EngineRuntime{baseURL: "http://docker/v1.48", client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if r.Method != http.MethodGet || strings.Contains(r.URL.Path, "/images/") {
				t.Fatal("unexpected effect after missing/uncertain existing run")
			}
			return response(code, ""), nil
		})}}
		if _, err := engine.startComputerContainer(context.Background(), p, b); err == nil {
			t.Fatal("accepted unavailable runtime")
		}
	}
}

func TestComputerNewRunImageCheckedAndLostCreateReplyIsReconciled(t *testing.T) {
	p, b, s := computerFixture(t)
	created := false
	creates, starts := 0, 0
	engine := &EngineRuntime{baseURL: "http://docker/v1.48", client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(r.URL.Path, "/images/"):
			return response(http.StatusOK, `{"Id":"`+p.RuntimeImage+`","Architecture":"arm64"}`), nil
		case strings.HasSuffix(r.URL.Path, "/containers/create"):
			creates++
			created = true
			return response(http.StatusServiceUnavailable, ""), nil // Docker created it, reply was lost.
		case r.Method == http.MethodGet:
			if !created {
				return response(http.StatusNotFound, ""), nil
			}
			raw, _ := json.Marshal(s)
			return response(http.StatusOK, string(raw)), nil
		case strings.HasSuffix(r.URL.Path, "/start"):
			starts++
			s.State.Status = "running"
			s.State.Running = true
			return response(http.StatusNoContent, ""), nil
		default:
			t.Fatal("unexpected Docker request")
			return nil, nil
		}
	})}}
	if _, err := engine.startComputerContainer(context.Background(), p, b); err == nil {
		t.Fatal("lost create response accepted")
	}
	if _, err := engine.startComputerContainer(context.Background(), p, b); err != nil {
		t.Fatal(err)
	}
	if creates != 1 || starts != 1 {
		t.Fatal("duplicate runtime on retry")
	}
}
