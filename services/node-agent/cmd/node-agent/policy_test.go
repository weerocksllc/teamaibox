package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

func loadTargetPolicyForTest(t *testing.T, filename string) (agent.Policy, error) {
	t.Helper()
	raw, err := os.ReadFile(filename)
	if err != nil {
		return agent.Policy{}, err
	}
	digest := targetPolicyDigestForTest(raw)
	return nodeAgentPolicyWithAuthorityReader(func(name string) string {
		switch name {
		case "TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_FILE":
			return filename
		case "TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_DIGEST":
			return digest
		default:
			return ""
		}
	}, func(actualFilename, actualDigest string, maximumBytes int64) ([]byte, error) {
		if actualFilename != filename || actualDigest != digest || maximumBytes != 64<<10 {
			return nil, errors.New("unexpected authority reader arguments")
		}
		return raw, nil
	})
}

func targetPolicyDigestForTest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func TestNodeAgentPublishedPortAllowlistIsExplicitAndFailClosed(t *testing.T) {
	policy, err := nodeAgentPolicy(func(name string) string {
		if name == "TEAMAIBOX_ALLOWED_WORKER_PORTS" {
			return "18086,18087"
		}
		return ""
	})
	if err != nil || !policy.AllowedPublishedPorts[18086] || !policy.AllowedPublishedPorts[18087] || len(policy.AllowedPublishedPorts) != 2 {
		t.Fatalf("valid worker port allowlist was not parsed: %#v %v", policy.AllowedPublishedPorts, err)
	}
	for _, value := range []string{"18086,18086", "80", "18086,not-a-port", "0", "65536"} {
		if _, err := nodeAgentPolicy(func(name string) string {
			if name == "TEAMAIBOX_ALLOWED_WORKER_PORTS" {
				return value
			}
			return ""
		}); err == nil {
			t.Fatalf("invalid worker port allowlist was accepted: %q", value)
		}
	}
	defaultPolicy, err := nodeAgentPolicy(func(string) string { return "" })
	if err != nil || len(defaultPolicy.AllowedPublishedPorts) != 0 {
		t.Fatalf("default worker port policy must deny all: %#v %v", defaultPolicy.AllowedPublishedPorts, err)
	}
}

func TestMigrationRuntimeIdentityIsExactlyUnprivilegedNodeAgent(t *testing.T) {
	if !migrationRuntimeIdentityAllowed(10001, 10001) {
		t.Fatal("exact unprivileged Node Agent identity was rejected")
	}
	for _, identity := range [][2]int{{0, 0}, {10001, 0}, {0, 10001}, {10002, 10001}} {
		if migrationRuntimeIdentityAllowed(identity[0], identity[1]) {
			t.Fatalf("unexpected migration identity was accepted: %v", identity)
		}
	}
}

