package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

func migrationPolicyFixture(t *testing.T) (Policy, LegacyProtectedSetMigrationPolicy, []WorkerStartPayload) {
	t.Helper()
	policy := DefaultPolicy()
	policy.AllowedPublishedPorts[19103] = true
	workers := make([]WorkerStartPayload, 0, 6)
	targets := make([]ExclusiveDrainTarget, 0, 6)
	migrations := make([]LegacyProtectedSetMigrationTarget, 0, 6)
	targetKeys := []string{
		"office.embedding-qwen3", "office.asr-whisper", "office.ocr-hunyuan",
		"office.translation-lmt4", "office.assistant-qwen38", "office.drawing-flux2",
	}
	for index := 0; index < 6; index++ {
		suffix := string(rune('a' + index))
		workerID := "00000000-0000-4000-8000-00000000009" + string(rune('1'+index))
		profileID := "00000000-0000-4000-8000-00000000008" + string(rune('1'+index))
		attemptID := "00000000-0000-4000-8000-00000000007" + string(rune('1'+index))
		spec := validStart()
		spec.WorkerID, spec.ModelProfileID, spec.AttemptID = workerID, profileID, attemptID
		spec.Image = "registry.local/office-" + suffix + "@sha256:" + strings.Repeat(suffix, 64)
		spec.ConfigDigest = "sha256:" + strings.Repeat(string(rune('1'+index)), 64)
		spec.PlacementClass, spec.MaintenanceGeneration = PlacementProtectedResident, 3
		spec.Mounts = []VolumeMount{{Type: "volume", Source: "teamaibox-worker-model-" + suffix, Target: "/var/lib/teamaibox/worker/model", ReadOnly: true}}
		spec.HealthCheck = &ContainerHealthCheck{Test: []string{"CMD-SHELL", "test -r /proc/1/status"}, Interval: 10_000_000_000, Timeout: 2_000_000_000, StartPeriod: 30_000_000_000, Retries: 3}
		target := ExclusiveDrainTarget{
			TargetKey: targetKeys[index], WorkerID: workerID, ModelProfileID: profileID,
			ContainerName: "teamaibox-worker-" + workerID, PlacementClass: PlacementProtectedResident,
			MaintenanceGeneration: 3, StageOrder: index + 1, RequiredImageID: "sha256:" + strings.Repeat(string(rune('a'+index)), 64),
			RequiredImageDigest: spec.Image, RequiredConfigDigest: spec.ConfigDigest,
			RequiredStartSpecDigest: WorkerStartSpecDigest(spec), RequiredLabels: map[string]string{"com.teamaibox.office-slot": suffix},
		}
		legacyPrimary := LegacyContainerIdentity{
			ContainerName: "legacy-office-" + suffix, ContainerID: strings.Repeat(string(rune('1'+index)), 64),
			RequiredImageID: "sha256:" + strings.Repeat(string(rune('a'+index)), 64), RequiredImageReference: "legacy/office:" + suffix,
			RequiredNetworkMode: "bridge", RequiredRuntimeDigest: "sha256:" + strings.Repeat("b", 63) + suffix,
			RequiredMounts:            []VolumeMount{{Type: "volume", Source: "legacy-office-volume-" + suffix, Target: "/model", ReadOnly: true}},
			RequiredEnvironmentDigest: "sha256:" + strings.Repeat("c", 63) + suffix,
			RequiredCommandDigest:     "sha256:" + strings.Repeat("d", 63) + suffix,
			RequiredHealthcheckDigest: "sha256:" + strings.Repeat("e", 63) + suffix,
			RequiredLabels:            map[string]string{"legacy.office.slot": suffix},
		}
		migration := LegacyProtectedSetMigrationTarget{TargetKey: target.TargetKey, DesiredWorkerID: workerID,
			DesiredStartSpecDigest: target.RequiredStartSpecDigest, LegacyPreviousTarget: LegacyProtectedTransitionTarget{Primary: legacyPrimary}}
		if index == 2 {
			legacyProvider := LegacyContainerIdentity{
				ContainerName: "legacy-ocr-provider", ContainerID: strings.Repeat("f", 64),
				RequiredImageID: "sha256:" + strings.Repeat("f", 64), RequiredImageReference: "legacy/ocr-provider:exact",
				RequiredNetworkMode: "container:" + legacyPrimary.ContainerID, RequiredRuntimeDigest: "sha256:" + strings.Repeat("1", 64),
				RequiredMounts:            []VolumeMount{{Type: "bind", Source: "/var/lib/teamaibox-provider-runtime/ocr/tls", Target: "/run/tls", ReadOnly: true}},
				RequiredEnvironmentDigest: "sha256:" + strings.Repeat("2", 64), RequiredCommandDigest: "sha256:" + strings.Repeat("3", 64),
				RequiredHealthcheckDigest: "sha256:" + strings.Repeat("4", 64), RequiredLabels: map[string]string{"legacy.office.companion": "ocr"},
			}
			companion := ProtectedCompanionStartPayload{
				ContainerName: "teamaibox-ocr-provider-canonical", ParentWorkerID: workerID,
				Image: "registry.local/ocr-provider@sha256:" + strings.Repeat("f", 64), RequiredImageID: "sha256:" + strings.Repeat("f", 64),
				ConfigDigest: "sha256:" + strings.Repeat("5", 64), Network: "compute-internal",
				Limits:         ResourceLimits{MemoryBytes: 128 << 20, CPUQuotaMicros: 50_000, PidsLimit: 64, EphemeralBytes: 64 << 20, OpenFilesLimit: 1024},
				Security:       SecurityProfile{RunAsUID: 10001, RunAsGID: 10001, ReadOnlyRoot: true, DropAllCaps: true, NoNewPrivileges: true},
				Mounts:         []VolumeMount{{Type: "bind", Source: "/var/lib/teamaibox-provider-runtime/ocr/tls", Target: "/run/tls", ReadOnly: true}},
				PublishedPorts: []PublishedPort{{ContainerPort: 19095, HostPort: 19103, HostIP: "10.64.0.20"}},
				Environment:    map[string]string{"TEAMAIBOX_OCR_UPSTREAM": "http://teamaibox-worker-" + workerID + ":19095"},
				Command:        []string{"serve"}, HealthCheck: &ContainerHealthCheck{Test: []string{"CMD-SHELL", "test -r /proc/1/status"}, Interval: 10_000_000_000, Timeout: 2_000_000_000, StartPeriod: 5_000_000_000, Retries: 3},
				RequiredLabels: map[string]string{"com.teamaibox.office-companion": "ocr"},
			}
			migration.LegacyPreviousTarget.DependentContainers = []LegacyContainerIdentity{legacyProvider}
			migration.DesiredCompanions = []ProtectedCompanionStartPayload{companion}
			target.DependentContainers = []ExclusiveDependentContainer{{ContainerName: companion.ContainerName, RequiredImageID: companion.RequiredImageID,
				RequiredImageDigest: companion.Image, RequiredConfigDigest: companion.ConfigDigest, RequiredLabels: companion.RequiredLabels}}
		}
		workers = append(workers, spec)
		targets = append(targets, target)
		migrations = append(migrations, migration)
		policy.ExclusiveDrainTargets[target.TargetKey] = target
	}
	legacySet := make([]LegacyProtectedTransitionTarget, 0, 6)
	for _, migration := range migrations {
		legacySet = append(legacySet, migration.LegacyPreviousTarget)
	}
	plan := LegacyProtectedSetMigrationPolicy{SchemaVersion: 1, NodeID: nodeID, NodeGeneration: nodeGeneration,
		PlanID: "legacy-office-v1", SetID: "office.baseline", SourceSetDigest: canonicalPolicyDigest(legacySet),
		DesiredSetDigest: canonicalPolicyDigest(targets),
		FaultInjection: ProtectedSetTransitionFaultInjection{StageOrder: 4, TargetKey: "office.translation-lmt4",
			InjectionPoint: "after-stage-health", FailureCode: "protected_set_transition_stage_failed", OneShot: true},
		Targets: migrations}
	return policy, plan, workers
}

