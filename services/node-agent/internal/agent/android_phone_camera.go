package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/netip"
	"strings"
	"time"
)

const PhoneCameraMaximum = 1<<53 - 1
const PhoneCameraVideoMaximum = 1<<53 - 1

type PhoneCameraPayload struct {
	PhoneCommandPayload
	Action         string          `json:"action"`
	GrantID        string          `json:"grantId"`
	SourceID       string          `json:"sourceId"`
	SourceKind     string          `json:"sourceKind"`
	SessionID      string          `json:"sessionId"`
	Deadline       int64           `json:"deadline"`
	LeaseExpiresAt int64           `json:"leaseExpiresAt,omitempty"`
	SizeBytes      int64           `json:"sizeBytes,omitempty"`
	SHA256         string          `json:"sha256,omitempty"`
	PeerAddress    string          `json:"peerAddress,omitempty"`
	Loop           *bool           `json:"loop,omitempty"`
	DeviceID       string          `json:"deviceId,omitempty"`
	AttachmentID   string          `json:"attachmentId,omitempty"`
	UDPPolicy      *PhoneUDPPolicy `json:"udpPolicy,omitempty"`
}
type PhoneUDPPolicy struct {
	ListenAddress  string   `json:"listenAddress"`
	ListenPort     int      `json:"listenPort"`
	AllowedSources []string `json:"allowedSources"`
}

func validPhoneUDPPolicy(p *PhoneUDPPolicy) bool {
	if p == nil || p.ListenPort < 1024 || p.ListenPort > 65535 || len(p.AllowedSources) == 0 {
		return false
	}
	validAddress := func(s string) bool {
		a, err := netip.ParseAddr(s)
		if err != nil || !a.Is4() || a.IsUnspecified() || a.IsMulticast() || a.IsLinkLocalUnicast() {
			return false
		}
		b := a.As4()
		return b[0] > 0 && b[0] < 224
	}
	if !validAddress(p.ListenAddress) {
		return false
	}
	seen := map[string]bool{}
	for _, source := range p.AllowedSources {
		n, err := netip.ParsePrefix(source)
		if err != nil || !n.Addr().Is4() || n.Bits() < 1 || n != n.Masked() || n.String() != source || !validAddress(n.Addr().String()) || seen[source] {
			return false
		}
		seen[source] = true
	}
	return true
}

type PhoneCameraGrant struct {
	ID         string `json:"id"`
	SourceID   string `json:"sourceId"`
	SourceKind string `json:"sourceKind"`
	PhoneID    string `json:"phoneId"`
	OwnerID    string `json:"ownerId"`
	RunID      string `json:"runId"`
	Generation uint64 `json:"generation"`
	SessionID  string `json:"sessionId"`
}

func (p PhoneCameraPayload) Grant() PhoneCameraGrant {
	return PhoneCameraGrant{p.GrantID, p.SourceID, p.SourceKind, p.PhoneID, p.OwnerID, p.Run.ID, p.Generation, p.SessionID}
}

type PhoneCameraResult struct {
	PhoneCameraGrant
	State              string `json:"state"`
	ResourceScope      string `json:"resourceScope"`
	LeaseExpiresAt     int64  `json:"leaseExpiresAt,omitempty"`
	RetainedFrameBytes *int64 `json:"retainedFrameBytes,omitempty"`
	AnswerSDP          string `json:"answerSdp,omitempty"`
	ContainerAddress   string `json:"containerAddress,omitempty"`
	NodeAddress        string `json:"nodeAddress,omitempty"`
	FirstPort          int    `json:"firstPort,omitempty"`
	LastPort           int    `json:"lastPort,omitempty"`
}

