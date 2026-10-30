package docker

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

func TestProtectedHealthWaitBoundUsesImmutableHealthContract(t *testing.T) {
	health := &agent.ContainerHealthCheck{
		Test:        []string{"CMD-SHELL", "test -r /proc/1/status"},
		Interval:    int64(10 * time.Second),
		Timeout:     int64(2 * time.Second),
		StartPeriod: int64(8 * time.Minute),
		Retries:     6,
	}
	if got, want := protectedHealthWaitBound(health), 9*time.Minute+42*time.Second; got != want {
		t.Fatalf("health-bound cold-start wait = %s, want %s", got, want)
	}
	if got := protectedHealthWaitBound(nil); got != protectedHealthWaitDefault {
		t.Fatalf("image-health fallback wait = %s, want %s", got, protectedHealthWaitDefault)
	}
	health.StartPeriod = int64(30 * time.Minute)
	health.Interval = int64(5 * time.Minute)
	health.Timeout = int64(5 * time.Minute)
	health.Retries = 30
	if got := protectedHealthWaitBound(health); got != protectedHealthWaitMaximum {
		t.Fatalf("cold-start wait was not capped: %s", got)
	}
}

func TestLegacyProtectedIdentityBindsActualRuntimeAndSeparatesImageIdentityClasses(t *testing.T) {
	configID := "sha256:" + strings.Repeat("a", 64)
	reference := "legacy.local/office:exact"
	raw, err := json.Marshal(map[string]any{
		"Id": "1" + strings.Repeat("0", 63), "Name": "/legacy-office-worker", "Image": configID,
		"Mounts": []map[string]any{{"Type": "volume", "Name": "legacy-office-model", "Source": "/var/lib/docker/volumes/legacy-office-model/_data", "Destination": "/model", "RW": false, "Propagation": ""}},
		"State":  map[string]any{"Status": "running", "Health": map[string]any{"Status": "healthy"}},
		"Config": map[string]any{
			"Image": reference, "User": "10001:10001", "Env": []string{"MODEL=/model"},
			"Cmd": []string{"serve"}, "Entrypoint": []string{"/entrypoint"},
			"Labels":      map[string]string{"legacy.teamaibox.slot": "embedding"},
			"Healthcheck": map[string]any{"Test": []string{"CMD-SHELL", "test -r /proc/1/status"}, "Interval": int64(10_000_000_000), "Timeout": int64(2_000_000_000), "StartPeriod": int64(30_000_000_000), "Retries": 3},
		},
		"HostConfig": map[string]any{
			"NetworkMode": "bridge", "IpcMode": "private", "PidMode": "", "ShmSize": int64(64 << 20),
			"ReadonlyRootfs": true, "Privileged": false, "CapDrop": []string{"ALL"},
			"SecurityOpt": []string{"no-new-privileges:true"}, "PidsLimit": int64(128),
			"Memory": int64(1 << 30), "MemorySwap": int64(1 << 30), "CpuPeriod": int64(100_000), "CpuQuota": int64(100_000),
			"Tmpfs": map[string]string{"/tmp": "rw,noexec"}, "Ulimits": []map[string]any{{"Name": "nofile", "Soft": int64(4096), "Hard": int64(4096)}},
			"RestartPolicy": map[string]string{"Name": "no"},
		},
		"NetworkSettings": map[string]any{"Networks": map[string]any{"bridge": map[string]string{"IPAddress": "172.17.0.2"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var document inspectDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	if got, want := legacyEnvironmentDigest(document), "sha256:727c6e64e6b64cb8c81d4e2165dba343eaf1ff92a4f2d779b3eb17509acd4b36"; got != want {
		t.Fatalf("legacy environment digest = %s, want %s", got, want)
	}
	if got, want := legacyCommandDigest(document), "sha256:060cc74915c00e668b008f9af2cd8572519148ef35bebe265b00fd2b3084845b"; got != want {
		t.Fatalf("legacy command digest = %s, want %s", got, want)
	}
	if got, want := legacyHealthcheckDigest(document), "sha256:1538cfe07355c7c33318e6444c0b8117d48eb9b703d45dfe9b9bfe36341a2a74"; got != want {
		t.Fatalf("legacy healthcheck digest = %s, want %s", got, want)
	}
	if got, want := legacyRuntimeDigest(document), "sha256:9db8cd861a80cc4bf999d403c01226d6102daa0bf3a5644d55bcf2dbca4f4578"; got != want {
		t.Fatalf("legacy runtime digest = %s, want %s", got, want)
	}
	expected := agent.LegacyContainerIdentity{
		ContainerName: "legacy-office-worker", ContainerID: document.ID,
		RequiredImageID: configID, RequiredImageReference: reference, RequiredNetworkMode: "bridge",
		RequiredRuntimeDigest:     legacyRuntimeDigest(document),
		RequiredMounts:            []agent.VolumeMount{{Type: "volume", Source: "legacy-office-model", Target: "/model", ReadOnly: true}},
		RequiredEnvironmentDigest: legacyEnvironmentDigest(document), RequiredCommandDigest: legacyCommandDigest(document),
		RequiredHealthcheckDigest: legacyHealthcheckDigest(document), RequiredLabels: map[string]string{"legacy.teamaibox.slot": "embedding"},
	}
	if !exactLegacyContainer(document, expected) {
		t.Fatal("exact legacy runtime was rejected")
	}
	emptyMountDocument := document
	emptyMountDocument.Mounts = nil
	emptyMountExpected := expected
	emptyMountExpected.RequiredMounts = nil
	emptyMountExpected.RequiredRuntimeDigest = legacyRuntimeDigest(emptyMountDocument)
	if normalizedDeclaredMounts(nil) == nil {
		t.Fatal("empty declared mounts were not normalized to a canonical empty array")
	}
	if !exactLegacyContainer(emptyMountDocument, emptyMountExpected) {
		t.Fatal("exact image-contained legacy runtime with zero mounts was rejected")
	}
	runningNetworkDigest := legacyRuntimeDigest(document)
	stoppedNetworkDocument := document
	stoppedNetworkDocument.State.Status = "exited"
	stoppedNetworkDocument.NetworkSettings.Networks = map[string]struct {
		IPAddress string `json:"IPAddress"`
	}{"bridge": {}}
	if got := legacyRuntimeDigest(stoppedNetworkDocument); got != runningNetworkDigest {
		t.Fatalf("stopping a legacy container changed its stable network identity: got %s, want %s", got, runningNetworkDigest)
	}
	if !exactLegacyContainer(stoppedNetworkDocument, expected) {
		t.Fatal("stopped legacy runtime was rejected only because its dynamic IP disappeared")
	}
	stoppedNetworkDocument.NetworkSettings.Networks["unexpected"] = struct {
		IPAddress string `json:"IPAddress"`
	}{}
	if legacyRuntimeDigest(stoppedNetworkDocument) == runningNetworkDigest || exactLegacyContainer(stoppedNetworkDocument, expected) {
		t.Fatal("legacy network membership drift was not bound by the stable runtime identity")
	}
	identityClassDrift := expected
	identityClassDrift.RequiredImageReference = configID
	if exactLegacyContainer(document, identityClassDrift) {
		t.Fatal("Docker config image ID was accepted as Config.Image reference")
	}
	before := legacyRuntimeDigest(document)
	document.HostConfig.IpcMode = "host"
	if before == legacyRuntimeDigest(document) || exactLegacyContainer(document, expected) {
		t.Fatal("actual runtime IPC drift was not bound by the legacy identity")
	}
}

func TestProtectedModelMaterialAllowsOnlyExplicitWritableOffloadScratch(t *testing.T) {
	flux := agent.WorkerStartPayload{Mounts: []agent.VolumeMount{
		{Type: "volume", Source: "model", Target: "/model", ReadOnly: true},
		{Type: "volume", Source: "runtime", Target: "/runtime", ReadOnly: true},
		{Type: "volume", Source: "auth", Target: "/run/secrets/auth", ReadOnly: true},
		{Type: "volume", Source: "offload", Target: "/offload", ReadOnly: false},
	}}
	if mode, valid := protectedModelMaterialMode(flux); !valid || mode != "read-only-mounts" {
		t.Fatalf("FLUX writable offload invalidated read-only model material: %q %v", mode, valid)
	}
	asr := agent.WorkerStartPayload{}
	if mode, valid := protectedModelMaterialMode(asr); !valid || mode != "image-contained" {
		t.Fatalf("image-contained ASR material was not represented exactly: %q %v", mode, valid)
	}
	drifted := flux
	drifted.Mounts = append([]agent.VolumeMount(nil), flux.Mounts...)
	drifted.Mounts[0].ReadOnly = false
	if mode, valid := protectedModelMaterialMode(drifted); valid || mode != "writable-model-material" {
		t.Fatalf("writable model material was accepted: %q %v", mode, valid)
	}
}
