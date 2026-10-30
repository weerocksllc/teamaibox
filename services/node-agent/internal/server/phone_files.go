package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type phoneFileService interface {
	TransferPhoneFile(context.Context, agent.CommandEnvelope, agent.AuthProof, io.Reader, io.Writer) error
}

type phoneFileResponse struct {
	http.ResponseWriter
	started bool
}

type phoneFileProgressReader struct {
	io.Reader
	controller *http.ResponseController
}

func (r phoneFileProgressReader) Read(p []byte) (int, error) {
	_ = r.controller.SetReadDeadline(time.Now().Add(30 * time.Second))
	_ = r.controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return r.Reader.Read(p)
}

func (w *phoneFileResponse) Write(p []byte) (int, error) {
	controller := http.NewResponseController(w.ResponseWriter)
	_ = controller.SetReadDeadline(time.Now().Add(30 * time.Second))
	_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if !w.started {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(200)
		w.started = true
	}
	n, err := w.ResponseWriter.Write(p)
	if err == nil {
		err = http.NewResponseController(w.ResponseWriter).Flush()
	}
	return n, err
}

func (h *Handler) phoneFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.RawQuery != "" || r.Header.Get("Content-Type") != "application/octet-stream" || r.Header.Get("Upgrade") != "" {
		errorResponse(w, 400, "phone_file_request_invalid")
		return
	}
	if !verifiedSchedulerController(r.TLS) {
		errorResponse(w, 401, "mutual_tls_required")
		return
	}
	service, ok := h.service.(phoneFileService)
	if !ok {
		errorResponse(w, 503, "phone_files_not_configured")
		return
	}
	encoded := r.Header.Get("X-Teamaibox-Command")
	if len(encoded) > 16384 || len(r.Header.Values("X-Teamaibox-Command")) != 1 {
		errorResponse(w, 400, "phone_file_request_invalid")
		return
	}
	body, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(body) > 8192 {
		errorResponse(w, 400, "phone_file_request_invalid")
		return
	}
	defer clear(body)
	var e agent.CommandEnvelope
	d := json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if d.Decode(&e) != nil || !errors.Is(d.Decode(&struct{}{}), io.EOF) || e.Type != "android-phone.file.transfer" {
		errorResponse(w, 400, "phone_file_request_invalid")
		return
	}
	controller := http.NewResponseController(w)
	if err = controller.EnableFullDuplex(); err != nil {
		errorResponse(w, 503, "phone_file_transport_unavailable")
		return
	}
	deadline := time.Now().Add(30 * time.Second)
	_ = controller.SetReadDeadline(deadline)
	_ = controller.SetWriteDeadline(deadline)
	defer func() { _ = controller.SetReadDeadline(time.Time{}); _ = controller.SetWriteDeadline(time.Time{}) }()
	input := http.MaxBytesReader(w, r.Body, agent.PhoneFileMaximum+64)
	defer input.Close()
	proof := agent.AuthProof{KeyID: r.Header.Get("X-Teamaibox-Key-Id"), Nonce: r.Header.Get("X-Teamaibox-Nonce"), Signature: r.Header.Get("X-Teamaibox-Signature"), SignedBody: body}
	response := &phoneFileResponse{ResponseWriter: w}
	err = service.TransferPhoneFile(r.Context(), e, proof, phoneFileProgressReader{input, controller}, response)
	if err != nil {
		if response.started {
			panic(http.ErrAbortHandler)
		} // Truncate, never append success/error JSON to file bytes.
		errorResponse(w, 409, "phone_file_transfer_rejected")
		return
	}
	if !response.started {
		errorResponse(w, 502, "phone_file_result_missing")
	}
}
