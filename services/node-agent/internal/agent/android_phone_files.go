package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const PhoneFileMaximum = 1<<53 - 1

type PhoneFilePayload struct {
	PhoneCommandPayload
	Action    string `json:"action"`
	Deadline  int64  `json:"deadline"`
	Name      string `json:"name,omitempty"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
}

type PhoneFileRuntime interface {
	TransferPhoneFile(context.Context, PhoneFilePayload, io.Reader, io.Writer) error
}

func validPhoneFile(p PhoneFilePayload, now time.Time) bool {
	if !validPhoneCommand("inspect", p.PhoneCommandPayload) || p.Deadline <= now.UnixMilli() || p.Deadline > now.Add(120*time.Second).UnixMilli() {
		return false
	}
	if p.Action == "list" {
		return p.Name == "" && p.SizeBytes == 0 && p.SHA256 == ""
	}
	if len(p.Name) == 0 || len(p.Name) > 240 || !utf8.ValidString(p.Name) || p.Name != strings.TrimSpace(p.Name) || p.Name == "." || p.Name == ".." || strings.HasPrefix(p.Name, ".transfer-") {
		return false
	}
	for _, c := range p.Name {
		if c == '/' || c == '\\' || unicode.IsControl(c) || unicode.In(c, unicode.Cf) {
			return false
		}
	}
	if p.Action == "download" {
		return p.SizeBytes == 0 && p.SHA256 == ""
	}
	return (p.Action == "upload" || p.Action == "install") && p.SizeBytes > 0 && p.SizeBytes <= PhoneFileMaximum && regexpPhoneRequestDigest.MatchString(p.SHA256)
}

// File bytes are streamed separately from the signed, closed metadata. This
// endpoint is not an ADB authorization and cannot select a program or host path.
// One use per command, one transfer per phone; finished IDs expire after the
// command deadline, not an unbounded history of file operations.
func (s *Service) TransferPhoneFile(ctx context.Context, e CommandEnvelope, proof AuthProof, input io.Reader, output io.Writer) error {
	now := s.now().UTC()
	if err := s.authenticator.Verify(e, proof, now); err != nil {
		return err
	}
	if e.NodeGeneration != s.nodeGeneration {
		return ErrStaleNodeGeneration
	}
	var p PhoneFilePayload
	d := json.NewDecoder(bytes.NewReader(e.Payload))
	d.DisallowUnknownFields()
	if e.Type != "android-phone.file.transfer" || !uuidPattern.MatchString(e.CommandID) || e.Idempotency != "keyed" || len(e.Payload) > 4096 || rejectPhoneDuplicateKeys(e.Payload) != nil ||
		d.Decode(&p) != nil || !errors.Is(d.Decode(&struct{}{}), io.EOF) || !validPhoneFile(p, now) || e.CommandID != p.OperationID ||
		e.LeaseID != p.PhoneID || e.FencingToken != p.Generation+1 || e.DeadlineAt.UnixMilli() != p.Deadline {
		return errors.New("phone_file_payload_invalid")
	}
	runtime, ok := s.phones.(PhoneFileRuntime)
	if !ok {
		return errors.New("phone_files_not_configured")
	}
	// Do not open file/install operations across exclusive host maintenance.
	// Reject contention immediately rather than carrying a deadline through a wait.
	if !s.maintenanceGate.TryRLock() {
		return errors.New("phone_operation_conflict")
	}
	defer s.maintenanceGate.RUnlock()
	if (s.protectedMaintenance != nil && s.protectedMaintenance.BlocksOrdinaryMutation()) ||
		(s.protectedTransition != nil && s.protectedTransition.BlocksOrdinaryMutation()) {
		return errors.New("phone_operation_conflict")
	}
	s.mu.Lock()
	if s.phoneFiles == nil {
		s.phoneFiles = map[string]time.Time{}
		s.phoneFileActive = map[string]bool{}
	}
	for id, until := range s.phoneFiles {
		if !until.After(now) {
			delete(s.phoneFiles, id)
		}
	}
	if _, used := s.phoneFiles[e.CommandID]; used || s.phoneFileActive[p.PhoneID] || len(s.phoneFiles) >= 4096 {
		s.mu.Unlock()
		return errors.New("phone_operation_conflict")
	}
	s.phoneFiles[e.CommandID] = e.DeadlineAt
	s.phoneFileActive[p.PhoneID] = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.phoneFileActive, p.PhoneID); s.mu.Unlock() }()
	// Admission is time-bounded; an already admitted transfer is governed by
	// connection progress and cancellation, not total file size or duration.
	bounded, cancel := context.WithCancel(ctx)
	defer cancel()
	return runtime.TransferPhoneFile(bounded, p, input, output)
}

func (c *PhoneCoordinator) TransferPhoneFile(ctx context.Context, p PhoneFilePayload, input io.Reader, output io.Writer) error {
	// Read the current atomic journal without blocking another phone's boot.
	c.mediaMu.RLock()
	defer c.mediaMu.RUnlock()
	if c.root == nil || !validPhoneFile(p, time.Now()) {
		return errors.New("phone_file_payload_invalid")
	}
	j, err := c.read()
	if err != nil {
		return err
	}
	r, ok := j.Phones[p.PhoneID]
	if !ok || r.Phase != "running" || r.Identity != p.PhoneIdentity || r.Generation != p.Generation || !samePhoneRun(r.Run, p.Run) {
		return errors.New("phone_stale_run")
	}
	driver, ok := c.driver.(PhoneFileRuntime)
	if !ok {
		return errors.New("phone_files_not_configured")
	}
	return driver.TransferPhoneFile(ctx, p, input, output)
}
