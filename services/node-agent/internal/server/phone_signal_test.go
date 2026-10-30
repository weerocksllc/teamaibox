package server

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

// These tests use real TLS sockets, client certificates and the production
// HMAC verifier. Only the Android operator and runtime lease are fixtures.
type signalServiceFixture struct {
	auth      *agent.Authenticator
	target    agent.PhoneSignalEndpoint
	liveUntil atomic.Int64
	closed    atomic.Int64
	resolved  atomic.Int64
}

func (s *signalServiceFixture) Handle(_ context.Context, e agent.CommandEnvelope, p agent.AuthProof) (agent.CommandResult, error) {
	if err := s.auth.Verify(e, p, time.Now()); err != nil {
		return agent.CommandResult{}, err
	}
	return agent.CommandResult{Status: "succeeded"}, nil
}
func (s *signalServiceFixture) PhoneSignalLive(agent.PhoneMediaPayload) bool {
	return time.Now().UnixMilli() < s.liveUntil.Load()
}
func (s *signalServiceFixture) PhoneSignalEndpoint(context.Context, agent.PhoneMediaPayload) (agent.PhoneSignalEndpoint, error) {
	s.resolved.Add(1)
	return s.target, nil
}
func (s *signalServiceFixture) DisconnectPhoneSignal(context.Context, agent.PhoneMediaPayload) {
	s.closed.Add(1)
}

func (s *signalServiceFixture) OpenPhoneADB(context.Context, agent.PhoneMediaPayload) (net.Conn, error) {
	s.resolved.Add(1)
	left, right := net.Pipe()
	go func() { defer right.Close(); _, _ = io.Copy(right, right) }()
	return left, nil
}

func signalControllerCertificate(t *testing.T, identity string) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	uri, _ := url.Parse(identity)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "phone signal test controller"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, URIs: []*url.URL{uri}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: cert}, pool
}
func signalOperator(t *testing.T) (*httptest.Server, <-chan http.Header, <-chan struct{}) {
	t.Helper()
	headers := make(chan http.Header, 1)
	closed := make(chan struct{}, 1)
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/connect_client" || r.URL.RawQuery != "" {
			t.Error("inexact operator path")
			http.Error(w, "wrong route", 400)
			return
		}
		headers <- r.Header.Clone()
		conn, buffer, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		defer func() { closed <- struct{}{} }()
		accept := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(accept[:]) + "\r\n\r\n")
		buffer.Flush()
		// A text frame 'ok' from the private operator crosses the actual tunnel.
		conn.Write([]byte{0x81, 2, 'o', 'k'})
		io.Copy(io.Discard, buffer)
	}))
	t.Cleanup(s.Close)
	return s, headers, closed
}
func signalNode(t *testing.T, s *signalServiceFixture, identity string) (*httptest.Server, *tls.Config) {
	t.Helper()
	cert, pool := signalControllerCertificate(t, identity)
	h, _ := NewHandler(s, fakeReady{})
	node := httptest.NewUnstartedServer(h)
	node.TLS = TLSConfig(pool)
	node.StartTLS()
	t.Cleanup(node.Close)
	roots := x509.NewCertPool()
	roots.AddCert(node.Certificate())
	return node, &tls.Config{RootCAs: roots, Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13, ServerName: "127.0.0.1"}
}
func signalRequest(t *testing.T, origin string, key []byte) *http.Request {
	t.Helper()
	var e agent.CommandEnvelope
	json.Unmarshal([]byte(commandBody(t)), &e)
	e.Type = "android-phone.media.renew"
	e.DeadlineAt = time.Now().Add(4 * time.Second)
	e.Payload = json.RawMessage(`{"run":{"id":"00000000-0000-4000-8000-000000000777"}}`)
	body, _ := json.Marshal(e)
	r, _ := http.NewRequest("GET", origin+"/v1/phone-media/signal", nil)
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Sec-WebSocket-Version", "13")
	r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	r.Header.Set("X-Teamaibox-Command", base64.RawURLEncoding.EncodeToString(body))
	r.Header.Set("X-Teamaibox-Key-Id", "test-key")
	r.Header.Set("X-Teamaibox-Nonce", "test-nonce")
	r.Header.Set("X-Teamaibox-Signature", agent.SignCommandBody(body, "test-key", "test-nonce", key))
	r.Header.Set("Cookie", "must-not-reach-operator")
	r.Header.Set("Authorization", "must-not-reach-operator")
	return r
}
func signalFixture(t *testing.T, operator *httptest.Server) (*signalServiceFixture, []byte) {
	t.Helper()
	key := []byte(strings.Repeat("s", 32))
	auth, err := agent.NewAuthenticator("00000000-0000-4000-8000-000000000101", map[string][]byte{"test-key": key})
	if err != nil {
		t.Fatal(err)
	}
	host, port, _ := net.SplitHostPort(operator.Listener.Addr().String())
	number, _ := strconv.Atoi(port)
	s := &signalServiceFixture{auth: auth, target: agent.PhoneSignalEndpoint{Host: host, Port: number, ServerName: "127.0.0.1", Certificate: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: operator.Certificate().Raw})}}
	s.liveUntil.Store(time.Now().Add(5 * time.Second).UnixMilli())
	return s, key
}

