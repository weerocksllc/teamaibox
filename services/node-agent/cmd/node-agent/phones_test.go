package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPhoneCompositionDisabledWithoutStartingAnything(t *testing.T) {
	close, err := configureInstalledPhones("", "", 0, "", nil, nil, nil)
	if err != nil || close == nil {
		t.Fatal("disabled configuration needs a runtime", err)
	}
	close()
	if _, err = configureInstalledPhones("/run/phones.json", "", 0, "", nil, nil, nil); err == nil {
		t.Fatal("missing memory guard accepted")
	}
}

func TestPhoneInstalledConfigurationIdentityAndClosedShape(t *testing.T) {
	node := "a0000000-0000-4000-8000-000000000001"
	dir := t.TempDir()
	seccomp := filepath.Join(dir, "seccomp.json")
	if err := os.WriteFile(seccomp, []byte(`{"defaultAction":"SCMP_ACT_ERRNO"}`), 0600); err != nil {
		t.Fatal(err)
	}
	base := map[string]any{"version": 1, "nodeId": node, "nodeGeneration": 2, "poolId": "phones.luks", "imageId": "sha256:" + strings.Repeat("b", 64),
		"dataRoot": "/srv/phones/volumes", "controlRoot": "/srv/phones/control", "storageSocket": "/run/phone-storage/storage.sock",
		"kvmGroup": 994, "vhostGroup": 994, "seccompFile": seccomp}
	path := filepath.Join(dir, "phones.json")
	write := func(value any) {
		raw, _ := json.Marshal(value)
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(base)
	config, policy, err := installedPhonePolicy(path, node, 2)
	if err != nil || config.PoolID != "phones.luks" || policy.KVMGroup != 994 || string(policy.Seccomp) != `{"defaultAction":"SCMP_ACT_ERRNO"}` {
		t.Fatal("config decode", err)
	}
	if _, policy, err = installedPhonePolicy(path, node, 3); err != nil || policy.NodeGeneration != 3 {
		t.Fatal("authenticated successor generation not applied", err)
	}
	if _, _, err = installedPhonePolicy(path, node, 1); err == nil {
		t.Fatal("generation rollback accepted")
	}
	base["controlNetworkId"] = strings.Repeat("c", 64)
	write(base)
	if _, policy, err = installedPhonePolicy(path, node, 3); err != nil || policy.ControlNetworkID != strings.Repeat("c", 64) {
		t.Fatal("installed control network not propagated", err)
	}
	base["controlNetworkId"] = "phone-control"
	write(base)
	if _, _, err = installedPhonePolicy(path, node, 3); err == nil {
		t.Fatal("unresolved control network accepted")
	}
	delete(base, "controlNetworkId")
	if _, _, err = installedPhonePolicy(path, "a0000000-0000-4000-8000-000000000002", 3); err == nil {
		t.Fatal("different node accepted")
	}
	oldImage := "sha256:" + strings.Repeat("a", 64)
	base["retiredImageDigests"] = []string{oldImage}
	write(base)
	if _, p, err := installedPhonePolicy(path, node, 3); err != nil || len(p.RetiredImageDigests) != 1 || p.RetiredImageDigests[0] != oldImage {
		t.Fatal("installed compatibility not propagated", err)
	}
	base["retiredImageDigests"] = []string{oldImage, oldImage}
	write(base)
	if _, _, err := installedPhonePolicy(path, node, 3); err == nil {
		t.Fatal("duplicate retired images accepted")
	}
	delete(base, "retiredImageDigests")
	base["arbitraryDockerFlags"] = []string{"--privileged"}
	write(base)
	if _, _, err = installedPhonePolicy(path, node, 2); err == nil {
		t.Fatal("unrecognised field")
	}
	delete(base, "arbitraryDockerFlags")
	write(base)
	if err = os.Chmod(path, 0666); err != nil {
		t.Fatal(err)
	}
	if _, _, err = installedPhonePolicy(path, node, 2); err == nil {
		t.Fatal("writable configuration")
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(seccomp, path); err != nil {
		t.Fatal(err)
	}
	if _, _, err = installedPhonePolicy(path, node, 2); err == nil {
		t.Fatal("symlink configuration")
	}
}
