package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type phoneSignalService interface {
	PhoneSignalEndpoint(context.Context, agent.PhoneMediaPayload) (agent.PhoneSignalEndpoint, error)
	PhoneSignalLive(agent.PhoneMediaPayload) bool
	DisconnectPhoneSignal(context.Context, agent.PhoneMediaPayload)
}

func validPhoneMediaEndpoint(endpoint agent.PhoneSignalEndpoint) bool {
	if endpoint.MediaAddress == "" && endpoint.MediaFirstPort == 0 && endpoint.MediaLastPort == 0 {
		return true
	}
	containerAddress := endpoint.MediaContainerAddress
	if containerAddress == "" { // Retained single-network declarations.
		containerAddress = endpoint.Host
	}
	media, container := net.ParseIP(endpoint.MediaAddress), net.ParseIP(containerAddress)
	return media != nil && media.To4() != nil && media.IsPrivate() && media.String() == endpoint.MediaAddress &&
		container != nil && container.To4() != nil && container.IsPrivate() && container.String() == containerAddress && container.String() != media.String() &&
		endpoint.MediaFirstPort >= 20000 && (endpoint.MediaFirstPort-20000)%100 == 0 && endpoint.MediaLastPort <= 65535 && endpoint.MediaLastPort == endpoint.MediaFirstPort+49
}

func setPhoneMediaHeaders(header http.Header, endpoint agent.PhoneSignalEndpoint) {
	for _, name := range []string{"X-Teamaibox-Phone-Media-Node", "X-Teamaibox-Phone-Media-Container", "X-Teamaibox-Phone-Media-Range"} {
		header.Del(name)
	}
	if endpoint.MediaAddress != "" {
		header.Set("X-Teamaibox-Phone-Media-Node", endpoint.MediaAddress)
		containerAddress := endpoint.MediaContainerAddress
		if containerAddress == "" {
			containerAddress = endpoint.Host
		}
		header.Set("X-Teamaibox-Phone-Media-Container", containerAddress)
		header.Set("X-Teamaibox-Phone-Media-Range", strconv.Itoa(endpoint.MediaFirstPort)+"-"+strconv.Itoa(endpoint.MediaLastPort))
	}
}

// The existing mTLS controller connection carries one HMAC-authenticated run
// declaration in a header. No browser cookies or secret URL parameters reach
// the node. The node resolves its own exact private operator and certificate.
func (h *Handler) phoneSignal(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || request.URL.RawQuery != "" || request.Header.Get("Upgrade") != "websocket" || request.Header.Get("Sec-WebSocket-Version") != "13" {
		errorResponse(writer, 400, "phone_signal_invalid")
		return
	}
	if !verifiedSchedulerController(request.TLS) {
		errorResponse(writer, 401, "mutual_tls_required")
		return
	}
	service, ok := h.service.(phoneSignalService)
	if !ok {
		errorResponse(writer, 503, "phone_signal_not_configured")
		return
	}
	encoded := request.Header.Get("X-Teamaibox-Command")
	if len(encoded) > 16384 || len(request.Header.Values("X-Teamaibox-Command")) != 1 {
		errorResponse(writer, 400, "phone_signal_invalid")
		return
	}
	body, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(body) > 8192 {
		errorResponse(writer, 400, "phone_signal_invalid")
		return
	}
	defer func() {
		for i := range body {
			body[i] = 0
		}
	}()
	var envelope agent.CommandEnvelope
	d := json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if d.Decode(&envelope) != nil || envelope.Type != "android-phone.media.renew" {
		errorResponse(writer, 400, "phone_signal_invalid")
		return
	}
	if err := d.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		errorResponse(writer, 400, "phone_signal_invalid")
		return
	}
	proof := agent.AuthProof{KeyID: request.Header.Get("X-Teamaibox-Key-Id"), Nonce: request.Header.Get("X-Teamaibox-Nonce"), Signature: request.Header.Get("X-Teamaibox-Signature"), SignedBody: body}
	result, err := h.service.Handle(request.Context(), envelope, proof)
	if err != nil || result.Status != "succeeded" {
		errorResponse(writer, 403, "phone_signal_rejected")
		return
	}
	var p agent.PhoneMediaPayload
	if json.Unmarshal(envelope.Payload, &p) != nil || p.Run == nil || !service.PhoneSignalLive(p) {
		errorResponse(writer, 403, "phone_signal_rejected")
		return
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		service.DisconnectPhoneSignal(ctx, p)
	}()
	endpoint, err := service.PhoneSignalEndpoint(request.Context(), p)
	if err != nil {
		errorResponse(writer, 503, "phone_signal_not_ready")
		return
	}
	ip := net.ParseIP(endpoint.Host)
	block, rest := pem.Decode(endpoint.Certificate)
	if ip == nil || ip.To4() == nil || !ip.IsPrivate() && !ip.IsLoopback() || endpoint.Port < 1024 || endpoint.Port > 65535 ||
		endpoint.ServerName != "127.0.0.1" || block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
		errorResponse(writer, 503, "phone_signal_target_invalid")
		return
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		errorResponse(writer, 503, "phone_signal_target_invalid")
		return
	}
	if !validPhoneMediaEndpoint(endpoint) {
		errorResponse(writer, 503, "phone_signal_target_invalid")
		return
	}
	roots := x509.NewCertPool()
	roots.AddCert(leaf)
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, ForceAttemptHTTP2: false, TLSHandshakeTimeout: 3 * time.Second, ResponseHeaderTimeout: 3 * time.Second,
		DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: endpoint.ServerName,
			VerifyConnection: func(state tls.ConnectionState) error {
				if len(state.PeerCertificates) < 1 || !bytes.Equal(state.PeerCertificates[0].Raw, leaf.Raw) {
					return errors.New("phone_signal_certificate_mismatch")
				}
				return nil
			}}}
	defer transport.CloseIdleConnections()
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !service.PhoneSignalLive(p) {
					cancel()
					return
				}
			}
		}
	}()
	target := &url.URL{Scheme: "https", Host: net.JoinHostPort(endpoint.Host, strconv.Itoa(endpoint.Port)), Path: "/connect_client"}
	proxy := &httputil.ReverseProxy{Transport: transport, ErrorLog: log.New(io.Discard, "", 0),
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL = target
			r.Out.Host = target.Host
			r.Out.Header = make(http.Header)
			for _, name := range []string{"Sec-WebSocket-Key", "Sec-WebSocket-Version"} {
				r.Out.Header.Set(name, r.In.Header.Get(name))
			}
			r.Out.Header.Set("Upgrade", "websocket")
			r.Out.Header.Set("Connection", "Upgrade")
		}, ModifyResponse: func(response *http.Response) error {
			if response.StatusCode != 101 {
				return errors.New("phone_signal_upgrade_rejected")
			}
			response.Header.Del("Set-Cookie")
			// These values come from the exact installed Docker binding. Ignore
			// any similarly named header supplied by the private operator.
			setPhoneMediaHeaders(response.Header, endpoint)
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			errorResponse(w, 503, "phone_signal_unavailable")
		}}
	// Cancelling this request closes the upgraded operator connection as well,
	// so an expired peer cannot use old signalling to reconnect to its successor.
	proxy.ServeHTTP(writer, request.WithContext(ctx))
}
