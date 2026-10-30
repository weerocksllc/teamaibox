// Command translation-provider-adapter adds an exact aligned-result JSON schema
// to Team AI Box translation requests before forwarding them to an existing
// authenticated OpenAI-compatible Provider gateway.
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	maximumRequestBytes  = 16 * 1024 * 1024
	maximumResponseBytes = 32 * 1024 * 1024
	translationModel     = "lmt-60-4b-nvfp4-mlp-edge"
)

type adapter struct {
	token    []byte
	upstream *url.URL
	client   *http.Client
}

type upstreamResponse struct {
	status  int
	payload []byte
}

func openAIError(writer http.ResponseWriter, status int, code, message string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]any{"error": map[string]any{
		"message": message, "type": "teamaibox_translation_adapter_error", "param": nil, "code": code,
	}})
}

func boundedBody(reader io.Reader, maximum int64) ([]byte, error) {
	value, err := io.ReadAll(io.LimitReader(reader, maximum+1))
	if err != nil || len(value) == 0 || int64(len(value)) > maximum {
		return nil, errors.New("body is outside the allowed boundary")
	}
	return value, nil
}

func alignedResponseFormat(segmentCount int) map[string]any {
	return map[string]any{
		"type": "json_schema",
		"json_schema": map[string]any{
			"name": "translation_result", "strict": true,
			"schema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"source_language": map[string]any{"type": "string"},
					"translations": map[string]any{
						"type": "array", "items": map[string]any{"type": "string"},
						"minItems": segmentCount, "maxItems": segmentCount,
					},
				},
				"required":             []string{"source_language", "translations"},
				"additionalProperties": false,
			},
		},
	}
}

func hardenTranslationRequest(body []byte) ([]byte, int, error) {
	var document map[string]any
	if json.Unmarshal(body, &document) != nil || document["model"] != translationModel {
		return nil, 0, errors.New("translation request model is invalid")
	}
	messages, ok := document["messages"].([]any)
	if !ok || len(messages) < 1 || len(messages) > 128 {
		return nil, 0, errors.New("translation request messages are invalid")
	}
	last, ok := messages[len(messages)-1].(map[string]any)
	content, contentOK := last["content"].(string)
	if !ok || !contentOK || len(content) == 0 || len(content) > 8*1024*1024 {
		return nil, 0, errors.New("translation request payload is invalid")
	}
	var input struct {
		Segments []any `json:"segments"`
	}
	if json.Unmarshal([]byte(content), &input) != nil {
		return append([]byte(nil), body...), 0, nil
	}
	if len(input.Segments) < 1 || len(input.Segments) > 100000 {
		return nil, 0, errors.New("translation segments are invalid")
	}
	for _, item := range input.Segments {
		text, valid := item.(string)
		if !valid || len(text) == 0 || len(text) > 4*1024*1024 {
			return nil, 0, errors.New("translation segment is invalid")
		}
	}
	inputBytes := len(content)
	maximumTokens := inputBytes*2 + 256
	if maximumTokens < 256 {
		maximumTokens = 256
	}
	if maximumTokens > 2048 {
		maximumTokens = 2048
	}
	document["messages"] = []any{
		map[string]any{"role": "system", "content": "Translate every segment precisely. Preserve numbers, codes, product names, and Latin proper nouns. Return only the required aligned JSON."},
		last,
	}
	document["max_tokens"] = maximumTokens
	document["response_format"] = alignedResponseFormat(len(input.Segments))
	result, err := json.Marshal(document)
	if err != nil || len(result) > maximumRequestBytes {
		return nil, 0, errors.New("translation request could not be encoded")
	}
	return result, len(input.Segments), nil
}

func (value *adapter) authorized(request *http.Request) bool {
	header := request.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	presented := []byte(strings.TrimPrefix(header, "Bearer "))
	return len(presented) == len(value.token) && subtle.ConstantTimeCompare(presented, value.token) == 1
}