func ValidPhoneCameraResult(p PhoneCameraPayload, r PhoneCameraResult) bool {
	if r.PhoneCameraGrant != p.Grant() || r.ResourceScope != "phone-run" {
		return false
	}
	if p.Action != "browser-offer" && (r.AnswerSDP != "" || r.ContainerAddress != "" || r.NodeAddress != "" || r.FirstPort != 0 || r.LastPort != 0) {
		return false
	}
	switch p.Action {
	case "open":
		return r.State == "waiting" && r.LeaseExpiresAt == p.LeaseExpiresAt && r.RetainedFrameBytes == nil
	case "renew":
		return (r.State == "waiting" || r.State == "receiving") && r.LeaseExpiresAt == p.LeaseExpiresAt && r.RetainedFrameBytes == nil
	case "image", "video", "usb":
		return r.State == "receiving" && r.LeaseExpiresAt == 0 && r.RetainedFrameBytes == nil
	case "udp":
		return (r.State == "waiting" || r.State == "receiving") && r.LeaseExpiresAt == 0 && r.RetainedFrameBytes == nil
	case "browser-offer":
		container, node := net.ParseIP(r.ContainerAddress), net.ParseIP(r.NodeAddress)
		return (r.State == "waiting" || r.State == "receiving") && r.LeaseExpiresAt == 0 && r.RetainedFrameBytes == nil &&
			strings.HasPrefix(r.AnswerSDP, "v=0\r\n") && len(r.AnswerSDP) <= 65536 &&
			container != nil && container.To4() != nil && container.IsPrivate() && node != nil && node.To4() != nil && node.IsPrivate() && !container.Equal(node) &&
			(r.FirstPort == 20040 || r.FirstPort == 20140) && r.LastPort == r.FirstPort+9
	case "close":
		return r.State == "stopped" && r.LeaseExpiresAt == 0 && r.RetainedFrameBytes != nil && *r.RetainedFrameBytes == 0
	case "status":
		return (r.State == "waiting" || r.State == "receiving" || r.State == "stopped") && r.LeaseExpiresAt == 0 && r.RetainedFrameBytes == nil
	}
	return false
}

type PhoneCameraRuntime interface {
	ExecutePhoneCamera(context.Context, PhoneCameraPayload, io.Reader) (PhoneCameraResult, error)
}

func validPhoneCamera(p PhoneCameraPayload, now time.Time) bool {
	if p.Action != "udp" && p.UDPPolicy != nil {
		return false
	}
	if p.Action != "usb" && (p.DeviceID != "" || p.AttachmentID != "") {
		return false
	}
	if !validPhoneCommand("inspect", p.PhoneCommandPayload) || !uuidPattern.MatchString(p.GrantID) || !uuidPattern.MatchString(p.SourceID) ||
		!uuidPattern.MatchString(p.SessionID) || p.OperationID != p.GrantID || (p.SourceKind != "image" && p.SourceKind != "browser" && p.SourceKind != "video" && p.SourceKind != "usb" && p.SourceKind != "udp") || p.Deadline <= now.UnixMilli() || (p.Action != "video" && p.Loop != nil) {
		return false
	}
	limit := 5 * time.Second
	if p.Action == "image" || p.Action == "video" || p.Action == "usb" || p.Action == "udp" || p.Action == "browser-offer" {
		limit = 15 * time.Second
	}
	if p.Deadline > now.Add(limit).UnixMilli() {
		return false
	}
	if p.Action == "image" {
		return p.SourceKind == "image" && p.PeerAddress == "" && p.LeaseExpiresAt == 0 && p.SizeBytes > 0 && p.SizeBytes <= PhoneCameraMaximum && regexpPhoneRequestDigest.MatchString(p.SHA256)
	}
	if p.Action == "video" {
		return p.SourceKind == "video" && p.Loop != nil && p.PeerAddress == "" && p.LeaseExpiresAt == 0 && p.SizeBytes > 0 && p.SizeBytes <= PhoneCameraVideoMaximum && regexpPhoneRequestDigest.MatchString(p.SHA256)
	}
	if p.Action == "browser-offer" {
		peer := net.ParseIP(p.PeerAddress)
		return p.SourceKind == "browser" && p.LeaseExpiresAt == 0 && p.SizeBytes > 0 && p.SizeBytes <= 65536 && regexpPhoneRequestDigest.MatchString(p.SHA256) &&
			peer != nil && peer.To4() != nil && peer.IsPrivate() && !strings.Contains(p.PeerAddress, ":")
	}
	if p.SizeBytes != 0 || p.SHA256 != "" || p.PeerAddress != "" {
		return false
	}
	if p.Action == "usb" {
		return p.SourceKind == "usb" && p.LeaseExpiresAt == 0 && uuidPattern.MatchString(p.DeviceID) && regexpPhoneRequestDigest.MatchString(p.AttachmentID)
	}
	if p.DeviceID != "" || p.AttachmentID != "" {
		return false
	}
	if p.Action == "udp" {
		return p.SourceKind == "udp" && p.LeaseExpiresAt == 0 && validPhoneUDPPolicy(p.UDPPolicy)
	}
	switch p.Action {
	case "open", "renew":
		return p.LeaseExpiresAt > now.UnixMilli() && p.LeaseExpiresAt <= now.Add(5*time.Second).UnixMilli()
	case "close", "status":
		return p.LeaseExpiresAt == 0
	}
	return false
}

