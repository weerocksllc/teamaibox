package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func gatewayFixture(t *testing.T) (*httptest.Server, *httptest.Server) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "" {
			t.Fatal("client authorization escaped to the upstream")
		}
		switch request.URL.Path {
		case "/health":
			writer.WriteHeader(http.StatusOK)
		case "/v1/models":
			_ = json.NewEncoder(writer).Encode(map[string]any{"object": "list", "data": []map[string]any{{"id": "embedding-test"}}})
		case "/v1/embeddings":
			body, _ := io.ReadAll(request.Body)
			if !strings.Contains(string(body), `"model":"embedding-test"`) {
				t.Fatal("embedding request body drifted")
			}
			_ = json.NewEncoder(writer).Encode(map[string]any{"object": "list", "model": "embedding-test", "data": []map[string]any{{"object": "embedding", "index": 0, "embedding": []float64{0.25, 0.5}}}})
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	origin, _ := url.Parse(upstream.URL)
	value := &gateway{token: []byte("test-token-at-least-thirty-two-bytes"), model: "embedding-test", origin: origin, client: &http.Client{Timeout: time.Second}}
	server := httptest.NewServer(handler(value))
	t.Cleanup(server.Close)
	t.Cleanup(upstream.Close)
	return server, upstream
}

func request(t *testing.T, method, target, token, body string) (int, map[string]any) {
	t.Helper()
	value, err := http.NewRequest(method, target, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		value.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		value.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(value)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	document := map[string]any{}
	if json.NewDecoder(response.Body).Decode(&document) != nil {
		t.Fatal("response was not JSON")
	}
	return response.StatusCode, document
}

func TestGatewayAuthenticatesAndProxiesEmbedding(t *testing.T) {
	server, _ := gatewayFixture(t)
	status, _ := request(t, http.MethodGet, server.URL+"/health/ready", "", "")
	if status != http.StatusOK {
		t.Fatalf("readiness returned %d", status)
	}
	status, unauthorized := request(t, http.MethodGet, server.URL+"/v1/models", "", "")
	if status != http.StatusUnauthorized || unauthorized["error"].(map[string]any)["code"] != "invalid_api_key" {
		t.Fatal("model discovery did not fail closed")
	}
	token := "test-token-at-least-thirty-two-bytes"
	status, models := request(t, http.MethodGet, server.URL+"/v1/models", token, "")
	if status != http.StatusOK || len(models["data"].([]any)) != 1 {
		t.Fatal("model discovery failed")
	}
	status, embedding := request(t, http.MethodPost, server.URL+"/v1/embeddings", token, `{"model":"embedding-test","input":"hello"}`)
	if status != http.StatusOK || embedding["model"] != "embedding-test" {
		t.Fatal("embedding proxy failed")
	}
	status, accounting := request(t, http.MethodGet, server.URL+"/gateway/v1/accounting", token, "")
	if status != http.StatusOK || accounting["request_count"] != float64(1) || accounting["success_count"] != float64(1) {
		t.Fatal("gateway accounting drifted")
	}
}

func TestGatewayRejectsUnknownModelWithoutCallingUpstream(t *testing.T) {
	server, _ := gatewayFixture(t)
	status, document := request(t, http.MethodPost, server.URL+"/v1/embeddings", "test-token-at-least-thirty-two-bytes", `{"model":"unknown","input":"hello"}`)
	if status != http.StatusNotFound || document["error"].(map[string]any)["code"] != "model_not_found" {
		t.Fatal("unknown model did not fail closed")
	}
}
