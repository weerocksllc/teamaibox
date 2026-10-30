package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

// Real TLS and HMAC. Only the Android input process is a fixture; its actual
// pixel conversion/Camera2 behavior has a separate disposable-guest test.
type cameraServiceFixture struct {
	*signalServiceFixture
	received chan []byte
	calls    atomic.Int64
	failure  error
}

func (s *cameraServiceFixture) ExecutePhoneCamera(ctx context.Context, e agent.CommandEnvelope, proof agent.AuthProof, input io.Reader) (agent.PhoneCameraResult, error) {
	if err := s.auth.Verify(e, proof, time.Now()); err != nil {
		return agent.PhoneCameraResult{}, err
	}
	s.calls.Add(1)
	if s.failure != nil {
		return agent.PhoneCameraResult{}, s.failure
	}
	raw, err := io.ReadAll(input)
	if err != nil {
		return agent.PhoneCameraResult{}, err
	}
	s.received <- raw
	var p agent.PhoneCameraPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return agent.PhoneCameraResult{}, err
	}
	return agent.PhoneCameraResult{PhoneCameraGrant: p.Grant(), State: "receiving", ResourceScope: "phone-run"}, nil
}

func TestPhoneCameraRealTLSAndSignedBinaryRequest(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	auth, err := agent.NewAuthenticator("00000000-0000-4000-8000-000000000101", map[string][]byte{"test-key": key})
	if err != nil {
		t.Fatal(err)
	}
	s := &cameraServiceFixture{signalServiceFixture: &signalServiceFixture{auth: auth}, received: make(chan []byte, 1)}
	certificate, pool := signalControllerCertificate(t, schedulerControllerSPIFFE)
	h, _ := NewHandler(s, fakeReady{})
	node := httptest.NewUnstartedServer(h)
	node.TLS = TLSConfig(pool)
	node.StartTLS()
	defer node.Close()
	roots := x509.NewCertPool()
	roots.AddCert(node.Certificate())
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS13}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	var e agent.CommandEnvelope
	json.Unmarshal([]byte(commandBody(t)), &e)
	e.Type = "android-phone.camera.input"
	e.DeadlineAt = time.Now().Add(4 * time.Second)
	e.Payload = json.RawMessage(`{"phoneId":"00000000-0000-4000-8000-000000000201","ownerId":"00000000-0000-4000-8000-000000000202","generation":1,"run":{"id":"00000000-0000-4000-8000-000000000203"},"grantId":"00000000-0000-4000-8000-000000000204","sourceId":"00000000-0000-4000-8000-000000000205","sourceKind":"image","sessionId":"00000000-0000-4000-8000-000000000206"}`)
	envelope, _ := json.Marshal(e)
	image := append(bytes.Repeat([]byte{0, 255, 127}, 100000), []byte("\nTEAMAIBOX-CAMERA-END\n")...)
	request := func() *http.Request {
		r, _ := http.NewRequest(http.MethodPost, node.URL+"/v1/phone-camera", bytes.NewReader(image))
		r.Header.Set("Content-Type", "application/octet-stream")
		r.Header.Set("X-Teamaibox-Command", base64.RawURLEncoding.EncodeToString(envelope))
		r.Header.Set("X-Teamaibox-Key-Id", "test-key")
		r.Header.Set("X-Teamaibox-Nonce", "test-nonce")
		r.Header.Set("X-Teamaibox-Signature", agent.SignCommandBody(envelope, "test-key", "test-nonce", key))
		return r
	}
	response, err := client.Do(request())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || response.TLS.Version != tls.VersionTLS13 {
		t.Fatalf("request failed: %d %s", response.StatusCode, body)
	}
	if !bytes.Equal(<-s.received, image) {
		t.Fatal("binary input changed")
	}
	if strings.Contains(string(body), "TEAMAIBOX-CAMERA-END") {
		t.Fatal("source bytes disclosed")
	}
	for _, modify := range []func(*http.Request){
		func(r *http.Request) { r.Header.Set("X-Teamaibox-Signature", "invalid") },
		func(r *http.Request) { r.Header.Add("X-Teamaibox-Command", r.Header.Get("X-Teamaibox-Command")) },
		func(r *http.Request) { r.URL.RawQuery = "path=/dev/video0" },
		func(r *http.Request) { r.Header.Set("Content-Type", "application/json") },
	} {
		r := request()
		modify(r)
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode < 400 {
			t.Fatal("invalid request accepted")
		}
	}
	if s.calls.Load() != 1 {
		t.Fatal("rejected request reached input runtime")
	}
	// A server-trusting caller without the controller client identity cannot
	// submit any camera source, even with otherwise correct signed headers.
	noIdentity := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}}
	defer noIdentity.CloseIdleConnections()
	r, err := (&http.Client{Transport: noIdentity, Timeout: 5 * time.Second}).Do(request())
	if err == nil {
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		if r.StatusCode < 400 {
			t.Fatal("client identity missing but accepted")
		}
	}
	if s.calls.Load() != 1 {
		t.Fatal("missing controller identity reached runtime")
	}
	for _, code := range []string{"phone_camera_usb_busy", "phone_camera_usb_device_changed"} {
		s.failure = errors.New(code)
		response, err := client.Do(request())
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 409 || !strings.Contains(string(body), code) {
			t.Fatalf("USB failure lost: %d %s", response.StatusCode, body)
		}
	}
	for _, code := range []string{"phone_camera_not_ready", "phone_runtime_status_stale", "phone_camera_worker_failed", "/private/frame.jpg"} {
		s.failure = errors.New(code)
		response, err := client.Do(request())
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if strings.HasPrefix(code, "phone_") {
			if response.StatusCode != 503 || !strings.Contains(string(body), code) {
				t.Fatalf("diagnostic lost: %s", body)
			}
		} else if strings.Contains(string(body), code) {
			t.Fatal("private error leaked")
		}
	}
}
