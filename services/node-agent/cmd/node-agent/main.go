package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"teamaibox.local/node-agent/internal/agent"
	dockerruntime "teamaibox.local/node-agent/internal/docker"
	"teamaibox.local/node-agent/internal/server"
	"teamaibox.local/node-agent/internal/telemetry"
)

const nodeAgentRuntimeIdentity = 10001

func migrationRuntimeIdentityAllowed(euid, egid int) bool {
	return euid == nodeAgentRuntimeIdentity && egid == nodeAgentRuntimeIdentity
}

var errNodeGenerationAdvanced = errors.New("appliance generation advanced; restart required")

type jsonEventSink struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

type commandTypeRestrictedService struct {
	delegate server.CommandService
	allowed  map[string]bool
}

type phoneSignalDelegate interface {
	PhoneSignalEndpoint(context.Context, agent.PhoneMediaPayload) (agent.PhoneSignalEndpoint, error)
	PhoneSignalLive(agent.PhoneMediaPayload) bool
	DisconnectPhoneSignal(context.Context, agent.PhoneMediaPayload)
}

type phoneFileDelegate interface {
	TransferPhoneFile(context.Context, agent.CommandEnvelope, agent.AuthProof, io.Reader, io.Writer) error
}

type phoneCameraDelegate interface {
	ExecutePhoneCamera(context.Context, agent.CommandEnvelope, agent.AuthProof, io.Reader) (agent.PhoneCameraResult, error)
}

func (service commandTypeRestrictedService) ExecutePhoneCamera(ctx context.Context, envelope agent.CommandEnvelope, proof agent.AuthProof, input io.Reader) (agent.PhoneCameraResult, error) {
	delegate, ok := service.delegate.(phoneCameraDelegate)
	if !ok || envelope.Type != "android-phone.camera.input" || !service.allowed[envelope.Type] {
		return agent.PhoneCameraResult{}, errors.New("phone_camera_not_configured")
	}
	return delegate.ExecutePhoneCamera(ctx, envelope, proof, input)
}

type phoneADBDelegate interface {
	OpenPhoneADB(context.Context, agent.PhoneMediaPayload) (net.Conn, error)
}

func (service commandTypeRestrictedService) TransferPhoneFile(ctx context.Context, envelope agent.CommandEnvelope, proof agent.AuthProof, input io.Reader, output io.Writer) error {
	delegate, ok := service.delegate.(phoneFileDelegate)
	if !ok || envelope.Type != "android-phone.file.transfer" || !service.allowed[envelope.Type] {
		return errors.New("phone_files_not_configured")
	}
	// The real delegate still verifies the signed envelope and phone owner/run.
	return delegate.TransferPhoneFile(ctx, envelope, proof, input, output)
}

func (service commandTypeRestrictedService) OpenPhoneADB(ctx context.Context, payload agent.PhoneMediaPayload) (net.Conn, error) {
	delegate, ok := service.delegate.(phoneADBDelegate)
	if !ok || payload.Kind != "adb" || !service.allowed["android-phone.media.renew"] || !service.PhoneSignalLive(payload) {
		return nil, errors.New("phone_adb_not_configured")
	}
	return delegate.OpenPhoneADB(ctx, payload)
}

// The production command allowlist wraps Service. Preserve the phone gateway
// interface only when the same authenticated media-renew command is permitted.
// A restricted recovery/inspection Agent must never expose this channel.
func (service commandTypeRestrictedService) PhoneSignalEndpoint(ctx context.Context, payload agent.PhoneMediaPayload) (agent.PhoneSignalEndpoint, error) {
	delegate, ok := service.delegate.(phoneSignalDelegate)
	if !ok || !service.allowed["android-phone.media.renew"] {
		return agent.PhoneSignalEndpoint{}, errors.New("phone_signal_not_configured")
	}
	return delegate.PhoneSignalEndpoint(ctx, payload)
}
func (service commandTypeRestrictedService) PhoneSignalLive(payload agent.PhoneMediaPayload) bool {
	delegate, ok := service.delegate.(phoneSignalDelegate)
	return ok && service.allowed["android-phone.media.renew"] && delegate.PhoneSignalLive(payload)
}
func (service commandTypeRestrictedService) DisconnectPhoneSignal(ctx context.Context, payload agent.PhoneMediaPayload) {
	if delegate, ok := service.delegate.(phoneSignalDelegate); ok && service.allowed["android-phone.media.renew"] {
		delegate.DisconnectPhoneSignal(ctx, payload)
	}
}

func (service commandTypeRestrictedService) Handle(ctx context.Context, envelope agent.CommandEnvelope, proof agent.AuthProof) (agent.CommandResult, error) {
	if !service.allowed[envelope.Type] {
		return agent.CommandResult{}, errors.New("node_agent_command_type_not_allowed")
	}
	return service.delegate.Handle(ctx, envelope, proof)
}

func restrictedCommandService(delegate server.CommandService, raw string) (server.CommandService, error) {
	if delegate == nil {
		return nil, errors.New("node Agent command service is required")
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return delegate, nil
	}
	// Bound configuration bytes, not the number of installed capabilities.
	// Android and Windows handlers share this Agent and must coexist.
	if len(raw) > 64*1024 {
		return nil, errors.New("TEAMAIBOX_ALLOWED_COMMAND_TYPES configuration is too large")
	}
	pattern := regexp.MustCompile(`^[a-z][a-z0-9.-]{2,127}$`)
	allowed := map[string]bool{}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if !pattern.MatchString(item) || allowed[item] {
			return nil, errors.New("TEAMAIBOX_ALLOWED_COMMAND_TYPES must be a unique bounded command allowlist")
		}
		allowed[item] = true
	}
	return commandTypeRestrictedService{delegate: delegate, allowed: allowed}, nil
}

