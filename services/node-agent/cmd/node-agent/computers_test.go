package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestComputerCompositionDisabledWithoutEffects(t *testing.T) {
	close, e := configureInstalledComputers("", "", 0, "", nil, nil, nil)
	if e != nil || close == nil {
		t.Fatal(e)
	}
	close()
	if _, e = configureInstalledComputers("/installed/computers.json", "", 1, "", nil, nil, nil); e == nil {
		t.Fatal("missing host sampler accepted")
	}
}
func TestComputerInstalledPolicyRetainsStableNodeAcrossReconnect(t *testing.T) {
	node := "a0000000-0000-4000-8000-000000000001"
	path := filepath.Join(t.TempDir(), "computers.json")
	base := map[string]any{"version": 1, "nodeId": node, "minimumNodeGeneration": 2, "poolId": "windows-pool", "dataRoot": "/srv/windows/volumes", "storageSocket": "/run/windows/storage.sock",
		"resources": map[string]any{"controlRoot": "/srv/windows/control", "profiles": []any{map[string]any{"profileId": "windows11-arm64"}}, "cpuGroups": [][]int{{0, 1}, {10, 11}}, "kvmGroup": 108, "memoryReserveBytes": 8 << 30, "provisionMemoryBytes": 512 << 20}}
	write := func() {
		raw, _ := json.Marshal(base)
		if e := os.WriteFile(path, raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	write()
	for _, generation := range []int64{2, 3, 42} {
		if c, e := installedComputerPolicy(path, node, generation); e != nil || c.NodeID != node {
			t.Fatal(e)
		}
	}
	if _, e := installedComputerPolicy(path, node, 1); e == nil {
		t.Fatal("old authority accepted")
	}
	if _, e := installedComputerPolicy(path, "another-node", 3); e == nil {
		t.Fatal("different node accepted")
	}
	base["dockerCommand"] = "arbitrary"
	write()
	if _, e := installedComputerPolicy(path, node, 3); e == nil {
		t.Fatal("unknown fields accepted")
	}
	delete(base, "dockerCommand")
	write()
	if e := os.Chmod(path, 0666); e != nil {
		t.Fatal(e)
	}
	if _, e := installedComputerPolicy(path, node, 3); e == nil {
		t.Fatal("writable configuration accepted")
	}
}
