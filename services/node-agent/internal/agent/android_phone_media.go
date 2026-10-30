package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
)

type PhoneMediaPayload struct {
	PhoneCommandPayload
	GrantID        string `json:"grantId"`
	SessionID      string `json:"sessionId"`
	Kind           string `json:"kind"`
	LeaseExpiresAt int64  `json:"leaseExpiresAt,omitempty"`
}

type PhoneMediaGrant struct {
	ID         string `json:"id"`
	PhoneID    string `json:"phoneId"`
	OwnerID    string `json:"ownerId"`
	RunID      string `json:"runId"`
	Generation uint64 `json:"generation"`
	SessionID  string `json:"sessionId"`
	Kind       string `json:"kind"`
}

func (p PhoneMediaPayload) Grant() PhoneMediaGrant {
	return PhoneMediaGrant{ID: p.GrantID, PhoneID: p.PhoneID, OwnerID: p.OwnerID, RunID: p.Run.ID,
		Generation: p.Generation, SessionID: p.SessionID, Kind: p.Kind}
}

type PhoneMediaResult struct {
	PhoneMediaGrant
	PeerOpen       bool  `json:"peerOpen,omitempty"`
	PeerClosed     bool  `json:"peerClosed,omitempty"`
	LeaseExpiresAt int64 `json:"leaseExpiresAt,omitempty"`
}

type PhoneMediaRuntime interface {
	ExecutePhoneMedia(context.Context, string, PhoneMediaPayload, Ownership) (PhoneMediaResult, error)
}

type PhoneMediaDriver interface {
	ControlPhoneMedia(context.Context, string, PhoneMediaPayload) (PhoneMediaResult, error)
}

func validPhoneMedia(action string, p PhoneMediaPayload, now time.Time) bool {
	if !validPhoneCommand("inspect", p.PhoneCommandPayload) || !uuidPattern.MatchString(p.GrantID) ||
		!uuidPattern.MatchString(p.SessionID) || p.OperationID != p.GrantID || (p.Kind != "control" && p.Kind != "adb") {
		return false
	}
	if action == "close" {
		return p.LeaseExpiresAt == 0
	}
	return (action == "open" || action == "renew") && p.LeaseExpiresAt > now.UnixMilli() && p.LeaseExpiresAt <= now.Add(5*time.Second).UnixMilli()
}

// Renewals are authenticated short-lived control messages, not durable jobs.
// They deliberately do not enter the indefinitely retained command/result and
// worker-event maps. The phone's run fence + grant tombstones own replay safety;
// every retry checks the current runtime rather than a cached "open" response.
func (s *Service) handlePhoneMedia(ctx context.Context, e CommandEnvelope) (CommandResult, error) {
	result := CommandResult{CommandID: e.CommandID, NodeID: s.nodeID, NodeGeneration: s.nodeGeneration, Type: e.Type,
		Status: "failed", FencingToken: e.FencingToken, CorrelationID: e.CorrelationID, CompletedAt: s.now().UTC()}
	action := strings.TrimPrefix(e.Type, "android-phone.media.")
	var p PhoneMediaPayload
	d := json.NewDecoder(bytes.NewReader(e.Payload))
	d.DisallowUnknownFields()
	if len(e.Payload) > 4096 || rejectPhoneDuplicateKeys(e.Payload) != nil || d.Decode(&p) != nil ||
		!validPhoneMedia(action, p, s.now()) || e.LeaseID != p.PhoneID || e.FencingToken != p.Generation+1 ||
		e.DeadlineAt.After(s.now().Add(5*time.Second)) || !e.DeadlineAt.After(s.now()) {
		result.ErrorCode = "phone_media_payload_invalid"
		return result, nil
	}
	if err := d.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		result.ErrorCode = "phone_media_payload_invalid"
		return result, nil
	}
	runtime, ok := s.phones.(PhoneMediaRuntime)
	if !ok {
		result.ErrorCode = "phone_media_not_configured"
		return result, nil
	}
	bounded, cancel := context.WithDeadline(ctx, e.DeadlineAt)
	defer cancel()
	if action == "close" {
		// Close the grant's operator proxy before asking the runtime to
		// confirm peer/socket removal. Otherwise confirmation waits behind
		// the very lease which keeps that proxy open.
		s.recordPhoneSignal("close", p)
	}
	value, err := runtime.ExecutePhoneMedia(bounded, action, p, Ownership{NodeID: s.nodeID, NodeGeneration: s.nodeGeneration,
		CommandID: e.CommandID, LeaseID: e.LeaseID, FencingToken: e.FencingToken, CommandDigest: commandDigest(e)})
	if err == nil && (value.PhoneMediaGrant != p.Grant() || (action == "close" && (!value.PeerClosed || value.PeerOpen || value.LeaseExpiresAt != 0)) ||
		(action != "close" && (!value.PeerOpen || value.PeerClosed || value.LeaseExpiresAt != p.LeaseExpiresAt))) {
		err = errors.New("phone_media_result_invalid")
	}
	if err != nil {
		result.ErrorCode = stableOperationErrorCode(e.Type, err)
	} else {
		result.Status = "succeeded"
		result.Payload, _ = json.Marshal(value)
		s.recordPhoneSignal(action, p)
	}
	result.CompletedAt = s.now().UTC()
	return result, nil
}