func writeMigrationPlan(t *testing.T, plan LegacyProtectedSetMigrationPolicy) (string, string) {
	t.Helper()
	raw, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "migration.json")
	if err := os.WriteFile(filename, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return filename, fileDigest(raw)
}

func loadMigrationPlanForTest(filename, digest string, policy Policy) (*LegacyProtectedSetMigrationPolicy, error) {
	raw, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	return decodeLegacyProtectedSetMigrationPolicy(raw, digest, policy)
}

func TestProtectedOfficeDeploymentV3DevicesAndExecutableTmpfsAreFrozen(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "compute",
		"protected-office-set-deployment.v3.json"))
	if err != nil {
		t.Fatal(err)
	}
	var deployment struct {
		DeploymentID string `json:"deploymentId"`
		Set          struct {
			Profiles []struct {
				Slot        string `json:"slot"`
				WorkerStart struct {
					Devices         []string `json:"devices"`
					TmpfsExecutable bool     `json:"tmpfsExecutable"`
				} `json:"workerStart"`
			} `json:"profiles"`
		} `json:"set"`
	}
	if err := json.Unmarshal(raw, &deployment); err != nil {
		t.Fatal(err)
	}
	if deployment.DeploymentID != "teamaibox.protected-office-set-deployment.v3" ||
		len(deployment.Set.Profiles) != 6 {
		t.Fatal("protected office deployment v3 identity or profile cardinality drifted")
	}
	policy := DefaultPolicy()
	gpuProfiles := 0
	executableTmpfsProfiles := 0
	asrProfiles := 0
	for _, profile := range deployment.Set.Profiles {
		for _, device := range profile.WorkerStart.Devices {
			if !policy.AllowedDevices[device] {
				t.Fatalf("%s device %q is denied by Node Agent DefaultPolicy", profile.Slot, device)
			}
		}
		if len(profile.WorkerStart.Devices) > 0 {
			gpuProfiles++
			if len(profile.WorkerStart.Devices) != 1 ||
				profile.WorkerStart.Devices[0] != "nvidia.com/gpu=all" {
				t.Fatalf("%s does not use the exact reviewed GPU request", profile.Slot)
			}
		}
		if profile.WorkerStart.TmpfsExecutable {
			executableTmpfsProfiles++
		}
		if profile.Slot == "asr-whisper" {
			asrProfiles++
			if profile.WorkerStart.TmpfsExecutable {
				t.Fatal("protected office ASR must retain a noexec tmpfs")
			}
		}
	}
	if gpuProfiles != 5 || executableTmpfsProfiles != 5 || asrProfiles != 1 || policy.AllowedDevices["gpu"] {
		t.Fatalf("protected office device/tmpfs boundary drifted: gpu=%d executableTmpfs=%d asr=%d bareGPU=%t",
			gpuProfiles, executableTmpfsProfiles, asrProfiles, policy.AllowedDevices["gpu"])
	}
}

func TestProtectedOfficeDeploymentV4EntrypointsDevicesAndExecutableTmpfsAreFrozen(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "compute",
		"protected-office-set-deployment.v4.json"))
	if err != nil {
		t.Fatal(err)
	}
	var deployment struct {
		DeploymentID string `json:"deploymentId"`
		Set          struct {
			Profiles []struct {
				Slot        string `json:"slot"`
				WorkerStart struct {
					Devices         []string `json:"devices"`
					Entrypoint      []string `json:"entrypoint"`
					TmpfsExecutable bool     `json:"tmpfsExecutable"`
				} `json:"workerStart"`
			} `json:"profiles"`
		} `json:"set"`
	}
	if err := json.Unmarshal(raw, &deployment); err != nil {
		t.Fatal(err)
	}
	expectedEntrypoints := map[string][]string{
		"embedding-qwen3":  {"vllm"},
		"asr-whisper":      {"python", "/opt/teamaibox/server.py"},
		"ocr-hunyuan":      {"python3", "/opt/teamaibox/ocr-worker/managed_dflash_server.py"},
		"translation-lmt4": {"vllm"},
		"assistant-qwen38": {"vllm"},
		"drawing-flux2":    {"python3"},
	}
	if deployment.DeploymentID != "teamaibox.protected-office-set-deployment.v4" ||
		len(deployment.Set.Profiles) != len(expectedEntrypoints) {
		t.Fatal("protected office deployment v4 identity or profile cardinality drifted")
	}
	policy := DefaultPolicy()
	gpuProfiles := 0
	executableTmpfsProfiles := 0
	seen := map[string]bool{}
	for _, profile := range deployment.Set.Profiles {
		expected, ok := expectedEntrypoints[profile.Slot]
		if !ok || !slices.Equal(profile.WorkerStart.Entrypoint, expected) || seen[profile.Slot] {
			t.Fatalf("%s exact reviewed entrypoint or slot identity drifted", profile.Slot)
		}
		seen[profile.Slot] = true
		for _, device := range profile.WorkerStart.Devices {
			if !policy.AllowedDevices[device] {
				t.Fatalf("%s device %q is denied by Node Agent DefaultPolicy", profile.Slot, device)
			}
		}
		if profile.Slot == "asr-whisper" {
			if len(profile.WorkerStart.Devices) != 0 || profile.WorkerStart.TmpfsExecutable {
				t.Fatal("protected office ASR must remain CPU-only with a noexec tmpfs")
			}
			continue
		}
		if len(profile.WorkerStart.Devices) != 1 ||
			profile.WorkerStart.Devices[0] != "nvidia.com/gpu=all" ||
			!profile.WorkerStart.TmpfsExecutable {
			t.Fatalf("%s exact GPU/executable-tmpfs boundary drifted", profile.Slot)
		}
		gpuProfiles++
		executableTmpfsProfiles++
	}
	if len(seen) != 6 || gpuProfiles != 5 || executableTmpfsProfiles != 5 ||
		policy.AllowedDevices["gpu"] {
		t.Fatalf("protected office v4 boundary drifted: slots=%d gpu=%d executableTmpfs=%d bareGPU=%t",
			len(seen), gpuProfiles, executableTmpfsProfiles, policy.AllowedDevices["gpu"])
	}
}

