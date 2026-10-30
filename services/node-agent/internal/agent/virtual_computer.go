package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
)

type ComputerResources struct {
	VCPUs       int64 `json:"vcpus"`
	MemoryBytes int64 `json:"memoryBytes"`
	DiskBytes   int64 `json:"diskBytes"`
}
type ComputerRun struct {
	ID           string  `json:"id"`
	Generation   uint64  `json:"generation"`
	ContainerID  *string `json:"containerId"`
	RuntimeImage string  `json:"runtimeImage"`
}

// Supplied only by Platform's committed resource reservation, never by a member.
// Persisted with the first start so reconnects cannot silently select new CPUs.
type ComputerAllocation struct {
	MemoryBytes int64 `json:"memoryBytes"`
	CPUIds      []int `json:"cpuIds"`
}
type ComputerIdentity struct {
	ComputerID  string  `json:"computerId"`
	OwnerID     string  `json:"ownerId"`
	NodeID      string  `json:"nodeId"`
	VolumeID    string  `json:"volumeId"`
	FirmwareID  string  `json:"firmwareId"`
	TPMID       *string `json:"tpmId"`
	OperationID string  `json:"operationId"`
	Generation  uint64  `json:"generation"`
}
type ComputerCommand struct {
	ComputerIdentity
	PoolID       string                       `json:"poolId"`
	ProfileID    string                       `json:"profileId"`
	RuntimeImage string                       `json:"runtimeImage"`
	Resources    ComputerResources            `json:"resources"`
	Run          *ComputerRun                 `json:"run"`
	Allocation   *ComputerAllocation          `json:"allocation,omitempty"`
	Installation *ComputerInstallationCommand `json:"installation,omitempty"`
}
type ComputerInstallationCommand struct {
	Action        string  `json:"action"`
	Revision      uint64  `json:"revision"`
	MediaID       *string `json:"mediaId"`
	Digest        *string `json:"digest"`
	Size          int64   `json:"size"`
	BootRequestID *string `json:"bootRequestId,omitempty"`
}
type ComputerResult struct {
	ComputerIdentity
	RunID                string  `json:"runId,omitempty"`
	ContainerID          string  `json:"containerId,omitempty"`
	RuntimeImage         string  `json:"runtimeImage,omitempty"`
	Provisioned          bool    `json:"provisioned,omitempty"`
	Encryption           string  `json:"encryption,omitempty"`
	Running              bool    `json:"running,omitempty"`
	Stopped              bool    `json:"stopped,omitempty"`
	CleanShutdown        bool    `json:"cleanShutdown,omitempty"`
	DataDeleted          bool    `json:"dataDeleted,omitempty"`
	Rejected             bool    `json:"rejected,omitempty"`
	NoSideEffects        bool    `json:"noSideEffects,omitempty"`
	ErrorCode            string  `json:"errorCode,omitempty"`
	InstallationRevision uint64  `json:"installationRevision,omitempty"`
	MediaDigest          *string `json:"mediaDigest,omitempty"`
	MediaReady           bool    `json:"mediaReady,omitempty"`
	BootRequestID        string  `json:"bootRequestId,omitempty"`
	BootState            string  `json:"bootState,omitempty"`
}

func (r ComputerResult) MarshalJSON() ([]byte, error) {
	type resultAlias ComputerResult
	if r.InstallationRevision == 0 {
		return json.Marshal(resultAlias(r))
	}
	return json.Marshal(struct {
		resultAlias
		MediaDigest *string `json:"mediaDigest"`
	}{resultAlias(r), r.MediaDigest})
}

// Implementations must persist operation/run/storage identities before effects,
// reconcile retries against exact existing resources, and atomically admit with
// the node's shared memory/CPU/storage accounting. A browser never supplies host
// paths, Docker flags, a shell command, guest password or management port.
type ComputerCommandRuntime interface {
	ExecuteComputer(context.Context, string, ComputerCommand, Ownership) (ComputerResult, error)
	ComputerProtectionConfigured() bool
}

func (s *Service) ConfigureComputers(runtime ComputerCommandRuntime) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if runtime == nil || !runtime.ComputerProtectionConfigured() || s.computers != nil || len(s.commands) != 0 {
		return errors.New("computer_configuration_locked")
	}
	s.computers = runtime
	return nil
}