// protectedSetRecoveryOnlyAllowed is intentionally narrower than the normal
// HTTP command allowlist.  The one-shot recovery entrypoint is permitted only
// for an image whose environment has already been reduced to the read-only
// protected-set inspection surface.  It never starts the HTTP server,
// heartbeat/metric loops, protected maintenance recovery, appliance
// coordinators, or stale-Worker reconciliation.
func protectedSetRecoveryOnlyAllowed(raw string) bool {
	return strings.TrimSpace(raw) == "protected-set.transaction.inspect"
}

func (sink *jsonEventSink) Publish(event agent.WorkerEvent) error {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	return sink.encoder.Encode(map[string]any{"event": "node-agent.worker-event", "value": event})
}

func requiredEnvironment(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func initializeStateDirectory() error {
	directory, err := requiredEnvironment("TEAMAIBOX_NODE_STATE_DIR")
	if err != nil {
		return err
	}
	if !filepath.IsAbs(directory) || filepath.Clean(directory) == "/" {
		return errors.New("TEAMAIBOX_NODE_STATE_DIR must be a bounded absolute path")
	}
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		if err = os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
		info, err = os.Lstat(directory)
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("appliance state directory is invalid")
	}
	if os.Geteuid() != 0 {
		return errors.New("appliance state initialization requires container root")
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return err
	}
	return os.Chown(directory, nodeAgentRuntimeIdentity, nodeAgentRuntimeIdentity)
}

func nodeAgentPolicy(environment func(string) string) (agent.Policy, error) {
	return nodeAgentPolicyWithAuthorityReader(environment, agent.ReadNodeAgentAuthorityArtifact)
}