func TestNodeAgentAuthorityMetadataIsExactRootGroupReadOnlySingleLink(t *testing.T) {
	valid := syscall.Stat_t{Uid: 0, Gid: 10001, Mode: syscall.S_IFREG | 0o440, Nlink: 1, Size: 2}
	if !validNodeAgentAuthorityMetadata(&valid, 10001, 10001) {
		t.Fatal("exact root:10001/0440 authority was rejected for the Node Agent")
	}
	invalid := []syscall.Stat_t{
		{Uid: 10001, Gid: 10001, Mode: syscall.S_IFREG | 0o440, Nlink: 1},
		{Uid: 0, Gid: 0, Mode: syscall.S_IFREG | 0o440, Nlink: 1},
		{Uid: 0, Gid: 10001, Mode: syscall.S_IFREG | 0o400, Nlink: 1},
		{Uid: 0, Gid: 10001, Mode: syscall.S_IFREG | 0o444, Nlink: 1},
		{Uid: 0, Gid: 10001, Mode: syscall.S_IFREG | 0o460, Nlink: 1},
		{Uid: 0, Gid: 10001, Mode: syscall.S_IFDIR | 0o440, Nlink: 1},
		{Uid: 0, Gid: 10001, Mode: syscall.S_IFREG | 0o440, Nlink: 2},
	}
	for index := range invalid {
		if validNodeAgentAuthorityMetadata(&invalid[index], 10001, 10001) {
			t.Fatalf("invalid authority metadata %d was accepted", index)
		}
	}
	if validNodeAgentAuthorityMetadata(&valid, 10001, 10002) ||
		validNodeAgentAuthorityMetadata(&valid, 0, 0) {
		t.Fatal("non-Node-Agent reader identity was accepted")
	}
}

func TestNodeAgentAuthorityReaderRejectsReplaceableUserFileSymlinkAndHardlink(t *testing.T) {
	directory := t.TempDir()
	raw := []byte("{}")
	digest := fileDigest(raw)
	regular := filepath.Join(directory, "authority.json")
	if err := os.WriteFile(regular, raw, 0o440); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadNodeAgentAuthorityArtifact(regular, digest, 1024); err == nil {
		t.Fatal("ordinary-user-owned authority was accepted")
	}
	symlink := filepath.Join(directory, "authority-symlink.json")
	if err := os.Symlink(regular, symlink); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadNodeAgentAuthorityArtifact(symlink, digest, 1024); err == nil {
		t.Fatal("symlink authority was accepted")
	}
	hardlink := filepath.Join(directory, "authority-hardlink.json")
	if err := os.Link(regular, hardlink); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadNodeAgentAuthorityArtifact(hardlink, digest, 1024); err == nil {
		t.Fatal("hard-linked authority was accepted")
	}
	if _, err := ReadNodeAgentAuthorityArtifact(regular, "sha256:"+strings.Repeat("0", 64), 1024); err == nil {
		t.Fatal("wrong authority digest was accepted")
	}
}

func TestLegacyProtectedSetMigrationPolicyLoadsAnExactSixTargetPlan(t *testing.T) {
	policy, plan, workers := migrationPolicyFixture(t)
	filename, digest := writeMigrationPlan(t, plan)
	loaded, err := loadMigrationPlanForTest(filename, digest, policy)
	if err != nil || loaded.SourceDigest != digest || len(loaded.Targets) != 6 {
		t.Fatalf("exact migration plan did not load: %#v %v", loaded, err)
	}
	policy.LegacyProtectedSetMigration = loaded
	for _, worker := range workers {
		if err := policy.ValidateStart(worker); err != nil {
			t.Fatalf("plan-bound canonical Worker was denied: %v", err)
		}
	}
	drifted := workers[0]
	drifted.Environment["TEAMAIBOX_MODEL_PROFILE_ID"] = workers[1].ModelProfileID
	if err := policy.ValidateStart(drifted); err == nil {
		t.Fatal("one-byte-equivalent desired Worker drift was accepted")
	}
}

func TestPermanentProtectedStartsAllowExecutableTmpfsForExactlyFiveReviewedTargets(t *testing.T) {
	policy, _, workers := migrationPolicyFixture(t)
	if policy.LegacyProtectedSetMigration != nil {
		t.Fatal("fixture unexpectedly retained one-time migration authority")
	}
	allowed := map[string]bool{
		"office.embedding-qwen3":  true,
		"office.ocr-hunyuan":      true,
		"office.translation-lmt4": true,
		"office.assistant-qwen38": true,
		"office.drawing-flux2":    true,
	}
	accepted := 0
	for _, worker := range workers {
		target, found := policy.ProtectedTargetForWorker(worker.WorkerID)
		if !found {
			t.Fatalf("protected target for %s is missing", worker.WorkerID)
		}
		// These values are not part of the general Worker allowlist. They are
		// safe here only because the root-owned target binds the entire start.
		worker.Environment["HF_HUB_OFFLINE"] = "1"
		if target.TargetKey == "office.translation-lmt4" {
			worker.Mounts = []VolumeMount{{
				Type: "bind", Source: "/srv/teamaibox/legacy/translation-models/reviewed-lmt4",
				Target: "/model", ReadOnly: true,
			}}
		}
		worker.TmpfsExecutable = allowed[target.TargetKey]
		target.RequiredStartSpecDigest = WorkerStartSpecDigest(worker)
		policy.ExclusiveDrainTargets[target.TargetKey] = target
		if err := policy.ValidateStart(worker); err != nil {
			t.Fatalf("exact permanent protected start for %s was rejected: %v", target.TargetKey, err)
		}
		if worker.TmpfsExecutable {
			accepted++
		}
		if target.TargetKey == "office.asr-whisper" {
			worker.TmpfsExecutable = true
			target.RequiredStartSpecDigest = WorkerStartSpecDigest(worker)
			policy.ExclusiveDrainTargets[target.TargetKey] = target
			if err := policy.ValidateStart(worker); err == nil || err.Error() != "worker_executable_tmpfs_denied" {
				t.Fatalf("exact ASR executable tmpfs was accepted: %v", err)
			}
		}
	}
	if accepted != 5 {
		t.Fatalf("expected exactly five executable-tmpfs protected starts, got %d", accepted)
	}
}

