package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

const schedulerControllerSPIFFE = "spiffe://teamaibox.local/controller/platform"

type CommandService interface {
	Handle(ctx context.Context, envelope agent.CommandEnvelope, proof agent.AuthProof) (agent.CommandResult, error)
}

type ReadyProbe interface {
	Ready(ctx context.Context) error
}

type Handler struct {
	service CommandService
	ready   ReadyProbe
}

func NewHandler(service CommandService, ready ReadyProbe) (*Handler, error) {
	if service == nil || ready == nil {
		return nil, errors.New("command service and readiness probe are required")
	}
	return &Handler{service: service, ready: ready}, nil
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func errorResponse(writer http.ResponseWriter, status int, code string) {
	writeJSON(writer, status, map[string]any{"error": map[string]any{"code": code, "message": "Node Agent request was rejected"}})
}

func (h *Handler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case "/health/live":
		if request.Method != http.MethodGet {
			errorResponse(writer, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"status": "live"})
	case "/health/ready":
		if request.Method != http.MethodGet {
			errorResponse(writer, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		if err := h.ready.Ready(ctx); err != nil {
			errorResponse(writer, http.StatusServiceUnavailable, "docker_unavailable")
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"status": "ready"})
	case "/v1/commands":
		h.command(writer, request)
	case "/v1/phone-media/signal":
		h.phoneSignal(writer, request)
	case "/v1/phone-media/adb":
		h.phoneADB(writer, request)
	case "/v1/computer-desktop/rdp", "/v1/computer-desktop/console", "/v1/computer-desktop/audio":
		h.computerDesktop(writer, request)
	case "/v1/phone-files":
		h.phoneFiles(writer, request)
	case "/v1/phone-camera":
		h.phoneCamera(writer, request)
	case "/v1/computer-installation":
		h.computerInstallation(writer, request)
	default:
		errorResponse(writer, http.StatusNotFound, "not_found")
	}
}

func (h *Handler) command(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		errorResponse(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !verifiedSchedulerController(request.TLS) {
		errorResponse(writer, http.StatusUnauthorized, "mutual_tls_required")
		return
	}
	if mediaType := strings.ToLower(strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0])); mediaType != "application/json" {
		errorResponse(writer, http.StatusUnsupportedMediaType, "json_required")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, 1<<20)
	body, err := io.ReadAll(request.Body)
	if err != nil {
		errorResponse(writer, http.StatusBadRequest, "invalid_command_envelope")
		return
	}
	defer func() {
		for index := range body {
			body[index] = 0
		}
	}()
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var envelope agent.CommandEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		errorResponse(writer, http.StatusBadRequest, "invalid_command_envelope")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		errorResponse(writer, http.StatusBadRequest, "invalid_command_envelope")
		return
	}
	proof := agent.AuthProof{
		KeyID:      request.Header.Get("X-Teamaibox-Key-Id"),
		Nonce:      request.Header.Get("X-Teamaibox-Nonce"),
		Signature:  request.Header.Get("X-Teamaibox-Signature"),
		SignedBody: body,
	}
	result, err := h.service.Handle(request.Context(), envelope, proof)
	if err != nil {
		switch {
		case errors.Is(err, agent.ErrAuthentication):
			errorResponse(writer, http.StatusUnauthorized, "command_authentication_failed")
		case errors.Is(err, agent.ErrExpired):
			errorResponse(writer, http.StatusConflict, "command_expired")
		case errors.Is(err, agent.ErrReplay):
			errorResponse(writer, http.StatusConflict, "command_replay_conflict")
		case errors.Is(err, agent.ErrStaleNodeGeneration):
			errorResponse(writer, http.StatusConflict, "stale_node_generation")
		default:
			errorResponse(writer, http.StatusConflict, "command_rejected")
		}
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func verifiedSchedulerController(state *tls.ConnectionState) bool {
	if state == nil || len(state.VerifiedChains) == 0 || len(state.VerifiedChains[0]) == 0 {
		return false
	}
	for _, identity := range state.VerifiedChains[0][0].URIs {
		if identity != nil && identity.String() == schedulerControllerSPIFFE {
			return true
		}
	}
	return false
}

func schedulerControllerURI() *url.URL {
	identity, err := url.Parse(schedulerControllerSPIFFE)
	if err != nil {
		panic("invalid scheduler controller SPIFFE identity")
	}
	return identity
}

func TLSConfig(clientCAs *x509.CertPool) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		ClientAuth: tls.RequireAndVerifyClientCert,
		ClientCAs:  clientCAs,
	}
}