func nodeAgentPolicyWithAuthorityReader(
	environment func(string) string,
	readAuthority func(string, string, int64) ([]byte, error),
) (agent.Policy, error) {
	policy := agent.DefaultPolicy()
	raw := strings.TrimSpace(environment("TEAMAIBOX_ALLOWED_WORKER_PORTS"))
	if raw != "" {
		for _, item := range strings.Split(raw, ",") {
			port, err := strconv.Atoi(strings.TrimSpace(item))
			if err != nil || port < 1024 || port > 65535 || policy.AllowedPublishedPorts[port] {
				return agent.Policy{}, errors.New("TEAMAIBOX_ALLOWED_WORKER_PORTS must be a unique comma-separated unprivileged port allowlist")
			}
			policy.AllowedPublishedPorts[port] = true
		}
	}
	filename := strings.TrimSpace(environment("TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_FILE"))
	policyDigest := strings.TrimSpace(environment("TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_DIGEST"))
	migrationFilename := strings.TrimSpace(environment("TEAMAIBOX_LEGACY_PROTECTED_SET_MIGRATION_PLAN_FILE"))
	migrationDigest := strings.TrimSpace(environment("TEAMAIBOX_LEGACY_PROTECTED_SET_MIGRATION_PLAN_DIGEST"))
	qualificationFilename := strings.TrimSpace(environment("TEAMAIBOX_PROTECTED_SET_QUALIFICATION_POLICY_FILE"))
	qualificationDigest := strings.TrimSpace(environment("TEAMAIBOX_PROTECTED_SET_QUALIFICATION_POLICY_DIGEST"))
	if filename == "" {
		if policyDigest != "" || migrationFilename != "" || migrationDigest != "" || qualificationFilename != "" || qualificationDigest != "" {
			return agent.Policy{}, errors.New("protected-set authority requires the protected target policy")
		}
		return policy, nil
	}
	if !strings.HasPrefix(filename, "/") {
		return agent.Policy{}, errors.New("TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_FILE must be absolute")
	}
	if policyDigest == "" {
		return agent.Policy{}, errors.New("TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_DIGEST is required with the protected target policy")
	}
	rawPolicy, err := readAuthority(filename, policyDigest, 64<<10)
	if err != nil {
		return agent.Policy{}, fmt.Errorf("exclusive drain target policy authority is invalid: %w", err)
	}
	value := struct {
		SchemaVersion int                          `json:"schemaVersion"`
		Targets       []agent.ExclusiveDrainTarget `json:"targets"`
	}{}
	decoder := json.NewDecoder(bytes.NewReader(rawPolicy))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil || value.SchemaVersion != 1 || len(value.Targets) < 1 || len(value.Targets) > 32 {
		return agent.Policy{}, errors.New("exclusive drain target policy is invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return agent.Policy{}, errors.New("exclusive drain target policy is invalid")
	}
	keyPattern := regexp.MustCompile(`^[a-z][a-z0-9_.-]{2,127}$`)
	namePattern := regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	labelPattern := regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$`)
	imageIDPattern := regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	imageDigestReferencePattern := regexp.MustCompile(`^([a-z0-9][a-z0-9._:\/-]*@)?sha256:[a-f0-9]{64}$`)
	uuidPattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	containerNames := map[string]bool{}
	protectedWorkerIDs := map[string]bool{}
	protectedStages := map[int]string{}
	var protectedMaintenanceGeneration int64
	for _, target := range value.Targets {
		placement := agent.EffectivePlacementClass(target.PlacementClass)
		if !keyPattern.MatchString(target.TargetKey) || !namePattern.MatchString(target.ContainerName) ||
			len(target.RequiredLabels) > 16 || (len(target.RequiredLabels) == 0 && target.RequiredImageID == "") ||
			(target.RequiredImageID != "" && !imageIDPattern.MatchString(target.RequiredImageID)) ||
			(target.RequiredImageDigest != "" && !imageDigestReferencePattern.MatchString(target.RequiredImageDigest)) ||
			(target.RequiredConfigDigest != "" && !imageIDPattern.MatchString(target.RequiredConfigDigest)) ||
			(target.RequiredStartSpecDigest != "" && !imageIDPattern.MatchString(target.RequiredStartSpecDigest)) ||
			(placement != agent.PlacementWarmOptional && placement != agent.PlacementExclusiveBatch && placement != agent.PlacementProtectedResident) ||
			policy.ExclusiveDrainTargets[target.TargetKey].TargetKey != "" || containerNames[target.ContainerName] ||
			len(target.DependentContainers) > 8 {
			return agent.Policy{}, errors.New("exclusive drain target policy is invalid")
		}
		if placement == agent.PlacementProtectedResident &&
			(!uuidPattern.MatchString(target.WorkerID) || !uuidPattern.MatchString(target.ModelProfileID) ||
				target.RequiredImageID == "" || target.RequiredImageDigest == "" || target.RequiredConfigDigest == "" || target.RequiredStartSpecDigest == "" ||
				target.MaintenanceGeneration < 1 || target.StageOrder < 1 || target.StageOrder > 32 || protectedStages[target.StageOrder] != "" ||
				protectedWorkerIDs[target.WorkerID] || len(target.DependsOnWorkerIDs) > 31) {
			return agent.Policy{}, errors.New("protected resident target policy is invalid")
		}
		if placement != agent.PlacementProtectedResident &&
			(target.WorkerID != "" || target.ModelProfileID != "" || target.MaintenanceGeneration != 0 || target.StageOrder != 0 || len(target.DependsOnWorkerIDs) != 0 ||
				target.RequiredImageDigest != "" || target.RequiredConfigDigest != "" || target.RequiredStartSpecDigest != "") {
			return agent.Policy{}, errors.New("exclusive drain target policy is invalid")
		}
		containerNames[target.ContainerName] = true
		if placement == agent.PlacementProtectedResident {
			if protectedMaintenanceGeneration == 0 {
				protectedMaintenanceGeneration = target.MaintenanceGeneration
			} else if protectedMaintenanceGeneration != target.MaintenanceGeneration {
				return agent.Policy{}, errors.New("protected resident maintenance generation is inconsistent")
			}
			protectedWorkerIDs[target.WorkerID] = true
			protectedStages[target.StageOrder] = target.WorkerID
			seenDependencies := map[string]bool{}
			for _, dependencyWorkerID := range target.DependsOnWorkerIDs {
				if !uuidPattern.MatchString(dependencyWorkerID) || dependencyWorkerID == target.WorkerID || seenDependencies[dependencyWorkerID] {
					return agent.Policy{}, errors.New("protected resident target policy is invalid")
				}
				seenDependencies[dependencyWorkerID] = true
			}
		}
		for key, expected := range target.RequiredLabels {
			if !labelPattern.MatchString(key) || expected == "" || len(expected) > 256 || strings.ContainsRune(expected, '\x00') {
				return agent.Policy{}, errors.New("exclusive drain target policy is invalid")
			}
		}
		for _, dependent := range target.DependentContainers {
			if !namePattern.MatchString(dependent.ContainerName) || containerNames[dependent.ContainerName] ||
				len(dependent.RequiredLabels) > 16 ||
				(len(dependent.RequiredLabels) == 0 && dependent.RequiredImageID == "") ||
				(dependent.RequiredImageID != "" && !imageIDPattern.MatchString(dependent.RequiredImageID)) ||
				(dependent.RequiredImageDigest != "" && !imageDigestReferencePattern.MatchString(dependent.RequiredImageDigest)) ||
				(dependent.RequiredConfigDigest != "" && !imageIDPattern.MatchString(dependent.RequiredConfigDigest)) ||
				(placement == agent.PlacementProtectedResident &&
					(dependent.RequiredImageID == "" || dependent.RequiredImageDigest == "" || dependent.RequiredConfigDigest == "")) ||
				(placement != agent.PlacementProtectedResident &&
					(dependent.RequiredImageDigest != "" || dependent.RequiredConfigDigest != "")) {
				return agent.Policy{}, errors.New("exclusive drain target policy is invalid")
			}
			for key, expected := range dependent.RequiredLabels {
				if !labelPattern.MatchString(key) || expected == "" || len(expected) > 256 || strings.ContainsRune(expected, '\x00') {
					return agent.Policy{}, errors.New("exclusive drain target policy is invalid")
				}
			}
			containerNames[dependent.ContainerName] = true
		}
		policy.ExclusiveDrainTargets[target.TargetKey] = target
	}
	for _, target := range policy.ProtectedTargets() {
		for _, dependencyWorkerID := range target.DependsOnWorkerIDs {
			dependency, exists := policy.ProtectedTargetForWorker(dependencyWorkerID)
			if !exists || dependency.StageOrder >= target.StageOrder {
				return agent.Policy{}, errors.New("protected resident dependency policy is invalid")
			}
		}
	}
	policy.ProtectedTargetPolicyDigest = policyDigest
	if migrationFilename != "" || migrationDigest != "" {
		if migrationFilename == "" || migrationDigest == "" || policyDigest == "" {
			return agent.Policy{}, errors.New("legacy protected-set migration plan file and digest must be configured together")
		}
		if !migrationRuntimeIdentityAllowed(os.Geteuid(), os.Getegid()) {
			return agent.Policy{}, fmt.Errorf("legacy protected set migration requires the unprivileged Node Agent identity")
		}
		migration, loadErr := agent.LoadLegacyProtectedSetMigrationPolicy(migrationFilename, migrationDigest, policy)
		if loadErr != nil {
			return agent.Policy{}, loadErr
		}
		policy.LegacyProtectedSetMigration = migration
	}
	if qualificationFilename != "" || qualificationDigest != "" {
		if qualificationFilename == "" || qualificationDigest == "" || policyDigest == "" {
			return agent.Policy{}, errors.New("protected-set qualification policy file and digest must be configured together")
		}
		if !migrationRuntimeIdentityAllowed(os.Geteuid(), os.Getegid()) {
			return agent.Policy{}, fmt.Errorf("protected set qualification requires the unprivileged Node Agent identity")
		}
		qualification, loadErr := agent.LoadProtectedSetQualificationPolicy(qualificationFilename, qualificationDigest, policy)
		if loadErr != nil {
			return agent.Policy{}, loadErr
		}
		policy.ProtectedSetQualification = qualification
	}
	return policy, nil
}

// validateStartupMaterial performs a side-effect-free access/parse check for
// the five existing identity materials plus the digest-pinned protected policy
// and migration plan.  It intentionally does not open Docker, state, or a
// network listener and is used before the predecessor Agent is stopped.
func validateStartupMaterial() error {
	return validateStartupMaterialForMode(true)
}

// Normal runtime maintenance has no legacy migration authority. Validate it
// before stopping a healthy predecessor, without acquiring Docker authority
// or starting heartbeat/metric loops.
func validateStartupMaterialForMode(legacyMigration bool) error {
	if !migrationRuntimeIdentityAllowed(os.Geteuid(), os.Getegid()) {
		return errors.New("startup material validation requires the unprivileged Node Agent identity")
	}
	nodeID, generation, err := loadNodeIdentity()
	if err != nil {
		return err
	}
	keyFile, err := requiredEnvironment("TEAMAIBOX_COMMAND_KEY_FILE")
	if err != nil {
		return err
	}
	key, err := readBase64Key(keyFile)
	if err != nil {
		return err
	}
	for index := range key {
		key[index] = 0
	}
	certFile, err := requiredEnvironment("TEAMAIBOX_TLS_CERT_FILE")
	if err != nil {
		return err
	}
	privateKeyFile, err := requiredEnvironment("TEAMAIBOX_TLS_KEY_FILE")
	if err != nil {
		return err
	}
	if _, err := tls.LoadX509KeyPair(certFile, privateKeyFile); err != nil {
		return err
	}
	clientCAFile, err := requiredEnvironment("TEAMAIBOX_CLIENT_CA_FILE")
	if err != nil {
		return err
	}
	caPEM, err := os.ReadFile(clientCAFile)
	if err != nil {
		return err
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(caPEM) {
		return errors.New("client CA file contains no valid certificate")
	}
	policy, err := nodeAgentPolicy(os.Getenv)
	if err != nil {
		return err
	}
	if legacyMigration && policy.LegacyProtectedSetMigration == nil {
		return errors.New("startup material validation requires exact migration authority")
	}
	if !legacyMigration {
		if len(policy.ProtectedTargetsDependencyOrder()) != 6 {
			return errors.New("runtime startup validation requires the full protected set")
		}
		if q := policy.ProtectedSetQualification; q != nil && (q.NodeID != nodeID || q.NodeGeneration > generation) {
			return errors.New("runtime startup qualification node drifted")
		}
		filename := strings.TrimSpace(os.Getenv("TEAMAIBOX_APPLIANCE_RESTART_POLICY_FILE"))
		digest := strings.TrimSpace(os.Getenv("TEAMAIBOX_APPLIANCE_RESTART_POLICY_DIGEST"))
		if filename != "" || digest != "" {
			if _, err := agent.LoadApplianceRestartPolicy(filename, digest, nodeID, generation); err != nil && !errors.Is(err, agent.ErrApplianceRestartAuthorityExpired) {
				return err
			}
		}
	}
	return nil
}

func readBase64Key(filename string) ([]byte, error) {
	encoded, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil || len(key) < 32 {
		return nil, errors.New("command HMAC key file must contain at least 32 base64-encoded bytes")
	}
	return key, nil
}

func healthcheck() error {
	certFile, err := requiredEnvironment("TEAMAIBOX_HEALTH_CLIENT_CERT_FILE")
	if err != nil {
		return err
	}
	privateKeyFile, err := requiredEnvironment("TEAMAIBOX_HEALTH_CLIENT_KEY_FILE")
	if err != nil {
		return err
	}
	clientCAFile, err := requiredEnvironment("TEAMAIBOX_CLIENT_CA_FILE")
	if err != nil {
		return err
	}
	certificate, err := tls.LoadX509KeyPair(certFile, privateKeyFile)
	if err != nil {
		return err
	}
	caPEM, err := os.ReadFile(clientCAFile)
	if err != nil {
		return err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return errors.New("healthcheck CA file contains no valid certificate")
	}
	serverName := os.Getenv("TEAMAIBOX_TLS_SERVER_NAME")
	if serverName == "" {
		serverName = "node-agent"
	}
	client := &http.Client{
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS13, RootCAs: roots,
			Certificates: []tls.Certificate{certificate}, ServerName: serverName,
		}},
		Timeout: 3 * time.Second,
	}
	response, err := client.Get("https://127.0.0.1:9443/health/ready")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("node agent readiness returned %d", response.StatusCode)
	}
	return nil
}

var applianceIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func localListenAddress(value string) (string, error) {
	if value == "" {
		return "127.0.0.1:9443", nil
	}
	host, port, err := net.SplitHostPort(value)
	ip := net.ParseIP(host)
	portNumber, portErr := strconv.Atoi(port)
	if err != nil || ip == nil || !ip.IsLoopback() || portErr != nil || portNumber < 1 || portNumber > 65535 {
		return "", errors.New("TEAMAIBOX_LISTEN_ADDRESS must use a loopback IP and valid port")
	}
	return value, nil
}

func loadNodeIdentity() (string, int64, error) {
	filename := strings.TrimSpace(os.Getenv("TEAMAIBOX_NODE_IDENTITY_FILE"))
	if filename == "" {
		nodeID, err := requiredEnvironment("TEAMAIBOX_NODE_ID")
		if err != nil {
			return "", 0, err
		}
		generation := int64(1)
		if value := strings.TrimSpace(os.Getenv("TEAMAIBOX_NODE_GENERATION")); value != "" {
			generation, err = strconv.ParseInt(value, 10, 64)
			if err != nil || generation < 1 {
				return "", 0, errors.New("TEAMAIBOX_NODE_GENERATION must be a positive integer")
			}
		}
		if !applianceIDPattern.MatchString(nodeID) {
			return "", 0, errors.New("TEAMAIBOX_NODE_ID must identify this appliance with a UUID")
		}
		return nodeID, generation, nil
	}
	file, err := os.Open(filename)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	value := struct {
		NodeID                 string `json:"nodeId"`
		NodeKey                string `json:"nodeKey"`
		Generation             int64  `json:"generation"`
		CertificateFingerprint string `json:"certificateFingerprint"`
		CertificateNotAfter    string `json:"certificateNotAfter"`
	}{}
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil || !applianceIDPattern.MatchString(value.NodeID) || value.NodeKey == "" || value.Generation < 1 {
		return "", 0, errors.New("appliance identity file is invalid")
	}
	fingerprint, fingerprintError := hex.DecodeString(strings.TrimPrefix(value.CertificateFingerprint, "sha256:"))
	notAfter, notAfterError := time.Parse(time.RFC3339, value.CertificateNotAfter)
	if !strings.HasPrefix(value.CertificateFingerprint, "sha256:") || fingerprintError != nil || len(fingerprint) != 32 ||
		notAfterError != nil || !notAfter.After(time.Now()) {
		return "", 0, errors.New("appliance identity file is invalid")
	}
	generation := value.Generation
	if generationFile := strings.TrimSpace(os.Getenv("TEAMAIBOX_NODE_GENERATION_FILE")); generationFile != "" {
		if !strings.HasPrefix(generationFile, "/") {
			return "", 0, errors.New("appliance generation file must be absolute")
		}
		persisted, readError := os.ReadFile(generationFile)
		if readError == nil {
			parsed, parseError := strconv.ParseInt(strings.TrimSpace(string(persisted)), 10, 64)
			if parseError != nil || parsed < generation || string(persisted) != fmt.Sprintf("%d\n", parsed) {
				return "", 0, errors.New("appliance generation file is invalid")
			}
			generation = parsed
		} else if !errors.Is(readError, os.ErrNotExist) {
			return "", 0, readError
		}
	}
	return value.NodeID, generation, nil
}

func watchGenerationFile(ctx context.Context, filename string, current int64, interval time.Duration) error {
	if !filepath.IsAbs(filename) || filepath.Clean(filename) == "/" || current < 1 || interval < time.Millisecond || interval > 30*time.Second {
		return errors.New("appliance generation watcher configuration is invalid")
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		value, err := os.ReadFile(filename)
		if err == nil {
			parsed, parseError := strconv.ParseInt(strings.TrimSpace(string(value)), 10, 64)
			if parseError != nil || parsed < current || string(value) != fmt.Sprintf("%d\n", parsed) {
				return errors.New("appliance generation watcher observed invalid state")
			}
			if parsed > current {
				return fmt.Errorf("%w: %d -> %d", errNodeGenerationAdvanced, current, parsed)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func generationWatchCommand() error {
	filename, err := requiredEnvironment("TEAMAIBOX_NODE_GENERATION_FILE")
	if err != nil {
		return err
	}
	value, err := os.ReadFile(filename)
	if err != nil {
		return err
	}
	current, parseError := strconv.ParseInt(strings.TrimSpace(string(value)), 10, 64)
	if parseError != nil || current < 1 || string(value) != fmt.Sprintf("%d\n", current) {
		return errors.New("appliance generation watcher initial state is invalid")
	}
	return watchGenerationFile(context.Background(), filename, current, 100*time.Millisecond)
}

func applianceHeartbeatRunner(nodeID string, generation int64, certificate *tls.Certificate) (*telemetry.HeartbeatRunner, error) {
	origin := strings.TrimSpace(os.Getenv("TEAMAIBOX_APPLIANCE_ORIGIN"))
	if origin == "" {
		return nil, nil
	}
	if generation < 1 {
		return nil, errors.New("appliance generation is required for telemetry")
	}
	inventoryFile, err := requiredEnvironment("TEAMAIBOX_NODE_INVENTORY_FILE")
	if err != nil {
		return nil, err
	}
	caFile, err := requiredEnvironment("TEAMAIBOX_APPLIANCE_CA_FILE")
	if err != nil {
		return nil, err
	}
	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return nil, err
	}
	serverName, err := requiredEnvironment("TEAMAIBOX_APPLIANCE_SERVER_NAME")
	if err != nil {
		return nil, err
	}
	httpClient, err := telemetry.NewTLSClient(caPEM, certificate, serverName)
	if err != nil {
		return nil, err
	}
	client, err := telemetry.NewClient(origin, httpClient)
	if err != nil {
		return nil, err
	}
	provider, err := heartbeatInventoryProvider(inventoryFile, os.Getenv)
	if err != nil {
		return nil, err
	}
	return telemetry.NewHeartbeatRunner(client, provider, nodeID, generation, 15*time.Second, 40*time.Second)
}

func applianceMetricRunner(nodeID string, generation int64, certificate *tls.Certificate) (*telemetry.MetricRunner, error) {
	enabled := strings.TrimSpace(os.Getenv("TEAMAIBOX_NODE_METRICS_ENABLED"))
	if enabled == "" || enabled == "false" {
		return nil, nil
	}
	if enabled != "true" {
		return nil, errors.New("TEAMAIBOX_NODE_METRICS_ENABLED must be true or false")
	}
	origin, err := requiredEnvironment("TEAMAIBOX_APPLIANCE_ORIGIN")
	if err != nil {
		return nil, err
	}
	caFile, err := requiredEnvironment("TEAMAIBOX_APPLIANCE_CA_FILE")
	if err != nil {
		return nil, err
	}
	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return nil, err
	}
	serverName, err := requiredEnvironment("TEAMAIBOX_APPLIANCE_SERVER_NAME")
	if err != nil {
		return nil, err
	}
	httpClient, err := telemetry.NewTLSClient(caPEM, certificate, serverName)
	if err != nil {
		return nil, err
	}
	client, err := telemetry.NewClient(origin, httpClient)
	if err != nil {
		return nil, err
	}
	inventoryFile, err := requiredEnvironment("TEAMAIBOX_NODE_INVENTORY_FILE")
	if err != nil {
		return nil, err
	}
	inventory, err := (telemetry.FileInventoryProvider{Filename: inventoryFile}).Snapshot(context.Background())
	if err != nil {
		return nil, err
	}
	stateDirectory := filepath.Dir(strings.TrimSpace(os.Getenv("TEAMAIBOX_NODE_GENERATION_FILE")))
	if !filepath.IsAbs(stateDirectory) || filepath.Clean(stateDirectory) == "/" {
		return nil, errors.New("appliance metric state directory is invalid")
	}
	valueOr := func(name, fallback string) string {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
		return fallback
	}
	provider, err := telemetry.NewHostMetricProvider(telemetry.HostMetricConfig{
		ProcRoot: valueOr("TEAMAIBOX_HOST_PROC_ROOT", "/host/proc"), SysRoot: valueOr("TEAMAIBOX_HOST_SYS_ROOT", "/host/sys"),
		StorageAnchor: valueOr("TEAMAIBOX_HOST_STORAGE_ANCHOR", "/host/storage-anchor"), DockerSocket: "/var/run/docker.sock",
		ComposeProject: strings.TrimSpace(os.Getenv("TEAMAIBOX_METRIC_COMPOSE_PROJECT")), InventoryFile: inventoryFile,
		RetiredCoreServices: strings.FieldsFunc(os.Getenv("TEAMAIBOX_METRIC_RETIRED_CORE_SERVICES"), func(r rune) bool { return r == ',' || r == ' ' }),
		SequenceFile:        filepath.Join(stateDirectory, "metric-sequence"), AgentVersion: inventory.AgentVersion, NodeID: nodeID,
		SampleWindow: 500 * time.Millisecond, NvidiaSMI: valueOr("TEAMAIBOX_NVIDIA_SMI", "/usr/bin/nvidia-smi"),
	})
	if err != nil {
		return nil, err
	}
	return telemetry.NewMetricRunner(client, provider, nodeID, generation, 15*time.Second)
}

func run() error {
	nodeID, nodeGeneration, err := loadNodeIdentity()
	if err != nil {
		return err
	}
	keyID, err := requiredEnvironment("TEAMAIBOX_COMMAND_KEY_ID")
	if err != nil {
		return err
	}
	keyFile, err := requiredEnvironment("TEAMAIBOX_COMMAND_KEY_FILE")
	if err != nil {
		return err
	}
	certFile, err := requiredEnvironment("TEAMAIBOX_TLS_CERT_FILE")
	if err != nil {
		return err
	}
	privateKeyFile, err := requiredEnvironment("TEAMAIBOX_TLS_KEY_FILE")
	if err != nil {
		return err
	}
	clientCAFile, err := requiredEnvironment("TEAMAIBOX_CLIENT_CA_FILE")
	if err != nil {
		return err
	}
	key, err := readBase64Key(keyFile)
	if err != nil {
		return err
	}
	authenticator, err := agent.NewAuthenticator(nodeID, map[string][]byte{keyID: key})
	if err != nil {
		return err
	}
	for index := range key {
		key[index] = 0
	}
	runtime, err := dockerruntime.NewEngineRuntime("/var/run/docker.sock")
	if err != nil {
		return err
	}
	policy, err := nodeAgentPolicy(os.Getenv)
	if err != nil {
		return err
	}
	stateDirectory, err := requiredEnvironment("TEAMAIBOX_NODE_STATE_DIR")
	if err != nil || !filepath.IsAbs(stateDirectory) || filepath.Clean(stateDirectory) == "/" {
		return errors.New("TEAMAIBOX_NODE_STATE_DIR must be a bounded absolute path")
	}
	maintenance, err := agent.NewProtectedMaintenanceCoordinator(nodeID, nodeGeneration,
		filepath.Join(stateDirectory, "protected-maintenance-journal.v1.json"), policy, runtime)
	if err != nil {
		return err
	}
	if err := maintenance.Recover(context.Background(), time.Now().UTC()); err != nil {
		return err
	}
	transition, err := agent.NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration,
		filepath.Join(stateDirectory, "protected-set-transition-journal.v1.json"), policy, runtime)
	if err != nil {
		return err
	}
	if err := transition.Recover(context.Background(), time.Now().UTC()); err != nil {
		return err
	}
	var applianceRestart *agent.ApplianceRestartCoordinator
	restartPolicyFile := strings.TrimSpace(os.Getenv("TEAMAIBOX_APPLIANCE_RESTART_POLICY_FILE"))
	restartPolicyDigest := strings.TrimSpace(os.Getenv("TEAMAIBOX_APPLIANCE_RESTART_POLICY_DIGEST"))
	if restartPolicyFile != "" || restartPolicyDigest != "" {
		if restartPolicyFile == "" || restartPolicyDigest == "" {
			return errors.New("appliance restart policy file and digest must be configured together")
		}
		restartPolicy, loadErr := agent.LoadApplianceRestartPolicy(restartPolicyFile, restartPolicyDigest, nodeID, nodeGeneration)
		if errors.Is(loadErr, agent.ErrApplianceRestartAuthorityExpired) {
			log.Print("appliance_restart_authority_refresh_required: node connected with restart operation disabled")
		} else if loadErr != nil {
			return loadErr
		} else {
			applianceRestart, err = agent.NewApplianceRestartCoordinator(nodeID, nodeGeneration,
				filepath.Join(stateDirectory, "appliance-restart-journal.v1.json"), restartPolicy, runtime)
			if err != nil {
				return err
			}
		}
	}
	if _, err := runtime.RemoveStaleEphemeralNodeWorkers(context.Background(), nodeID, nodeGeneration); err != nil {
		return err
	}
	certificate, err := tls.LoadX509KeyPair(certFile, privateKeyFile)
	if err != nil {
		return err
	}
	if len(certificate.Certificate) < 1 {
		return errors.New("appliance TLS certificate is incomplete")
	}
	certificateLeaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil || len(certificateLeaf.DNSNames) != 1 {
		return errors.New("appliance TLS certificate DNS identity is invalid")
	}
	caPEM, err := os.ReadFile(clientCAFile)
	if err != nil {
		return err
	}
	events := &jsonEventSink{encoder: json.NewEncoder(os.Stdout)}
	commandService, err := agent.NewService(nodeID, nodeGeneration, authenticator, policy, runtime, events)
	if err != nil {
		return err
	}
	if err := commandService.ConfigureProtectedMaintenance(maintenance); err != nil {
		return err
	}
	if err := commandService.ConfigureProtectedSetTransition(transition); err != nil {
		return err
	}
	if applianceRestart != nil {
		if err := commandService.ConfigureApplianceRestart(applianceRestart); err != nil {
			return err
		}
	}
	var phoneBaseline *telemetry.PhoneBaselineSampler
	baselineEnabled := os.Getenv("TEAMAIBOX_PHONE_BASELINE_ENABLED")
	switch baselineEnabled {
	case "", "false":
	case "true":
		phoneProcRoot := strings.TrimSpace(os.Getenv("TEAMAIBOX_HOST_PROC_ROOT"))
		if phoneProcRoot == "" {
			phoneProcRoot = "/host/proc"
		}
		phoneBaseline, err = telemetry.NewPhoneBaselineSampler(phoneProcRoot, nodeID, nodeGeneration)
		if err != nil {
			return err
		}
		if err := phoneBaseline.ConfigureWorkers("/var/run/docker.sock"); err != nil {
			return err
		}
		if err := commandService.ConfigurePhoneBaseline(phoneBaseline); err != nil {
			return err
		}
	default:
		return errors.New("TEAMAIBOX_PHONE_BASELINE_ENABLED must be true or false")
	}
	var phoneMemory agent.PhoneMemorySource
	if phoneBaseline != nil {
		phoneMemory = phoneBaseline
	}
	closePhones, err := configureInstalledPhones(strings.TrimSpace(os.Getenv("TEAMAIBOX_PHONES_CONFIG_FILE")), nodeID,
		nodeGeneration, stateDirectory, runtime, commandService, phoneMemory)
	if err != nil {
		return err
	}
	defer closePhones()
	closeComputers, err := configureInstalledComputers(strings.TrimSpace(os.Getenv("TEAMAIBOX_COMPUTERS_CONFIG_FILE")), nodeID,
		nodeGeneration, stateDirectory, runtime, commandService, phoneMemory)
	if err != nil {
		return err
	}
	defer closeComputers()
	handlerService, err := restrictedCommandService(commandService, os.Getenv("TEAMAIBOX_ALLOWED_COMMAND_TYPES"))
	if err != nil {
		return err
	}
	handler, err := server.NewHandler(handlerService, runtime)
	if err != nil {
		return err
	}

	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(caPEM) {
		return errors.New("client CA file contains no valid certificate")
	}
	tlsConfig := server.TLSConfig(clientCAs)
	tlsConfig.Certificates = []tls.Certificate{certificate}
	address, err := localListenAddress(os.Getenv("TEAMAIBOX_LISTEN_ADDRESS"))
	if err != nil {
		return err
	}
	httpServer := &http.Server{
		Addr: address, Handler: handler, TLSConfig: tlsConfig,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		// An accepted protected-set transition may cold-start six models in
		// dependency order. Its coordinator and immutable health contracts are
		// individually bounded; the HTTP response window must not cancel that
		// durable transaction before those tighter bounds expire.
		WriteTimeout: 4*time.Hour + 5*time.Minute, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 16 << 10,
	}
	heartbeats, err := applianceHeartbeatRunner(nodeID, nodeGeneration, &certificate)
	if err != nil {
		return err
	}
	var metrics *telemetry.MetricRunner
	if heartbeats != nil {
		metrics, err = applianceMetricRunner(nodeID, nodeGeneration, &certificate)
		if err != nil {
			return err
		}
	}
	generationFilename := strings.TrimSpace(os.Getenv("TEAMAIBOX_NODE_GENERATION_FILE"))
	if generationFilename != "" && heartbeats != nil {
		if err := heartbeats.SetGenerationReconciler(telemetry.IdentityGenerationFile{Filename: generationFilename}); err != nil {
			return err
		}
		if metrics != nil {
			if err := metrics.SetGenerationReconciler(telemetry.IdentityGenerationFile{Filename: generationFilename}); err != nil {
				return err
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if phoneBaseline != nil {
		go phoneBaseline.Run(ctx)
	}
	go commandService.RunPhoneProtection(ctx, nil)
	serverFailure := make(chan error, 1)
	var heartbeatFailure <-chan error
	var metricFailure <-chan error
	var generationFailure <-chan error
	go func() { serverFailure <- httpServer.ListenAndServeTLS("", "") }()
	if applianceRestart != nil {
		go func() {
			state, recoveryErr := applianceRestart.ReconcileAfterStart(ctx)
			if recoveryErr != nil {
				log.Printf("appliance restart startup recovery: %v", recoveryErr)
			} else if state.Phase == "complete" {
				log.Printf("appliance_restart_recovered: restartId=%s", state.RestartID)
			}
		}()
	}
	if heartbeats != nil {
		failures := make(chan error, 1)
		heartbeatFailure = failures
		go func() { failures <- heartbeats.Run(ctx) }()
	}
	if metrics != nil {
		failures := make(chan error, 1)
		metricFailure = failures
		go func() { failures <- metrics.Run(ctx) }()
	}
	if generationFilename != "" {
		failures := make(chan error, 1)
		generationFailure = failures
		go func() { failures <- watchGenerationFile(ctx, generationFilename, nodeGeneration, 2*time.Second) }()
	}
	shutdown := func() {
		cancel()
		shutdownContext, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		_ = httpServer.Shutdown(shutdownContext)
	}
	select {
	case err = <-serverFailure:
		cancel()
	case err = <-heartbeatFailure:
		shutdown()
	case err = <-metricFailure:
		shutdown()
	case err = <-generationFailure:
		shutdown()
	}
	return err
}

// recoverProtectedSetOnly resumes one already-fsynced protected-set journal
// and exits.  It cannot accept a new transaction and deliberately omits every
// unrelated startup-time mutation performed by the long-running Agent.
func recoverProtectedSetOnly() error {
	if !protectedSetRecoveryOnlyAllowed(os.Getenv("TEAMAIBOX_ALLOWED_COMMAND_TYPES")) {
		return errors.New("protected-set recovery-only command allowlist is invalid")
	}
	nodeID, nodeGeneration, err := loadNodeIdentity()
	if err != nil {
		return err
	}
	runtime, err := dockerruntime.NewEngineRuntime("/var/run/docker.sock")
	if err != nil {
		return err
	}
	policy, err := nodeAgentPolicy(os.Getenv)
	if err != nil {
		return err
	}
	stateDirectory, err := requiredEnvironment("TEAMAIBOX_NODE_STATE_DIR")
	if err != nil || !filepath.IsAbs(stateDirectory) || filepath.Clean(stateDirectory) == "/" {
		return errors.New("TEAMAIBOX_NODE_STATE_DIR must be a bounded absolute path")
	}
	transition, err := agent.NewProtectedSetTransitionCoordinator(nodeID, nodeGeneration,
		filepath.Join(stateDirectory, "protected-set-transition-journal.v1.json"), policy, runtime)
	if err != nil {
		return err
	}
	return transition.Recover(context.Background(), time.Now().UTC())
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "validate-runtime-startup" {
		if err := validateStartupMaterialForMode(false); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "execute-protected-generation-recovery" {
		if err := executeProtectedGenerationRecovery(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "execute-protected-authority-reconciliation" {
		if err := executeProtectedAuthorityReconciliation(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "validate-protected-authority-reconciliation-input" {
		if err := validateProtectedAuthorityReconciliationInput(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "maintain-appliance-heartbeat" {
		if err := maintainApplianceHeartbeat(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "validate-startup-material" {
		if err := validateStartupMaterial(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "init-state" {
		if err := initializeStateDirectory(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		if err := healthcheck(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "generation-watch" {
		if err := generationWatchCommand(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "recover-protected-set" {
		if err := recoverProtectedSetOnly(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := run(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