func TestProtectedOfficeEntrypointsMatchTheExactReviewedTargetMap(t *testing.T) {
	policy, _, workers := migrationPolicyFixture(t)
	reviewed := map[string][]string{
		"office.embedding-qwen3":  {"vllm"},
		"office.asr-whisper":      {"python", "/opt/teamaibox/server.py"},
		"office.ocr-hunyuan":      {"python3", "/opt/teamaibox/ocr-worker/managed_dflash_server.py"},
		"office.translation-lmt4": {"vllm"},
		"office.assistant-qwen38": {"vllm"},
		"office.drawing-flux2":    {"python3"},
	}
	accepted := 0
	for _, worker := range workers {
		target, found := policy.ProtectedTargetForWorker(worker.WorkerID)
		if !found {
			t.Fatalf("protected target for %s is missing", worker.WorkerID)
		}
		entrypoint, reviewedTarget := reviewed[target.TargetKey]
		if !reviewedTarget {
			t.Fatalf("target %s has no reviewed test entrypoint", target.TargetKey)
		}
		worker.Entrypoint = append([]string(nil), entrypoint...)
		target.RequiredStartSpecDigest = WorkerStartSpecDigest(worker)
		policy.ExclusiveDrainTargets[target.TargetKey] = target
		if err := policy.ValidateStart(worker); err != nil {
			t.Fatalf("exact reviewed entrypoint for %s was rejected: %v", target.TargetKey, err)
		}
		accepted++
	}
	if accepted != 6 {
		t.Fatalf("expected six exact reviewed entrypoints, got %d", accepted)
	}
}

func TestProtectedOfficeEntrypointDriftFailsClosedAfterDigestRebinding(t *testing.T) {
	testCases := []struct {
		name       string
		targetKey  string
		entrypoint []string
	}{
		{name: "missing argument", targetKey: "office.asr-whisper", entrypoint: []string{"python"}},
		{name: "wrong executable", targetKey: "office.embedding-qwen3", entrypoint: []string{"python3"}},
		{name: "extra argument", targetKey: "office.drawing-flux2", entrypoint: []string{"python3", "--serve"}},
		{name: "reordered", targetKey: "office.ocr-hunyuan", entrypoint: []string{"/opt/teamaibox/ocr-worker/managed_dflash_server.py", "python3"}},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			policy, _, workers := migrationPolicyFixture(t)
			var worker WorkerStartPayload
			var target ExclusiveDrainTarget
			found := false
			for _, candidate := range workers {
				candidateTarget, exists := policy.ProtectedTargetForWorker(candidate.WorkerID)
				if exists && candidateTarget.TargetKey == testCase.targetKey {
					worker, target, found = candidate, candidateTarget, true
					break
				}
			}
			if !found {
				t.Fatalf("target %s is missing", testCase.targetKey)
			}
			worker.Entrypoint = append([]string(nil), testCase.entrypoint...)
			target.RequiredStartSpecDigest = WorkerStartSpecDigest(worker)
			policy.ExclusiveDrainTargets[target.TargetKey] = target
			if err := policy.ValidateStart(worker); err == nil || err.Error() != "worker_entrypoint_denied" {
				t.Fatalf("digest-rebound entrypoint drift was accepted: %v", err)
			}
		})
	}

	t.Run("unknown target", func(t *testing.T) {
		policy, _, workers := migrationPolicyFixture(t)
		worker := workers[0]
		target, _ := policy.ProtectedTargetForWorker(worker.WorkerID)
		delete(policy.ExclusiveDrainTargets, target.TargetKey)
		target.TargetKey = "office.embedding-qwen3-shadow"
		worker.Entrypoint = []string{"vllm"}
		target.RequiredStartSpecDigest = WorkerStartSpecDigest(worker)
		policy.ExclusiveDrainTargets[target.TargetKey] = target
		if err := policy.ValidateStart(worker); err == nil || err.Error() != "worker_entrypoint_denied" {
			t.Fatalf("unknown digest-rebound target entrypoint was accepted: %v", err)
		}
	})

	t.Run("empty historical v3 entrypoint remains compatible", func(t *testing.T) {
		policy, _, workers := migrationPolicyFixture(t)
		worker := workers[0]
		target, _ := policy.ProtectedTargetForWorker(worker.WorkerID)
		if len(worker.Entrypoint) != 0 {
			t.Fatal("historical fixture unexpectedly has an entrypoint")
		}
		target.RequiredStartSpecDigest = WorkerStartSpecDigest(worker)
		policy.ExclusiveDrainTargets[target.TargetKey] = target
		if err := policy.ValidateStart(worker); err != nil {
			t.Fatalf("empty exact historical v3 entrypoint was rejected: %v", err)
		}
	})
}

