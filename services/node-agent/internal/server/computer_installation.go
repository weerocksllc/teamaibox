package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"teamaibox.local/node-agent/internal/agent"
	"time"
)

type computerInstallationService interface {
	ExecuteComputerInstallation(context.Context, agent.CommandEnvelope, agent.AuthProof, io.Reader) (agent.ComputerResult, error)
}

func (h *Handler) computerInstallation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.RawQuery != "" || r.Header.Get("Content-Type") != "application/octet-stream" || r.Header.Get("Upgrade") != "" {
		errorResponse(w, 400, "computer_media_request_invalid")
		return
	}
	if !verifiedSchedulerController(r.TLS) {
		errorResponse(w, 401, "mutual_tls_required")
		return
	}
	service, ok := h.service.(computerInstallationService)
	if !ok {
		errorResponse(w, 503, "computer_installation_unavailable")
		return
	}
	encoded := r.Header.Get("X-Teamaibox-Command")
	if len(encoded) > 16384 || len(r.Header.Values("X-Teamaibox-Command")) != 1 {
		errorResponse(w, 400, "computer_media_request_invalid")
		return
	}
	body, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(body) > 8192 {
		errorResponse(w, 400, "computer_media_request_invalid")
		return
	}
	defer clear(body)
	var envelope agent.CommandEnvelope
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&envelope) != nil || !errors.Is(decoder.Decode(&struct{}{}), io.EOF) || envelope.Type != "virtual-computer.installation" {
		errorResponse(w, 400, "computer_media_request_invalid")
		return
	}
	var payload agent.ComputerCommand
	if json.Unmarshal(envelope.Payload, &payload) != nil || payload.Installation == nil || payload.Installation.Size < 0 || payload.Installation.Size >= 1<<53 || r.ContentLength != payload.Installation.Size {
		errorResponse(w, 400, "computer_media_request_invalid")
		return
	}
	controller := http.NewResponseController(w)
	if controller.EnableFullDuplex() != nil {
		errorResponse(w, 503, "computer_installation_unavailable")
		return
	}
	_ = controller.SetReadDeadline(time.Now().Add(30 * time.Second))
	_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
	defer func() { _ = controller.SetReadDeadline(time.Time{}); _ = controller.SetWriteDeadline(time.Time{}) }()
	input := http.MaxBytesReader(w, r.Body, payload.Installation.Size+1)
	defer input.Close()
	proof := agent.AuthProof{KeyID: r.Header.Get("X-Teamaibox-Key-Id"), Nonce: r.Header.Get("X-Teamaibox-Nonce"), Signature: r.Header.Get("X-Teamaibox-Signature"), SignedBody: body}
	// JSON permits leading whitespace. Keep a progress heartbeat during local
	// hashing/fsync/QMP work too, not just while request bytes arrive. Large ISOs
	// must not turn a transport idle timeout into a hidden file-size limit.
	var writer sync.Mutex
	done := make(chan struct{})
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				writer.Lock()
				_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "no-store")
				_, _ = w.Write([]byte("\n"))
				_ = controller.Flush()
				writer.Unlock()
			}
		}
	}()
	result, err := service.ExecuteComputerInstallation(r.Context(), envelope, proof, cameraProgressReader{input, controller})
	close(done)
	<-exited
	if err != nil {
		errorResponse(w, 503, "computer_installation_unconfirmed")
		return
	}
	writeJSON(w, 200, result)
}