var computerProfileID = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
var computerContainerID = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validComputerCommand(action string, p ComputerCommand) bool {
	if action == "installation" {
		i := p.Installation
		if i == nil || i.Revision == 0 || i.Revision >= 1<<53 {
			return false
		}
		if i.Action == "mount" {
			if i.MediaID == nil || !uuidPattern.MatchString(*i.MediaID) || i.Digest == nil || !phoneImageID.MatchString(*i.Digest) || i.Size <= 0 || i.Size >= 1<<53 {
				return false
			}
		} else if i.Action != "eject" || i.MediaID != nil || i.Digest != nil || i.Size != 0 {
			return false
		}
		if i.BootRequestID != nil {
			return false
		}
	} else if p.Installation != nil {
		i := p.Installation
		if action != "start" || i.Action != "launch" || i.Revision == 0 || i.Revision >= 1<<53 {
			return false
		}
		if i.MediaID == nil {
			if i.Digest != nil || i.Size != 0 || i.BootRequestID != nil {
				return false
			}
		} else if !uuidPattern.MatchString(*i.MediaID) || i.Digest == nil || !phoneImageID.MatchString(*i.Digest) || i.Size <= 0 || i.Size >= 1<<53 {
			return false
		}
		if i.BootRequestID != nil && !uuidPattern.MatchString(*i.BootRequestID) {
			return false
		}
	}
	if p.Allocation != nil {
		if action != "start" || p.Allocation.MemoryBytes <= p.Resources.MemoryBytes || p.Allocation.MemoryBytes >= 1<<53 || int64(len(p.Allocation.CPUIds)) != p.Resources.VCPUs {
			return false
		}
		seen := map[int]bool{}
		for _, cpu := range p.Allocation.CPUIds {
			if cpu < 0 || seen[cpu] {
				return false
			}
			seen[cpu] = true
		}
	}
	for _, id := range []string{p.ComputerID, p.OwnerID, p.NodeID, p.VolumeID, p.FirmwareID, p.OperationID} {
		if !uuidPattern.MatchString(id) {
			return false
		}
	}
	if p.TPMID != nil && !uuidPattern.MatchString(*p.TPMID) || !phonePoolID.MatchString(p.PoolID) || !computerProfileID.MatchString(p.ProfileID) ||
		!phoneImageID.MatchString(p.RuntimeImage) || p.Generation >= 9007199254740991 {
		return false
	}
	for _, value := range []int64{p.Resources.VCPUs, p.Resources.MemoryBytes, p.Resources.DiskBytes} {
		if value <= 0 || value > 9007199254740991 {
			return false
		}
	}
	switch action {
	case "create":
		return p.Generation == 0 && p.Run == nil
	case "delete":
		return p.Run == nil
	case "installation":
		return p.Run == nil || p.Generation > 0 && uuidPattern.MatchString(p.Run.ID) && p.Run.Generation == p.Generation && p.Run.RuntimeImage == p.RuntimeImage && p.Run.ContainerID != nil && computerContainerID.MatchString(*p.Run.ContainerID)
	case "start", "shutdown", "inspect":
		return p.Generation > 0 && p.Run != nil && uuidPattern.MatchString(p.Run.ID) && p.Run.Generation == p.Generation && p.Run.RuntimeImage == p.RuntimeImage &&
			(p.Run.ContainerID == nil || computerContainerID.MatchString(*p.Run.ContainerID)) && (action != "shutdown" || p.Run.ContainerID != nil)
	}
	return false
}
func decodeComputerCommand(raw json.RawMessage, action string) (ComputerCommand, error) {
	var p ComputerCommand
	var fields map[string]json.RawMessage
	if rejectComputerDuplicateKeys(raw) != nil || json.Unmarshal(raw, &fields) != nil {
		return p, errors.New("computer_payload_invalid")
	}
	for _, key := range []string{"computerId", "ownerId", "nodeId", "volumeId", "firmwareId", "tpmId", "operationId", "generation", "poolId", "profileId", "runtimeImage", "resources", "run"} {
		if _, ok := fields[key]; !ok {
			return p, errors.New("computer_payload_invalid")
		}
	}
	if action == "installation" {
		var installation map[string]json.RawMessage
		if json.Unmarshal(fields["installation"], &installation) != nil || len(installation) != 5 {
			return p, errors.New("computer_payload_invalid")
		}
		for _, key := range []string{"action", "revision", "mediaId", "digest", "size"} {
			if _, ok := installation[key]; !ok {
				return p, errors.New("computer_payload_invalid")
			}
		}
	}
	if action == "start" && fields["installation"] != nil {
		var installation map[string]json.RawMessage
		if json.Unmarshal(fields["installation"], &installation) != nil || len(installation) < 5 || len(installation) > 6 {
			return p, errors.New("computer_payload_invalid")
		}
		for _, key := range []string{"action", "revision", "mediaId", "digest", "size"} {
			if _, ok := installation[key]; !ok {
				return p, errors.New("computer_payload_invalid")
			}
		}
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&p) != nil || !validComputerCommand(action, p) || !errors.Is(d.Decode(&struct{}{}), io.EOF) {
		return p, errors.New("computer_payload_invalid")
	}
	return p, nil
}