func TestExecutableTmpfsAndReviewedProtectedOverridesFailClosedOnIdentityDrift(t *testing.T) {
	t.Run("ordinary worker executable tmpfs", func(t *testing.T) {
		worker := validStart()
		worker.TmpfsExecutable = true
		if err := DefaultPolicy().ValidateStart(worker); err == nil || err.Error() != "worker_executable_tmpfs_denied" {
			t.Fatalf("ordinary Worker executable tmpfs was accepted: %v", err)
		}
	})

	t.Run("ordinary worker protected-only environment", func(t *testing.T) {
		worker := validStart()
		worker.Environment["HF_HUB_OFFLINE"] = "1"
		if err := DefaultPolicy().ValidateStart(worker); err == nil || err.Error() != "worker environment \"HF_HUB_OFFLINE\" is not allowed" {
			t.Fatalf("ordinary Worker protected-only environment was accepted: %v", err)
		}
	})

	t.Run("non-exact protected start", func(t *testing.T) {
		policy, _, workers := migrationPolicyFixture(t)
		worker := workers[0]
		worker.TmpfsExecutable = true
		target, _ := policy.ProtectedTargetForWorker(worker.WorkerID)
		target.RequiredStartSpecDigest = WorkerStartSpecDigest(worker)
		policy.ExclusiveDrainTargets[target.TargetKey] = target
		worker.Command = append(worker.Command, "--identity-drift")
		if err := policy.ValidateStart(worker); err == nil || err.Error() != "worker_executable_tmpfs_denied" {
			t.Fatalf("non-exact protected executable tmpfs was accepted: %v", err)
		}
	})

	t.Run("unreviewed protected target key", func(t *testing.T) {
		policy, _, workers := migrationPolicyFixture(t)
		worker := workers[0]
		worker.TmpfsExecutable = true
		target, _ := policy.ProtectedTargetForWorker(worker.WorkerID)
		delete(policy.ExclusiveDrainTargets, target.TargetKey)
		target.TargetKey = "office.embedding-qwen3-shadow"
		target.RequiredStartSpecDigest = WorkerStartSpecDigest(worker)
		policy.ExclusiveDrainTargets[target.TargetKey] = target
		if err := policy.ValidateStart(worker); err == nil || err.Error() != "worker_executable_tmpfs_denied" {
			t.Fatalf("unreviewed target executable tmpfs was accepted: %v", err)
		}
	})

	t.Run("exact protected start unsafe bind", func(t *testing.T) {
		policy, _, workers := migrationPolicyFixture(t)
		worker := workers[3]
		worker.TmpfsExecutable = true
		worker.Mounts = []VolumeMount{{Type: "bind", Source: "/etc", Target: "/model", ReadOnly: true}}
		target, _ := policy.ProtectedTargetForWorker(worker.WorkerID)
		target.RequiredStartSpecDigest = WorkerStartSpecDigest(worker)
		policy.ExclusiveDrainTargets[target.TargetKey] = target
		if err := policy.ValidateStart(worker); err == nil || err.Error() != "worker mount is not an assigned named volume" {
			t.Fatalf("unsafe exact protected bind was accepted: %v", err)
		}
	})

	t.Run("exact protected start raw secret environment", func(t *testing.T) {
		policy, _, workers := migrationPolicyFixture(t)
		worker := workers[0]
		worker.TmpfsExecutable = true
		worker.Environment["MODEL_PASSWORD"] = "raw-secret"
		target, _ := policy.ProtectedTargetForWorker(worker.WorkerID)
		target.RequiredStartSpecDigest = WorkerStartSpecDigest(worker)
		policy.ExclusiveDrainTargets[target.TargetKey] = target
		if err := policy.ValidateStart(worker); err == nil || err.Error() != "raw secret environment variables are forbidden" {
			t.Fatalf("raw secret in exact protected start was accepted: %v", err)
		}
	})
}

func TestLegacyProtectedSetMigrationPolicyRejectsDigestAndIdentityClassDrift(t *testing.T) {
	policy, plan, _ := migrationPolicyFixture(t)
	filename, digest := writeMigrationPlan(t, plan)
	if _, err := loadMigrationPlanForTest(filename, "sha256:"+strings.Repeat("0", 64), policy); err == nil {
		t.Fatal("wrong plan byte digest was accepted")
	}
	plan.Targets[0].LegacyPreviousTarget.Primary.RequiredImageID = plan.Targets[0].LegacyPreviousTarget.Primary.RequiredImageReference
	filename, digest = writeMigrationPlan(t, plan)
	if _, err := loadMigrationPlanForTest(filename, digest, policy); err == nil {
		t.Fatal("manifest/config identity class swap was accepted")
	}
}

func TestLegacyProtectedSetMigrationPolicyRejectsUnsafeBindAndNamespaceDrift(t *testing.T) {
	policy, plan, _ := migrationPolicyFixture(t)
	plan.Targets[0].LegacyPreviousTarget.Primary.RequiredMounts = []VolumeMount{{Type: "bind", Source: "/srv/teamaibox/legacy/translation-models-evil/model", Target: "/model", ReadOnly: true}}
	legacySet := make([]LegacyProtectedTransitionTarget, 0, 6)
	for _, target := range plan.Targets {
		legacySet = append(legacySet, target.LegacyPreviousTarget)
	}
	plan.SourceSetDigest = canonicalPolicyDigest(legacySet)
	filename, digest := writeMigrationPlan(t, plan)
	if _, err := loadMigrationPlanForTest(filename, digest, policy); err == nil {
		t.Fatal("approved-root sibling bind escaped the allowlist")
	}
	policy, plan, _ = migrationPolicyFixture(t)
	plan.Targets[2].LegacyPreviousTarget.DependentContainers[0].RequiredNetworkMode = "container:" + strings.Repeat("0", 64)
	legacySet = legacySet[:0]
	for _, target := range plan.Targets {
		legacySet = append(legacySet, target.LegacyPreviousTarget)
	}
	plan.SourceSetDigest = canonicalPolicyDigest(legacySet)
	filename, digest = writeMigrationPlan(t, plan)
	if _, err := loadMigrationPlanForTest(filename, digest, policy); err == nil {
		t.Fatal("OCR provider was allowed to target a different legacy namespace")
	}
}

func TestLegacyTranslationModelRootIsInstallationScoped(t *testing.T) {
	t.Setenv("TEAMAIBOX_LEGACY_TRANSLATION_MODEL_ROOT", "")
	if legacyTranslationModelRoot() != "/srv/teamaibox/legacy/translation-models" {
		t.Fatal("unexpected product migration root")
	}
	t.Setenv("TEAMAIBOX_LEGACY_TRANSLATION_MODEL_ROOT", "/srv/synthetic-installation/translation-models")
	valid := VolumeMount{Type: "bind", Source: "/srv/synthetic-installation/translation-models/model", Target: "/model", ReadOnly: true}
	if !validMigrationMount(valid) {
		t.Fatal("explicit installation root rejected")
	}
	for _, source := range []string{"/srv/synthetic-installation/translation-models", "/srv/synthetic-installation/translation-models-other/model", "/srv/teamaibox/legacy/translation-models/model"} {
		invalid := valid
		invalid.Source = source
		if validMigrationMount(invalid) {
			t.Fatal("mount outside the explicit installation root accepted")
		}
	}
	for _, root := range []string{"/", "relative", "/etc", "/srv/synthetic-installation", "/srv/../srv/translation-models", "/srv/translation-models/"} {
		t.Setenv("TEAMAIBOX_LEGACY_TRANSLATION_MODEL_ROOT", root)
		if validMigrationMount(valid) {
			t.Fatal("invalid configured root broadened the allowlist")
		}
	}
}

