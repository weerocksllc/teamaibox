package telemetry

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func computerMetricLabels() map[string]string {
	labels := map[string]string{"com.teamaibox.kind": "windows-computer", "com.teamaibox.managed": "true", "com.teamaibox.computer-generation": "7"}
	for _, key := range []string{"node-id", "computer-run-id", "computer-id", "owner-identity-id", "volume-id", "firmware-id", "pool-id", "profile-id"} {
		labels["com.teamaibox."+key] = "00000000-0000-4000-8000-000000000201"
	}
	labels["com.teamaibox.profile-id"] = "windows-11-arm64-25h2"
	labels["com.teamaibox.pool-id"] = "pool-00000000-0000-4000-8000-000000000201"
	return labels
}

func TestComputerMetricIdentityRequiresCurrentOwnedRun(t *testing.T) {
	labels := computerMetricLabels()
	node := labels["com.teamaibox.node-id"]
	if metricWorkerIdentity(labels, node) != labels["com.teamaibox.computer-run-id"] {
		t.Fatal("computer run not associated")
	}
	for key := range labels {
		if key == "com.teamaibox.kind" {
			continue
		}
		bad := computerMetricLabels()
		bad[key] = "invalid"
		if key == "com.teamaibox.pool-id" {
			bad[key] = "../invalid"
		}
		if key == "com.teamaibox.profile-id" {
			bad[key] = ""
		}
		if metricWorkerIdentity(bad, node) != "" {
			t.Fatalf("accepted invalid %s", key)
		}
	}
	if metricWorkerIdentity(labels, "00000000-0000-4000-8000-000000000202") != "" {
		t.Fatal("foreign node accepted")
	}
	delete(labels, "com.teamaibox.computer-run-id")
	labels["com.teamaibox.provision-id"] = node
	if metricWorkerIdentity(labels, node) != "" {
		t.Fatal("provisioning discounted a running reservation")
	}
}

func TestComputerMetricsPublishRunWithoutGrantingModelOrPhoneAuthority(t *testing.T) {
	cid := strings.Repeat("b", 64)
	labels, state := computerMetricLabels(), "running"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var value any
		switch {
		case r.URL.Path == "/v1.48/containers/json":
			value = []dockerContainer{{ID: cid, State: state, Labels: labels}}
		case strings.HasSuffix(r.URL.Path, "/stats"):
			value = map[string]any{"memory_stats": map[string]any{"usage": 8 << 30}}
		default:
			value = map[string]any{"State": map[string]any{"Pid": 0, "OOMKilled": false}}
		}
		json.NewEncoder(w).Encode(value)
	}))
	defer server.Close()
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}}
	defer transport.CloseIdleConnections()
	provider := &HostMetricProvider{config: HostMetricConfig{NodeID: labels["com.teamaibox.node-id"], ProcRoot: t.TempDir()}, docker: &http.Client{Transport: transport}}
	processes, workers, models, _ := provider.containerMetrics(context.Background())
	if len(processes) != 1 || len(workers) != 1 || workers[0].WorkerID != labels["com.teamaibox.computer-run-id"] || workers[0].State != "busy" || workers[0].ProfileID != nil || workers[0].UnifiedMemoryBytes.Value == nil || *workers[0].UnifiedMemoryBytes.Value != 8<<30 || len(models) != 0 {
		t.Fatalf("computer run telemetry missing or grants model authority: %+v", workers)
	}
	guests, err := provider.phoneWorkerMemory(context.Background())
	if err != nil || len(guests) != 1 || guests[0].WorkerID != labels["com.teamaibox.computer-run-id"] || guests[0].CurrentBytes != 8<<30 {
		t.Fatalf("live computer missing from shared memory admission: %+v %v", guests, err)
	}
	state = "exited"
	_, workers, _, _ = provider.containerMetrics(context.Background())
	if len(workers) != 0 {
		t.Fatal("stopped computer discounts a reservation")
	}
	guests, err = provider.phoneWorkerMemory(context.Background())
	if err != nil || len(guests) != 0 {
		t.Fatal("stopped computer discounts phone admission")
	}
	state = "running"
	labels["com.teamaibox.node-id"] = "00000000-0000-4000-8000-000000000202"
	guests, err = provider.phoneWorkerMemory(context.Background())
	if err != nil || len(guests) != 0 {
		t.Fatal("foreign computer discounts phone admission")
	}
}
