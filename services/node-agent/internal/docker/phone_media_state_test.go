package docker

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAppliedPhoneMediaFollowsCurrentHostState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "media.json")
	p := PhoneContainerPolicy{NodeID: "node", PoolID: "pool", MediaAddress: "10.64.0.20", HostMediaStateFile: path}
	var c phoneEngineState
	c.ID = "container"
	c.State.StartedAt = "boot"
	run := map[string]any{"containerId": c.ID, "startedAt": "boot", "containerAddress": "172.21.0.3", "address": "10.64.0.10", "firstPort": 20200, "lastPort": 20249}
	state := map[string]any{"version": 1, "nodeId": "node", "poolId": "pool", "status": "ready", "updatedAt": time.Now().Unix(), "runs": map[string]any{"run": run}}
	write := func() {
		raw, _ := json.Marshal(state)
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	for _, address := range []string{"10.64.0.10", "10.23.45.67"} {
		run["address"] = address
		write()
		got, err := appliedPhoneMediaAddress(p, c, "run", "172.21.0.3", 20200)
		if err != nil || got != address {
			t.Fatalf("current mapping: %s %v", got, err)
		}
	}
	for _, field := range []string{"nodeId", "poolId", "status", "updatedAt"} {
		old := state[field]
		state[field] = "wrong"
		write()
		if got, err := appliedPhoneMediaAddress(p, c, "run", "172.21.0.3", 20200); err == nil || got != "" {
			t.Fatal("invalid host state accepted", field)
		}
		state[field] = old
	}
	for _, field := range []string{"containerId", "startedAt", "containerAddress", "address", "firstPort", "lastPort"} {
		old := run[field]
		run[field] = "wrong"
		write()
		if _, err := appliedPhoneMediaAddress(p, c, "run", "172.21.0.3", 20200); err == nil {
			t.Fatal("invalid run accepted", field)
		}
		run[field] = old
	}
	state["updatedAt"] = time.Now().Unix() - 61
	write()
	if _, err := appliedPhoneMediaAddress(p, c, "run", "172.21.0.3", 20200); err == nil {
		t.Fatal("stale address accepted")
	}
	state["updatedAt"] = time.Now().Unix()
	state["status"] = "waiting_for_network"
	write()
	if _, err := appliedPhoneMediaAddress(p, c, "run", "172.21.0.3", 20200); err == nil || err.Error() != "phone_media_network_unavailable" {
		t.Fatal(err)
	}
}
