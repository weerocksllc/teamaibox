package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	uuidPattern       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	imagePattern      = regexp.MustCompile(`^([a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$`)
	volumePattern     = regexp.MustCompile(`^teamaibox-worker-[a-z0-9][a-z0-9_.-]{1,80}$`)
	pluginIDPattern   = regexp.MustCompile(`^[a-z][a-z0-9.-]{2,127}$`)
	apiScopePattern   = regexp.MustCompile(`^[a-z][a-z0-9:._-]{2,127}$`)
	hostPattern       = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$`)
	policyIDPattern   = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	envPattern        = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)
	sandboxPattern    = regexp.MustCompile(`^sandbox\.[a-f0-9]{32}$`)
	sha256Pattern     = regexp.MustCompile(`^[a-f0-9]{64}$`)
	modelAliasPattern = regexp.MustCompile(`^[a-z][a-z0-9_.-]{2,127}$`)
)

type Policy struct {
	MaxMemoryBytes              int64
	MaxCPUQuotaMicros           int64
	MaxPids                     int64
	MaxEphemeralBytes           int64
	MaxWorkspaceBytes           int64
	AllowedNetworks             map[string]bool
	AllowedDevices              map[string]bool
	AllowedEnv                  map[string]bool
	AllowedPublishedPorts       map[int]bool
	ExclusiveDrainTargets       map[string]ExclusiveDrainTarget
	LegacyProtectedSetMigration *LegacyProtectedSetMigrationPolicy
	ProtectedSetQualification   *ProtectedSetQualificationPolicy
	ProtectedTargetPolicyDigest string
}

func DefaultPolicy() Policy {
	return Policy{
		MaxMemoryBytes: 120 << 30, MaxCPUQuotaMicros: 2_000_000,
		MaxPids: 4096, MaxEphemeralBytes: 2 << 40, MaxWorkspaceBytes: 2 << 40,
		AllowedNetworks:       map[string]bool{"none": true, "compute-internal": true, "compute-egress": true, "plugin-ingress": true, "plugin-egress-proxy": true, "agent-egress-proxy": true},
		AllowedDevices:        map[string]bool{"nvidia.com/gpu=all": true, "nvidia.com/nvenc=all": true, "nvidia.com/nvdec=all": true},
		AllowedPublishedPorts: map[int]bool{},
		ExclusiveDrainTargets: map[string]ExclusiveDrainTarget{},
		AllowedEnv: map[string]bool{
			"TEAMAIBOX_GATEWAY_URL": true, "TEAMAIBOX_WORKER_TOKEN_FILE": true,
			"TEAMAIBOX_OBJECT_GRANT_FILE": true, "TEAMAIBOX_MODEL_PROFILE_ID": true,
			"TEAMAIBOX_PLUGIN_ID":                            true, "TEAMAIBOX_PLUGIN_TOKEN_FILE": true,
			"TEAMAIBOX_NETWORK_POLICY_ID": true,
			"TEAMAIBOX_SANDBOX_KEY":       true, "TEAMAIBOX_COMPUTE_GATEWAY_URL": true,
			"TEAMAIBOX_PIP_INDEX_URL": true, "TEAMAIBOX_NPM_REGISTRY_URL": true,
			"TEAMAIBOX_APT_PROXY_URL": true, "HOME": true, "XDG_CONFIG_HOME": true,
			"XDG_DATA_HOME": true, "XDG_CACHE_HOME": true,
			"PIP_CONFIG_FILE": true, "PIP_INDEX_URL": true, "PIP_EXTRA_INDEX_URL": true,
			"PIP_TRUSTED_HOST": true, "NPM_CONFIG_USERCONFIG": true, "NPM_CONFIG_REGISTRY": true,
			"APT_CONFIG": true, "HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true,
			"OPENCODE_CONFIG": true, "OPENCODE_DISABLE_PROJECT_CONFIG": true,
			"OPENCODE_DISABLE_AUTOUPDATE": true, "OPENCODE_DISABLE_SHARE": true,
			"OPENCODE_AUTO_SHARE": true, "OPENCODE_PURE": true,
			"OPENCODE_DISABLE_DEFAULT_PLUGINS": true, "OPENCODE_DISABLE_EXTERNAL_SKILLS": true,
			"OPENCODE_DISABLE_MODELS_FETCH": true, "OPENCODE_DISABLE_EMBEDDED_WEB_UI": true,
			"OPENCODE_PERMISSION": true,
		},
	}
}

func (p Policy) ExclusiveTargets() []ExclusiveDrainTarget {
	keys := make([]string, 0, len(p.ExclusiveDrainTargets))
	for key, target := range p.ExclusiveDrainTargets {
		if !IsProtectedPlacement(target.PlacementClass) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	values := make([]ExclusiveDrainTarget, 0, len(keys))
	for _, key := range keys {
		values = append(values, p.ExclusiveDrainTargets[key])
	}
	return values
}

func (p Policy) ProtectedTargets() []ExclusiveDrainTarget {
	values := make([]ExclusiveDrainTarget, 0, len(p.ExclusiveDrainTargets))
	for _, target := range p.ExclusiveDrainTargets {
		if IsProtectedPlacement(target.PlacementClass) {
			values = append(values, target)
		}
	}
	// The policy stage order is dependency-first for boot. Maintenance stops in
	// the reverse order and restores this returned list in reverse again.
	sort.Slice(values, func(left, right int) bool {
		if values[left].StageOrder != values[right].StageOrder {
			return values[left].StageOrder > values[right].StageOrder
		}
		return values[left].TargetKey < values[right].TargetKey
	})
	return values
}

// ProtectedTargetsDependencyOrder is the declarative boot/cutover order.  The
// existing ProtectedTargets method intentionally remains reverse dependency
// order because bounded maintenance must stop dependents first.
func (p Policy) ProtectedTargetsDependencyOrder() []ExclusiveDrainTarget {
	values := p.ProtectedTargets()
	for left, right := 0, len(values)-1; left < right; left, right = left+1, right-1 {
		values[left], values[right] = values[right], values[left]
	}
	return values
}

func (p Policy) ProtectedTargetForWorker(workerID string) (ExclusiveDrainTarget, bool) {
	for _, target := range p.ExclusiveDrainTargets {
		if IsProtectedPlacement(target.PlacementClass) && target.WorkerID == workerID {
			return target, true
		}
	}
	return ExclusiveDrainTarget{}, false
}

func WorkerStartSpecDigest(spec WorkerStartPayload) string {
	encoded, err := json.Marshal(spec)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func exactProtectedStart(target ExclusiveDrainTarget, found bool, spec WorkerStartPayload) bool {
	return found && workloadKind(spec) == "compute-worker" &&
		EffectivePlacementClass(spec.PlacementClass) == PlacementProtectedResident &&
		target.ModelProfileID == spec.ModelProfileID &&
		target.RequiredImageDigest == spec.Image &&
		target.RequiredConfigDigest != "" && target.RequiredConfigDigest == spec.ConfigDigest &&
		target.RequiredStartSpecDigest != "" && target.RequiredStartSpecDigest == WorkerStartSpecDigest(spec) &&
		target.MaintenanceGeneration == spec.MaintenanceGeneration && spec.MaintenanceGeneration >= 1
}

func protectedTargetAllowsExecutableTmpfs(targetKey string) bool {
	switch targetKey {
	case "office.embedding-qwen3",
		"office.ocr-hunyuan",
		"office.translation-lmt4",
		"office.assistant-qwen38",
		"office.drawing-flux2":
		return true
	default:
		return false
	}
}

func (p Policy) legacyMigrationTargetForWorker(workerID string) (LegacyProtectedSetMigrationTarget, bool) {
	if p.LegacyProtectedSetMigration == nil {
		return LegacyProtectedSetMigrationTarget{}, false
	}
	for _, target := range p.LegacyProtectedSetMigration.Targets {
		if target.DesiredWorkerID == workerID {
			return target, true
		}
	}
	return LegacyProtectedSetMigrationTarget{}, false
}

func (p Policy) legacyMigrationAllowsStart(spec WorkerStartPayload) bool {
	target, exists := p.legacyMigrationTargetForWorker(spec.WorkerID)
	return exists && target.DesiredStartSpecDigest == WorkerStartSpecDigest(spec)
}

func (p Policy) ExclusiveTarget(key string) (ExclusiveDrainTarget, bool) {
	value, exists := p.ExclusiveDrainTargets[key]
	return value, exists
}

func (p Policy) validatePublishedPorts(spec WorkerStartPayload, kind string) error {
	if len(spec.PublishedPorts) == 0 {
		return nil
	}
	if kind != "compute-worker" || spec.Network == "none" || len(spec.PublishedPorts) > 8 {
		return fmt.Errorf("worker published port is not allowed")
	}
	seenContainer := map[int]bool{}
	seenHost := map[int]bool{}
	for _, published := range spec.PublishedPorts {
		if published.ContainerPort < 1024 || published.ContainerPort > 65535 ||
			published.HostPort < 1024 || published.HostPort > 65535 ||
			published.HostIP == "" || net.ParseIP(published.HostIP) == nil ||
			published.HostIP == "0.0.0.0" || published.HostIP == "::" ||
			seenContainer[published.ContainerPort] || seenHost[published.HostPort] ||
			!p.AllowedPublishedPorts[published.HostPort] {
			return fmt.Errorf("worker published port is not allowed")
		}
		seenContainer[published.ContainerPort] = true
		seenHost[published.HostPort] = true
	}
	return nil
}

func agentSandboxIdentity(ownerIdentityID string) (string, string) {
	digest := sha256.Sum256([]byte(ownerIdentityID))
	identity := hex.EncodeToString(digest[:])[:32]
	return "sandbox." + identity, "teamaibox-agent-" + identity + "-workspace"
}

func decodeSandboxFileProject(payload SandboxFileProjectPayload, now time.Time) (SandboxFileProjection, error) {
	if !uuidPattern.MatchString(payload.WorkerID) || !uuidPattern.MatchString(payload.OwnerIdentityID) ||
		!sandboxPattern.MatchString(payload.SandboxKey) || !sha256Pattern.MatchString(payload.ContentSHA256) {
		return SandboxFileProjection{}, fmt.Errorf("agent_sandbox_file_identity_invalid")
	}
	expectedKey, _ := agentSandboxIdentity(payload.OwnerIdentityID)
	if payload.SandboxKey != expectedKey {
		return SandboxFileProjection{}, fmt.Errorf("agent_sandbox_file_identity_invalid")
	}
	contents, err := base64.StdEncoding.Strict().DecodeString(payload.ContentBase64)
	if err != nil || base64.StdEncoding.EncodeToString(contents) != payload.ContentBase64 {
		return SandboxFileProjection{}, fmt.Errorf("agent_sandbox_file_content_invalid")
	}
	failed := true
	defer func() {
		if failed {
			for index := range contents {
				contents[index] = 0
			}
		}
	}()
	digest := sha256.Sum256(contents)
	if hex.EncodeToString(digest[:]) != payload.ContentSHA256 {
		return SandboxFileProjection{}, fmt.Errorf("agent_sandbox_file_digest_mismatch")
	}
	switch payload.FileClass {
	case "opencode-config":
		if len(contents) < 2 || len(contents) > 128<<10 || payload.TokenID != "" || !payload.ExpiresAt.IsZero() {
			return SandboxFileProjection{}, fmt.Errorf("agent_sandbox_config_invalid")
		}
		if !validOpenCodeConfig(contents) {
			return SandboxFileProjection{}, fmt.Errorf("agent_sandbox_config_invalid")
		}
	case "model-token":
		if len(contents) < 32 || len(contents) > 8192 || !uuidPattern.MatchString(payload.TokenID) ||
			payload.ExpiresAt.IsZero() || !payload.ExpiresAt.After(now) || payload.ExpiresAt.After(now.Add(10*time.Minute)) ||
			hasCredentialWhitespace(contents) {
			return SandboxFileProjection{}, fmt.Errorf("agent_sandbox_model_token_invalid")
		}
	case "source-client-config":
		if len(contents) < 2 || len(contents) > 16<<10 || payload.TokenID != "" || !payload.ExpiresAt.IsZero() || !validSourceClientConfig(contents) {
			return SandboxFileProjection{}, fmt.Errorf("agent_sandbox_source_config_invalid")
		}
	default:
		return SandboxFileProjection{}, fmt.Errorf("agent_sandbox_file_class_denied")
	}
	failed = false
	return SandboxFileProjection{
		WorkerID: payload.WorkerID, OwnerIdentityID: payload.OwnerIdentityID,
		SandboxKey: payload.SandboxKey, FileClass: payload.FileClass,
		ContentSHA256: payload.ContentSHA256, TokenID: payload.TokenID,
		ExpiresAt: payload.ExpiresAt, Contents: contents,
	}, nil
}

type openCodeConfig struct {
	Schema           string                      `json:"$schema"`
	AutoUpdate       *bool                       `json:"autoupdate"`
	Share            string                      `json:"share"`
	AutoShare        *bool                       `json:"autoshare"`
	Plugin           []string                    `json:"plugin"`
	Permission       string                      `json:"permission"`
	EnabledProviders []string                    `json:"enabled_providers"`
	Model            string                      `json:"model"`
	SmallModel       string                      `json:"small_model"`
	Provider         map[string]openCodeProvider `json:"provider"`
}

type openCodeProvider struct {
	Name    string                   `json:"name"`
	NPM     string                   `json:"npm"`
	Env     []string                 `json:"env"`
	Models  map[string]openCodeModel `json:"models"`
	Options struct {
		APIKey  string `json:"apiKey"`
		BaseURL string `json:"baseURL"`
	} `json:"options"`
}

type openCodeModel struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ToolCall *bool  `json:"tool_call"`
	Limit    struct {
		Context int64 `json:"context"`
		Output  int64 `json:"output"`
	} `json:"limit"`
}

func validOpenCodeConfig(contents []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var config openCodeConfig
	if err := decoder.Decode(&config); err != nil {
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return false
	}
	if config.Schema != "https://opencode.ai/config.json" || config.AutoUpdate == nil || *config.AutoUpdate ||
		config.Share != "disabled" || config.AutoShare == nil || *config.AutoShare || config.Plugin == nil || len(config.Plugin) != 0 ||
		config.Permission != "ask" || len(config.EnabledProviders) != 1 || config.EnabledProviders[0] != "teamaibox" ||
		len(config.Provider) != 1 || !strings.HasPrefix(config.Model, "teamaibox/") || !strings.HasPrefix(config.SmallModel, "teamaibox/") {
		return false
	}
	provider, exists := config.Provider["teamaibox"]
	if !exists || provider.Name != "Team AI Box" || provider.NPM != "@ai-sdk/openai-compatible" || provider.Env == nil || len(provider.Env) != 0 ||
		provider.Options.BaseURL != "http://compute-gateway:8080/v1" || provider.Options.APIKey != "{file:/run/secrets/teamaibox-model-token}" ||
		len(provider.Models) == 0 {
		return false
	}
	for alias, model := range provider.Models {
		if !modelAliasPattern.MatchString(alias) || model.ID != alias || strings.TrimSpace(model.Name) == "" || model.ToolCall == nil || !*model.ToolCall ||
			model.Limit.Context < 1024 || model.Limit.Output < 1 || model.Limit.Output > model.Limit.Context {
			return false
		}
	}
	_, defaultExists := provider.Models[strings.TrimPrefix(config.Model, "teamaibox/")]
	_, smallExists := provider.Models[strings.TrimPrefix(config.SmallModel, "teamaibox/")]
	return defaultExists && smallExists
}

type sourceClientConfig struct {
	SchemaVersion int    `json:"schemaVersion"`
	PipConf       string `json:"pipConf"`
	NPMRC         string `json:"npmrc"`
	APTConf       string `json:"aptConf"`
	APTSources    string `json:"aptSources"`
}

func validSourceClientConfig(contents []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var config sourceClientConfig
	if err := decoder.Decode(&config); err != nil {
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return false
	}
	return config.SchemaVersion == 1 &&
		config.PipConf == "[global]\nindex-url = http://source-gateway:8080/pip/simple/\ntrusted-host = source-gateway\ndisable-pip-version-check = true\nno-input = true\n" &&
		config.NPMRC == "registry=http://source-gateway:8080/npm/registry/\nalways-auth=false\naudit=false\nupdate-notifier=false\nfund=false\n" &&
		config.APTConf == "Dir::Etc::sourcelist \"/run/teamaibox/source-config/apt/sources.list\";\nDir::Etc::sourceparts \"-\";\nAPT::Architecture \"arm64\";\nAcquire::AllowInsecureRepositories \"false\";\nAcquire::AllowDowngradeToInsecureRepositories \"false\";\n" &&
		config.APTSources == "deb [arch=arm64 signed-by=/usr/share/keyrings/teamaibox-source-gateway.gpg] http://source-gateway:8080/apt teamaibox main\n"
}

func hasCredentialWhitespace(contents []byte) bool {
	for _, value := range contents {
		if value == 0 || value == ' ' || value == '\t' || value == '\r' || value == '\n' {
			return true
		}
	}
	return false
}

func validateAgentNetwork(spec WorkerStartPayload) error {
	if spec.Network != "agent-egress-proxy" || !sort.StringsAreSorted(spec.EgressHosts) {
		return fmt.Errorf("agent_sandbox_network_policy_invalid")
	}
	seen := map[string]bool{}
	for _, host := range spec.EgressHosts {
		lower := strings.ToLower(host)
		if seen[lower] || !hostPattern.MatchString(host) || strings.Contains(host, "*") ||
			lower == "localhost" || lower == "host.docker.internal" || lower == "gateway.docker.internal" ||
			lower == "169.254.169.254" || strings.HasPrefix(lower, "127.") || strings.HasPrefix(lower, "169.254.") {
			return fmt.Errorf("agent_sandbox_network_destination_denied")
		}
		seen[lower] = true
	}
	if !seen["compute-gateway"] || !seen["source-gateway"] ||
		(len(seen) > 2 && !seen["agent-egress-gateway"]) {
		return fmt.Errorf("agent_sandbox_network_policy_invalid")
	}
	if !policyIDPattern.MatchString(spec.NetworkPolicyID) {
		return fmt.Errorf("agent_sandbox_network_policy_invalid")
	}
	payload := spec.OwnerIdentityID + "\n" + strings.Join(spec.EgressHosts, "\n")
	digest := sha256.Sum256([]byte(payload))
	if spec.NetworkPolicyID != "sha256:"+hex.EncodeToString(digest[:]) {
		return fmt.Errorf("agent_sandbox_network_policy_invalid")
	}
	return nil
}

func validateAgentPolicy(p Policy, spec WorkerStartPayload) error {
	if !uuidPattern.MatchString(spec.WorkerID) || !uuidPattern.MatchString(spec.OwnerIdentityID) ||
		spec.AttemptID != "" || spec.ModelProfileID != "" || spec.PluginID != "" {
		return fmt.Errorf("agent_sandbox_identity_invalid")
	}
	expectedKey, expectedVolume := agentSandboxIdentity(spec.OwnerIdentityID)
	if !sandboxPattern.MatchString(spec.SandboxKey) || spec.SandboxKey != expectedKey {
		return fmt.Errorf("agent_sandbox_identity_invalid")
	}
	if err := validateAgentNetwork(spec); err != nil {
		return err
	}
	if len(spec.APIScopes) != 0 {
		return fmt.Errorf("agent_sandbox_api_scope_denied")
	}
	if len(spec.Mounts) != 1 {
		return fmt.Errorf("agent_sandbox_volume_namespace_invalid")
	}
	mount := spec.Mounts[0]
	if mount.Type != "volume" || mount.Source != expectedVolume || path.Clean(mount.Target) != "/workspace" || mount.ReadOnly ||
		strings.Contains(strings.ToLower(mount.Source+mount.Target), "docker.sock") {
		return fmt.Errorf("agent_sandbox_host_mount_denied")
	}
	if len(spec.Devices) != 0 {
		return fmt.Errorf("agent_sandbox_device_denied")
	}
	if spec.Limits.WorkspaceBytes < 1 || spec.Limits.WorkspaceBytes > p.MaxWorkspaceBytes {
		return fmt.Errorf("agent_sandbox_resource_limit_denied")
	}
	return nil
}

func workloadKind(spec WorkerStartPayload) string {
	if spec.WorkloadKind == "" {
		return "compute-worker"
	}
	return spec.WorkloadKind
}

func pluginVolumePrefix(pluginID string) string {
	digest := sha256.Sum256([]byte(pluginID))
	return "teamaibox-plugin-" + hex.EncodeToString(digest[:])[:32]
}

func validatePluginNetwork(spec WorkerStartPayload, kind string) error {
	if spec.Network != "none" && spec.Network != "plugin-egress-proxy" && !(kind == "application-plugin" && spec.Network == "plugin-ingress") {
		return fmt.Errorf("plugin_sandbox_network_denied")
	}
	if !sort.StringsAreSorted(spec.EgressHosts) {
		return fmt.Errorf("plugin_sandbox_network_policy_invalid")
	}
	seen := map[string]bool{}
	for _, host := range spec.EgressHosts {
		lower := strings.ToLower(host)
		if seen[lower] || !hostPattern.MatchString(host) || strings.Contains(host, "*") ||
			lower == "localhost" || lower == "host.docker.internal" || lower == "gateway.docker.internal" ||
			lower == "169.254.169.254" || strings.HasPrefix(lower, "127.") || strings.HasPrefix(lower, "169.254.") {
			return fmt.Errorf("plugin_sandbox_network_destination_denied")
		}
		seen[lower] = true
	}
	noEgress := spec.Network == "none" || (kind == "application-plugin" && spec.Network == "plugin-ingress")
	if noEgress != (len(spec.EgressHosts) == 0) {
		return fmt.Errorf("plugin_sandbox_network_policy_invalid")
	}
	if noEgress {
		if spec.NetworkPolicyID != "" {
			return fmt.Errorf("plugin_sandbox_network_policy_invalid")
		}
		return nil
	}
	if !policyIDPattern.MatchString(spec.NetworkPolicyID) {
		return fmt.Errorf("plugin_sandbox_network_policy_invalid")
	}
	payload := spec.PluginID + "\n" + strings.Join(spec.EgressHosts, "\n")
	digest := sha256.Sum256([]byte(payload))
	if spec.NetworkPolicyID != "sha256:"+hex.EncodeToString(digest[:]) {
		return fmt.Errorf("plugin_sandbox_network_policy_invalid")
	}
	return nil
}

func validatePluginPolicy(p Policy, spec WorkerStartPayload, kind string) error {
	if !uuidPattern.MatchString(spec.WorkerID) || !pluginIDPattern.MatchString(spec.PluginID) || spec.AttemptID != "" || spec.ModelProfileID != "" {
		return fmt.Errorf("plugin_sandbox_identity_invalid")
	}
	if err := validatePluginNetwork(spec, kind); err != nil {
		return err
	}
	if kind == "application-plugin" && (len(spec.PublishedPorts) != 0 || spec.ApplicationPort < 1024 || spec.ApplicationPort > 65535) {
		return fmt.Errorf("plugin_sandbox_ingress_denied")
	}
	if kind == "compute-plugin" && (len(spec.PublishedPorts) != 0 || spec.ApplicationPort != 0) {
		return fmt.Errorf("plugin_sandbox_ingress_denied")
	}
	if len(spec.APIScopes) > 128 || !sort.StringsAreSorted(spec.APIScopes) {
		return fmt.Errorf("plugin_sandbox_api_scope_denied")
	}
	seenScopes := map[string]bool{}
	for _, scope := range spec.APIScopes {
		if seenScopes[scope] || !apiScopePattern.MatchString(scope) || strings.Contains(scope, "*") || strings.HasPrefix(scope, "admin:") {
			return fmt.Errorf("plugin_sandbox_api_scope_denied")
		}
		seenScopes[scope] = true
	}
	prefix := pluginVolumePrefix(spec.PluginID)
	seenMounts := map[string]bool{}
	for _, mount := range spec.Mounts {
		target := path.Clean(mount.Target)
		expected := ""
		switch target {
		case "/var/lib/teamaibox/plugin/data":
			expected = prefix + "-data"
		case "/var/cache/teamaibox/plugin":
			expected = prefix + "-cache"
		default:
			return fmt.Errorf("plugin_sandbox_host_mount_denied")
		}
		if mount.Type != "volume" || mount.Source != expected || seenMounts[target] || strings.Contains(strings.ToLower(mount.Source+mount.Target), "docker.sock") {
			return fmt.Errorf("plugin_sandbox_host_mount_denied")
		}
		seenMounts[target] = true
	}
	if len(spec.Mounts) != 2 {
		return fmt.Errorf("plugin_sandbox_volume_namespace_invalid")
	}
	if kind == "application-plugin" && len(spec.Devices) > 0 {
		return fmt.Errorf("plugin_sandbox_device_denied")
	}
	seenDevices := map[string]bool{}
	for _, device := range spec.Devices {
		if seenDevices[device] || !p.AllowedDevices[device] {
			return fmt.Errorf("plugin_sandbox_device_denied")
		}
		seenDevices[device] = true
	}
	return nil
}

func validContainerHealthCheck(value ContainerHealthCheck) bool {
	if len(value.Test) < 2 || len(value.Test) > 32 ||
		(value.Test[0] != "CMD" && value.Test[0] != "CMD-SHELL") ||
		value.Interval < int64(time.Second) || value.Interval > int64(5*time.Minute) ||
		value.Timeout < int64(time.Second) || value.Timeout > value.Interval ||
		value.StartPeriod < 0 || value.StartPeriod > int64(30*time.Minute) ||
		value.Retries < 1 || value.Retries > 30 {
		return false
	}
	for _, item := range value.Test {
		if item == "" || len(item) > 4096 || strings.ContainsRune(item, '\x00') {
			return false
		}
	}
	return true
}

func validWorkerEntrypoint(value []string) bool {
	if len(value) < 1 || len(value) > 32 {
		return false
	}
	for _, item := range value {
		if item == "" || len(item) > 4096 || strings.ContainsRune(item, '\x00') {
			return false
		}
	}
	return true
}

func protectedTargetAllowsEntrypoint(targetKey string, value []string) bool {
	var reviewed []string
	switch targetKey {
	case "office.embedding-qwen3", "office.translation-lmt4", "office.assistant-qwen38":
		reviewed = []string{"vllm"}
	case "office.asr-whisper":
		reviewed = []string{"python", "/opt/teamaibox/server.py"}
	case "office.ocr-hunyuan":
		reviewed = []string{"python3", "/opt/teamaibox/ocr-worker/managed_dflash_server.py"}
	case "office.drawing-flux2":
		reviewed = []string{"python3"}
	default:
		return false
	}
	if len(value) != len(reviewed) {
		return false
	}
	for index := range reviewed {
		if value[index] != reviewed[index] {
			return false
		}
	}
	return true
}

func (p Policy) ValidateStart(spec WorkerStartPayload) error {
	kind := workloadKind(spec)
	placement := EffectivePlacementClass(spec.PlacementClass)
	if placement != PlacementWarmOptional && placement != PlacementExclusiveBatch && placement != PlacementProtectedResident {
		return fmt.Errorf("worker_placement_class_invalid")
	}
	if spec.ConfigDigest != "" && !policyIDPattern.MatchString(spec.ConfigDigest) {
		return fmt.Errorf("worker_config_digest_invalid")
	}
	protectedTarget, protectedWorkerID := p.ProtectedTargetForWorker(spec.WorkerID)
	exactProtected := exactProtectedStart(protectedTarget, protectedWorkerID, spec)
	if len(spec.Entrypoint) != 0 {
		if !validWorkerEntrypoint(spec.Entrypoint) {
			return fmt.Errorf("worker_entrypoint_invalid")
		}
		if !exactProtected || !protectedTargetAllowsEntrypoint(protectedTarget.TargetKey, spec.Entrypoint) {
			return fmt.Errorf("worker_entrypoint_denied")
		}
	}
	if spec.TmpfsExecutable {
		if !exactProtected || !protectedTargetAllowsExecutableTmpfs(protectedTarget.TargetKey) {
			return fmt.Errorf("worker_executable_tmpfs_denied")
		}
	}
	if protectedWorkerID && (kind != "compute-worker" || placement != PlacementProtectedResident) {
		return fmt.Errorf("protected_resident_start_identity_denied")
	}
	if kind != "compute-worker" && (placement != PlacementWarmOptional || spec.MaintenanceGeneration != 0 || spec.ConfigDigest != "") {
		return fmt.Errorf("workload_protected_placement_denied")
	}
	if kind != "application-plugin" && spec.ApplicationPort != 0 {
		return fmt.Errorf("worker application port is not allowed")
	}
	if kind == "compute-worker" {
		if !uuidPattern.MatchString(spec.WorkerID) || !uuidPattern.MatchString(spec.AttemptID) || !uuidPattern.MatchString(spec.ModelProfileID) {
			return fmt.Errorf("worker, attempt, and model profile identifiers must be UUIDs")
		}
		if placement == PlacementProtectedResident {
			if !exactProtected {
				return fmt.Errorf("protected_resident_start_identity_denied")
			}
		} else if spec.MaintenanceGeneration != 0 {
			return fmt.Errorf("worker_maintenance_generation_denied")
		}
	} else if kind == "application-plugin" || kind == "compute-plugin" {
		if err := validatePluginPolicy(p, spec, kind); err != nil {
			return err
		}
	} else if kind == "agent-sandbox" {
		if err := validateAgentPolicy(p, spec); err != nil {
			return err
		}
	} else {
		return fmt.Errorf("workload_kind_not_allowed")
	}
	if err := p.validatePublishedPorts(spec, kind); err != nil {
		return err
	}
	if !imagePattern.MatchString(spec.Image) {
		return fmt.Errorf("worker image must be an exact sha256 digest reference")
	}
	if !p.AllowedNetworks[spec.Network] || spec.Network == "host" {
		return fmt.Errorf("worker network is not allowed")
	}
	limits := spec.Limits
	if limits.MemoryBytes < 64<<20 || limits.MemoryBytes > p.MaxMemoryBytes ||
		limits.CPUQuotaMicros < 1_000 || limits.CPUQuotaMicros > p.MaxCPUQuotaMicros ||
		limits.PidsLimit < 1 || limits.PidsLimit > p.MaxPids ||
		limits.EphemeralBytes < 1 || limits.EphemeralBytes > p.MaxEphemeralBytes ||
		limits.OpenFilesLimit < 64 || limits.OpenFilesLimit > 1_048_576 {
		if kind == "agent-sandbox" {
			return fmt.Errorf("agent_sandbox_resource_limit_denied")
		}
		if kind != "compute-worker" {
			return fmt.Errorf("plugin_sandbox_resource_limit_denied")
		}
		return fmt.Errorf("worker resource limits are incomplete or exceed node policy")
	}
	if limits.SharedMemoryBytes != 0 &&
		(limits.SharedMemoryBytes < 64<<20 || limits.SharedMemoryBytes > limits.MemoryBytes) {
		if kind == "agent-sandbox" {
			return fmt.Errorf("agent_sandbox_resource_limit_denied")
		}
		if kind != "compute-worker" {
			return fmt.Errorf("plugin_sandbox_resource_limit_denied")
		}
		return fmt.Errorf("worker shared memory limit is invalid")
	}
	security := spec.Security
	if security.RunAsUID == 0 || security.RunAsGID == 0 || !security.ReadOnlyRoot ||
		!security.DropAllCaps || !security.NoNewPrivileges || security.Privileged ||
		security.HostPID || security.HostIPC || security.HostNetwork || security.DockerSocket {
		if kind == "agent-sandbox" {
			return fmt.Errorf("agent_sandbox_security_denied")
		}
		if kind != "compute-worker" {
			return fmt.Errorf("plugin_sandbox_security_denied")
		}
		return fmt.Errorf("worker security profile violates the non-root isolation baseline")
	}
	if kind == "agent-sandbox" && security.SeccompProfile != "builtin" {
		return fmt.Errorf("agent_sandbox_security_denied")
	}
	if (kind == "application-plugin" || kind == "compute-plugin") && security.SeccompProfile != "teamaibox-plugin-v1" {
		return fmt.Errorf("plugin_sandbox_security_denied")
	}
	if kind == "compute-worker" {
		for _, mount := range spec.Mounts {
			canonicalMount := mount.Type == "volume" && volumePattern.MatchString(mount.Source) &&
				strings.HasPrefix(path.Clean(mount.Target), "/var/lib/teamaibox/worker/")
			allowedMount := canonicalMount
			if exactProtected {
				// The root-owned protected target binds the complete start payload,
				// but it must not turn a typo into an arbitrary host bind. Exact
				// protected starts retain the reviewed volume/bind root boundary.
				allowedMount = validMigrationMount(mount)
			}
			if !allowedMount || strings.Contains(strings.ToLower(mount.Source+mount.Target), "docker.sock") {
				return fmt.Errorf("worker mount is not an assigned named volume")
			}
		}
	}
	if kind == "compute-worker" {
		for _, device := range spec.Devices {
			if !p.AllowedDevices[device] {
				return fmt.Errorf("worker device %q is not allowed", device)
			}
		}
	}
	for name, value := range spec.Environment {
		if !envPattern.MatchString(name) || (!p.AllowedEnv[name] && !exactProtected) || strings.ContainsRune(value, '\x00') {
			if kind == "agent-sandbox" {
				return fmt.Errorf("agent_sandbox_environment_denied")
			}
			if kind != "compute-worker" {
				return fmt.Errorf("plugin_sandbox_environment_denied")
			}
			return fmt.Errorf("worker environment %q is not allowed", name)
		}
		if strings.Contains(strings.ToLower(name), "secret") || strings.Contains(strings.ToLower(name), "password") {
			if kind == "agent-sandbox" {
				return fmt.Errorf("agent_sandbox_environment_denied")
			}
			if kind != "compute-worker" {
				return fmt.Errorf("plugin_sandbox_environment_denied")
			}
			return fmt.Errorf("raw secret environment variables are forbidden")
		}
	}
	if spec.HealthCheck != nil {
		if kind != "compute-worker" || !validContainerHealthCheck(*spec.HealthCheck) {
			return fmt.Errorf("worker healthcheck is invalid")
		}
		if len(spec.HealthCommand) != 0 {
			return fmt.Errorf("worker healthcheck is ambiguous")
		}
	} else if len(spec.HealthCommand) != 0 {
		return fmt.Errorf("worker healthcheck is ambiguous")
	}
	if kind == "agent-sandbox" {
		expected := map[string]string{
			"TEAMAIBOX_SANDBOX_KEY":            spec.SandboxKey,
			"HOME":                             "/workspace/.teamaibox/home",
			"XDG_CONFIG_HOME":                  "/run/teamaibox/xdg-config",
			"XDG_DATA_HOME":                    "/workspace/.teamaibox/data",
			"XDG_CACHE_HOME":                   "/workspace/.teamaibox/cache",
			"OPENCODE_CONFIG":                  "/run/teamaibox/xdg-config/opencode/opencode.json",
			"OPENCODE_DISABLE_PROJECT_CONFIG":  "1",
			"OPENCODE_DISABLE_AUTOUPDATE":      "1",
			"OPENCODE_DISABLE_SHARE":           "1",
			"OPENCODE_AUTO_SHARE":              "false",
			"OPENCODE_PURE":                    "1",
			"OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
			"OPENCODE_DISABLE_EXTERNAL_SKILLS": "1",
			"OPENCODE_DISABLE_MODELS_FETCH":    "1",
			"OPENCODE_DISABLE_EMBEDDED_WEB_UI": "1",
			"OPENCODE_PERMISSION":              `{"*":"ask"}`,
			"TEAMAIBOX_COMPUTE_GATEWAY_URL":    "http://compute-gateway:8080",
			"TEAMAIBOX_PIP_INDEX_URL":          "http://source-gateway:8080/pip/simple/",
			"TEAMAIBOX_NPM_REGISTRY_URL":       "http://source-gateway:8080/npm/registry/",
			"TEAMAIBOX_APT_PROXY_URL":          "http://source-gateway:8080/apt",
			"PIP_CONFIG_FILE":                  "/run/teamaibox/source-config/pip.conf",
			"PIP_INDEX_URL":                    "http://source-gateway:8080/pip/simple/",
			"PIP_EXTRA_INDEX_URL":              "",
			"PIP_TRUSTED_HOST":                 "source-gateway",
			"NPM_CONFIG_USERCONFIG":            "/run/teamaibox/source-config/npmrc",
			"NPM_CONFIG_REGISTRY":              "http://source-gateway:8080/npm/registry/",
			"APT_CONFIG":                       "/run/teamaibox/source-config/apt/apt.conf",
		}
		if containsString(spec.EgressHosts, "agent-egress-gateway") {
			expected["HTTP_PROXY"] = "http://agent-egress-gateway:8080"
			expected["HTTPS_PROXY"] = "http://agent-egress-gateway:8080"
			expected["NO_PROXY"] = "compute-gateway,source-gateway"
		} else if spec.Environment["HTTP_PROXY"] != "" || spec.Environment["HTTPS_PROXY"] != "" || spec.Environment["NO_PROXY"] != "" {
			return fmt.Errorf("agent_sandbox_environment_denied")
		}
		for name, value := range expected {
			if spec.Environment[name] != value {
				return fmt.Errorf("agent_sandbox_environment_denied")
			}
		}
		if len(spec.Environment) != len(expected) {
			return fmt.Errorf("agent_sandbox_environment_denied")
		}
	}
	if len(spec.Command) > 128 || len(spec.HealthCommand) > 32 {
		return fmt.Errorf("worker command exceeds the bounded argument count")
	}
	for _, argument := range append(append([]string(nil), spec.Command...), spec.HealthCommand...) {
		if len(argument) > 4096 || strings.ContainsRune(argument, '\x00') {
			return fmt.Errorf("worker command argument is invalid")
		}
	}
	return nil
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
