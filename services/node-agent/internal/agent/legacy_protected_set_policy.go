package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
)

const legacyProtectedSetMigrationMaximumBytes = 1 << 20

const (
	nodeAgentAuthorityOwnerUID = 0
	nodeAgentAuthorityGroupID  = 10001
	nodeAgentAuthorityMode     = 0o440
)

const (
	legacyProtectedSetFaultStageOrder     = 4
	legacyProtectedSetFaultTargetKey      = "office.translation-lmt4"
	legacyProtectedSetFaultInjectionPoint = "after-stage-health"
	legacyProtectedSetFaultFailureCode    = "protected_set_transition_stage_failed"
)

var (
	legacyContainerIDPattern    = regexp.MustCompile(`^[a-f0-9]{64}$`)
	legacyContainerNamePattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	legacyImageReferencePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$`)
	legacyVolumeNamePattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
)

func fileDigest(value []byte) string {
	digest := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func canonicalPolicyDigest(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return ""
	}
	canonical, err := json.Marshal(generic)
	if err != nil {
		return ""
	}
	return fileDigest(canonical)
}

func stableJSONEqual(left, right any) bool {
	first, firstErr := json.Marshal(left)
	second, secondErr := json.Marshal(right)
	return firstErr == nil && secondErr == nil && bytes.Equal(first, second)
}

func validLegacyProtectedSetFaultInjection(value ProtectedSetTransitionFaultInjection) bool {
	return value.StageOrder == legacyProtectedSetFaultStageOrder &&
		value.TargetKey == legacyProtectedSetFaultTargetKey &&
		value.InjectionPoint == legacyProtectedSetFaultInjectionPoint &&
		value.FailureCode == legacyProtectedSetFaultFailureCode && value.OneShot
}

func validMigrationMount(value VolumeMount) bool {
	target := filepath.Clean(value.Target)
	if !filepath.IsAbs(target) || target == "/" || strings.Contains(strings.ToLower(value.Source+target), "docker.sock") {
		return false
	}
	switch value.Type {
	case "volume":
		return legacyVolumeNamePattern.MatchString(value.Source)
	case "bind":
		// The one-time migration may reuse only installation-approved read-only
		// host roots. The exact source is additionally bound by the local plan.
		source := filepath.Clean(value.Source)
		if !filepath.IsAbs(source) || source == "/" || !value.ReadOnly {
			return false
		}
		return withinApprovedMigrationRoot(source, legacyTranslationModelRoot()) ||
			withinApprovedMigrationRoot(source, "/var/lib/teamaibox-provider-runtime")
	default:
		return false
	}
}

func legacyTranslationModelRoot() string {
	root := os.Getenv("TEAMAIBOX_LEGACY_TRANSLATION_MODEL_ROOT")
	if root == "" {
		return "/srv/teamaibox/legacy/translation-models"
	}
	// Do not silently broaden the mount allowlist for malformed configuration.
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || filepath.Base(root) != "translation-models" || strings.ContainsRune(root, '\x00') {
		return ""
	}
	return root
}

func withinApprovedMigrationRoot(value, root string) bool {
	if root == "" {
		return false
	}
	relative, err := filepath.Rel(root, value)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func validLegacyIdentity(value LegacyContainerIdentity, dependency bool) bool {
	if !legacyContainerNamePattern.MatchString(value.ContainerName) ||
		!legacyContainerIDPattern.MatchString(value.ContainerID) ||
		!policyIDPattern.MatchString(value.RequiredImageID) ||
		!legacyImageReferencePattern.MatchString(value.RequiredImageReference) ||
		value.RequiredNetworkMode == "" || len(value.RequiredNetworkMode) > 256 || strings.ContainsRune(value.RequiredNetworkMode, '\x00') ||
		!policyIDPattern.MatchString(value.RequiredRuntimeDigest) ||
		!policyIDPattern.MatchString(value.RequiredEnvironmentDigest) ||
		!policyIDPattern.MatchString(value.RequiredCommandDigest) ||
		!policyIDPattern.MatchString(value.RequiredHealthcheckDigest) ||
		len(value.RequiredMounts) > 16 || len(value.RequiredLabels) > 32 {
		return false
	}
	if dependency {
		if value.RequiredNetworkMode != "compute-internal" && !strings.HasPrefix(value.RequiredNetworkMode, "container:") {
			return false
		}
	} else if strings.HasPrefix(value.RequiredNetworkMode, "container:") {
		return false
	}
	seenTargets := map[string]bool{}
	for _, mount := range value.RequiredMounts {
		if !validMigrationMount(mount) || seenTargets[filepath.Clean(mount.Target)] {
			return false
		}
		seenTargets[filepath.Clean(mount.Target)] = true
	}
	for key, expected := range value.RequiredLabels {
		if !hostPattern.MatchString(strings.ReplaceAll(key, "/", ".")) || expected == "" || len(expected) > 512 || strings.ContainsRune(expected, '\x00') {
			return false
		}
	}
	return true
}

func validCompanionStart(value ProtectedCompanionStartPayload, allowedPorts map[int]bool) bool {
	if !legacyContainerNamePattern.MatchString(value.ContainerName) || !uuidPattern.MatchString(value.ParentWorkerID) || !imagePattern.MatchString(value.Image) ||
		!policyIDPattern.MatchString(value.RequiredImageID) || !policyIDPattern.MatchString(value.ConfigDigest) ||
		value.Network != "compute-internal" || value.Security.RunAsUID == 0 || value.Security.RunAsGID == 0 ||
		!value.Security.ReadOnlyRoot || !value.Security.DropAllCaps || !value.Security.NoNewPrivileges ||
		value.Security.Privileged || value.Security.HostPID || value.Security.HostIPC || value.Security.HostNetwork || value.Security.DockerSocket ||
		value.Limits.MemoryBytes < 64<<20 || value.Limits.MemoryBytes > 16<<30 ||
		value.Limits.CPUQuotaMicros < 1_000 || value.Limits.CPUQuotaMicros > 2_000_000 ||
		value.Limits.PidsLimit < 1 || value.Limits.PidsLimit > 4096 || value.Limits.EphemeralBytes < 1 ||
		value.Limits.OpenFilesLimit < 64 || value.Limits.OpenFilesLimit > 1_048_576 || len(value.Mounts) > 16 ||
		len(value.PublishedPorts) > 8 || len(value.Environment) > 64 || len(value.Command) > 128 ||
		value.HealthCheck == nil || !validContainerHealthCheck(*value.HealthCheck) || len(value.RequiredLabels) == 0 || len(value.RequiredLabels) > 32 {
		return false
	}
	seenTargets := map[string]bool{}
	for _, mount := range value.Mounts {
		if !validMigrationMount(mount) || seenTargets[filepath.Clean(mount.Target)] {
			return false
		}
		seenTargets[filepath.Clean(mount.Target)] = true
	}
	seenPorts := map[int]bool{}
	for _, port := range value.PublishedPorts {
		if port.ContainerPort < 1024 || port.ContainerPort > 65535 || port.HostPort < 1024 || port.HostPort > 65535 ||
			port.HostIP == "" || port.HostIP == "0.0.0.0" || port.HostIP == "::" || seenPorts[port.HostPort] || !allowedPorts[port.HostPort] {
			return false
		}
		seenPorts[port.HostPort] = true
	}
	for name, environmentValue := range value.Environment {
		lower := strings.ToLower(name)
		if !envPattern.MatchString(name) || strings.ContainsRune(environmentValue, '\x00') ||
			strings.Contains(lower, "password") || strings.Contains(lower, "secret") ||
			(strings.HasSuffix(lower, "token") && !strings.HasSuffix(lower, "token_file")) {
			return false
		}
	}
	for _, argument := range value.Command {
		if argument == "" || len(argument) > 4096 || strings.ContainsRune(argument, '\x00') {
			return false
		}
	}
	for key, expected := range value.RequiredLabels {
		if key == "" || len(key) > 128 || expected == "" || len(expected) > 512 || strings.ContainsRune(key+expected, '\x00') {
			return false
		}
	}
	return true
}

func validateLegacyProtectedSetMigrationPolicy(value LegacyProtectedSetMigrationPolicy, protected Policy) error {
	if value.SchemaVersion != 1 || !uuidPattern.MatchString(value.NodeID) || value.NodeGeneration < 1 || !modelAliasPattern.MatchString(value.PlanID) ||
		value.SetID != "office.baseline" || !policyIDPattern.MatchString(value.SourceSetDigest) ||
		!policyIDPattern.MatchString(value.DesiredSetDigest) || len(value.Targets) != 6 ||
		!validLegacyProtectedSetFaultInjection(value.FaultInjection) {
		return fmt.Errorf("legacy_protected_set_migration_plan_invalid")
	}
	configured := protected.ProtectedTargetsDependencyOrder()
	if len(configured) != 6 {
		return fmt.Errorf("legacy_protected_set_migration_plan_set_drift")
	}
	if value.DesiredSetDigest != canonicalPolicyDigest(configured) {
		return fmt.Errorf("legacy_protected_set_migration_plan_set_drift")
	}
	seenContainers := map[string]bool{}
	seenWorkers := map[string]bool{}
	seenPorts := map[int]bool{}
	legacySet := make([]LegacyProtectedTransitionTarget, 0, len(value.Targets))
	for index, migration := range value.Targets {
		canonical := configured[index]
		if migration.TargetKey != canonical.TargetKey || migration.DesiredWorkerID != canonical.WorkerID ||
			canonical.ContainerName != "teamaibox-worker-"+canonical.WorkerID || canonical.RequiredStartSpecDigest == "" ||
			migration.DesiredStartSpecDigest != canonical.RequiredStartSpecDigest || !policyIDPattern.MatchString(migration.DesiredStartSpecDigest) ||
			seenWorkers[migration.DesiredWorkerID] || !validLegacyIdentity(migration.LegacyPreviousTarget.Primary, false) ||
			len(migration.LegacyPreviousTarget.DependentContainers) > 4 || len(migration.DesiredCompanions) > 4 {
			return fmt.Errorf("legacy_protected_set_migration_plan_set_drift")
		}
		seenWorkers[migration.DesiredWorkerID] = true
		legacySet = append(legacySet, migration.LegacyPreviousTarget)
		if seenContainers[canonical.ContainerName] {
			return fmt.Errorf("legacy_protected_set_migration_plan_identity_invalid")
		}
		seenContainers[canonical.ContainerName] = true
		identities := append([]LegacyContainerIdentity{migration.LegacyPreviousTarget.Primary}, migration.LegacyPreviousTarget.DependentContainers...)
		for identityIndex, identity := range identities {
			if (identityIndex > 0 && !validLegacyIdentity(identity, true)) || seenContainers[identity.ContainerName] {
				return fmt.Errorf("legacy_protected_set_migration_plan_identity_invalid")
			}
			if identityIndex > 0 && strings.HasPrefix(identity.RequiredNetworkMode, "container:") &&
				identity.RequiredNetworkMode != "container:"+migration.LegacyPreviousTarget.Primary.ContainerID {
				return fmt.Errorf("legacy_protected_set_migration_plan_identity_invalid")
			}
			seenContainers[identity.ContainerName] = true
		}
		if len(migration.DesiredCompanions) != len(canonical.DependentContainers) {
			return fmt.Errorf("legacy_protected_set_migration_plan_companion_drift")
		}
		for companionIndex, companion := range migration.DesiredCompanions {
			target := canonical.DependentContainers[companionIndex]
			if !validCompanionStart(companion, protected.AllowedPublishedPorts) || companion.ParentWorkerID != canonical.WorkerID || seenContainers[companion.ContainerName] ||
				companion.ContainerName != target.ContainerName || companion.RequiredImageID != target.RequiredImageID ||
				companion.Image != target.RequiredImageDigest || companion.ConfigDigest != target.RequiredConfigDigest ||
				!stableJSONEqual(companion.RequiredLabels, target.RequiredLabels) {
				return fmt.Errorf("legacy_protected_set_migration_plan_companion_drift")
			}
			seenContainers[companion.ContainerName] = true
			for _, published := range companion.PublishedPorts {
				if seenPorts[published.HostPort] {
					return fmt.Errorf("legacy_protected_set_migration_plan_companion_drift")
				}
				seenPorts[published.HostPort] = true
			}
		}
	}
	if value.Targets[value.FaultInjection.StageOrder-1].TargetKey != value.FaultInjection.TargetKey {
		return fmt.Errorf("legacy_protected_set_migration_plan_fault_injection_drift")
	}
	if value.SourceSetDigest != canonicalPolicyDigest(legacySet) {
		return fmt.Errorf("legacy_protected_set_migration_plan_set_drift")
	}
	return nil
}

func validNodeAgentAuthorityMetadata(stat *syscall.Stat_t, readerUID, readerGID int) bool {
	return readerUID == nodeAgentAuthorityGroupID && readerGID == nodeAgentAuthorityGroupID &&
		stat != nil && stat.Uid == nodeAgentAuthorityOwnerUID && stat.Gid == nodeAgentAuthorityGroupID &&
		stat.Mode&syscall.S_IFMT == syscall.S_IFREG && stat.Mode&0o777 == nodeAgentAuthorityMode &&
		stat.Nlink == 1
}

// ReadNodeAgentAuthorityArtifact opens one immutable local authority with
// O_NOFOLLOW, validates the opened inode (not a pathname pre-check), and then
// binds its bytes to an exact digest.  Production migration authority is owned
// by root but is readable only by the unprivileged Node Agent primary group.
func ReadNodeAgentAuthorityArtifact(filename, expectedDigest string, maximumBytes int64) ([]byte, error) {
	if !filepath.IsAbs(filename) || filepath.Clean(filename) == "/" ||
		!policyIDPattern.MatchString(expectedDigest) || maximumBytes < 2 || maximumBytes > legacyProtectedSetMigrationMaximumBytes {
		return nil, fmt.Errorf("node_agent_authority_configuration_invalid")
	}
	descriptor, err := syscall.Open(filename, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("node_agent_authority_file_invalid")
	}
	file := os.NewFile(uintptr(descriptor), filename)
	if file == nil {
		_ = syscall.Close(descriptor)
		return nil, fmt.Errorf("node_agent_authority_file_invalid")
	}
	defer file.Close()
	stat := &syscall.Stat_t{}
	if err := syscall.Fstat(descriptor, stat); err != nil ||
		!validNodeAgentAuthorityMetadata(stat, os.Geteuid(), os.Getegid()) ||
		stat.Size < 2 || stat.Size > maximumBytes {
		return nil, fmt.Errorf("node_agent_authority_file_invalid")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maximumBytes+1))
	if err != nil || int64(len(raw)) > maximumBytes || fileDigest(raw) != expectedDigest {
		return nil, fmt.Errorf("node_agent_authority_digest_mismatch")
	}
	return raw, nil
}

func decodeLegacyProtectedSetMigrationPolicy(raw []byte, expectedDigest string, protected Policy) (*LegacyProtectedSetMigrationPolicy, error) {
	if len(raw) < 2 || len(raw) > legacyProtectedSetMigrationMaximumBytes || fileDigest(raw) != expectedDigest {
		return nil, fmt.Errorf("legacy_protected_set_migration_plan_digest_mismatch")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var value LegacyProtectedSetMigrationPolicy
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("legacy_protected_set_migration_plan_invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("legacy_protected_set_migration_plan_invalid")
	}
	value.SourceDigest = expectedDigest
	if err := validateLegacyProtectedSetMigrationPolicy(value, protected); err != nil {
		return nil, err
	}
	// Normalize maps/slices through a stable copy before the policy becomes live.
	// It prevents callers retaining mutable aliases to the decoded object.
	encoded, _ := json.Marshal(value)
	var frozen LegacyProtectedSetMigrationPolicy
	_ = json.Unmarshal(encoded, &frozen)
	frozen.SourceDigest = expectedDigest
	sort.SliceStable(frozen.Targets, func(left, right int) bool {
		return configuredStage(protected, frozen.Targets[left].DesiredWorkerID) < configuredStage(protected, frozen.Targets[right].DesiredWorkerID)
	})
	return &frozen, nil
}

// LoadLegacyProtectedSetMigrationPolicy loads a root-owned, group-readable
// deployment artifact by exact byte digest. The command payload may reference
// it but cannot add a container, mount, environment value or companion not
// present in this local allowlist.
func LoadLegacyProtectedSetMigrationPolicy(filename, expectedDigest string, protected Policy) (*LegacyProtectedSetMigrationPolicy, error) {
	raw, err := ReadNodeAgentAuthorityArtifact(filename, expectedDigest, legacyProtectedSetMigrationMaximumBytes)
	if err != nil {
		return nil, fmt.Errorf("legacy_protected_set_migration_plan_file_invalid: %w", err)
	}
	return decodeLegacyProtectedSetMigrationPolicy(raw, expectedDigest, protected)
}

func configuredStage(policy Policy, workerID string) int {
	if target, ok := policy.ProtectedTargetForWorker(workerID); ok {
		return target.StageOrder
	}
	return int(^uint(0) >> 1)
}
