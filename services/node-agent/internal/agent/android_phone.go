package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
)

const PhoneMemoryBytes int64 = 6 << 30
const PhoneStorageBytes int64 = 16 << 30
const PhoneCPUMillis = 2000
const PhoneBaseBuild = "16102939"

var phonePoolID = regexp.MustCompile(`^[a-z][a-z0-9_.-]{2,127}$`)
var phoneImageID = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var regexpPhoneRequestDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Only identities cross the command boundary. Paths, devices, commands, network
// names and Docker flags are selected by the installed phone driver, not callers.
type PhoneIdentity struct {
	PhoneID     string `json:"phoneId"`
	OwnerID     string `json:"ownerId"`
	VolumeID    string `json:"volumeId"`
	PoolID      string `json:"poolId"`
	BaseBuildID string `json:"baseBuildId"`
}

type PhoneRunIdentity struct {
	ID            string `json:"id"`
	ReservationID string `json:"reservationId"`
	ImageDigest   string `json:"imageDigest"`
	MemoryBytes   int64  `json:"memoryBytes"`
	CPUMillis     int    `json:"cpuMillis"`
}

type PhoneCommandPayload struct {
	PhoneIdentity
	OperationID string            `json:"operationId"`
	Generation  uint64            `json:"generation"`
	Run         *PhoneRunIdentity `json:"run,omitempty"`
}

type PhoneCommandResult struct {
	PhoneIdentity
	OperationID      string `json:"operationId"`
	Generation       uint64 `json:"generation"`
	RunID            string `json:"runId,omitempty"`
	ContainerID      string `json:"containerId,omitempty"`
	StorageReady     bool   `json:"storageReady"`
	AndroidReady     bool   `json:"androidReady"`
	MediaReady       bool   `json:"mediaReady"`
	RuntimeStopped   bool   `json:"runtimeStopped"`
	CleanShutdown    bool   `json:"cleanShutdown"`
	DataDeleted      bool   `json:"dataDeleted"`
	ProtectionReason string `json:"protectionReason,omitempty"`
}

type PhoneCommandRuntime interface {
	ExecutePhone(context.Context, string, PhoneCommandPayload, Ownership) (PhoneCommandResult, error)
}

type protectedPhoneRuntime interface {
	PhoneCommandRuntime
	PhoneProtectionConfigured() bool
	RunPhoneProtection(context.Context, func(error))
}

func (s *Service) ConfigurePhones(runtime PhoneCommandRuntime) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	guarded, ok := runtime.(protectedPhoneRuntime)
	if runtime == nil || !ok || !guarded.PhoneProtectionConfigured() || s.phones != nil || len(s.commands) != 0 {
		return errors.New("phone_configuration_locked")
	}
	s.phones = runtime
	return nil
}

// Called by the existing Agent process, not a second daemon. Non-phone nodes
// do nothing; an installed phone runtime cannot omit its local memory guard.
func (s *Service) RunPhoneProtection(ctx context.Context, onError func(error)) {
	s.mu.Lock()
	runtime, ok := s.phones.(protectedPhoneRuntime)
	s.mu.Unlock()
	if ok {
		runtime.RunPhoneProtection(ctx, onError)
	}
}

func validPhoneCommand(action string, p PhoneCommandPayload) bool {
	if !uuidPattern.MatchString(p.PhoneID) || !uuidPattern.MatchString(p.OwnerID) ||
		!uuidPattern.MatchString(p.VolumeID) || !uuidPattern.MatchString(p.OperationID) ||
		!phonePoolID.MatchString(p.PoolID) || p.BaseBuildID != PhoneBaseBuild || p.Generation > 9007199254740990 {
		return false
	}
	switch action {
	case "provision":
		return p.Generation == 0 && p.Run == nil
	case "delete":
		return p.Run == nil
	case "start", "stop", "inspect":
		return p.Generation > 0 && p.Run != nil && uuidPattern.MatchString(p.Run.ID) &&
			uuidPattern.MatchString(p.Run.ReservationID) && phoneImageID.MatchString(p.Run.ImageDigest) &&
			p.Run.MemoryBytes == PhoneMemoryBytes && p.Run.CPUMillis == PhoneCPUMillis
	default:
		return false
	}
}

