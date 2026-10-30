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

type computerDesktopService interface {
	OpenComputerDesktop(context.Context, agent.ComputerCommand, string) (net.Conn, error)
}

// RDP and installation-console bytes stay inside the existing mTLS channel.
// No host RDP/VNC port, SSH forward, password database or new login service.
func (h *Handler) computerDesktop(w http.ResponseWriter, r *http.Request) {
	kind := strings.TrimPrefix(r.URL.Path, "/v1/computer-desktop/")
	if r.Method != http.MethodGet || (kind != "rdp" && kind != "console" && kind != "audio") || r.URL.RawQuery != "" || r.Header.Get("Upgrade") != "teamaibox-computer" ||
		!strings.EqualFold(r.Header.Get("Connection"), "upgrade") || r.ContentLength > 0 || len(r.TransferEncoding) != 0 {
		errorResponse(w, 400, "computer_desktop_request_invalid")
		return
	}
	if !verifiedSchedulerController(r.TLS) {
		errorResponse(w, 401, "mutual_tls_required")
		return
	}
	service, ok := h.service.(computerDesktopService)
	if !ok {
		errorResponse(w, 503, "computer_desktop_unavailable")
		return
	}
	encoded := r.Header.Get("X-Teamaibox-Command")
	if len(encoded) > 16384 || len(r.Header.Values("X-Teamaibox-Command")) != 1 {
		errorResponse(w, 400, "computer_desktop_request_invalid")
		return
	}
	body, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(body) > 8192 {
		errorResponse(w, 400, "computer_desktop_request_invalid")
		return
	}
	defer clear(body)
	var envelope agent.CommandEnvelope
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var p agent.ComputerCommand
	if decoder.Decode(&envelope) != nil || envelope.Type != "virtual-computer.inspect" || !errors.Is(decoder.Decode(&struct{}{}), io.EOF) ||
		json.Unmarshal(envelope.Payload, &p) != nil || p.Run == nil || p.Run.ContainerID == nil {
		errorResponse(w, 400, "computer_desktop_request_invalid")
		return
	}
	proof := agent.AuthProof{KeyID: r.Header.Get("X-Teamaibox-Key-Id"), Nonce: r.Header.Get("X-Teamaibox-Nonce"), Signature: r.Header.Get("X-Teamaibox-Signature"), SignedBody: body}
	result, err := h.service.Handle(r.Context(), envelope, proof)
	var current agent.ComputerResult
	if err != nil || result.Status != "succeeded" || json.Unmarshal(result.Payload, &current) != nil || !current.Running ||
		current.ComputerID != p.ComputerID || current.OwnerID != p.OwnerID || current.RunID != p.Run.ID || current.ContainerID != *p.Run.ContainerID {
		errorResponse(w, 403, "computer_desktop_rejected")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	upstream, err := service.OpenComputerDesktop(ctx, p, kind)
	cancel()
	if err != nil {
		errorResponse(w, 503, "computer_desktop_unavailable")
		return
	}
	defer upstream.Close()
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		errorResponse(w, 503, "computer_desktop_transport_unavailable")
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	if _, err = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: teamaibox-computer\r\n\r\n"); err != nil || buffered.Flush() != nil {
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
	select {
	case <-done:
	case <-r.Context().Done():
	}
}