// Short camera controls never enter the durable command-result map. Frames are
// not events or audit payloads. Only image preparation is exclusive and bounded.
func (s *Service) ExecutePhoneCamera(ctx context.Context, e CommandEnvelope, proof AuthProof, input io.Reader) (PhoneCameraResult, error) {
	var empty PhoneCameraResult
	now := s.now().UTC()
	if err := s.authenticator.Verify(e, proof, now); err != nil {
		return empty, err
	}
	if e.NodeGeneration != s.nodeGeneration {
		return empty, ErrStaleNodeGeneration
	}
	var p PhoneCameraPayload
	d := json.NewDecoder(bytes.NewReader(e.Payload))
	d.DisallowUnknownFields()
	if e.Type != "android-phone.camera.input" || !uuidPattern.MatchString(e.CommandID) || e.Idempotency != "keyed" || len(e.Payload) > 4096 || rejectPhoneDuplicateKeys(e.Payload) != nil ||
		d.Decode(&p) != nil || !errors.Is(d.Decode(&struct{}{}), io.EOF) || !validPhoneCamera(p, now) || e.LeaseID != p.PhoneID || e.FencingToken != p.Generation+1 || e.DeadlineAt.UnixMilli() != p.Deadline {
		return empty, errors.New("phone_camera_payload_invalid")
	}
	runtime, ok := s.phones.(PhoneCameraRuntime)
	if !ok {
		return empty, errors.New("phone_camera_not_configured")
	}
	if p.Action == "open" || p.Action == "image" || p.Action == "video" || p.Action == "usb" || p.Action == "udp" || p.Action == "browser-offer" {
		if !s.maintenanceGate.TryRLock() {
			return empty, errors.New("phone_operation_conflict")
		}
		defer s.maintenanceGate.RUnlock()
		if (s.protectedMaintenance != nil && s.protectedMaintenance.BlocksOrdinaryMutation()) || (s.protectedTransition != nil && s.protectedTransition.BlocksOrdinaryMutation()) {
			return empty, errors.New("phone_operation_conflict")
		}
	}
	if p.Action == "image" || p.Action == "video" || p.Action == "usb" || p.Action == "udp" || p.Action == "browser-offer" {
		s.mu.Lock()
		if s.phoneCameraImages == nil {
			s.phoneCameraImages = map[string]time.Time{}
			s.phoneCameraActive = map[string]bool{}
		}
		for id, until := range s.phoneCameraImages {
			if !until.After(now) {
				delete(s.phoneCameraImages, id)
			}
		}
		if _, used := s.phoneCameraImages[e.CommandID]; used || s.phoneCameraActive[p.PhoneID] || len(s.phoneCameraImages) >= 4096 {
			s.mu.Unlock()
			return empty, errors.New("phone_operation_conflict")
		}
		s.phoneCameraImages[e.CommandID] = e.DeadlineAt
		s.phoneCameraActive[p.PhoneID] = true
		s.mu.Unlock()
		defer func() { s.mu.Lock(); delete(s.phoneCameraActive, p.PhoneID); s.mu.Unlock() }()
	}
	// The signed deadline authorizes starting this command. A file transfer
	// continues while making progress; cancellation and the separate camera
	// lease still revoke it. Do not turn a 15s command window into a file cap.
	bounded, cancel := context.WithCancel(ctx)
	if p.Action != "image" && p.Action != "video" {
		cancel()
		bounded, cancel = context.WithDeadline(ctx, e.DeadlineAt)
	}
	defer cancel()
	result, err := runtime.ExecutePhoneCamera(bounded, p, input)
	if err == nil && !ValidPhoneCameraResult(p, result) {
		err = errors.New("phone_camera_result_invalid")
	}
	return result, err
}
func (c *PhoneCoordinator) ExecutePhoneCamera(ctx context.Context, p PhoneCameraPayload, input io.Reader) (PhoneCameraResult, error) {
	var empty PhoneCameraResult
	if c.root == nil || !validPhoneCamera(p, time.Now()) {
		return empty, errors.New("phone_camera_payload_invalid")
	}
	c.mediaMu.RLock()
	j, err := c.read()
	c.mediaMu.RUnlock()
	if err != nil {
		return empty, err
	}
	r, ok := j.Phones[p.PhoneID]
	if !ok || r.Identity != p.PhoneIdentity || r.Generation != p.Generation || !samePhoneRun(r.Run, p.Run) || r.Phase == "deleted" || (p.Action != "close" && r.Phase != "running") {
		return empty, errors.New("phone_stale_run")
	}
	driver, ok := c.driver.(PhoneCameraRuntime)
	if !ok {
		return empty, errors.New("phone_camera_not_configured")
	}
	return driver.ExecutePhoneCamera(ctx, p, input)
}
