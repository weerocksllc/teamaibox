package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type commandRecord struct {
	digest     string
	inProgress bool
	result     CommandResult
}

type Service struct {
	nodeID               string
	nodeGeneration       int64
	authenticator        *Authenticator
	policy               Policy
	runtime              Runtime
	events               EventSink
	now                  func() time.Time
	mu                   sync.Mutex
	commands             map[string]commandRecord
	fences               map[string]uint64
	sequence             uint64
	maintenanceGate      sync.RWMutex
	protectedMaintenance *ProtectedMaintenanceCoordinator
	protectedTransition  *ProtectedSetTransitionCoordinator
	applianceRestart     *ApplianceRestartCoordinator
	phoneBaseline        PhoneBaselineProvider
	phoneStorage         PhoneStorageProvider
	phones               PhoneCommandRuntime
	computers            ComputerCommandRuntime
	phoneSignals         map[string]phoneSignalLease
	phoneFiles           map[string]time.Time
	phoneFileActive      map[string]bool
	phoneCameraImages    map[string]time.Time
	phoneCameraActive    map[string]bool
}

type PhoneBaselineProvider interface {
	PhoneBaseline(context.Context) (json.RawMessage, error)
}

func (s *Service) ConfigurePhoneBaseline(provider PhoneBaselineProvider) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if provider == nil || s.phoneBaseline != nil || len(s.commands) != 0 {
		return errors.New("phone_baseline_configuration_locked")
	}
	s.phoneBaseline = provider
	return nil
}

var ErrStaleNodeGeneration = errors.New("stale node generation")
var regexpDockerAPIVersion = regexp.MustCompile(`^[0-9]{1,3}\.[0-9]{1,3}$`)

func validSecureBootState(value string) bool {
	return value == "enabled" || value == "disabled" || value == "unknown"
}

func validApplicationPath(value string) bool {
	if len(value) < 10 || len(value) > 4096 || strings.ContainsRune(value, '\x00') || strings.Contains(value, "#") {
		return false
	}
	parsed, err := url.ParseRequestURI(value)
	return err == nil && !parsed.IsAbs() && parsed.Host == "" && strings.HasPrefix(parsed.Path, "/plugins/")
}

func stableOperationErrorCode(commandType string, operationErr error) string {
	code := operationErr.Error()
	valid := len(code) >= 3 && len(code) <= 64 && code[0] >= 'a' && code[0] <= 'z'
	for _, value := range code {
		if !((value >= 'a' && value <= 'z') || (value >= '0' && value <= '9') || value == '_') {
			valid = false
			break
		}
	}
	if valid {
		return code
	}
	fallback := map[string]string{
		"worker.start":                      "worker_start_failed",
		"worker.stop":                       "worker_stop_failed",
		"worker.health":                     "worker_health_failed",
		"worker.control":                    "worker_control_failed",
		"worker.application.fetch":          "worker_application_fetch_failed",
		"worker.conflicts.list":             "worker_conflicts_list_failed",
		"worker.conflict.drain":             "worker_conflict_drain_failed",
		"worker.conflict.restore":           "worker_conflict_restore_failed",
		"agent.sandbox.file.project":        "agent_sandbox_file_project_failed",
		"maintenance.preflight":             "maintenance_preflight_failed",
		"maintenance.transaction.execute":   "protected_maintenance_failed",
		"protected-set.transaction.execute": "protected_set_transition_failed",
		"protected-set.transaction.inspect": "protected_set_transition_inspection_failed",
		"appliance.runtime.restart":         "appliance_restart_failed",
		"appliance.inspect":                 "appliance_inspection_failed",
	}
	if value := fallback[commandType]; value != "" {
		return value
	}
	return "node_agent_command_failed"
}

func NewService(nodeID string, nodeGeneration int64, authenticator *Authenticator, policy Policy, runtime Runtime, events EventSink) (*Service, error) {
	if !uuidPattern.MatchString(nodeID) || nodeGeneration < 1 || authenticator == nil || runtime == nil || events == nil {
		return nil, fmt.Errorf("node identity, authenticator, runtime, and event sink are required")
	}
	return &Service{
		nodeID: nodeID, nodeGeneration: nodeGeneration, authenticator: authenticator, policy: policy,
		runtime: runtime, events: events, now: time.Now,
		commands: make(map[string]commandRecord), fences: make(map[string]uint64),
	}, nil
}

func (s *Service) SetClock(clock func() time.Time) { s.now = clock }