// Decode one closed object; duplicate JSON keys are ambiguous even when both
// have valid values, so reject them rather than relying on last-key-wins.
func decodePhoneCommand(raw json.RawMessage, action string) (PhoneCommandPayload, error) {
	var p PhoneCommandPayload
	if len(raw) > 4096 || rejectPhoneDuplicateKeys(raw) != nil {
		return p, errors.New("phone_payload_invalid")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&p); err != nil || !validPhoneCommand(action, p) {
		return p, errors.New("phone_payload_invalid")
	}
	if err := d.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return p, errors.New("phone_payload_invalid")
	}
	return p, nil
}

func rejectPhoneDuplicateKeys(raw []byte) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	var object func(int) error
	object = func(depth int) error {
		if depth > 2 {
			return errors.New("phone_payload_invalid")
		}
		token, err := d.Token()
		if err != nil || token != json.Delim('{') {
			return errors.New("phone_payload_invalid")
		}
		keys := map[string]bool{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok || keys[name] {
				return errors.New("phone_payload_invalid")
			}
			keys[name] = true
			if depth == 0 && (name == "run" || name == "udpPolicy") {
				if err := object(depth + 1); err != nil {
					return err
				}
			} else if depth == 1 && name == "allowedSources" {
				// UDP policy carries a list of sender CIDRs. The typed decoder
				// and policy validation below still check its exact schema.
				token, err := d.Token()
				if err != nil || token != json.Delim('[') {
					return errors.New("phone_payload_invalid")
				}
				for d.More() {
					value, err := d.Token()
					if _, ok := value.(string); err != nil || !ok {
						return errors.New("phone_payload_invalid")
					}
				}
				if _, err := d.Token(); err != nil {
					return err
				}
			} else {
				value, err := d.Token()
				if err != nil {
					return err
				}
				if _, nested := value.(json.Delim); nested {
					return errors.New("phone_payload_invalid")
				}
			}
		}
		_, err = d.Token()
		return err
	}
	if err := object(0); err != nil {
		return err
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return errors.New("phone_payload_invalid")
	}
	return nil
}

func phoneRequestDigest(action string, p PhoneCommandPayload) string {
	raw, _ := json.Marshal(struct {
		Action  string
		Payload PhoneCommandPayload
	}{action, p})
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func validatePhoneResult(action string, p PhoneCommandPayload, result PhoneCommandResult) error {
	if result.PhoneIdentity != p.PhoneIdentity || result.OperationID != p.OperationID || result.Generation != p.Generation ||
		(p.Run == nil && result.RunID != "") || (p.Run != nil && result.RunID != p.Run.ID) ||
		(result.ContainerID != "" && !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(result.ContainerID)) ||
		(result.RuntimeStopped && (result.AndroidReady || result.MediaReady)) ||
		(result.CleanShutdown && !result.RuntimeStopped) || !validPhoneProtectionReason(result.ProtectionReason) {
		return errors.New("phone_runtime_result_invalid")
	}
	valid := false
	switch action {
	case "provision":
		valid = result.StorageReady && result.RuntimeStopped && !result.DataDeleted && result.ContainerID == ""
	case "start":
		valid = result.StorageReady && result.AndroidReady && result.MediaReady && result.ContainerID != "" && !result.DataDeleted
	case "inspect":
		valid = !result.DataDeleted && (result.RuntimeStopped || result.ContainerID != "")
	case "stop":
		valid = result.RuntimeStopped && !result.DataDeleted
	case "delete":
		valid = result.RuntimeStopped && result.DataDeleted && !result.StorageReady && result.ContainerID == ""
	}
	if !valid {
		return errors.New("phone_runtime_result_invalid")
	}
	return nil
}
