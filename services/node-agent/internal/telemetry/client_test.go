package telemetry

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testClient(t *testing.T, handler http.HandlerFunc) (*Client, *[]string) {
	t.Helper()
	paths := []string{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		handler(response, request)
	}))
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client, &paths
}

func TestClientRejectsRedirectsAndRedactsTokenFromErrors(t *testing.T) {
	client, _ := testClient(t, func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, "https://evil.invalid/steal", http.StatusTemporaryRedirect)
	})
	_, err := client.Heartbeat(context.Background(), "018f6f18-24d7-7c21-9b62-8c0174199502", 1, Inventory{})
	if err == nil || strings.Contains(err.Error(), "do-not-log") {
		t.Fatal("redirect was followed or token leaked")
	}
	if _, err := NewClient("http://127.0.0.1", http.DefaultClient); err == nil {
		t.Fatal("plain HTTP origin accepted")
	}
}

func TestClientRetainsBoundedCurrentGenerationErrorDetail(t *testing.T) {
	client, _ := testClient(t, func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusConflict)
		_, _ = response.Write([]byte(`{"error":{"code":"stale_node_generation","message":"fenced","retryable":true,"details":{"currentGeneration":7}}}`))
	})
	_, err := client.Heartbeat(context.Background(), "018f6f18-24d7-7c21-9b62-8c0174199502", 1, Inventory{SchemaVersion: 1})
	failure := new(APIError)
	if !errors.As(err, &failure) || failure.Details.CurrentGeneration != 7 {
		t.Fatalf("current generation detail was lost: %#v", err)
	}
}

func TestClientRetainsOnlySafeMetricFieldDetail(t *testing.T) {
	client, _ := testClient(t, func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusBadRequest)
		_, _ = response.Write([]byte(`{"error":{"code":"node_metric_invalid","message":"invalid","retryable":false,"details":{"field":"snapshot.domains.cpu.utilizationPercent"}}}`))
	})
	_, err := client.Metrics(context.Background(), "018f6f18-24d7-7c21-9b62-8c0174199502", 1, MetricSnapshot{})
	if err == nil || !strings.Contains(err.Error(), "field=snapshot.domains.cpu.utilizationPercent") {
		t.Fatalf("safe metric field detail was lost: %v", err)
	}
}
