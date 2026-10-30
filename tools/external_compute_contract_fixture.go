// Command external-compute-contract-fixture is a content-safe OpenAI-compatible
// HTTPS fixture for bounded external-routing tests. It is never a model server.
package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const providerModel = "contract/giant-llm"

type fixture struct {
	token     []byte
	mu        sync.Mutex
	healthy   bool
	requests  uint64
	errors    uint64
	replays   uint64
	responses map[string]storedResponse
}

type storedResponse struct {
	digest string
	body   []byte
}

func jsonResponse(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func openAIError(writer http.ResponseWriter, status int, code, message string) {
	jsonResponse(writer, status, map[string]any{"error": map[string]any{
		"message": message, "type": "teamaibox_contract_error", "param": nil, "code": code,
	}})
}

func (value *fixture) authorized(request *http.Request) bool {
	header := request.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	presented := []byte(strings.TrimPrefix(header, "Bearer "))
	if len(presented) != len(value.token) {
		return false
	}
	return subtle.ConstantTimeCompare(presented, value.token) == 1
}

func (value *fixture) requireAuthorization(writer http.ResponseWriter, request *http.Request) bool {
	if value.authorized(request) {
		return true
	}
	writer.Header().Set("WWW-Authenticate", `Bearer realm="teamaibox-contract-fixture"`)
	openAIError(writer, http.StatusUnauthorized, "invalid_api_key", "Authentication failed")
	return false
}

func (value *fixture) live(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		openAIError(writer, 405, "method_not_allowed", "Method not allowed")
		return
	}
	jsonResponse(writer, 200, map[string]any{"status": "live", "fixture": true})
}

func (value *fixture) ready(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		openAIError(writer, 405, "method_not_allowed", "Method not allowed")
		return
	}
	value.mu.Lock()
	healthy := value.healthy
	value.mu.Unlock()
	status := http.StatusOK
	state := "ready"
	if !healthy {
		status = http.StatusServiceUnavailable
		state = "unavailable"
	}
	jsonResponse(writer, status, map[string]any{
		"status": state, "fixture": true, "provider": "contract-openai",
		"hardware_metrics": map[string]any{"supported": false},
	})
}

func (value *fixture) models(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		openAIError(writer, 405, "method_not_allowed", "Method not allowed")
		return
	}
	if !value.requireAuthorization(writer, request) {
		return
	}
	jsonResponse(writer, 200, map[string]any{"object": "list", "data": []any{map[string]any{
		"id": providerModel, "object": "model", "owned_by": "teamaibox-contract-fixture",
	}}})
}

func readBody(request *http.Request) ([]byte, map[string]any, error) {
	body, errorValue := io.ReadAll(io.LimitReader(request.Body, 1_048_577))
	if errorValue != nil {
		return nil, nil, errorValue
	}
	if len(body) == 0 || len(body) > 1_048_576 {
		return nil, nil, fmt.Errorf("invalid body size")
	}
	document := map[string]any{}
	if json.Unmarshal(body, &document) != nil {
		return nil, nil, fmt.Errorf("invalid json")
	}
	return body, document, nil
}

func responseBody(id string) []byte {
	value := map[string]any{
		"id": id, "object": "response", "created_at": time.Now().Unix(), "status": "completed",
		"model": providerModel,
		"output": []any{map[string]any{"type": "message", "role": "assistant", "content": []any{
			map[string]any{"type": "output_text", "text": "contract-fixture-result"},
		}}},
		"usage":               map[string]any{"input_tokens": 4, "output_tokens": 3, "total_tokens": 7},
		"x_teamaibox_fixture": map[string]any{"simulated_provider": true, "hardware_metrics_supported": false},
	}
	body, _ := json.Marshal(value)
	return append(body, '\n')
}

