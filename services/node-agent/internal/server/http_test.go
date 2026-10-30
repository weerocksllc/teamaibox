package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type fakeCommandService struct {
	calls int
	proof agent.AuthProof
	err   error
}

func (f *fakeCommandService) Handle(_ context.Context, envelope agent.CommandEnvelope, proof agent.AuthProof) (agent.CommandResult, error) {
	f.calls++
	f.proof = proof
	f.proof.SignedBody = append([]byte(nil), proof.SignedBody...)
	if f.err != nil {
		return agent.CommandResult{}, f.err
	}
	return agent.CommandResult{CommandID: envelope.CommandID, NodeID: envelope.NodeID, Status: "succeeded", CompletedAt: time.Now()}, nil
}

type fakeReady struct{ err error }

func (f fakeReady) Ready(context.Context) error { return f.err }

func commandBody(t *testing.T) string {
	t.Helper()
	value := agent.CommandEnvelope{
		ProtocolVersion: 1,
		CommandID:       "00000000-0000-4000-8000-000000000601",
		NodeID:          "00000000-0000-4000-8000-000000000101",
		NodeGeneration:  7,
		Type:            "worker.health",
		IssuedAt:        time.Now().Add(-time.Second),
		DeadlineAt:      time.Now().Add(time.Minute),
		LeaseID:         "00000000-0000-4000-8000-000000000501",
		FencingToken:    1,
		Idempotency:     "keyed",
		Payload:         json.RawMessage(`{"workerId":"00000000-0000-4000-8000-000000000201"}`),
	}
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func mutualTLSRequest(method, target, body string) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.TLS = &tls.ConnectionState{VerifiedChains: [][]*x509.Certificate{{{URIs: []*url.URL{schedulerControllerURI()}}}}}
	return request
}

func TestCommandEndpointRequiresMutualTLSAndPassesHeaderProof(t *testing.T) {
	service := &fakeCommandService{}
	handler, _ := NewHandler(service, fakeReady{})
	body := commandBody(t)

	withoutTLS := httptest.NewRequest(http.MethodPost, "/v1/commands", strings.NewReader(body))
	withoutTLS.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, withoutTLS)
	if response.Code != http.StatusUnauthorized || service.calls != 0 {
		t.Fatalf("command without mTLS was not rejected: status=%d calls=%d", response.Code, service.calls)
	}

	nodeIdentity, err := url.Parse("spiffe://teamaibox.local/node/00000000-0000-4000-8000-000000000101")
	if err != nil {
		t.Fatal(err)
	}
	wrongIdentity := httptest.NewRequest(http.MethodPost, "/v1/commands", strings.NewReader(body))
	wrongIdentity.TLS = &tls.ConnectionState{VerifiedChains: [][]*x509.Certificate{{{URIs: []*url.URL{nodeIdentity}}}}}
	wrongIdentity.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, wrongIdentity)
	if response.Code != http.StatusUnauthorized || service.calls != 0 {
		t.Fatalf("managed-node peer certificate was accepted as the scheduler controller: status=%d calls=%d", response.Code, service.calls)
	}

	request := mutualTLSRequest(http.MethodPost, "/v1/commands", body)
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	request.Header.Set("X-Teamaibox-Key-Id", "scheduler-a")
	request.Header.Set("X-Teamaibox-Nonce", "nonce-a")
	request.Header.Set("X-Teamaibox-Signature", "signature-a")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.calls != 1 {
		t.Fatalf("valid command did not reach service: status=%d calls=%d body=%s", response.Code, service.calls, response.Body.String())
	}
	if service.proof.KeyID != "scheduler-a" || service.proof.Nonce != "nonce-a" || service.proof.Signature != "signature-a" {
		t.Fatalf("authentication headers were not preserved: %#v", service.proof)
	}
	if string(service.proof.SignedBody) != body {
		t.Fatal("the exact bounded request body was not preserved for signature verification")
	}
}

func TestCommandParsingFailsClosedAndNeverReturnsInternalErrorText(t *testing.T) {
	service := &fakeCommandService{err: agent.ErrAuthentication}
	handler, _ := NewHandler(service, fakeReady{})

	request := mutualTLSRequest(http.MethodPost, "/v1/commands", commandBody(t))
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnsupportedMediaType || service.calls != 0 {
		t.Fatalf("wrong media type reached service: %d calls=%d", response.Code, service.calls)
	}

	request = mutualTLSRequest(http.MethodPost, "/v1/commands", commandBody(t))
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || strings.Contains(response.Body.String(), agent.ErrAuthentication.Error()) {
		t.Fatalf("authentication response leaked internal error: %d %s", response.Code, response.Body.String())
	}

	service.err = errors.New("private runtime detail")
	request = mutualTLSRequest(http.MethodPost, "/v1/commands", commandBody(t)+` {}`)
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || service.calls != 1 {
		t.Fatalf("trailing JSON was not rejected before another call: %d calls=%d", response.Code, service.calls)
	}
}

func TestReadinessReflectsDockerWithoutProtectingLiveness(t *testing.T) {
	service := &fakeCommandService{}
	handler, _ := NewHandler(service, fakeReady{err: errors.New("docker down")})

	live := httptest.NewRecorder()
	handler.ServeHTTP(live, httptest.NewRequest(http.MethodGet, "/health/live", nil))
	ready := httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if live.Code != http.StatusOK || ready.Code != http.StatusServiceUnavailable {
		t.Fatalf("unexpected health states: live=%d ready=%d", live.Code, ready.Code)
	}
}