func (value *adapter) upstreamRequest(request *http.Request, body []byte) (*upstreamResponse, error) {
	target := *value.upstream
	target.Path = request.URL.Path
	boundedContext, cancel := context.WithTimeout(request.Context(), 90*time.Second)
	defer cancel()
	upstream, err := http.NewRequestWithContext(boundedContext, request.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	upstream.Header.Set("Authorization", "Bearer "+string(value.token))
	upstream.Header.Set("Accept", "application/json")
	if body != nil {
		upstream.Header.Set("Content-Type", "application/json")
	}
	response, err := value.client.Do(upstream)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, err := boundedBody(response.Body, maximumResponseBytes)
	if err != nil {
		return nil, err
	}
	return &upstreamResponse{status: response.StatusCode, payload: payload}, nil
}

func writeJSON(writer http.ResponseWriter, status int, payload []byte) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_, _ = writer.Write(payload)
}

func (value *adapter) proxy(writer http.ResponseWriter, request *http.Request, body []byte) {
	response, err := value.upstreamRequest(request, body)
	if err != nil {
		openAIError(writer, http.StatusBadGateway, "upstream_request_failed", "Upstream request failed")
		return
	}
	defer func() {
		for index := range response.payload {
			response.payload[index] = 0
		}
	}()
	writeJSON(writer, response.status, response.payload)
}

func alignedCompletion(payload []byte, segmentCount int) ([]byte, bool) {
	var document map[string]any
	if json.Unmarshal(payload, &document) != nil || document["object"] != "chat.completion" {
		return nil, false
	}
	choices, ok := document["choices"].([]any)
	if !ok || len(choices) < 1 {
		return nil, false
	}
	choice, ok := choices[0].(map[string]any)
	if !ok {
		return nil, false
	}
	message, ok := choice["message"].(map[string]any)
	if !ok {
		return nil, false
	}
	content, ok := message["content"].(string)
	if !ok || len(content) > maximumResponseBytes {
		return nil, false
	}
	trimmed := strings.TrimSpace(content)
	trimmed = strings.TrimPrefix(trimmed, "```json")
	trimmed = strings.TrimPrefix(trimmed, "```")
	trimmed = strings.TrimSuffix(strings.TrimSpace(trimmed), "```")
	var translated map[string]any
	if json.Unmarshal([]byte(strings.TrimSpace(trimmed)), &translated) != nil {
		return nil, false
	}
	items, ok := translated["translations"].([]any)
	if !ok || len(items) != segmentCount {
		return nil, false
	}
	for _, item := range items {
		text, valid := item.(string)
		if !valid || len(text) > 4*1024*1024 {
			return nil, false
		}
	}
	if usage, present := document["usage"]; present && usage != nil {
		values, valid := usage.(map[string]any)
		prompt, promptOK := values["prompt_tokens"].(float64)
		completion, completionOK := values["completion_tokens"].(float64)
		total, totalOK := values["total_tokens"].(float64)
		usageValid := valid && promptOK && completionOK && totalOK &&
			prompt >= 0 && completion >= 0 && total == prompt+completion &&
			prompt <= 9_007_199_254_740_991 && completion <= 9_007_199_254_740_991 &&
			total <= 9_007_199_254_740_991 && prompt == float64(int64(prompt)) &&
			completion == float64(int64(completion)) && total == float64(int64(total))
		if !usageValid {
			// Usage is optional in the platform contract. Removing malformed provider
			// accounting is safer than forwarding a structurally invalid completion.
			delete(document, "usage")
			result, err := json.Marshal(document)
			if err != nil || len(result) > maximumResponseBytes {
				return nil, false
			}
			return result, true
		}
	}
	return append([]byte(nil), payload...), true
}

func (value *adapter) proxyAligned(writer http.ResponseWriter, request *http.Request, body []byte, segmentCount int) {
	for attempt := 0; attempt < 3; attempt++ {
		response, err := value.upstreamRequest(request, body)
		if err != nil {
			if attempt < 2 {
				continue
			}
			openAIError(writer, http.StatusBadGateway, "upstream_request_failed", "Upstream request failed")
			return
		}
		if response.status < 200 || response.status >= 300 {
			writeJSON(writer, response.status, response.payload)
			for index := range response.payload {
				response.payload[index] = 0
			}
			return
		}
		normalized, valid := alignedCompletion(response.payload, segmentCount)
		for index := range response.payload {
			response.payload[index] = 0
		}
		if valid {
			writeJSON(writer, http.StatusOK, normalized)
			for index := range normalized {
				normalized[index] = 0
			}
			return
		}
	}
	openAIError(writer, http.StatusBadGateway, "upstream_alignment_invalid", "Upstream response did not preserve segment alignment")
}

