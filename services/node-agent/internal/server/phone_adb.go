package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type phoneADBService interface {
	OpenPhoneADB(context.Context, agent.PhoneMediaPayload) (net.Conn, error)
	PhoneSignalLive(agent.PhoneMediaPayload) bool
	DisconnectPhoneSignal(context.Context, agent.PhoneMediaPayload)
}

// Internal HTTP/1.1 upgrade over the existing mTLS channel; the public side
// uses WSS. This handler cannot receive a destination, command or host path.
func (h *Handler) phoneADB(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.RawQuery != "" || r.Header.Get("Upgrade") != "teamaibox-adb" ||
		!strings.EqualFold(r.Header.Get("Connection"), "upgrade") || r.ContentLength > 0 || len(r.TransferEncoding) != 0 {
		errorResponse(w, 400, "phone_adb_request_invalid")
		return
	}
	if !verifiedSchedulerController(r.TLS) {
		errorResponse(w, 401, "mutual_tls_required")
		return
	}
	service, ok := h.service.(phoneADBService)
	if !ok {
		errorResponse(w, 503, "phone_adb_not_configured")
		return
	}
	encoded := r.Header.Get("X-Teamaibox-Command")
	if len(encoded) > 16384 || len(r.Header.Values("X-Teamaibox-Command")) != 1 {
		errorResponse(w, 400, "phone_adb_request_invalid")
		return
	}
	body, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(body) > 8192 {
		errorResponse(w, 400, "phone_adb_request_invalid")
		return
	}
	defer clear(body)
	var envelope agent.CommandEnvelope
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var p agent.PhoneMediaPayload
	if decoder.Decode(&envelope) != nil || envelope.Type != "android-phone.media.renew" ||
		!errors.Is(decoder.Decode(&struct{}{}), io.EOF) || json.Unmarshal(envelope.Payload, &p) != nil || p.Kind != "adb" || p.Run == nil {
		errorResponse(w, 400, "phone_adb_request_invalid")
		return
	}
	proof := agent.AuthProof{KeyID: r.Header.Get("X-Teamaibox-Key-Id"), Nonce: r.Header.Get("X-Teamaibox-Nonce"), Signature: r.Header.Get("X-Teamaibox-Signature"), SignedBody: body}
	result, err := h.service.Handle(r.Context(), envelope, proof)
	if err != nil || result.Status != "succeeded" || !service.PhoneSignalLive(p) {
		errorResponse(w, 403, "phone_adb_rejected")
		return
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		service.DisconnectPhoneSignal(ctx, p)
	}()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	upstream, err := service.OpenPhoneADB(ctx, p)
	cancel()
	if err != nil {
		errorResponse(w, 503, "phone_adb_not_ready")
		return
	}
	defer upstream.Close()
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		errorResponse(w, 503, "phone_adb_transport_unavailable")
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	if !service.PhoneSignalLive(p) {
		return
	}
	// No credentials, cookies, upstream headers or device data are forwarded.
	if _, err = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: teamaibox-adb\r\n\r\n"); err != nil || buffered.Flush() != nil {
		return
	}
	if client.SetDeadline(time.Time{}) != nil {
		return
	}
	done := make(chan struct{}, 2)
	copyData := func(dst io.Writer, src io.Reader) {
		buffer := make([]byte, 32768)
		_, _ = io.CopyBuffer(dst, src, buffer)
		clear(buffer)
		done <- struct{}{}
	}
	go copyData(upstream, buffered)
	go copyData(client, upstream)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !service.PhoneSignalLive(p) {
				return
			}
		}
	}
}
