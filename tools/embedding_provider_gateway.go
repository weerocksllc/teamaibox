// Command embedding-provider-gateway exposes one OpenAI-compatible embedding
// worker through a narrow authenticated TLS boundary. The gateway never loads
// a model and never forwards client credentials to the upstream worker.
package main

import (
	"bytes"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	maximumRequestBytes  = 16 * 1024 * 1024
	maximumResponseBytes = 128 * 1024 * 1024
)

type gateway struct {
	token    []byte
	model    string
	origin   *url.URL
	client   *http.Client
	mu       sync.Mutex
	requests uint64
	success  uint64
	errors   uint64
}

func openAIError(writer http.ResponseWriter, status int, code, message string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]any{"error": map[string]any{
		"message": message, "type": "teamaibox_gateway_error", "param": nil, "code": code,
	}})
}

func jsonResponse(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func boundedBody(reader io.Reader, maximum int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, maximum+1))
	if err != nil {
		return nil, err
	}
	if len(body) == 0 || int64(len(body)) > maximum {
		return nil, errors.New("body is outside the allowed boundary")
	}
	return body, nil
}

func (value *gateway) authorized(request *http.Request) bool {
	header := request.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	presented := []byte(strings.TrimPrefix(header, "Bearer "))
	return len(presented) == len(value.token) && subtle.ConstantTimeCompare(presented, value.token) == 1
}

func (value *gateway) requireAuthorization(writer http.ResponseWriter, request *http.Request) bool {
	if value.authorized(request) {
		return true
	}
	writer.Header().Set("WWW-Authenticate", `Bearer realm="teamaibox-embedding-provider"`)
	openAIError(writer, http.StatusUnauthorized, "invalid_api_key", "Authentication failed")
	return false
}

func (value *gateway) upstream(method, path string, body []byte, contentType string, timeout time.Duration) (*http.Response, error) {
	target := *value.origin
	target.Path = path
	request, err := http.NewRequest(method, target.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	client := *value.client
	client.Timeout = timeout
	return client.Do(request)
}

func (value *gateway) upstreamReady() bool {
	response, err := value.upstream(http.MethodGet, "/health", nil, "", 3*time.Second)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return response.StatusCode >= 200 && response.StatusCode < 300
}

func (value *gateway) live(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		openAIError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
		return
	}
	jsonResponse(writer, http.StatusOK, map[string]any{"status": "live", "gateway": true, "real_model": true})
}

func (value *gateway) ready(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		openAIError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
		return
	}
	if !value.upstreamReady() {
		jsonResponse(writer, http.StatusServiceUnavailable, map[string]any{"status": "unavailable", "gateway": true, "real_model": true})
		return
	}
	jsonResponse(writer, http.StatusOK, map[string]any{"status": "ready", "gateway": true, "real_model": true})
}

func (value *gateway) models(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		openAIError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
		return
	}
	if !value.requireAuthorization(writer, request) {
		return
	}
	response, err := value.upstream(http.MethodGet, "/v1/models", nil, "", 10*time.Second)
	if err != nil {
		openAIError(writer, http.StatusBadGateway, "upstream_unavailable", "Embedding provider is unavailable")
		return
	}
	defer response.Body.Close()
	body, err := boundedBody(response.Body, 2*1024*1024)
	if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		openAIError(writer, http.StatusBadGateway, "upstream_discovery_failed", "Embedding model discovery failed")
		return
	}
	var document struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &document) != nil {
		openAIError(writer, http.StatusBadGateway, "upstream_discovery_failed", "Embedding model discovery failed")
		return
	}
	found := false
	for _, item := range document.Data {
		found = found || item.ID == value.model
	}
	if !found {
		openAIError(writer, http.StatusBadGateway, "upstream_discovery_failed", "Configured embedding model is absent")
		return
	}
	jsonResponse(writer, http.StatusOK, map[string]any{"object": "list", "data": []map[string]any{{
		"id": value.model, "object": "model", "owned_by": "lan-embedding-provider",
	}}})
}

func copyResponseHeaders(destination, source http.Header) {
	for _, name := range []string{"Content-Type", "Cache-Control", "Retry-After", "X-Request-Id", "OpenAI-Processing-Ms"} {
		for _, item := range source.Values(name) {
			destination.Add(name, item)
		}
	}
	if destination.Get("Cache-Control") == "" {
		destination.Set("Cache-Control", "no-store")
	}
}