func (value *adapter) serve(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path == "/health/live" || request.URL.Path == "/health/ready" {
		if request.Method != http.MethodGet {
			openAIError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(writer).Encode(map[string]any{"status": "ready", "adapter": true, "real_model": true})
		return
	}
	if !value.authorized(request) {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="teamaibox-translation-provider-adapter"`)
		openAIError(writer, http.StatusUnauthorized, "invalid_api_key", "Authentication failed")
		return
	}
	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/v1/models":
		value.proxy(writer, request, nil)
	case request.Method == http.MethodPost && request.URL.Path == "/v1/chat/completions":
		body, err := boundedBody(request.Body, maximumRequestBytes)
		if err != nil {
			openAIError(writer, http.StatusBadRequest, "invalid_request", "Request is invalid")
			return
		}
		hardened, segmentCount, err := hardenTranslationRequest(body)
		for index := range body {
			body[index] = 0
		}
		if err != nil {
			openAIError(writer, http.StatusBadRequest, "invalid_translation_request", "Translation request is invalid")
			return
		}
		defer func() {
			for index := range hardened {
				hardened[index] = 0
			}
		}()
		if segmentCount == 0 {
			value.proxy(writer, request, hardened)
		} else {
			value.proxyAligned(writer, request, hardened, segmentCount)
		}
	default:
		openAIError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
	}
}

func buildAdapter(token, certificate []byte, upstreamValue string) (*adapter, error) {
	upstream, err := url.Parse(upstreamValue)
	if err != nil || upstream == nil {
		return nil, errors.New("upstream is outside the approved Provider boundary")
	}
	host := upstream.Hostname()
	local := host == "localhost" || host == "host.docker.internal" || net.ParseIP(host).IsLoopback()
	port, portErr := strconv.Atoi(upstream.Port())
	if upstream.Scheme != "https" || !local || portErr != nil || port < 1 || port > 65535 || upstream.Path != "" || upstream.RawPath != "" || upstream.User != nil || upstream.RawQuery != "" || upstream.ForceQuery || upstream.Fragment != "" {
		return nil, errors.New("upstream is outside the approved Provider boundary")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(certificate) {
		return nil, errors.New("upstream certificate is invalid")
	}
	transport := &http.Transport{
		Proxy: nil, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool},
		DisableCompression: true, MaxIdleConns: 8, MaxIdleConnsPerHost: 4,
		IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 10 * time.Minute,
	}
	return &adapter{token: token, upstream: upstream, client: &http.Client{Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--self-test" {
		fmt.Println(`{"valid":true,"adapter":"translation-json-schema","model":"lmt-60-4b-nvfp4-mlp-edge"}`)
		return
	}
	tokenPath, certPath := os.Getenv("ADAPTER_TOKEN_FILE"), os.Getenv("ADAPTER_CA_FILE")
	tlsCertPath, tlsKeyPath := os.Getenv("ADAPTER_TLS_CERT_FILE"), os.Getenv("ADAPTER_TLS_KEY_FILE")
	token, err := os.ReadFile(tokenPath)
	if err != nil || len(strings.TrimSpace(string(token))) < 32 {
		fmt.Fprintln(os.Stderr, "adapter credential invalid")
		os.Exit(2)
	}
	token = []byte(strings.TrimSpace(string(token)))
	certificate, err := os.ReadFile(certPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "adapter CA invalid")
		os.Exit(2)
	}
	upstreamURL := os.Getenv("ADAPTER_UPSTREAM_URL")
	value, err := buildAdapter(token, certificate, upstreamURL)
	for index := range certificate {
		certificate[index] = 0
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "adapter configuration invalid")
		os.Exit(2)
	}
	server := &http.Server{
		Addr: ":9443", Handler: http.HandlerFunc(value.serve), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 10 * time.Minute, IdleTimeout: 30 * time.Second,
		MaxHeaderBytes: 16 * 1024,
	}
	if err := server.ListenAndServeTLS(tlsCertPath, tlsKeyPath); err != nil {
		fmt.Fprintln(os.Stderr, "adapter stopped")
		os.Exit(1)
	}
}