func (value *fixture) responsesHandler(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		openAIError(writer, 405, "method_not_allowed", "Method not allowed")
		return
	}
	if !value.requireAuthorization(writer, request) {
		return
	}
	body, document, errorValue := readBody(request)
	if errorValue != nil {
		openAIError(writer, 400, "invalid_request", "Request is invalid")
		return
	}
	if document["model"] != providerModel {
		openAIError(writer, 404, "model_not_found", "Model is not available")
		return
	}
	mode := request.Header.Get("X-Teamaibox-Contract-Scenario")
	if mode == "" {
		mode = "success"
	}
	value.mu.Lock()
	value.requests++
	healthy := value.healthy
	value.mu.Unlock()
	if !healthy {
		value.recordError()
		openAIError(writer, 503, "provider_unavailable", "Provider is unavailable")
		return
	}
	switch mode {
	case "overload":
		value.recordError()
		writer.Header().Set("Retry-After", "1")
		openAIError(writer, 429, "provider_overloaded", "Provider is overloaded")
		return
	case "timeout":
		value.recordError()
		openAIError(writer, 504, "provider_timeout", "Provider timed out before acceptance")
		return
	case "partial-output":
		if document["stream"] != true {
			openAIError(writer, 400, "stream_required", "Partial-output scenario requires streaming")
			return
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.Header().Set("Cache-Control", "no-store")
		writer.WriteHeader(200)
		_, _ = io.WriteString(writer, "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_fixture_partial\",\"status\":\"in_progress\"}}\n\n")
		_, _ = io.WriteString(writer, "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"contract-partial\"}\n\n")
		if flusher, ok := writer.(http.Flusher); ok {
			flusher.Flush()
		}
		value.recordError()
		return
	case "success":
	default:
		openAIError(writer, 400, "unknown_fixture_scenario", "Fixture scenario is unknown")
		return
	}
	key := request.Header.Get("Idempotency-Key")
	if len(key) > 128 {
		openAIError(writer, 400, "idempotency_key_invalid", "Idempotency-Key is invalid")
		return
	}
	digestBytes := sha256.Sum256(body)
	digest := hex.EncodeToString(digestBytes[:])
	idSeed := key
	if idSeed == "" {
		idSeed = digest
	}
	idBytes := sha256.Sum256([]byte(idSeed))
	response := responseBody("resp_fixture_" + hex.EncodeToString(idBytes[:8]))
	if key != "" {
		value.mu.Lock()
		if previous, exists := value.responses[key]; exists {
			if previous.digest != digest {
				value.mu.Unlock()
				openAIError(writer, 409, "idempotency_conflict", "Idempotency facts changed")
				return
			}
			value.replays++
			replay := append([]byte(nil), previous.body...)
			value.mu.Unlock()
			writer.Header().Set("Content-Type", "application/json")
			writer.Header().Set("X-Teamaibox-Fixture-Replay", "true")
			writer.WriteHeader(200)
			_, _ = writer.Write(replay)
			return
		}
		if len(value.responses) >= 1024 {
			value.responses = map[string]storedResponse{}
		}
		value.responses[key] = storedResponse{digest: digest, body: append([]byte(nil), response...)}
		value.mu.Unlock()
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(200)
	_, _ = writer.Write(response)
}

func (value *fixture) recordError() { value.mu.Lock(); value.errors++; value.mu.Unlock() }

func (value *fixture) state(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		openAIError(writer, 405, "method_not_allowed", "Method not allowed")
		return
	}
	if !value.requireAuthorization(writer, request) {
		return
	}
	var document struct {
		Healthy *bool `json:"healthy"`
	}
	if json.NewDecoder(io.LimitReader(request.Body, 1024)).Decode(&document) != nil || document.Healthy == nil {
		openAIError(writer, 400, "invalid_state", "Fixture state is invalid")
		return
	}
	value.mu.Lock()
	value.healthy = *document.Healthy
	healthy := value.healthy
	value.mu.Unlock()
	jsonResponse(writer, 200, map[string]any{"healthy": healthy})
}

func (value *fixture) accounting(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		openAIError(writer, 405, "method_not_allowed", "Method not allowed")
		return
	}
	if !value.requireAuthorization(writer, request) {
		return
	}
	value.mu.Lock()
	requests, errors, replays := value.requests, value.errors, value.replays
	value.mu.Unlock()
	jsonResponse(writer, 200, map[string]any{
		"schema_version": 1, "request_count": requests, "error_count": errors, "replay_count": replays,
		"hardware_metrics": map[string]any{"supported": false}, "currency_cost": map[string]any{"supported": false},
	})
}

func main() {
	listen := flag.String("listen", ":9443", "listen address")
	selfTest := flag.Bool("self-test", false, "print fixture contract and exit")
	flag.Parse()
	if *selfTest {
		jsonResponseWriter := map[string]any{"valid": true, "model": providerModel, "scenarios": []string{"success", "overload", "timeout", "partial-output"}, "hardware_metrics_supported": false}
		_ = json.NewEncoder(os.Stdout).Encode(jsonResponseWriter)
		return
	}
	tokenPath, certPath, keyPath := os.Getenv("FIXTURE_TOKEN_FILE"), os.Getenv("FIXTURE_TLS_CERT_FILE"), os.Getenv("FIXTURE_TLS_KEY_FILE")
	token, errorValue := os.ReadFile(tokenPath)
	if errorValue != nil || len(strings.TrimSpace(string(token))) < 32 || certPath == "" || keyPath == "" {
		fmt.Fprintln(os.Stderr, "fixture configuration invalid")
		os.Exit(2)
	}
	value := &fixture{token: []byte(strings.TrimSpace(string(token))), healthy: true, responses: map[string]storedResponse{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/health/live", value.live)
	mux.HandleFunc("/health/ready", value.ready)
	mux.HandleFunc("/v1/models", value.models)
	mux.HandleFunc("/v1/responses", value.responsesHandler)
	mux.HandleFunc("/fixture/v1/state", value.state)
	mux.HandleFunc("/fixture/v1/accounting", value.accounting)
	server := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024}
	if errorValue = server.ListenAndServeTLS(certPath, keyPath); errorValue != nil {
		fmt.Fprintln(os.Stderr, "fixture server stopped")
		os.Exit(1)
	}
}