func TestPhoneMediaHeadersOnlyUseInstalledBinding(t *testing.T) {
	e := agent.PhoneSignalEndpoint{Host: "172.30.0.2", MediaAddress: "10.64.0.19", MediaFirstPort: 20000, MediaLastPort: 20049}
	if !validPhoneMediaEndpoint(e) {
		t.Fatal("valid media endpoint rejected")
	}
	h := http.Header{}
	h.Add("X-Teamaibox-Phone-Media-Node", "forged")
	h.Add("X-Teamaibox-Phone-Media-Node", "duplicate")
	h.Add("X-Teamaibox-Phone-Media-Container", "127.0.0.1")
	h.Add("X-Teamaibox-Phone-Media-Range", "1-65535")
	setPhoneMediaHeaders(h, e)
	if len(h.Values("X-Teamaibox-Phone-Media-Node")) != 1 || h.Get("X-Teamaibox-Phone-Media-Node") != e.MediaAddress ||
		h.Get("X-Teamaibox-Phone-Media-Container") != e.Host || h.Get("X-Teamaibox-Phone-Media-Range") != "20000-20049" {
		t.Fatal("operator changed mapping")
	}
	setPhoneMediaHeaders(h, agent.PhoneSignalEndpoint{})
	if len(h) != 0 {
		t.Fatal("legacy operator injected LAN policy")
	}
	for _, change := range []string{"partial", "loopback", "public", "same", "range", "slot"} {
		invalid := e
		switch change {
		case "partial":
			invalid.MediaAddress = ""
		case "loopback":
			invalid.Host = "127.0.0.1"
		case "public":
			invalid.MediaAddress = "1.1.1.1"
		case "same":
			invalid.Host = e.MediaAddress
		case "range":
			invalid.MediaLastPort = 20149
		case "slot":
			invalid.MediaFirstPort = 65500
			invalid.MediaLastPort = 65549
		}
		if validPhoneMediaEndpoint(invalid) {
			t.Fatal("invalid LAN endpoint accepted", change)
		}
	}
}

func TestPhoneMediaAllAllocatedRanges(t *testing.T) {
	for first := 20000; first+49 <= 65535; first += 100 {
		if !validPhoneMediaEndpoint(agent.PhoneSignalEndpoint{Host: "172.21.0.3", MediaContainerAddress: "172.21.0.3", MediaAddress: "10.64.0.10", MediaFirstPort: first, MediaLastPort: first + 49}) {
			t.Fatalf("valid allocated range rejected %d", first)
		}
	}
}