type phoneSignalLease struct {
	grant PhoneMediaGrant
	until time.Time
}

func (s *Service) recordPhoneSignal(action string, p PhoneMediaPayload) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.phoneSignals == nil {
		s.phoneSignals = map[string]phoneSignalLease{}
	}
	now := s.now()
	for id, item := range s.phoneSignals {
		if !item.until.After(now) {
			delete(s.phoneSignals, id)
		}
	}
	if action == "close" {
		if item, ok := s.phoneSignals[p.PhoneID+":"+p.Kind]; ok && item.grant == p.Grant() {
			delete(s.phoneSignals, p.PhoneID+":"+p.Kind)
		}
		return
	}
	s.phoneSignals[p.PhoneID+":"+p.Kind] = phoneSignalLease{grant: p.Grant(), until: now.Add(time.Duration(p.LeaseExpiresAt-now.UnixMilli()) * time.Millisecond)}
}

func (s *Service) PhoneSignalLive(p PhoneMediaPayload) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.phoneSignals[p.PhoneID+":"+p.Kind]
	return ok && p.Run != nil && item.grant == p.Grant() && item.until.After(s.now())
}

type PhoneSignalEndpoint struct {
	Host         string
	Port         int
	ServerName   string
	Certificate  []byte
	MediaAddress string
	// Media travels through the per-phone network, not the private signalling
	// interface in Host. Docker may assign either interface the name eth0.
	MediaContainerAddress string
	MediaFirstPort        int
	MediaLastPort         int
}
type PhoneSignalRuntime interface {
	PhoneSignalEndpoint(context.Context, PhoneMediaPayload) (PhoneSignalEndpoint, error)
}

func (s *Service) PhoneSignalEndpoint(ctx context.Context, p PhoneMediaPayload) (PhoneSignalEndpoint, error) {
	var empty PhoneSignalEndpoint
	if p.Kind != "control" || !s.PhoneSignalLive(p) {
		return empty, errors.New("phone_media_grant_expired")
	}
	r, ok := s.phones.(PhoneSignalRuntime)
	if !ok {
		return empty, errors.New("phone_signal_not_configured")
	}
	return r.PhoneSignalEndpoint(ctx, p)
}

func (s *Service) DisconnectPhoneSignal(ctx context.Context, p PhoneMediaPayload) {
	p.LeaseExpiresAt = 0
	s.recordPhoneSignal("close", p)
	if r, ok := s.phones.(PhoneMediaRuntime); ok {
		_, _ = r.ExecutePhoneMedia(ctx, "close", p, Ownership{NodeID: s.nodeID, NodeGeneration: s.nodeGeneration, LeaseID: p.PhoneID, FencingToken: p.Generation + 1})
	}
}

func (c *PhoneCoordinator) PhoneSignalEndpoint(ctx context.Context, p PhoneMediaPayload) (PhoneSignalEndpoint, error) {
	c.mediaMu.RLock()
	defer c.mediaMu.RUnlock()
	var empty PhoneSignalEndpoint
	if c.root == nil || !validPhoneMedia("renew", p, time.Now()) {
		return empty, errors.New("phone_media_binding_invalid")
	}
	j, err := c.read()
	if err != nil {
		return empty, err
	}
	r, ok := j.Phones[p.PhoneID]
	if !ok || r.Phase != "running" || r.Identity != p.PhoneIdentity || r.Generation != p.Generation || !samePhoneRun(r.Run, p.Run) {
		return empty, errors.New("phone_media_stale_run")
	}
	d, ok := c.driver.(PhoneSignalRuntime)
	if !ok {
		return empty, errors.New("phone_signal_not_configured")
	}
	return d.PhoneSignalEndpoint(ctx, p)
}

// Read the atomically replaced journal without waiting behind a several-minute
// Android boot. A second phone's boot must not starve a live phone's 5s lease.
// The installed driver checks the exact live container again before socket I/O.
func (c *PhoneCoordinator) ExecutePhoneMedia(ctx context.Context, action string, p PhoneMediaPayload, owner Ownership) (PhoneMediaResult, error) {
	c.mediaMu.RLock()
	defer c.mediaMu.RUnlock()
	var empty PhoneMediaResult
	if c.root == nil || !validPhoneMedia(action, p, time.Now()) || owner.NodeID != c.policy.NodeID ||
		owner.NodeGeneration != c.policy.NodeGeneration || owner.LeaseID != p.PhoneID || owner.FencingToken != p.Generation+1 {
		return empty, errors.New("phone_media_binding_invalid")
	}
	j, err := c.read()
	if err != nil {
		return empty, err
	}
	r, exists := j.Phones[p.PhoneID]
	if !exists || r.Identity != p.PhoneIdentity || r.Generation != p.Generation || !samePhoneRun(r.Run, p.Run) ||
		(action != "close" && r.Phase != "running") || r.Phase == "deleted" {
		return empty, errors.New("phone_media_stale_run")
	}
	driver, ok := c.driver.(PhoneMediaDriver)
	if !ok {
		return empty, errors.New("phone_media_not_configured")
	}
	return driver.ControlPhoneMedia(ctx, action, p)
}