func (s *Service) ConfigureProtectedMaintenance(coordinator *ProtectedMaintenanceCoordinator) error {
	if coordinator == nil || coordinator.nodeID != s.nodeID || coordinator.nodeGeneration != s.nodeGeneration {
		return fmt.Errorf("protected_maintenance_configuration_invalid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.protectedMaintenance != nil || len(s.commands) != 0 {
		return fmt.Errorf("protected_maintenance_configuration_locked")
	}
	s.protectedMaintenance = coordinator
	return nil
}

func (s *Service) ConfigureProtectedSetTransition(coordinator *ProtectedSetTransitionCoordinator) error {
	if coordinator == nil || coordinator.nodeID != s.nodeID || coordinator.nodeGeneration != s.nodeGeneration {
		return fmt.Errorf("protected_set_transition_configuration_invalid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.protectedTransition != nil || len(s.commands) != 0 {
		return fmt.Errorf("protected_set_transition_configuration_locked")
	}
	s.protectedTransition = coordinator
	return nil
}

func (s *Service) ConfigureApplianceRestart(coordinator *ApplianceRestartCoordinator) error {
	if coordinator == nil || coordinator.nodeID != s.nodeID || coordinator.nodeGeneration != s.nodeGeneration {
		return fmt.Errorf("appliance_restart_configuration_invalid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.applianceRestart != nil || len(s.commands) != 0 {
		return fmt.Errorf("appliance_restart_configuration_locked")
	}
	s.applianceRestart = coordinator
	return nil
}

func commandDigest(envelope CommandEnvelope) string {
	body, _ := json.Marshal(envelope)
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

func newUUID() string {
	var value [16]byte
	_, _ = rand.Read(value[:])
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:]
}

func (s *Service) begin(envelope CommandEnvelope) (CommandResult, bool, error) {
	digest := commandDigest(envelope)
	s.mu.Lock()
	defer s.mu.Unlock()
	if record, exists := s.commands[envelope.CommandID]; exists {
		if record.digest != digest {
			return CommandResult{}, false, fmt.Errorf("command_id_conflict")
		}
		if record.inProgress {
			return CommandResult{}, false, fmt.Errorf("command_in_progress")
		}
		// A self-restart schedule is intentionally replayable while the same
		// process is still alive. The durable coordinator either re-arms the
		// exact policy-bound restart or returns the completed post-restart state.
		if envelope.Type == "appliance.runtime.restart" && record.result.Status == "restart-required" {
			s.commands[envelope.CommandID] = commandRecord{digest: digest, inProgress: true}
			return CommandResult{}, false, nil
		}
		// Phone results describe live guests. Re-check the persistent phone
		// fence even for an identical retry, rather than returning a cached
		// "running" response after that run was stopped or superseded.
		if !strings.HasPrefix(envelope.Type, "android-phone.") && !strings.HasPrefix(envelope.Type, "virtual-computer.") {
			return record.result, true, nil
		}
	}
	if envelope.LeaseID == "" || envelope.FencingToken == 0 {
		return CommandResult{}, false, fmt.Errorf("lease_and_fence_required")
	}
	if previous := s.fences[envelope.LeaseID]; envelope.FencingToken < previous {
		return CommandResult{}, false, fmt.Errorf("stale_fencing_token")
	} else if envelope.FencingToken > previous {
		s.fences[envelope.LeaseID] = envelope.FencingToken
	}
	s.commands[envelope.CommandID] = commandRecord{digest: digest, inProgress: true}
	return CommandResult{}, false, nil
}

func (s *Service) finish(envelope CommandEnvelope, result CommandResult) CommandResult {
	s.mu.Lock()
	s.commands[envelope.CommandID] = commandRecord{digest: commandDigest(envelope), result: result}
	s.mu.Unlock()
	return result
}

func (s *Service) publish(envelope CommandEnvelope, workerID, attemptID, eventType string, payload any) {
	body, _ := json.Marshal(payload)
	s.mu.Lock()
	s.sequence++
	sequence := s.sequence
	s.mu.Unlock()
	_ = s.events.Publish(WorkerEvent{
		ProtocolVersion: 1, EventID: newUUID(), Sequence: sequence,
		NodeID: s.nodeID, WorkerID: workerID, AttemptID: attemptID,
		LeaseID: envelope.LeaseID, FencingToken: envelope.FencingToken,
		Type: eventType, OccurredAt: s.now().UTC(), CorrelationID: envelope.CorrelationID,
		Payload: body,
	})
}

func (s *Service) Handle(ctx context.Context, envelope CommandEnvelope, proof AuthProof) (CommandResult, error) {
	now := s.now().UTC()
	if err := s.authenticator.Verify(envelope, proof, now); err != nil {
		return CommandResult{}, err
	}
	if envelope.NodeGeneration != s.nodeGeneration {
		return CommandResult{}, ErrStaleNodeGeneration
	}
	if !uuidPattern.MatchString(envelope.CommandID) || envelope.Idempotency == "non_replayable" {
		return CommandResult{}, fmt.Errorf("invalid_command_identity_or_replay_policy")
	}
	if strings.HasPrefix(envelope.Type, "android-phone.media.") {
		return s.handlePhoneMedia(ctx, envelope)
	}
	if previous, replay, err := s.begin(envelope); err != nil {
		return CommandResult{}, err
	} else if replay {
		return previous, nil
	}
	ordinaryMutation := false
	switch envelope.Type {
	case "worker.start", "worker.stop", "worker.control", "worker.conflict.drain", "worker.conflict.restore",
		"android-phone.provision", "android-phone.start", "android-phone.stop", "android-phone.delete",
		"virtual-computer.create", "virtual-computer.start", "virtual-computer.shutdown", "virtual-computer.delete":
		ordinaryMutation = true
	}
	executionNow := now
	if envelope.Type == "maintenance.transaction.execute" || envelope.Type == "protected-set.transaction.execute" ||
		envelope.Type == "appliance.runtime.restart" {
		s.maintenanceGate.Lock()
		defer s.maintenanceGate.Unlock()
		// Authentication happens before waiting for the exclusive maintenance
		// gate, but the bounded maintenance authorization must still be live at
		// the instant mutation can begin. Never carry the pre-wait clock across
		// this serialization boundary.
		executionNow = s.now().UTC()
	} else if ordinaryMutation || envelope.Type == "protected-set.transaction.inspect" || envelope.Type == "appliance.inspect" {
		s.maintenanceGate.RLock()
		defer s.maintenanceGate.RUnlock()
	}

	result := CommandResult{
		CommandID: envelope.CommandID, NodeID: s.nodeID, NodeGeneration: s.nodeGeneration, Type: envelope.Type,
		Status: "failed", FencingToken: envelope.FencingToken,
		CompletedAt: now, CorrelationID: envelope.CorrelationID,
	}
	var operationErr error
	if ordinaryMutation && s.protectedMaintenance != nil && s.protectedMaintenance.BlocksOrdinaryMutation() {
		operationErr = fmt.Errorf("protected_maintenance_recovery_incomplete")
	}
	if ordinaryMutation && s.protectedTransition != nil && s.protectedTransition.BlocksOrdinaryMutation() {
		operationErr = fmt.Errorf("protected_set_transition_recovery_incomplete")
	}
	if envelope.Type == "maintenance.transaction.execute" && s.protectedTransition != nil && s.protectedTransition.BlocksOrdinaryMutation() {
		operationErr = fmt.Errorf("protected_set_transition_recovery_incomplete")
	}
	if envelope.Type == "protected-set.transaction.execute" && s.protectedMaintenance != nil && s.protectedMaintenance.BlocksOrdinaryMutation() {
		operationErr = fmt.Errorf("protected_maintenance_recovery_incomplete")
	}
	if envelope.Type != "appliance.runtime.restart" && s.applianceRestart != nil && s.applianceRestart.BlocksOrdinaryMutation() {
		operationErr = fmt.Errorf("appliance_restart_recovery_incomplete")
	}
	if envelope.Type == "appliance.runtime.restart" &&
		((s.protectedMaintenance != nil && s.protectedMaintenance.BlocksOrdinaryMutation()) ||
			(s.protectedTransition != nil && s.protectedTransition.BlocksOrdinaryMutation())) {
		operationErr = fmt.Errorf("appliance_restart_maintenance_conflict")
	}
	if operationErr != nil {
		result.ErrorCode = stableOperationErrorCode(envelope.Type, operationErr)
		result.Retryable = false
		s.publish(envelope, "", "", "worker.command_failed", map[string]string{"code": result.ErrorCode})
		result.CompletedAt = s.now().UTC()
		return s.finish(envelope, result), nil
	}

	switch envelope.Type {
	case "virtual-computer.create", "virtual-computer.start", "virtual-computer.shutdown", "virtual-computer.delete", "virtual-computer.inspect":
		action := strings.TrimPrefix(envelope.Type, "virtual-computer.")
		payload, err := decodeComputerCommand(envelope.Payload, action)
		if err != nil || payload.NodeID != s.nodeID || envelope.LeaseID != payload.ComputerID || envelope.FencingToken != payload.Generation+1 {
			operationErr = errors.New("computer_payload_invalid")
			break
		}
		if s.computers == nil {
			operationErr = errors.New("computer_runtime_not_configured")
			break
		}
		remaining := envelope.DeadlineAt.Sub(s.now().UTC())
		if remaining <= 0 {
			operationErr = errors.New("computer_command_expired")
			break
		}
		computerContext, cancel := context.WithTimeout(ctx, remaining)
		state, err := s.computers.ExecuteComputer(computerContext, action, payload, Ownership{NodeID: s.nodeID, NodeGeneration: s.nodeGeneration,
			CommandID: envelope.CommandID, CommandDigest: commandDigest(envelope), LeaseID: envelope.LeaseID, FencingToken: envelope.FencingToken})
		cancel()
		if err == nil {
			err = validateComputerResult(action, payload, state)
		}
		if err != nil {
			operationErr = err
			break
		}
		result.Status = "succeeded"
		result.Payload, _ = json.Marshal(state)
		s.publish(envelope, "", "", "virtual-computer."+action, map[string]string{"computerId": payload.ComputerID, "operationId": payload.OperationID})
	case "android-phone.provision", "android-phone.start", "android-phone.stop", "android-phone.delete", "android-phone.inspect":
		action := strings.TrimPrefix(envelope.Type, "android-phone.")
		payload, err := decodePhoneCommand(envelope.Payload, action)
		if err != nil || envelope.LeaseID != payload.PhoneID || envelope.FencingToken != payload.Generation+1 {
			operationErr = errors.New("phone_payload_invalid")
			break
		}
		if s.phones == nil {
			operationErr = errors.New("phone_runtime_not_configured")
			break
		}
		remaining := envelope.DeadlineAt.Sub(s.now().UTC())
		if remaining <= 0 {
			operationErr = errors.New("phone_command_expired")
			break
		}
		phoneContext, cancel := context.WithTimeout(ctx, remaining)
		state, err := s.phones.ExecutePhone(phoneContext, action, payload, Ownership{NodeID: s.nodeID, NodeGeneration: s.nodeGeneration,
			CommandID: envelope.CommandID, CommandDigest: commandDigest(envelope), LeaseID: envelope.LeaseID,
			FencingToken: envelope.FencingToken})
		cancel()
		if err == nil {
			err = validatePhoneResult(action, payload, state)
		}
		if err != nil {
			operationErr = err
			break
		}
		result.Status = "succeeded"
		result.Payload, _ = json.Marshal(state)
		s.publish(envelope, "", "", "android-phone."+action, map[string]string{"phoneId": payload.PhoneID, "operationId": payload.OperationID})
	case "virtual-computer.baseline":
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil || payload == nil || len(payload) != 0 {
			operationErr = errors.New("computer_baseline_payload_invalid")
			break
		}
		provider, ok := s.computers.(ComputerBaselineProvider)
		if !ok {
			operationErr = errors.New("computer_baseline_unavailable")
			break
		}
		result.Payload, operationErr = provider.ComputerBaseline(ctx)
		if operationErr == nil {
			result.Status = "succeeded"
		}
	case "android-phone.baseline":
		// The controller can read the prepared window; no request paths or commands are accepted.
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil || payload == nil || len(payload) != 0 {
			operationErr = errors.New("phone_baseline_payload_invalid")
			break
		}
		if s.phoneBaseline == nil {
			operationErr = errors.New("phone_baseline_not_configured")
			break
		}
		result.Payload, operationErr = s.phoneBaseline.PhoneBaseline(ctx)
		if operationErr == nil {
			result.Status = "succeeded"
		}
	case "android-phone.storage":
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil || payload == nil || len(payload) != 0 {
			operationErr = errors.New("phone_storage_payload_invalid")
			break
		}
		if s.phoneStorage == nil {
			operationErr = errors.New("phone_storage_not_configured")
			break
		}
		result.Payload, operationErr = s.phoneStorage.PhoneStorage(ctx)
		if operationErr == nil {
			result.Status = "succeeded"
		}
	case "android-phone.camera.usb.inventory":
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil || payload == nil || len(payload) != 0 {
			operationErr = errors.New("phone_camera_payload_invalid")
			break
		}
		provider, ok := s.phones.(PhoneUsbInventoryProvider)
		if !ok {
			operationErr = errors.New("phone_camera_usb_not_configured")
			break
		}
		result.Payload, operationErr = provider.PhoneUsbInventory(ctx)
		if operationErr == nil {
			result.Status = "succeeded"
		}
	case "worker.start":
		var payload WorkerStartPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			operationErr = fmt.Errorf("invalid_worker_start_payload")
			break
		}
		result.WorkerID = payload.WorkerID
		if err := s.policy.ValidateStart(payload); err != nil {
			operationErr = err
			break
		}
		// A protected Worker is created or recovered only by the complete-set
		// transaction. A signed ordinary worker.start is still ordinary authority
		// and must not bypass aggregate admission, ordering, or rollback.
		if IsProtectedPlacement(payload.PlacementClass) {
			operationErr = fmt.Errorf("protected_resident_operation_denied")
			break
		}
		state, err := s.runtime.StartWorker(ctx, payload, Ownership{
			NodeID: s.nodeID, NodeGeneration: s.nodeGeneration, CommandID: envelope.CommandID, LeaseID: envelope.LeaseID,
			CommandDigest: commandDigest(envelope), FencingToken: envelope.FencingToken, AttemptID: payload.AttemptID,
		})
		if err != nil {
			operationErr = err
			break
		}
		result.Status, result.ContainerID = "succeeded", state.ContainerID
		result.Payload, _ = json.Marshal(state)
		s.publish(envelope, payload.WorkerID, payload.AttemptID, "worker.started", state)
	case "appliance.inspect":
		var payload ApplianceInspectPayload
		decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil || !uuidPattern.MatchString(payload.InspectionID) ||
			payload.InspectionID != envelope.CommandID || payload.InspectionID != envelope.LeaseID {
			operationErr = fmt.Errorf("invalid_appliance_inspection")
			break
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			operationErr = fmt.Errorf("invalid_appliance_inspection")
			break
		}
		runtime, _ := s.runtime.(ApplianceInspectionRuntime)
		ok := runtime != nil
		if !ok {
			operationErr = fmt.Errorf("appliance_inspection_not_configured")
			break
		}
		identity, err := runtime.InspectAppliance(ctx, Ownership{NodeID: s.nodeID, NodeGeneration: s.nodeGeneration,
			CommandID: envelope.CommandID, CommandDigest: commandDigest(envelope), LeaseID: envelope.LeaseID,
			FencingToken: envelope.FencingToken})
		if err != nil || identity.NodeID != s.nodeID || identity.NodeGeneration != s.nodeGeneration {
			if err == nil {
				err = fmt.Errorf("appliance_identity_mismatch")
			}
			operationErr = err
			break
		}
		identity.ProtectedTargetPolicyDigest = s.policy.ProtectedTargetPolicyDigest
		identity.RuntimeIdentities = []json.RawMessage{}
		inspector, _ := s.runtime.(ProtectedOfficeInspectionRuntime)
		for _, target := range s.policy.ProtectedTargetsDependencyOrder() {
			observed := ProtectedOfficeRuntimeIdentity{WorkerState: WorkerState{WorkerID: target.WorkerID},
				ErrorCode: "protected_office_inspection_unavailable"}
			if inspector != nil {
				state, inspectErr := inspector.InspectProtectedOfficeProfile(ctx, target,
					Ownership{NodeID: s.nodeID, NodeGeneration: s.nodeGeneration})
				if inspectErr == nil && state.WorkerID == target.WorkerID && state.ModelProfileID == target.ModelProfileID &&
					state.PlacementClass == PlacementProtectedResident && state.Image == target.RequiredImageDigest &&
					state.ConfigDigest == target.RequiredConfigDigest && state.MaintenanceGeneration == target.MaintenanceGeneration {
					observed = ProtectedOfficeRuntimeIdentity{WorkerState: state, IdentityExact: true}
				}
			}
			encoded, _ := json.Marshal(observed)
			identity.RuntimeIdentities = append(identity.RuntimeIdentities, encoded)
		}
		result.Status = "succeeded"
		result.Payload, _ = json.Marshal(identity)
	case "worker.stop":
		var payload WorkerStopPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil || !uuidPattern.MatchString(payload.WorkerID) || payload.GracePeriodSeconds < 0 || payload.GracePeriodSeconds > 300 || payload.RuntimeGeneration < 0 || payload.RuntimeGeneration > s.nodeGeneration || (payload.RuntimeGeneration != 0 && !payload.ApplicationOnly) {
			operationErr = fmt.Errorf("invalid_worker_stop_payload")
			break
		}
		result.WorkerID = payload.WorkerID
		if _, protected := s.policy.ProtectedTargetForWorker(payload.WorkerID); protected {
			operationErr = fmt.Errorf("protected_resident_operation_denied")
			break
		}
		state, err := s.runtime.StopWorker(ctx, payload.WorkerID, payload.GracePeriodSeconds, Ownership{
			RuntimeGeneration: payload.RuntimeGeneration, ApplicationOnly: payload.ApplicationOnly,
			NodeID: s.nodeID, NodeGeneration: s.nodeGeneration, CommandID: envelope.CommandID, LeaseID: envelope.LeaseID,
			FencingToken: envelope.FencingToken,
		})
		if err != nil {
			operationErr = err
			break
		}
		result.Status, result.ContainerID = "succeeded", state.ContainerID
		result.Payload, _ = json.Marshal(state)
		s.publish(envelope, payload.WorkerID, "", "worker.stopped", state)
	case "worker.health":
		var payload WorkerHealthPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil || !uuidPattern.MatchString(payload.WorkerID) || payload.RuntimeGeneration < 0 || payload.RuntimeGeneration > s.nodeGeneration {
			operationErr = fmt.Errorf("invalid_worker_health_payload")
			break
		}
		result.WorkerID = payload.WorkerID
		state, err := s.runtime.WorkerHealth(ctx, payload.WorkerID, Ownership{
			RuntimeGeneration: payload.RuntimeGeneration,
			NodeID:            s.nodeID, NodeGeneration: s.nodeGeneration, CommandID: envelope.CommandID, LeaseID: envelope.LeaseID,
			FencingToken: envelope.FencingToken,
		})
		if err != nil {
			operationErr = err
			break
		}
		result.Status, result.ContainerID = "succeeded", state.ContainerID
		result.Payload, _ = json.Marshal(state)
		s.publish(envelope, payload.WorkerID, "", "worker.health", state)
	case "worker.control":
		var payload WorkerControlPayload
		decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil || !uuidPattern.MatchString(payload.WorkerID) || len(payload.Request) == 0 || len(payload.Request) > 512<<10 || payload.RuntimeGeneration < 0 || payload.RuntimeGeneration > s.nodeGeneration {
			operationErr = fmt.Errorf("invalid_worker_control_payload")
			break
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			operationErr = fmt.Errorf("invalid_worker_control_payload")
			break
		}
		var requestIdentity struct {
			ProtocolVersion int    `json:"protocolVersion"`
			WorkerID        string `json:"workerId"`
			LeaseID         string `json:"leaseId"`
			FencingToken    uint64 `json:"fencingToken"`
			Type            string `json:"type"`
		}
		if err := json.Unmarshal(payload.Request, &requestIdentity); err != nil || requestIdentity.ProtocolVersion != 1 ||
			requestIdentity.WorkerID != payload.WorkerID || !uuidPattern.MatchString(requestIdentity.LeaseID) ||
			requestIdentity.FencingToken == 0 {
			operationErr = fmt.Errorf("worker_control_fence_mismatch")
			break
		}
		if _, protected := s.policy.ProtectedTargetForWorker(payload.WorkerID); protected && !ProtectedControlRequestAllowed(requestIdentity.Type) {
			operationErr = fmt.Errorf("protected_resident_operation_denied")
			break
		}
		runtime, ok := s.runtime.(WorkerControlRuntime)
		if !ok {
			operationErr = fmt.Errorf("worker_control_not_configured")
			break
		}
		result.WorkerID = payload.WorkerID
		response, err := runtime.ForwardWorkerControl(ctx, payload, Ownership{
			RuntimeGeneration: payload.RuntimeGeneration,
			NodeID:            s.nodeID, NodeGeneration: s.nodeGeneration, CommandID: envelope.CommandID, LeaseID: envelope.LeaseID,
			CommandDigest: commandDigest(envelope), FencingToken: envelope.FencingToken,
		})
		if err != nil {
			operationErr = err
			break
		}
		result.Status, result.Payload = "succeeded", response
		s.publish(envelope, payload.WorkerID, "", "worker.control_forwarded", map[string]any{"bytes": len(response)})
	case "worker.application.fetch":
		var payload ApplicationFetchPayload
		decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil || !uuidPattern.MatchString(payload.WorkerID) || payload.RuntimeGeneration < 0 || payload.RuntimeGeneration > s.nodeGeneration ||
			(payload.Method != "GET" && payload.Method != "HEAD") || !validApplicationPath(payload.Path) {
			operationErr = fmt.Errorf("invalid_application_fetch_payload")
			break
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			operationErr = fmt.Errorf("invalid_application_fetch_payload")
			break
		}
		result.WorkerID = payload.WorkerID
		content, err := s.runtime.FetchApplication(ctx, payload, Ownership{
			RuntimeGeneration: payload.RuntimeGeneration,
			NodeID:            s.nodeID, NodeGeneration: s.nodeGeneration, CommandID: envelope.CommandID, LeaseID: envelope.LeaseID,
			FencingToken: envelope.FencingToken,
		})
		if err != nil {
			operationErr = err
			break
		}
		result.Status = "succeeded"
		result.Payload, _ = json.Marshal(content)
		s.publish(envelope, payload.WorkerID, "", "worker.application_fetched", map[string]any{
			"method": payload.Method, "status": content.Status, "bytes": len(content.Body),
		})
	case "worker.conflicts.list":
		var payload ExclusiveConflictListPayload
		decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil || !uuidPattern.MatchString(payload.ExclusiveJobID) {
			operationErr = fmt.Errorf("invalid_exclusive_conflict_payload")
			break
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			operationErr = fmt.Errorf("invalid_exclusive_conflict_payload")
			break
		}
		runtime, ok := s.runtime.(ExclusiveDrainRuntime)
		if !ok || len(s.policy.ExclusiveTargets()) == 0 {
			operationErr = fmt.Errorf("exclusive_drain_not_configured")
			break
		}
		states, err := runtime.ListExclusiveConflicts(ctx, s.policy.ExclusiveTargets())
		if err != nil {
			operationErr = err
			break
		}
		result.Status = "succeeded"
		result.Payload, _ = json.Marshal(map[string]any{"workers": states})
		s.publish(envelope, "", "", "worker.conflicts_listed", map[string]any{"exclusiveJobId": payload.ExclusiveJobID, "count": len(states)})
	case "worker.conflict.drain", "worker.conflict.restore":
		var payload ExclusiveConflictWorkerPayload
		decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil || !uuidPattern.MatchString(payload.ExclusiveJobID) {
			operationErr = fmt.Errorf("invalid_exclusive_conflict_payload")
			break
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			operationErr = fmt.Errorf("invalid_exclusive_conflict_payload")
			break
		}
		target, allowed := s.policy.ExclusiveTarget(payload.TargetKey)
		runtime, ok := s.runtime.(ExclusiveDrainRuntime)
		if !allowed || !ok || IsProtectedPlacement(target.PlacementClass) {
			operationErr = fmt.Errorf("exclusive_drain_target_denied")
			break
		}
		var state ExclusiveConflictState
		var err error
		if envelope.Type == "worker.conflict.drain" {
			state, err = runtime.DrainExclusiveConflict(ctx, target)
		} else {
			state, err = runtime.RestoreExclusiveConflict(ctx, target)
		}
		if err != nil {
			operationErr = err
			break
		}
		result.Status, result.WorkerID = "succeeded", target.TargetKey
		result.Payload, _ = json.Marshal(state)
		eventType := "worker.conflict_drained"
		if envelope.Type == "worker.conflict.restore" {
			eventType = "worker.conflict_restored"
		}
		s.publish(envelope, target.TargetKey, "", eventType, map[string]any{"exclusiveJobId": payload.ExclusiveJobID, "state": state.State})
	case "maintenance.preflight":
		var payload MaintenancePreflightPayload
		decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil || !uuidPattern.MatchString(payload.PlanID) || payload.PlanID != envelope.LeaseID ||
			(payload.Kind != "platform" && payload.Kind != "host") || !sha256Pattern.MatchString(strings.TrimPrefix(payload.CandidateDigest, "sha256:")) ||
			payload.ExpectedArchitecture != "arm64" || !regexpDockerAPIVersion.MatchString(payload.MinimumDockerAPIVersion) ||
			len(payload.AllowedSecureBootStates) < 1 || len(payload.AllowedSecureBootStates) > 3 {
			operationErr = fmt.Errorf("invalid_maintenance_preflight_payload")
			break
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			operationErr = fmt.Errorf("invalid_maintenance_preflight_payload")
			break
		}
		seenSecureBoot := map[string]bool{}
		for _, state := range payload.AllowedSecureBootStates {
			if !validSecureBootState(state) || seenSecureBoot[state] {
				operationErr = fmt.Errorf("invalid_maintenance_preflight_payload")
				break
			}
			seenSecureBoot[state] = true
		}
		if operationErr != nil {
			break
		}
		runtime, ok := s.runtime.(MaintenancePreflightRuntime)
		if !ok {
			operationErr = fmt.Errorf("maintenance_preflight_not_configured")
			break
		}
		evidence, err := runtime.InspectMaintenancePreflight(ctx, payload, Ownership{
			NodeID: s.nodeID, NodeGeneration: s.nodeGeneration, CommandID: envelope.CommandID, LeaseID: envelope.LeaseID,
			CommandDigest: commandDigest(envelope), FencingToken: envelope.FencingToken,
		})
		if err != nil {
			operationErr = err
			break
		}
		result.Status = "succeeded"
		result.Payload, _ = json.Marshal(evidence)
		s.publish(envelope, "", "", "maintenance.preflight_observed", map[string]any{"planId": payload.PlanID, "kind": payload.Kind, "passed": evidence.Passed, "evidenceDigest": evidence.EvidenceDigest})
	case "maintenance.transaction.execute":
		var payload ProtectedMaintenancePayload
		decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil || payload.TransactionID != envelope.LeaseID ||
			!payload.IssuedAt.Equal(envelope.IssuedAt) || !payload.ExpiresAt.Equal(envelope.DeadlineAt) {
			operationErr = fmt.Errorf("protected_maintenance_identity_invalid")
			break
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			operationErr = fmt.Errorf("protected_maintenance_identity_invalid")
			break
		}
		if s.protectedMaintenance == nil {
			operationErr = fmt.Errorf("protected_maintenance_not_configured")
			break
		}
		state, err := s.protectedMaintenance.Execute(ctx, payload, Ownership{
			NodeID: s.nodeID, NodeGeneration: s.nodeGeneration, CommandID: envelope.CommandID, LeaseID: envelope.LeaseID,
			CommandDigest: commandDigest(envelope), FencingToken: envelope.FencingToken,
		}, commandDigest(envelope), executionNow)
		if err != nil {
			operationErr = err
			break
		}
		result.Status = "succeeded"
		result.Payload, _ = json.Marshal(state)
		s.publish(envelope, "", "", "maintenance.protected_completed", map[string]any{
			"transactionId": payload.TransactionID, "maintenanceGeneration": payload.MaintenanceGeneration,
			"journalRevision": payload.JournalRevision, "planDigest": state.PlanDigest,
		})
	case "protected-set.transaction.execute":
		var payload ProtectedSetTransitionPayload
		decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil || payload.TransactionID != envelope.LeaseID ||
			!payload.IssuedAt.Equal(envelope.IssuedAt) || !payload.ExpiresAt.Equal(envelope.DeadlineAt) {
			operationErr = fmt.Errorf("protected_set_transition_identity_invalid")
			break
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			operationErr = fmt.Errorf("protected_set_transition_identity_invalid")
			break
		}
		if s.protectedTransition == nil {
			operationErr = fmt.Errorf("protected_set_transition_not_configured")
			break
		}
		state, err := s.protectedTransition.Execute(ctx, payload, Ownership{
			NodeID: s.nodeID, NodeGeneration: s.nodeGeneration, CommandID: envelope.CommandID, LeaseID: envelope.LeaseID,
			CommandDigest: commandDigest(envelope), FencingToken: envelope.FencingToken,
		}, commandDigest(envelope), executionNow)
		if err != nil {
			operationErr = err
			break
		}
		result.Status = "succeeded"
		result.Payload, _ = json.Marshal(state)
		s.publish(envelope, "", "", "protected_set.transition_completed", map[string]any{
			"transactionId": payload.TransactionID, "setId": payload.SetID,
			"desiredStateRevision":  payload.DesiredStateRevision,
			"maintenanceGeneration": payload.MaintenanceGeneration,
			"journalRevision":       payload.JournalRevision, "planDigest": state.PlanDigest,
		})
	case "protected-set.transaction.inspect":
		var payload ProtectedSetTransitionInspectionPayload
		decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil || payload.InspectionID != envelope.CommandID ||
			payload.InspectionID != envelope.LeaseID {
			operationErr = fmt.Errorf("protected_set_transition_inspection_binding_invalid")
			break
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			operationErr = fmt.Errorf("protected_set_transition_inspection_binding_invalid")
			break
		}
		if s.protectedTransition == nil {
			operationErr = fmt.Errorf("protected_set_transition_not_configured")
			break
		}
		inspection, err := s.protectedTransition.Inspect(ctx, payload)
		if err != nil {
			operationErr = err
			break
		}
		result.Status = "succeeded"
		result.Payload, _ = json.Marshal(inspection)
		s.publish(envelope, "", "", "protected_set.transition_inspected", map[string]any{
			"inspectionId": payload.InspectionID, "transactionId": payload.TransactionID,
			"migrationPlanId": payload.MigrationPlanID, "mode": payload.Mode,
			"journalPhase": inspection.Journal.Phase, "runtimeState": inspection.RuntimeState,
		})
	case "appliance.runtime.restart":
		var payload ApplianceRuntimeRestartPayload
		decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil || payload.RestartID != envelope.CommandID ||
			payload.RestartID != envelope.LeaseID || payload.JournalRevision != envelope.FencingToken {
			operationErr = fmt.Errorf("appliance_restart_identity_invalid")
			break
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			operationErr = fmt.Errorf("appliance_restart_identity_invalid")
			break
		}
		if s.applianceRestart == nil {
			operationErr = fmt.Errorf("appliance_restart_not_configured")
			break
		}
		state, err := s.applianceRestart.Execute(ctx, payload, envelope.CommandID, commandDigest(envelope),
			envelope.Idempotency, executionNow)
		if err != nil {
			operationErr = err
			break
		}
		result.Status = "restart-required"
		if state.Phase == "complete" {
			result.Status = "succeeded"
		}
		result.Payload, _ = json.Marshal(state)
		eventType := "appliance.runtime_restart_armed"
		if state.Phase == "complete" {
			eventType = "appliance.runtime_restart_completed"
		}
		s.publish(envelope, "", "", eventType, map[string]any{"restartId": state.RestartID,
			"policyDigest": state.PolicyDigest, "phase": state.Phase, "journalRevisions": state.Revisions})
	case "sandbox.file.project":
		var payload SandboxFileProjectPayload
		decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			operationErr = fmt.Errorf("invalid_sandbox_file_project_payload")
			break
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			operationErr = fmt.Errorf("invalid_sandbox_file_project_payload")
			break
		}
		result.WorkerID = payload.WorkerID
		projection, err := decodeSandboxFileProject(payload, now)
		if err != nil {
			operationErr = err
			break
		}
		defer func() {
			for index := range projection.Contents {
				projection.Contents[index] = 0
			}
		}()
		state, err := s.runtime.ProjectSandboxFile(ctx, projection, Ownership{
			NodeID: s.nodeID, NodeGeneration: s.nodeGeneration, CommandID: envelope.CommandID, LeaseID: envelope.LeaseID,
			CommandDigest: commandDigest(envelope), FencingToken: envelope.FencingToken,
		})
		if err != nil {
			operationErr = err
			break
		}
		result.Status = "succeeded"
		result.Payload, _ = json.Marshal(state)
		s.publish(envelope, payload.WorkerID, "", "sandbox.file_projected", state)
	default:
		operationErr = fmt.Errorf("unsupported_command_type")
	}

	if operationErr != nil {
		result.ErrorCode = stableOperationErrorCode(envelope.Type, operationErr)
		result.Retryable = !errors.Is(operationErr, context.Canceled)
		s.publish(envelope, result.WorkerID, "", "worker.command_failed", map[string]string{"code": result.ErrorCode})
	}
	result.CompletedAt = s.now().UTC()
	return s.finish(envelope, result), nil
}
