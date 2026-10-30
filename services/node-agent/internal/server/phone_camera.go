package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"teamaibox.local/node-agent/internal/agent"
	"time"
)

type phoneCameraService interface {
	ExecutePhoneCamera(context.Context, agent.CommandEnvelope, agent.AuthProof, io.Reader) (agent.PhoneCameraResult, error)
}

type cameraProgressReader struct {
	input      io.Reader
	controller *http.ResponseController
}

func (r cameraProgressReader) Read(p []byte) (int, error) {
	_ = r.controller.SetReadDeadline(time.Now().Add(30 * time.Second))
	_ = r.controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return r.input.Read(p)
}

func (h *Handler) phoneCamera(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.RawQuery != "" || r.Header.Get("Content-Type") != "application/octet-stream" || r.Header.Get("Upgrade") != "" {
		errorResponse(w, 400, "phone_camera_request_invalid")
		return
	}
	if !verifiedSchedulerController(r.TLS) {
		errorResponse(w, 401, "mutual_tls_required")
		return
	}
	service, ok := h.service.(phoneCameraService)
	if !ok {
		errorResponse(w, 503, "phone_camera_not_configured")
		return
	}
	encoded := r.Header.Get("X-Teamaibox-Command")
	if len(encoded) > 16384 || len(r.Header.Values("X-Teamaibox-Command")) != 1 {
		errorResponse(w, 400, "phone_camera_request_invalid")
		return
	}
	body, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(body) > 8192 {
		errorResponse(w, 400, "phone_camera_request_invalid")
		return
	}
	defer clear(body)
	var e agent.CommandEnvelope
	d := json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if d.Decode(&e) != nil || !errors.Is(d.Decode(&struct{}{}), io.EOF) || e.Type != "android-phone.camera.input" {
		errorResponse(w, 400, "phone_camera_request_invalid")
		return
	}
	controller := http.NewResponseController(w)
	if controller.EnableFullDuplex() != nil {
		errorResponse(w, 503, "phone_camera_transport_unavailable")
		return
	}
	deadline := time.Now().Add(15 * time.Second)
	_ = controller.SetReadDeadline(deadline)
	_ = controller.SetWriteDeadline(deadline)
	defer func() { _ = controller.SetReadDeadline(time.Time{}); _ = controller.SetWriteDeadline(time.Time{}) }()
	input := http.MaxBytesReader(w, r.Body, agent.PhoneCameraVideoMaximum+64)
	defer input.Close()
	proof := agent.AuthProof{KeyID: r.Header.Get("X-Teamaibox-Key-Id"), Nonce: r.Header.Get("X-Teamaibox-Nonce"), Signature: r.Header.Get("X-Teamaibox-Signature"), SignedBody: body}
	result, err := service.ExecutePhoneCamera(r.Context(), e, proof, cameraProgressReader{input, controller})
	if err != nil {
		switch err.Error() {
		case "phone_camera_image_unsupported", "phone_camera_image_too_large", "phone_camera_video_unsupported", "phone_camera_video_too_large":
			errorResponse(w, 422, err.Error())
			return
		case "phone_camera_source_stopped", "phone_camera_usb_busy", "phone_camera_usb_device_changed", "phone_camera_udp_port_unavailable":
			errorResponse(w, 409, err.Error())
			return
		case "phone_camera_storage_full":
			errorResponse(w, 409, err.Error())
			return
		case "phone_camera_video_memory_unavailable":
			errorResponse(w, 503, err.Error())
			return
		case "phone_camera_not_ready", "phone_runtime_status_unavailable", "phone_runtime_status_stale",
			"phone_camera_worker_failed", "phone_camera_result_invalid", "phone_camera_payload_invalid",
			"phone_stale_run", "phone_stop_unconfirmed":
			// Fixed diagnostic codes only; never relay arbitrary process output.
			errorResponse(w, 503, err.Error())
			return
		}
		errorResponse(w, 409, "phone_camera_input_rejected")
		return
	}
	writeJSON(w, 200, result)
}