func TestPhoneMediaHeaderUsesPrimaryNetworkInsteadOfControlNetwork(t *testing.T) {
	e := agent.PhoneSignalEndpoint{Host: "172.21.0.3", MediaContainerAddress: "192.168.80.2",
		MediaAddress: "10.64.0.20", MediaFirstPort: 20000, MediaLastPort: 20049}
	if !validPhoneMediaEndpoint(e) {
		t.Fatal("dual-network endpoint rejected")
	}
	h := http.Header{}
	setPhoneMediaHeaders(h, e)
	if h.Get("X-Teamaibox-Phone-Media-Container") != e.MediaContainerAddress {
		t.Fatal("signalling interface incorrectly used for media")
	}
	for _, address := range []string{"127.0.0.1", "8.8.8.8", e.MediaAddress, "192.168.80.2;reboot"} {
		bad := e
		bad.MediaContainerAddress = address
		if validPhoneMediaEndpoint(bad) {
			t.Fatal("invalid primary media address accepted", address)
		}
	}
}
func TestPhoneSignalTLSProxyStripsCredentialsAndExpiresTheActualSocket(t *testing.T) {
	operator, headers, operatorClosed := signalOperator(t)
	s, key := signalFixture(t, operator)
	node, configuration := signalNode(t, s, schedulerControllerSPIFFE)
	conn, err := tls.Dial("tcp", node.Listener.Addr().String(), configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	r := signalRequest(t, node.URL, key)
	if err = r.Write(conn); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, r)
	if err != nil || response.StatusCode != 101 {
		t.Fatalf("upgrade failed: %v %+v", err, response)
	}
	frame := make([]byte, 4)
	if _, err = io.ReadFull(reader, frame); err != nil || string(frame[2:]) != "ok" {
		t.Fatalf("operator frame lost: %v %v", frame, err)
	}
	h := <-headers
	for _, name := range []string{"Cookie", "Authorization", "X-Teamaibox-Command", "X-Teamaibox-Key-Id", "X-Teamaibox-Nonce", "X-Teamaibox-Signature", "X-Forwarded-For"} {
		if h.Get(name) != "" {
			t.Errorf("leaked %s", name)
		}
	}
	start := time.Now()
	s.liveUntil.Store(start.UnixMilli())
	if _, err = reader.ReadByte(); err == nil {
		t.Fatal("expired tunnel remained readable")
	}
	select {
	case <-operatorClosed:
	case <-time.After(time.Second):
		t.Fatal("expired operator socket did not close")
	}
	for s.closed.Load() == 0 && time.Since(start) < time.Second {
		time.Sleep(time.Millisecond)
	}
	if s.closed.Load() != 1 || time.Since(start) > time.Second {
		t.Fatal("media close was not requested promptly and exactly once")
	}
}
func TestPhoneSignalRejectsAuthenticationTargetsAndCertificateDrift(t *testing.T) {
	for _, kind := range []string{"identity", "signature", "expired", "query", "redirect", "certificate"} {
		t.Run(kind, func(t *testing.T) {
			operator := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "https://must-not-follow.invalid", 302)
			}))
			defer operator.Close()
			s, key := signalFixture(t, operator)
			identity := schedulerControllerSPIFFE
			if kind == "identity" {
				identity = "spiffe://teamaibox.local/node/not-controller"
			}
			if kind == "expired" {
				s.liveUntil.Store(0)
			}
			if kind == "certificate" {
				cert, _ := signalControllerCertificate(t, schedulerControllerSPIFFE)
				s.target.Certificate = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]})
			}
			node, configuration := signalNode(t, s, identity)
			r := signalRequest(t, node.URL, key)
			if kind == "signature" {
				r.Header.Set("X-Teamaibox-Signature", "invalid")
			}
			if kind == "query" {
				r.URL.RawQuery = "target=other"
			}
			client := &http.Client{Transport: &http.Transport{TLSClientConfig: configuration}, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
				t.Error("followed operator redirect")
				return http.ErrUseLastResponse
			}}
			defer client.CloseIdleConnections()
			response, err := client.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode == 101 || response.StatusCode < 400 {
				t.Fatalf("accepted %s: %d", kind, response.StatusCode)
			}
			if (kind == "identity" || kind == "signature" || kind == "expired" || kind == "query") && s.resolved.Load() != 0 {
				t.Fatal("rejected request resolved a private target")
			}
		})
	}
}