func TestMigrationPolicyConfiguredRejectsCallerAddedCompanionWithoutLegacyCutover(t *testing.T) {
	policy, plan, _ := migrationPolicyFixture(t)
	filename, digest := writeMigrationPlan(t, plan)
	loaded, err := loadMigrationPlanForTest(filename, digest, policy)
	if err != nil {
		t.Fatal(err)
	}
	policy.LegacyProtectedSetMigration = loaded
	coordinator, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration, filepath.Join(t.TempDir(), "journal.json"), policy,
		&fakeProtectedSetTransitionRuntime{current: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	payload := ProtectedSetTransitionPayload{Targets: []ProtectedSetTransitionTarget{{DesiredCompanions: plan.Targets[2].DesiredCompanions}}}
	if coordinator.payloadMatchesMigrationPolicy(payload) {
		t.Fatal("caller-added companion escaped the immutable local migration plan")
	}
}

func migrationTransitionPayload(plan LegacyProtectedSetMigrationPolicy, workers []WorkerStartPayload) ProtectedSetTransitionPayload {
	targets := make([]ProtectedSetTransitionTarget, 0, len(plan.Targets))
	workerIDs := make([]string, 0, len(plan.Targets))
	for index, migration := range plan.Targets {
		legacy := migration.LegacyPreviousTarget
		targets = append(targets, ProtectedSetTransitionTarget{
			DesiredWorker:        workers[index],
			DesiredTarget:        migrationTargetForTest(plan, migration.DesiredWorkerID),
			LegacyPreviousTarget: &legacy,
			DesiredCompanions:    migration.DesiredCompanions,
		})
		workerIDs = append(workerIDs, migration.DesiredWorkerID)
	}
	return ProtectedSetTransitionPayload{
		TransactionID: leaseID, SetID: plan.SetID, DesiredStateRevision: 1,
		WorkerIDs: workerIDs, AllowedOperations: []string{ProtectedSetTransition},
		OperationOrder:        []string{ProtectedTransitionInspect, ProtectedTransitionStage, ProtectedTransitionVerify, ProtectedTransitionCommit},
		MaintenanceGeneration: 3, IssuedAt: fixedNow.Add(-time.Second), ExpiresAt: fixedNow.Add(time.Minute),
		JournalRevision: 17, MigrationPlanID: plan.PlanID, MigrationPlanDigest: plan.SourceDigest, Targets: targets,
	}
}

func migrationTargetForTest(plan LegacyProtectedSetMigrationPolicy, workerID string) ExclusiveDrainTarget {
	// The caller replaces this placeholder from the policy before validation.
	return ExclusiveDrainTarget{WorkerID: workerID}
}

func migrationPayloadFromPolicy(policy Policy, plan LegacyProtectedSetMigrationPolicy, workers []WorkerStartPayload) ProtectedSetTransitionPayload {
	payload := migrationTransitionPayload(plan, workers)
	for index := range payload.Targets {
		target, _ := policy.ProtectedTargetForWorker(payload.Targets[index].DesiredWorker.WorkerID)
		payload.Targets[index].DesiredTarget = target
	}
	return payload
}

func TestLegacyMigrationFailureRollsBackTheCompleteSixTargetSetInReverse(t *testing.T) {
	policy, plan, workers := migrationPolicyFixture(t)
	filename, digest := writeMigrationPlan(t, plan)
	loaded, err := loadMigrationPlanForTest(filename, digest, policy)
	if err != nil {
		t.Fatal(err)
	}
	policy.LegacyProtectedSetMigration = loaded
	plan = *loaded
	payload := migrationPayloadFromPolicy(policy, plan, workers)
	payload.FaultInjection = &plan.FaultInjection
	runtime := &fakeProtectedSetTransitionRuntime{current: map[string]string{}}
	for _, workerID := range payload.WorkerIDs {
		runtime.current[workerID] = "prior"
	}
	coordinator, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration,
		filepath.Join(t.TempDir(), "journal.json"), policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	commandDigest := strings.Repeat("a", 64)
	if _, err := coordinator.Execute(context.Background(), payload, transitionOwnership(commandDigest), commandDigest, fixedNow); err == nil || err.Error() != "protected_set_transition_stage_failed" {
		t.Fatalf("fault-injected migration did not fail at target four: %v", err)
	}
	want := []string{}
	for index := 0; index <= 3; index++ {
		want = append(want, "stage:"+payload.Targets[index].DesiredTarget.TargetKey)
	}
	for index := len(payload.Targets) - 1; index >= 0; index-- {
		want = append(want, "rollback:"+payload.Targets[index].DesiredTarget.TargetKey)
	}
	if strings.Join(runtime.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("complete-set reverse recovery drifted: got %v want %v", runtime.calls, want)
	}
	for _, workerID := range payload.WorkerIDs {
		if runtime.current[workerID] != "prior" {
			t.Fatalf("legacy identity %s was not restored: %#v", workerID, runtime.current)
		}
	}
	state := coordinator.stateLocked()
	if coordinator.BlocksOrdinaryMutation() || state.Phase != "recovered" || !state.FaultInjectionConsumed ||
		state.FaultInjectionStageOrder != 4 || state.FaultInjectionTargetKey != "office.translation-lmt4" ||
		!state.FaultInjectionAfterHealthy {
		t.Fatalf("successful rollback did not close the durable journal: %#v", coordinator.stateLocked())
	}
}

func TestLegacyMigrationRealTargetFailureIsNotReportedAsThePlannedFaultInjection(t *testing.T) {
	policy, plan, workers := migrationPolicyFixture(t)
	filename, digest := writeMigrationPlan(t, plan)
	loaded, err := loadMigrationPlanForTest(filename, digest, policy)
	if err != nil {
		t.Fatal(err)
	}
	policy.LegacyProtectedSetMigration = loaded
	plan = *loaded
	payload := migrationPayloadFromPolicy(policy, plan, workers)
	payload.FaultInjection = &plan.FaultInjection
	runtime := &fakeProtectedSetTransitionRuntime{current: map[string]string{}, failStage: payload.WorkerIDs[0]}
	for _, workerID := range payload.WorkerIDs {
		runtime.current[workerID] = "prior"
	}
	coordinator, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration,
		filepath.Join(t.TempDir(), "journal.json"), policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	commandDigest := strings.Repeat("a", 64)
	if _, err := coordinator.Execute(context.Background(), payload, transitionOwnership(commandDigest), commandDigest, fixedNow); err == nil ||
		err.Error() != protectedSetTransitionTargetStageFailed {
		t.Fatalf("real target failure used the planned injection error code: %v", err)
	}
	state := coordinator.stateLocked()
	if state.Phase != "recovered" || state.FailureCode != protectedSetTransitionTargetStageFailed ||
		state.FaultInjectionConsumed || state.FaultInjectionStageOrder != 0 ||
		state.FaultInjectionTargetKey != "" || state.FaultInjectionAfterHealthy {
		t.Fatalf("real target failure journal impersonated the planned injection: %#v", state)
	}
	if strings.Join(runtime.calls, ",") != "stage:"+payload.Targets[0].DesiredTarget.TargetKey+","+
		strings.Join([]string{
			"rollback:" + payload.Targets[5].DesiredTarget.TargetKey,
			"rollback:" + payload.Targets[4].DesiredTarget.TargetKey,
			"rollback:" + payload.Targets[3].DesiredTarget.TargetKey,
			"rollback:" + payload.Targets[2].DesiredTarget.TargetKey,
			"rollback:" + payload.Targets[1].DesiredTarget.TargetKey,
			"rollback:" + payload.Targets[0].DesiredTarget.TargetKey,
		}, ",") {
		t.Fatalf("real target failure did not complete reverse recovery: %v", runtime.calls)
	}
}

func TestLegacyMigrationStartupRecoversUnconsumedRollbackFailureJournal(t *testing.T) {
	policy, plan, workers := migrationPolicyFixture(t)
	filename, digest := writeMigrationPlan(t, plan)
	loaded, err := loadMigrationPlanForTest(filename, digest, policy)
	if err != nil {
		t.Fatal(err)
	}
	policy.LegacyProtectedSetMigration = loaded
	plan = *loaded
	payload := migrationPayloadFromPolicy(policy, plan, workers)
	payload.FaultInjection = &plan.FaultInjection
	runtime := &fakeProtectedSetTransitionRuntime{
		current:      map[string]string{},
		failStage:    payload.WorkerIDs[2],
		failRollback: payload.WorkerIDs[2],
	}
	for _, workerID := range payload.WorkerIDs {
		runtime.current[workerID] = "prior"
	}
	journalPath := filepath.Join(t.TempDir(), "journal.json")
	coordinator, err := NewProtectedSetTransitionCoordinator(
		nodeID, nodeGeneration, journalPath, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	commandDigest := strings.Repeat("a", 64)
	if _, err := coordinator.Execute(
		context.Background(), payload, transitionOwnership(commandDigest), commandDigest, fixedNow,
	); err == nil || err.Error() != "protected_set_transition_recovery_incomplete" {
		t.Fatalf("rollback failure did not remain fail-closed: %v", err)
	}
	failed := coordinator.stateLocked()
	if failed.Phase != "recovery_required" || failed.NextOperation != 2 ||
		failed.FailureCode != "protected_set_transition_rollback_failed" ||
		failed.FaultInjectionConsumed || failed.FaultInjectionStageOrder != 0 ||
		failed.FaultInjectionTargetKey != "" || failed.FaultInjectionAfterHealthy {
		t.Fatalf("unconsumed rollback-failure journal drifted: %#v", failed)
	}

	// A fixed successor starts from the durable journal. It must not need a
	// fresh or still-valid cutover authorization: startup recovery performs
	// only the complete reverse reconciliation to the exact legacy set.
	runtime.failRollback = ""
	runtime.calls = nil
	restarted, err := NewProtectedSetTransitionCoordinator(
		nodeID, nodeGeneration, journalPath, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Recover(context.Background(), fixedNow.Add(2*time.Hour)); err != nil {
		t.Fatalf("startup recovery did not finish the exact rollback: %v", err)
	}
	want := make([]string, 0, len(payload.Targets))
	for index := len(payload.Targets) - 1; index >= 0; index-- {
		want = append(want, "rollback:"+payload.Targets[index].DesiredTarget.TargetKey)
	}
	if strings.Join(runtime.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("startup recovery did not reconcile the complete set: got %v want %v", runtime.calls, want)
	}
	for _, workerID := range payload.WorkerIDs {
		if runtime.current[workerID] != "prior" {
			t.Fatalf("legacy identity %s was not restored: %#v", workerID, runtime.current)
		}
	}
	recovered := restarted.stateLocked()
	if recovered.Phase != "recovered" || recovered.NextOperation != 0 ||
		recovered.FailureCode != "protected_set_transition_rollback_failed" ||
		recovered.FaultInjectionConsumed || recovered.FaultInjectionStageOrder != 0 ||
		recovered.FaultInjectionTargetKey != "" || recovered.FaultInjectionAfterHealthy ||
		restarted.BlocksOrdinaryMutation() {
		t.Fatalf("terminal recovered journal drifted: %#v", recovered)
	}
}

func TestLegacyMigrationFaultInjectionRequiresExactPlanBindingAndIsOneShot(t *testing.T) {
	policy, plan, workers := migrationPolicyFixture(t)
	filename, digest := writeMigrationPlan(t, plan)
	loaded, err := loadMigrationPlanForTest(filename, digest, policy)
	if err != nil {
		t.Fatal(err)
	}
	policy.LegacyProtectedSetMigration = loaded
	plan = *loaded
	payload := migrationPayloadFromPolicy(policy, plan, workers)
	drifted := plan.FaultInjection
	drifted.StageOrder = 3
	payload.FaultInjection = &drifted
	runtime := &fakeProtectedSetTransitionRuntime{current: map[string]string{}}
	for _, workerID := range payload.WorkerIDs {
		runtime.current[workerID] = "prior"
	}
	coordinator, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration,
		filepath.Join(t.TempDir(), "journal.json"), policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	commandDigest := strings.Repeat("a", 64)
	if _, err := coordinator.Execute(context.Background(), payload, transitionOwnership(commandDigest), commandDigest, fixedNow); err == nil ||
		err.Error() != "protected_set_transition_migration_plan_drift" {
		t.Fatalf("command-selected fault drift was accepted: %v", err)
	}
	if len(runtime.calls) != 0 {
		t.Fatalf("fault drift reached runtime mutation: %v", runtime.calls)
	}

	payload.FaultInjection = &plan.FaultInjection
	if _, err := coordinator.Execute(context.Background(), payload, transitionOwnership(commandDigest), commandDigest, fixedNow); err == nil ||
		err.Error() != "protected_set_transition_stage_failed" {
		t.Fatalf("exact fault selection did not execute: %v", err)
	}
	before := len(runtime.calls)
	if _, err := coordinator.Execute(context.Background(), payload, transitionOwnership(commandDigest), commandDigest, fixedNow); err == nil {
		t.Fatal("recovered one-shot fault command replayed")
	}
	if len(runtime.calls) != before {
		t.Fatalf("one-shot replay reached runtime mutation: %v", runtime.calls[before:])
	}
}

func TestLegacyMigrationInspectionUsesRecoveredJournalAndRejectsSpoofedBindings(t *testing.T) {
	policy, plan, workers := migrationPolicyFixture(t)
	filename, digest := writeMigrationPlan(t, plan)
	loaded, err := loadMigrationPlanForTest(filename, digest, policy)
	if err != nil {
		t.Fatal(err)
	}
	policy.LegacyProtectedSetMigration = loaded
	plan = *loaded
	payload := migrationPayloadFromPolicy(policy, plan, workers)
	payload.FaultInjection = &plan.FaultInjection
	runtime := &fakeProtectedSetTransitionRuntime{current: map[string]string{}}
	for _, workerID := range payload.WorkerIDs {
		runtime.current[workerID] = "prior"
	}
	coordinator, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration,
		filepath.Join(t.TempDir(), "journal.json"), policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	commandDigest := strings.Repeat("a", 64)
	if _, err := coordinator.Execute(context.Background(), payload, transitionOwnership(commandDigest), commandDigest, fixedNow); err == nil {
		t.Fatal("fault run unexpectedly succeeded")
	}
	request := ProtectedSetTransitionInspectionPayload{
		InspectionID:  "00000000-0000-4000-8000-000000000099",
		TransactionID: payload.TransactionID, MigrationPlanID: plan.PlanID,
		MigrationPlanDigest: digest, Mode: "fault",
	}
	inspection, err := coordinator.Inspect(context.Background(), request)
	if err != nil || !inspection.ReadOnly || inspection.MutationCount != 0 ||
		inspection.RuntimeState != "legacy-exact" || inspection.Journal.Phase != "recovered" ||
		!inspection.Journal.FaultInjectionAfterHealthy || inspection.RestartPersistenceObserved ||
		len(inspection.Targets) != 6 || len(inspection.RollbackTargetKeys) != 6 {
		t.Fatalf("recovered read-only inspection drifted: %#v %v", inspection, err)
	}
	spoofed := request
	spoofed.MigrationPlanDigest = "sha256:" + strings.Repeat("0", 64)
	if _, err := coordinator.Inspect(context.Background(), spoofed); err == nil ||
		err.Error() != "protected_set_transition_inspection_binding_invalid" {
		t.Fatalf("spoofed inspection binding was accepted: %v", err)
	}
	wrongMode := request
	wrongMode.Mode = "success"
	if _, err := coordinator.Inspect(context.Background(), wrongMode); err == nil ||
		err.Error() != "protected_set_transition_inspection_phase_invalid" {
		t.Fatalf("fault journal was replayed as success inspection: %v", err)
	}
	withoutFault := *coordinator.journal
	withoutFault.Payload.FaultInjection = nil
	if validProtectedSetTransitionJournal(withoutFault, nodeID, nodeGeneration) {
		t.Fatal("fault-consumed journal was accepted without its payload authorization")
	}
	impossibleSuccess := *coordinator.journal
	impossibleSuccess.Phase = "complete"
	impossibleSuccess.NextOperation = 0
	impossibleSuccess.FailureCode = ""
	impossibleSuccess.FaultInjectionConsumed = false
	impossibleSuccess.FaultInjectionStageOrder = 0
	impossibleSuccess.FaultInjectionTargetKey = ""
	impossibleSuccess.FaultInjectionAfterHealthy = false
	if validProtectedSetTransitionJournal(impossibleSuccess, nodeID, nodeGeneration) {
		t.Fatal("unconsumed fault authorization was accepted as a complete journal")
	}
}

func TestLegacyMigrationCrashJournalRecoversByExactRuntimeReconciliation(t *testing.T) {
	policy, plan, workers := migrationPolicyFixture(t)
	filename, digest := writeMigrationPlan(t, plan)
	loaded, err := loadMigrationPlanForTest(filename, digest, policy)
	if err != nil {
		t.Fatal(err)
	}
	policy.LegacyProtectedSetMigration = loaded
	plan = *loaded
	payload := migrationPayloadFromPolicy(policy, plan, workers)
	runtime := &fakeProtectedSetTransitionRuntime{current: map[string]string{}}
	for index, workerID := range payload.WorkerIDs {
		if index < 3 {
			runtime.current[workerID] = "desired"
		} else {
			runtime.current[workerID] = "prior"
		}
	}
	journalPath := filepath.Join(t.TempDir(), "journal.json")
	coordinator, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration, journalPath, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	commandDigest := strings.Repeat("b", 64)
	journal := protectedSetTransitionJournal{
		SchemaVersion: protectedSetTransitionJournalSchema, NodeID: nodeID, NodeGeneration: nodeGeneration,
		CommandDigest: commandDigest, PlanDigest: protectedSetTransitionPlanDigest(payload), Payload: payload,
		Phase: "staging", NextOperation: 3, UpdatedAt: fixedNow,
	}
	if err := coordinator.writeJournal(journal); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration, journalPath, policy, runtime)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Recover(context.Background(), fixedNow.Add(time.Second)); err != nil {
		t.Fatalf("crash recovery failed: %v", err)
	}
	want := []string{}
	for index := len(payload.Targets) - 1; index >= 0; index-- {
		want = append(want, "rollback:"+payload.Targets[index].DesiredTarget.TargetKey)
	}
	if strings.Join(runtime.calls, ",") != strings.Join(want, ",") || restarted.stateLocked().Phase != "recovered" {
		t.Fatalf("crash recovery did not reconcile exact runtime state: calls=%v state=%#v", runtime.calls, restarted.stateLocked())
	}
}