func TestMigrationAuthorityCannotOptOutOfExactProtectedPolicyDigest(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "targets.json")
	contents := `{"schemaVersion":1,"targets":[{"targetKey":"ocr.vlm","containerName":"teamaibox-ocr-vlm","requiredLabels":{"com.teamaibox.component":"ocr-worker"}}]}`
	if err := os.WriteFile(filename, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := nodeAgentPolicy(func(name string) string {
		switch name {
		case "TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_FILE":
			return filename
		case "TEAMAIBOX_LEGACY_PROTECTED_SET_MIGRATION_PLAN_FILE":
			return "/authority/migration.json"
		case "TEAMAIBOX_LEGACY_PROTECTED_SET_MIGRATION_PLAN_DIGEST":
			return "sha256:" + strings.Repeat("a", 64)
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_DIGEST is required") {
		t.Fatalf("migration without exact protected policy digest was accepted: %v", err)
	}
}

func TestQualificationAuthorityCannotStartPartiallyConfiguredOrWithoutTargetPolicy(t *testing.T) {
	for _, environment := range []map[string]string{
		{"TEAMAIBOX_PROTECTED_SET_QUALIFICATION_POLICY_FILE": "/authority/qualification.json"},
		{"TEAMAIBOX_PROTECTED_SET_QUALIFICATION_POLICY_DIGEST": "sha256:" + strings.Repeat("a", 64)},
	} {
		if _, err := nodeAgentPolicyWithAuthorityReader(func(name string) string { return environment[name] },
			func(string, string, int64) ([]byte, error) { return nil, errors.New("must not read") }); err == nil ||
			!strings.Contains(err.Error(), "protected-set authority requires the protected target policy") {
			t.Fatalf("partial qualification authority was accepted: %v", err)
		}
	}
}

func TestExclusiveDrainTargetPolicyRequiresDigestPinnedAuthority(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "targets.json")
	contents := `{"schemaVersion":1,"targets":[{"targetKey":"ocr.vlm","containerName":"teamaibox-ocr-vlm","requiredLabels":{"com.teamaibox.component":"ocr-worker"}}]}`
	if err := os.WriteFile(filename, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := nodeAgentPolicy(func(name string) string {
		if name == "TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_FILE" {
			return filename
		}
		return ""
	}); err == nil || !strings.Contains(err.Error(), "TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_DIGEST is required") {
		t.Fatalf("target policy without an exact digest was accepted: %v", err)
	}
	if _, err := nodeAgentPolicy(func(name string) string {
		switch name {
		case "TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_FILE":
			return filename
		case "TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_DIGEST":
			return targetPolicyDigestForTest([]byte(contents))
		default:
			return ""
		}
	}); err == nil || !strings.Contains(err.Error(), "policy authority is invalid") {
		t.Fatalf("replaceable ordinary file was accepted as target policy authority: %v", err)
	}
	policy, err := loadTargetPolicyForTest(t, filename)
	if err != nil || policy.ExclusiveDrainTargets["ocr.vlm"].ContainerName != "teamaibox-ocr-vlm" {
		t.Fatalf("valid target policy failed: %#v %v", policy.ExclusiveDrainTargets, err)
	}
	for _, invalid := range []string{"relative.json", filepath.Join(directory, "missing.json")} {
		if _, err := nodeAgentPolicy(func(name string) string {
			switch name {
			case "TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_FILE":
				return invalid
			case "TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_DIGEST":
				return "sha256:" + strings.Repeat("a", 64)
			default:
				return ""
			}
		}); err == nil {
			t.Fatalf("invalid target policy was accepted: %s", invalid)
		}
	}
}

func TestExclusiveDrainTargetPolicyAcceptsAnExactImageIdentityWithoutLabels(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "targets.json")
	digest := "sha256:" + strings.Repeat("a", 64)
	contents := `{"schemaVersion":1,"targets":[{"targetKey":"llm.large","containerName":"teamaibox-llm","requiredImageId":"` + digest + `","requiredLabels":{}}]}`
	if err := os.WriteFile(filename, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	policy, err := loadTargetPolicyForTest(t, filename)
	if err != nil || policy.ExclusiveDrainTargets["llm.large"].RequiredImageID != digest {
		t.Fatalf("exact image target policy failed: %#v %v", policy.ExclusiveDrainTargets, err)
	}
}

func TestExclusiveDrainTargetPolicyAcceptsExactDependentContainer(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "targets.json")
	digest := "sha256:" + strings.Repeat("a", 64)
	dependentDigest := "sha256:" + strings.Repeat("b", 64)
	contents := `{"schemaVersion":1,"targets":[{"targetKey":"drawing.flux","containerName":"flux-worker","requiredImageId":"` + digest + `","requiredLabels":{},"dependentContainers":[{"containerName":"flux-provider","requiredImageId":"` + dependentDigest + `","requiredLabels":{}}]}]}`
	if err := os.WriteFile(filename, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	policy, err := loadTargetPolicyForTest(t, filename)
	target := policy.ExclusiveDrainTargets["drawing.flux"]
	if err != nil || len(target.DependentContainers) != 1 || target.DependentContainers[0].RequiredImageID != dependentDigest {
		t.Fatalf("exact dependent container policy failed: %#v %v", target, err)
	}
}

func TestProtectedResidentPolicyRequiresExactUniqueWorkerAndDependencyIdentity(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "protected-targets.json")
	imageID := "sha256:" + strings.Repeat("a", 64)
	imageDigest := "registry.local/resident@sha256:" + strings.Repeat("b", 64)
	configDigest := "sha256:" + strings.Repeat("c", 64)
	dependentImageID := "sha256:" + strings.Repeat("d", 64)
	dependentImageDigest := "registry.local/provider@sha256:" + strings.Repeat("e", 64)
	dependentConfigDigest := "sha256:" + strings.Repeat("f", 64)
	startSpecDigest := "sha256:" + strings.Repeat("1", 64)
	workerID := "00000000-0000-4000-8000-000000000811"
	profileID := "00000000-0000-4000-8000-000000000821"
	target := `{"targetKey":"resident.office","workerId":"` + workerID + `","modelProfileId":"` + profileID +
		`","containerName":"resident-worker","placementClass":"protected-resident","maintenanceGeneration":1,"stageOrder":1,"requiredImageId":"` + imageID +
		`","requiredImageDigest":"` + imageDigest + `","requiredConfigDigest":"` + configDigest + `","requiredStartSpecDigest":"` + startSpecDigest +
		`","requiredLabels":{"com.teamaibox.resident":"office"},"dependentContainers":[{"containerName":"resident-provider","requiredImageId":"` + dependentImageID +
		`","requiredImageDigest":"` + dependentImageDigest + `","requiredConfigDigest":"` + dependentConfigDigest +
		`","requiredLabels":{"com.teamaibox.companion":"office"}}]}`
	contents := `{"schemaVersion":1,"targets":[` + target + `]}`
	if err := os.WriteFile(filename, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	policy, err := loadTargetPolicyForTest(t, filename)
	if err != nil || len(policy.ProtectedTargets()) != 1 || len(policy.ExclusiveTargets()) != 0 ||
		policy.ProtectedTargets()[0].WorkerID != workerID {
		t.Fatalf("exact protected policy failed: %#v %v", policy.ProtectedTargets(), err)
	}

	invalid := map[string]string{
		"missing primary config":    strings.Replace(contents, `,"requiredConfigDigest":"`+configDigest+`"`, "", 1),
		"missing start spec digest": strings.Replace(contents, `,"requiredStartSpecDigest":"`+startSpecDigest+`"`, "", 1),
		"missing dependency config": strings.Replace(contents, `,"requiredConfigDigest":"`+dependentConfigDigest+`"`, "", 1),
		"duplicate protected worker": `{"schemaVersion":1,"targets":[` + target + `,` +
			strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(target,
				`resident.office`, `resident.second`), `resident-worker`, `resident-worker-2`), `resident-provider`, `resident-provider-2`), `"stageOrder":1`, `"stageOrder":2`) + `]}`,
	}
	for name, document := range invalid {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(directory, strings.ReplaceAll(name, " ", "-")+".json")
			if err := os.WriteFile(path, []byte(document), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadTargetPolicyForTest(t, path); err == nil {
				t.Fatalf("invalid protected policy was accepted: %s", document)
			}
		})
	}
}
