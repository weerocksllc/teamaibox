package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"teamaibox.local/node-agent/internal/agent"
	"testing"
	"time"
)

type computerInstallationServiceFixture struct {
	*signalServiceFixture
	received []byte
}

func (s *computerInstallationServiceFixture) ExecuteComputerInstallation(ctx context.Context, e agent.CommandEnvelope, proof agent.AuthProof, input io.Reader) (agent.ComputerResult, error) {
	if err := s.auth.Verify(e, proof, time.Now()); err != nil {
		return agent.ComputerResult{}, err
	}
	raw, err := io.ReadAll(input)
	if err != nil {
		return agent.ComputerResult{}, err
	}
	s.received = raw
	var p agent.ComputerCommand
	json.Unmarshal(e.Payload, &p)
	return agent.ComputerResult{ComputerIdentity: p.ComputerIdentity, InstallationRevision: p.Installation.Revision, MediaDigest: p.Installation.Digest, MediaReady: true}, nil
}
func TestComputerInstallationSignedStreamAndLength(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	auth, err := agent.NewAuthenticator("00000000-0000-4000-8000-000000000101", map[string][]byte{"test-key": key})
	if err != nil {
		t.Fatal(err)
	}
	service := &computerInstallationServiceFixture{signalServiceFixture: &signalServiceFixture{auth: auth}}
	certificate, pool := signalControllerCertificate(t, schedulerControllerSPIFFE)
	handler, _ := NewHandler(service, fakeReady{})
	server := httptest.NewUnstartedServer(handler)
	server.TLS = TLSConfig(pool)
	server.StartTLS()
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS13}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	var envelope agent.CommandEnvelope
	json.Unmarshal([]byte(commandBody(t)), &envelope)
	envelope.Type = "virtual-computer.installation"
	envelope.DeadlineAt = time.Now().Add(4 * time.Second)
	data := bytes.Repeat([]byte{0, 255, 127}, 100000)
	p := agent.ComputerCommand{Installation: &agent.ComputerInstallationCommand{Action: "mount", Revision: 2, Size: int64(len(data))}}
	envelope.Payload, _ = json.Marshal(p)
	body, _ := json.Marshal(envelope)
	request := func(content []byte, signature string) *http.Request {
		r, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/computer-installation", bytes.NewReader(content))
		r.Header.Set("Content-Type", "application/octet-stream")
		r.Header.Set("X-Teamaibox-Command", base64.RawURLEncoding.EncodeToString(body))
		r.Header.Set("X-Teamaibox-Key-Id", "test-key")
		r.Header.Set("X-Teamaibox-Nonce", "installation-fixture")
		r.Header.Set("X-Teamaibox-Signature", signature)
		return r
	}
	signature := agent.SignCommandBody(body, "test-key", "installation-fixture", key)
	response, err := client.Do(request(data, signature))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !bytes.Equal(service.received, data) {
		t.Fatalf("stream mismatch %d %s", response.StatusCode, raw)
	}
	service.received = nil
	for _, r := range []*http.Request{request(data[:100], signature), request(data, "incorrect-signature")} {
		response, err = client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode == 200 || service.received != nil {
			t.Fatal("invalid upload accepted")
		}
	}
}