// Computer run may be explicit null, and resources is a nested object. Do not
// reuse Android's different payload grammar or silently accept last-key-wins.
func rejectComputerDuplicateKeys(raw []byte) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	var value func(int) error
	value = func(depth int) error {
		token, err := d.Token()
		if err != nil {
			return err
		}
		delim, nested := token.(json.Delim)
		if !nested {
			if depth == 0 {
				return errors.New("computer_payload_invalid")
			}
			return nil
		}
		if delim == '[' && depth == 2 {
			for d.More() {
				token, err := d.Token()
				if err != nil {
					return err
				}
				if _, ok := token.(float64); !ok {
					return errors.New("computer_payload_invalid")
				}
			}
			end, err := d.Token()
			if err != nil || end != json.Delim(']') {
				return errors.New("computer_payload_invalid")
			}
			return nil
		}
		if delim != '{' || depth > 1 {
			return errors.New("computer_payload_invalid")
		}
		keys := map[string]bool{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok || keys[name] {
				return errors.New("computer_payload_invalid")
			}
			keys[name] = true
			if err = value(depth + 1); err != nil {
				return err
			}
		}
		end, err := d.Token()
		if err != nil {
			return err
		}
		if end != json.Delim('}') {
			return errors.New("computer_payload_invalid")
		}
		return nil
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return errors.New("computer_payload_invalid")
	}
	return nil
}
func sameOptionalString(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}
func validateComputerResult(action string, p ComputerCommand, r ComputerResult) error {
	fail := errors.New("computer_runtime_result_invalid")
	if !r.Rejected && action == "start" && p.Installation != nil && p.Installation.BootRequestID != nil {
		if r.BootRequestID != *p.Installation.BootRequestID || (r.BootState != "armed" && r.BootState != "consumed") {
			return fail
		}
	} else if r.BootRequestID != "" || r.BootState != "" {
		if action != "inspect" || !uuidPattern.MatchString(r.BootRequestID) || (r.BootState != "armed" && r.BootState != "consumed") {
			return fail
		}
	}
	if r.ComputerID != p.ComputerID || r.OwnerID != p.OwnerID || r.NodeID != p.NodeID || r.VolumeID != p.VolumeID || r.FirmwareID != p.FirmwareID ||
		!sameOptionalString(r.TPMID, p.TPMID) || r.OperationID != p.OperationID || r.Generation != p.Generation {
		return fail
	}
	if action == "installation" {
		if p.Installation == nil || r.InstallationRevision != p.Installation.Revision || r.Running || r.Stopped || r.Provisioned || r.DataDeleted {
			return fail
		}
		if p.Run == nil {
			if r.RunID != "" || r.ContainerID != "" || r.RuntimeImage != "" {
				return fail
			}
		} else if r.RunID != p.Run.ID || p.Run.ContainerID == nil || r.ContainerID != *p.Run.ContainerID || r.RuntimeImage != p.RuntimeImage {
			return fail
		}
		if r.Rejected {
			if !r.NoSideEffects || r.MediaReady {
				return fail
			}
			switch r.ErrorCode {
			case "computer_optical_locked", "computer_media_not_ready", "computer_installation_upgrade_required", "computer_capacity_unavailable", "computer_storage_unavailable":
				return nil
			}
			return fail
		}
		if r.NoSideEffects || r.ErrorCode != "" || !r.MediaReady || !sameOptionalString(r.MediaDigest, p.Installation.Digest) {
			return fail
		}
		return nil
	}
	if r.InstallationRevision != 0 || r.MediaDigest != nil || r.MediaReady {
		return fail
	}
	if r.Rejected {
		if !r.NoSideEffects || r.Running || r.Provisioned || r.DataDeleted {
			return fail
		}
		switch r.ErrorCode {
		case "computer_capacity_unavailable", "computer_storage_unavailable", "computer_profile_unavailable", "computer_permission_required":
			return nil
		}
		return fail
	}
	if r.NoSideEffects || r.ErrorCode != "" || r.Running && r.Stopped || r.CleanShutdown && !r.Stopped {
		return fail
	}
	switch action {
	case "create":
		if r.Provisioned && r.Encryption == "luks2" && !r.Running && !r.DataDeleted && r.ContainerID == "" {
			return nil
		}
	case "delete":
		if r.DataDeleted && !r.Running && r.ContainerID == "" {
			return nil
		}
	case "start", "shutdown", "inspect":
		if p.Run == nil || r.RunID != p.Run.ID || r.RuntimeImage != p.RuntimeImage {
			return fail
		}
		if action == "start" && r.Running && computerContainerID.MatchString(r.ContainerID) {
			return nil
		}
		if action == "shutdown" && r.Stopped && r.CleanShutdown && p.Run.ContainerID != nil && r.ContainerID == *p.Run.ContainerID {
			return nil
		}
		if action == "inspect" && (r.Stopped || r.Running) && computerContainerID.MatchString(r.ContainerID) && (p.Run.ContainerID == nil || *p.Run.ContainerID == r.ContainerID) {
			return nil
		}
	}
	return fail
}
