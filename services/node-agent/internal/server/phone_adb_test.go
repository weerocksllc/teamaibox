package server

import (
	"bufio"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

func adbRequest(t *testing.T, origin string, key []byte, kind string) *http.Request {
	r := signalRequest(t, origin, key)
	r.URL.Path = "/v1/phone-media/adb"
	r.Header.Set("Upgrade", "teamaibox-adb")
	r.Header.Del("Sec-WebSocket-Version")
	r.Header.Del("Sec-WebSocket-Key")
	body, _ := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Teamaibox-Command"))
	var envelope agent.CommandEnvelope
	json.Unmarshal(body, &envelope)
	envelope.Payload, _ = json.Marshal(map[string]any{"kind": kind, "run": map[string]any{"id": "00000000-0000-4000-8000-000000000777"}})
	body, _ = json.Marshal(envelope)
	r.Header.Set("X-Teamaibox-Command", base64.RawURLEncoding.EncodeToString(body))
	r.Header.Set("X-Teamaibox-Signature", agent.SignCommandBody(body, "test-key", "test-nonce", key))
	return r
}

func TestPhoneADBTunnelUsesMTLSAndClosesRealSocketsOnExpiry(t *testing.T) {
	operator, _, _ := signalOperator(t)
	s, key := signalFixture(t, operator)
	node, config := signalNode(t, s, schedulerControllerSPIFFE)
	connection, err := tls.Dial("tcp", node.Listener.Addr().String(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	connection.SetDeadline(time.Now().Add(3 * time.Second))
	r := adbRequest(t, node.URL, key, "adb")
	if err := r.Write(connection); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, r)
	if err != nil || response.StatusCode != 101 || response.Header.Get("Upgrade") != "teamaibox-adb" {
		t.Fatalf("upgrade: %v %+v", err, response)
	}
	if _, err := connection.Write([]byte("synthetic-adb-bytes")); err != nil {
		t.Fatal(err)
	}
	value := make([]byte, len("synthetic-adb-bytes"))
	if _, err := io.ReadFull(reader, value); err != nil || string(value) != "synthetic-adb-bytes" {
		t.Fatalf("bytes changed: %v", err)
	}
	started := time.Now()
	s.liveUntil.Store(0)
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("expired debug stream still open")
	}
	if time.Since(started) > time.Second {
		t.Fatal("debug close exceeded bound")
	}
}

func TestPhoneADBTunnelRejectsUnsignedWrongIdentityAndControlGrant(t *testing.T) {
	for _, kind := range []string{"signature", "identity", "control", "expired", "query"} {
		t.Run(kind, func(t *testing.T) {
			operator, _, _ := signalOperator(t)
			s, key := signalFixture(t, operator)
			identity := schedulerControllerSPIFFE
			if kind == "identity" {
				identity = "spiffe://teamaibox.local/node/not-controller"
			}
			node, config := signalNode(t, s, identity)
			grantKind := "adb"
			if kind == "control" {
				grantKind = "control"
			}
			r := adbRequest(t, node.URL, key, grantKind)
			if kind == "signature" {
				r.Header.Set("X-Teamaibox-Signature", "invalid")
			}
			if kind == "expired" {
				s.liveUntil.Store(0)
			}
			if kind == "query" {
				r.URL.RawQuery = "target=another-phone"
			}
			client := &http.Client{Transport: &http.Transport{TLSClientConfig: config}, Timeout: 3 * time.Second}
			defer client.CloseIdleConnections()
			response, err := client.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode < 400 || s.resolved.Load() != 0 {
				t.Fatalf("invalid request reached ADB: %d", response.StatusCode)
			}
		})
	}
}
