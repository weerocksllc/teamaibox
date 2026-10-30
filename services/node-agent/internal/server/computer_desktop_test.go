package server

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type computerDesktopFixture struct {
	auth    *agent.Authenticator
	opened  atomic.Int64
	running bool
}

func (s *computerDesktopFixture) Handle(_ context.Context, e agent.CommandEnvelope, proof agent.AuthProof) (agent.CommandResult, error) {
	if err := s.auth.Verify(e, proof, time.Now()); err != nil {
		return agent.CommandResult{}, err
	}
	var p agent.ComputerCommand
	_ = json.Unmarshal(e.Payload, &p)
	raw, _ := json.Marshal(agent.ComputerResult{ComputerIdentity: p.ComputerIdentity, Running: s.running, RunID: p.Run.ID, ContainerID: *p.Run.ContainerID})
	return agent.CommandResult{Status: "succeeded", Payload: raw}, nil
}
func (s *computerDesktopFixture) OpenComputerDesktop(_ context.Context, _ agent.ComputerCommand, kind string) (net.Conn, error) {
	s.opened.Add(1)
	left, right := net.Pipe()
	go func() { defer right.Close(); _, _ = io.Copy(right, right) }()
	return left, nil
}
func computerDesktopRequest(t *testing.T, origin string, key []byte, kind string) *http.Request {
	r := signalRequest(t, origin, key)
	r.URL.Path = "/v1/computer-desktop/" + kind
	r.Header.Set("Upgrade", "teamaibox-computer")
	r.Header.Del("Sec-WebSocket-Version")
	r.Header.Del("Sec-WebSocket-Key")
	body, _ := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Teamaibox-Command"))
	var e agent.CommandEnvelope
	_ = json.Unmarshal(body, &e)
	e.Type = "virtual-computer.inspect"
	e.Payload = json.RawMessage(`{"computerId":"00000000-0000-4000-8000-000000000201","ownerId":"00000000-0000-4000-8000-000000000202","run":{"id":"00000000-0000-4000-8000-000000000203","containerId":"` + strings.Repeat("b", 64) + `"}}`)
	body, _ = json.Marshal(e)
	r.Header.Set("X-Teamaibox-Command", base64.RawURLEncoding.EncodeToString(body))
	r.Header.Set("X-Teamaibox-Signature", agent.SignCommandBody(body, "test-key", "test-nonce", key))
	return r
}
func computerDesktopNode(t *testing.T, identity string) (*httptest.Server, *tls.Config, *computerDesktopFixture, []byte) {
	key := []byte(strings.Repeat("s", 32))
	auth, e := agent.NewAuthenticator("00000000-0000-4000-8000-000000000101", map[string][]byte{"test-key": key})
	if e != nil {
		t.Fatal(e)
	}
	s := &computerDesktopFixture{auth: auth, running: true}
	h, _ := NewHandler(s, fakeReady{})
	cert, pool := signalControllerCertificate(t, identity)
	node := httptest.NewUnstartedServer(h)
	node.TLS = TLSConfig(pool)
	node.StartTLS()
	t.Cleanup(node.Close)
	roots := x509.NewCertPool()
	roots.AddCert(node.Certificate())
	return node, &tls.Config{RootCAs: roots, Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13, ServerName: "127.0.0.1"}, s, key
}
func TestComputerDesktopRealMTLSStream(t *testing.T) {
	for _, kind := range []string{"rdp", "console", "audio"} {
		t.Run(kind, func(t *testing.T) {
			node, config, s, key := computerDesktopNode(t, schedulerControllerSPIFFE)
			conn, e := tls.Dial("tcp", node.Listener.Addr().String(), config)
			if e != nil {
				t.Fatal(e)
			}
			defer conn.Close()
			conn.SetDeadline(time.Now().Add(3 * time.Second))
			r := computerDesktopRequest(t, node.URL, key, kind)
			if e = r.Write(conn); e != nil {
				t.Fatal(e)
			}
			reader := bufio.NewReader(conn)
			response, e := http.ReadResponse(reader, r)
			if e != nil || response.StatusCode != 101 || response.Header.Get("Upgrade") != "teamaibox-computer" {
				t.Fatalf("upgrade failed: %v %+v", e, response)
			}
			input := []byte{0, 1, 2, 255, 0, 13, 10}
			if _, e = conn.Write(input); e != nil {
				t.Fatal(e)
			}
			output := make([]byte, len(input))
			if _, e = io.ReadFull(reader, output); e != nil || string(output) != string(input) {
				t.Fatal("bytes changed", e)
			}
			if s.opened.Load() != 1 {
				t.Fatal("opened more than selected stream")
			}
		})
	}
}
func TestComputerDesktopRejectsUntrustedAndStoppedTargets(t *testing.T) {
	for _, kind := range []string{"signature", "identity", "query", "stopped", "missing-container", "wrong-command"} {
		t.Run(kind, func(t *testing.T) {
			identity := schedulerControllerSPIFFE
			if kind == "identity" {
				identity = "spiffe://teamaibox.local/node/other"
			}
			node, config, s, key := computerDesktopNode(t, identity)
			r := computerDesktopRequest(t, node.URL, key, "rdp")
			if kind == "signature" {
				r.Header.Set("X-Teamaibox-Signature", "bad")
			}
			if kind == "query" {
				r.URL.RawQuery = "host=other"
			}
			if kind == "stopped" {
				s.running = false
			}
			if kind == "missing-container" || kind == "wrong-command" {
				body, _ := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Teamaibox-Command"))
				var e agent.CommandEnvelope
				_ = json.Unmarshal(body, &e)
				if kind == "wrong-command" {
					e.Type = "virtual-computer.start"
				} else {
					e.Payload = json.RawMessage(`{"run":{}}`)
				}
				body, _ = json.Marshal(e)
				r.Header.Set("X-Teamaibox-Command", base64.RawURLEncoding.EncodeToString(body))
				r.Header.Set("X-Teamaibox-Signature", agent.SignCommandBody(body, "test-key", "test-nonce", key))
			}
			client := &http.Client{Transport: &http.Transport{TLSClientConfig: config}, Timeout: 3 * time.Second}
			defer client.CloseIdleConnections()
			response, e := client.Do(r)
			if e != nil {
				t.Fatal(e)
			}
			defer response.Body.Close()
			if response.StatusCode < 400 || s.opened.Load() != 0 {
				t.Fatal("invalid request opened desktop")
			}
		})
	}
}