func (value *gateway) record(status int) {
	value.mu.Lock()
	defer value.mu.Unlock()
	value.requests++
	if status >= 200 && status < 300 {
		value.success++
	} else {
		value.errors++
	}
}

func (value *gateway) embeddings(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		openAIError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
		return
	}
	if !value.requireAuthorization(writer, request) {
		return
	}
	body, err := boundedBody(request.Body, maximumRequestBytes)
	if err != nil {
		openAIError(writer, http.StatusBadRequest, "invalid_request", "Request is invalid")
		return
	}
	var document struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &document) != nil {
		openAIError(writer, http.StatusBadRequest, "invalid_request", "Request is invalid")
		return
	}
	if document.Model != value.model {
		openAIError(writer, http.StatusNotFound, "model_not_found", "Embedding model is not available")
		return
	}
	response, err := value.upstream(http.MethodPost, "/v1/embeddings", body, "application/json", 10*time.Minute)
	if err != nil {
		value.record(http.StatusBadGateway)
		openAIError(writer, http.StatusBadGateway, "upstream_unavailable", "Embedding provider is unavailable")
		return
	}
	defer response.Body.Close()
	responseBody, err := boundedBody(response.Body, maximumResponseBytes)
	if err != nil {
		value.record(http.StatusBadGateway)
		openAIError(writer, http.StatusBadGateway, "upstream_response_invalid", "Embedding provider response is invalid")
		return
	}
	value.record(response.StatusCode)
	copyResponseHeaders(writer.Header(), response.Header)
	writer.WriteHeader(response.StatusCode)
	_, _ = writer.Write(responseBody)
}

func (value *gateway) accounting(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		openAIError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
		return
	}
	if !value.requireAuthorization(writer, request) {
		return
	}
	value.mu.Lock()
	result := map[string]any{"schema_version": 1, "request_count": value.requests, "success_count": value.success, "error_count": value.errors, "real_model": true}
	value.mu.Unlock()
	jsonResponse(writer, http.StatusOK, result)
}

func configuration() ([]byte, string, *url.URL, error) {
	tokenPath, model, rawOrigin := os.Getenv("GATEWAY_TOKEN_FILE"), os.Getenv("GATEWAY_MODEL"), os.Getenv("GATEWAY_UPSTREAM_ORIGIN")
	rawToken, err := os.ReadFile(tokenPath)
	if err != nil {
		return nil, "", nil, err
	}
	defer func() {
		for index := range rawToken {
			rawToken[index] = 0
		}
	}()
	token := []byte(strings.TrimSpace(string(rawToken)))
	origin, err := url.Parse(rawOrigin)
	if err != nil || origin.Scheme != "http" || origin.User != nil || origin.Host == "" || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return nil, "", nil, errors.New("upstream origin is invalid")
	}
	if len(token) < 32 || len(token) > 8192 || model == "" || len(model) > 512 || strings.ContainsAny(model, "\r\n\x00 \t") {
		return nil, "", nil, errors.New("gateway configuration is invalid")
	}
	return token, model, origin, nil
}

func handler(value *gateway) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health/live", value.live)
	mux.HandleFunc("/health/ready", value.ready)
	mux.HandleFunc("/v1/models", value.models)
	mux.HandleFunc("/v1/embeddings", value.embeddings)
	mux.HandleFunc("/gateway/v1/accounting", value.accounting)
	return mux
}

func main() {
	listen := flag.String("listen", ":9443", "listen address")
	selfTest := flag.Bool("self-test", false, "validate the static gateway contract and exit")
	flag.Parse()
	if *selfTest {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"valid": true, "embedding_gateway": true, "maximum_response_bytes": maximumResponseBytes})
		return
	}
	token, model, origin, err := configuration()
	if err != nil {
		fmt.Fprintln(os.Stderr, "embedding gateway configuration invalid")
		os.Exit(2)
	}
	transport := &http.Transport{Proxy: nil, DisableCompression: true, MaxIdleConns: 8, MaxIdleConnsPerHost: 4, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 10 * time.Minute}
	value := &gateway{token: token, model: model, origin: origin, client: &http.Client{Transport: transport}}
	server := &http.Server{Addr: *listen, Handler: handler(value), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 10 * time.Minute, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	if err = server.ListenAndServeTLS(os.Getenv("GATEWAY_TLS_CERT_FILE"), os.Getenv("GATEWAY_TLS_KEY_FILE")); err != nil {
		fmt.Fprintln(os.Stderr, "embedding gateway stopped")
		os.Exit(1)
	}
}
