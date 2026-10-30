package agent

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	ErrAuthentication = errors.New("command authentication failed")
	ErrReplay         = errors.New("command nonce replayed with different facts")
	ErrExpired        = errors.New("command is expired or outside the accepted clock window")
)

type nonceRecord struct {
	commandID string
	expiresAt time.Time
}

type Authenticator struct {
	nodeID    string
	keys      map[string][]byte
	clockSkew time.Duration
	maxWindow time.Duration
	mu        sync.Mutex
	nonces    map[string]nonceRecord
}

func NewAuthenticator(nodeID string, keys map[string][]byte) (*Authenticator, error) {
	if !uuidPattern.MatchString(nodeID) || len(keys) == 0 {
		return nil, fmt.Errorf("node identity and at least one authentication key are required")
	}
	owned := make(map[string][]byte, len(keys))
	for keyID, key := range keys {
		if keyID == "" || len(key) < 32 {
			return nil, fmt.Errorf("authentication key %q must contain at least 32 bytes", keyID)
		}
		owned[keyID] = append([]byte(nil), key...)
	}
	return &Authenticator{
		nodeID: nodeID, keys: owned, clockSkew: 30 * time.Second,
		maxWindow: 15 * time.Minute, nonces: make(map[string]nonceRecord),
	}, nil
}

func signatureInput(envelope CommandEnvelope, proof AuthProof) ([]byte, error) {
	body := proof.SignedBody
	if len(body) == 0 {
		var err error
		body, err = json.Marshal(envelope)
		if err != nil {
			return nil, err
		}
	}
	prefix := []byte(proof.KeyID + "\n" + proof.Nonce + "\n")
	return append(prefix, body...), nil
}

func SignCommand(envelope CommandEnvelope, keyID, nonce string, key []byte) (string, error) {
	body, err := json.Marshal(envelope)
	if err != nil {
		return "", err
	}
	return SignCommandBody(body, keyID, nonce, key), nil
}

func SignCommandBody(body []byte, keyID, nonce string, key []byte) string {
	input := append([]byte(keyID+"\n"+nonce+"\n"), body...)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(input)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *Authenticator) Verify(envelope CommandEnvelope, proof AuthProof, now time.Time) error {
	if envelope.ProtocolVersion != 1 || envelope.NodeID != a.nodeID || proof.Nonce == "" {
		return ErrAuthentication
	}
	if envelope.IssuedAt.After(now.Add(a.clockSkew)) || envelope.DeadlineAt.Before(now) ||
		envelope.DeadlineAt.Before(envelope.IssuedAt) || envelope.DeadlineAt.Sub(envelope.IssuedAt) > a.maxWindow {
		return ErrExpired
	}
	key, ok := a.keys[proof.KeyID]
	if !ok {
		return ErrAuthentication
	}
	input, err := signatureInput(envelope, proof)
	if err != nil {
		return ErrAuthentication
	}
	defer func() {
		for index := range input {
			input[index] = 0
		}
	}()
	provided, err := base64.RawURLEncoding.DecodeString(proof.Signature)
	if err != nil {
		return ErrAuthentication
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(input)
	if !hmac.Equal(provided, mac.Sum(nil)) {
		return ErrAuthentication
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	for nonceKey, record := range a.nonces {
		if record.expiresAt.Before(now) {
			delete(a.nonces, nonceKey)
		}
	}
	nonceKey := proof.KeyID + "\x00" + proof.Nonce
	if record, exists := a.nonces[nonceKey]; exists {
		if record.commandID != envelope.CommandID {
			return ErrReplay
		}
		return nil
	}
	a.nonces[nonceKey] = nonceRecord{commandID: envelope.CommandID, expiresAt: envelope.DeadlineAt.Add(a.clockSkew)}
	return nil
}
