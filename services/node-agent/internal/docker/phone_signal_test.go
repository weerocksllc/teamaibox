package docker

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

func TestPhoneSignalResolvesOnlyExactPrivateRun(t *testing.T) {
	for _, scenario := range []string{"exact", "exact_control", "missing_control", "foreign_control", "three_networks", "stopped", "public_ip", "foreign_network", "two_networks", "foreign_owner", "foreign_image", "duplicate_key", "extra_key", "wrong_version", "config_symlink", "run_symlink", "certs_symlink", "oversized_certificate"} {
		t.Run(scenario, func(t *testing.T) {
			d, r, state, p := phoneDriverFixture(t)
			d.policy.ControlRoot = t.TempDir()
			controlID := strings.Repeat("d", 64)
			if strings.Contains(scenario, "control") || scenario == "three_networks" {
				d.policy.ControlNetworkID = controlID
			}
			// Match the exact Docker mount declaration after changing the test root.
			recipe, err := buildPhoneContainer(d.policy, p, r.binding.NetworkID)
			if err != nil {
				t.Fatal(err)
			}
			state.HostConfig = phoneNormalized(recipe["HostConfig"]).(map[string]any)
			state.Config = phoneNormalized(map[string]any{
				"Image": recipe["Image"], "User": recipe["User"], "WorkingDir": recipe["WorkingDir"],
				"Entrypoint": recipe["Entrypoint"], "Cmd": recipe["Cmd"], "Env": recipe["Env"], "Labels": recipe["Labels"],
				"StopTimeout": recipe["StopTimeout"],
			}).(map[string]any)
			network := struct {
				NetworkID string `json:"NetworkID"`
				IPAddress string `json:"IPAddress"`
			}{r.binding.NetworkID, "172.28.40.2"}
			state.NetworkSettings.Networks = map[string]struct {
				NetworkID string `json:"NetworkID"`
				IPAddress string `json:"IPAddress"`
			}{"phone": network}
			if d.policy.ControlNetworkID != "" && scenario != "missing_control" {
				state.NetworkSettings.Networks["control"] = struct {
					NetworkID string `json:"NetworkID"`
					IPAddress string `json:"IPAddress"`
				}{controlID, "10.252.120.2"}
			}
			directory := filepath.Join(d.policy.ControlRoot, p.Run.ID)
			if err := os.MkdirAll(filepath.Join(directory, "certs"), 0700); err != nil {
				t.Fatal(err)
			}
			config := map[string]any{"version": 1, "phoneId": p.PhoneID, "ownerId": p.OwnerID, "volumeId": p.VolumeID, "runId": p.Run.ID, "generation": p.Generation, "instance": 21, "buildId": p.BaseBuildID}
			switch scenario {
			case "stopped":
				state.State.Running = false
			case "public_ip":
				network.IPAddress = "8.8.8.8"
				state.NetworkSettings.Networks["phone"] = network
			case "foreign_network":
				network.NetworkID = strings.Repeat("c", 64)
				state.NetworkSettings.Networks["phone"] = network
			case "two_networks":
				state.NetworkSettings.Networks["other"] = network
			case "foreign_control":
				value := state.NetworkSettings.Networks["control"]
				value.NetworkID = strings.Repeat("e", 64)
				state.NetworkSettings.Networks["control"] = value
			case "three_networks":
				state.NetworkSettings.Networks["other"] = network
			case "foreign_owner":
				config["ownerId"] = p.PhoneID
			case "foreign_image":
				state.Image = "sha256:" + strings.Repeat("c", 64)
			case "extra_key":
				config["url"] = "https://other.test"
			case "wrong_version":
				config["version"] = 2
			}
			raw, _ := json.Marshal(config)
			if scenario == "duplicate_key" {
				raw = append([]byte(`{"version":1,`), raw[1:]...)
			}
			if err := os.WriteFile(filepath.Join(directory, "config.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}
			certificate := []byte("synthetic public certificate; parsed/pinned by the proxy test")
			if scenario == "oversized_certificate" {
				certificate = make([]byte, 8193)
			}
			if err := os.WriteFile(filepath.Join(directory, "certs", "server.crt"), certificate, 0600); err != nil {
				t.Fatal(err)
			}
			// Only rename fresh fixture paths, never a real run directory.
			for _, item := range []struct{ scenario, path string }{{"run_symlink", directory}, {"certs_symlink", filepath.Join(directory, "certs")}, {"config_symlink", filepath.Join(directory, "config.json")}} {
				if scenario != item.scenario {
					continue
				}
				if err := os.Rename(item.path, item.path+"-saved"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(item.path+"-saved", item.path); err != nil {
					t.Fatal(err)
				}
			}
			endpoint, err := d.PhoneSignalEndpoint(context.Background(), agent.PhoneMediaPayload{PhoneCommandPayload: p})
			if scenario == "exact" || scenario == "exact_control" {
				expectedHost := "172.28.40.2"
				if scenario == "exact_control" {
					expectedHost = "10.252.120.2"
				}
				if err != nil || endpoint.Host != expectedHost || endpoint.Port != 8463 || endpoint.ServerName != "127.0.0.1" || string(endpoint.Certificate) != string(certificate) {
					t.Fatalf("%+v %v", endpoint, err)
				}
			} else if err == nil {
				t.Fatal("unsafe signal target accepted")
			}
		})
	}
}
