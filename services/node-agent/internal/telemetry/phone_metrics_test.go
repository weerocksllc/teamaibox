package telemetry

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func phoneMetricLabels() map[string]string {
	value := map[string]string{"com.teamaibox.kind": "android-phone", "com.teamaibox.managed": "true", "com.teamaibox.node-generation": "3", "com.teamaibox.phone-generation": "1"}
	for _, key := range []string{"node-id", "phone-run-id", "phone-id", "owner-identity-id", "reservation-id", "volume-id", "pool-id"} {
		value["com.teamaibox."+key] = "00000000-0000-4000-8000-000000000101"
	}
	value["com.teamaibox.pool-id"] = "pool-00000000-0000-4000-8000-000000000101"
	return value
}

func TestPhoneMetricsBindExactRunAndRejectIncompleteOrForeignLabels(t *testing.T) {
	labels := phoneMetricLabels()
	node := labels["com.teamaibox.node-id"]
	if metricWorkerIdentity(labels, node) != labels["com.teamaibox.phone-run-id"] {
		t.Fatal("phone run not associated")
	}
	for key := range labels {
		if key == "com.teamaibox.kind" {
			continue
		}
		bad := phoneMetricLabels()
		bad[key] = "invalid"
		if key == "com.teamaibox.pool-id" {
			bad[key] = "../invalid"
		}
		if metricWorkerIdentity(bad, node) != "" {
			t.Fatalf("accepted invalid %s", key)
		}
	}
	if metricWorkerIdentity(labels, "00000000-0000-4000-8000-000000000102") != "" {
		t.Fatal("foreign node accepted")
	}
	if metricWorkerIdentity(map[string]string{"com.teamaibox.node-id": node, "com.teamaibox.worker-id": node}, node) != node {
		t.Fatal("ordinary worker changed")
	}
}

func TestPhoneMetricsPublishMeasuredCgroupUnderReservationRunID(t *testing.T) {
	root := t.TempDir()
	cid := strings.Repeat("a", 64)
	labels := phoneMetricLabels()
	cgroup := filepath.Join(root, "sys/fs/cgroup/system.slice/docker-"+cid+".scope")
	for _, dir := range []string{cgroup, filepath.Join(root, "proc/123")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for path, body := range map[string]string{
		filepath.Join(root, "proc/123/cgroup"):  "0::/system.slice/docker-" + cid + ".scope\n",
		filepath.Join(root, "proc/123/status"):  "Name:\tphone\nVmRSS:\t1024 kB\n",
		filepath.Join(cgroup, "memory.current"): "4294967296\n", filepath.Join(cgroup, "memory.peak"): "4500000000\n",
		filepath.Join(cgroup, "memory.max"): "6442450944\n", filepath.Join(cgroup, "memory.stat"): "inactive_file 0\n",
		filepath.Join(cgroup, "memory.events"): "high 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
	} {
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	state := "running"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var value any
		switch r.URL.Path {
		case "/v1.48/containers/json":
			value = []dockerContainer{{ID: cid, State: state, Labels: labels}}
		case "/v1.48/containers/" + cid + "/json":
			value = map[string]any{"State": map[string]any{"Pid": 123, "OOMKilled": false}}
		case "/v1.48/containers/" + cid + "/stats":
			value = map[string]any{"memory_stats": map[string]any{"usage": 4294967296}}
		default:
			t.Errorf("unexpected Docker request %s", r.URL.Path)
			http.Error(w, "unexpected", 404)
			return
		}
		json.NewEncoder(w).Encode(value)
	}))
	defer server.Close()
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}}
	defer transport.CloseIdleConnections()
	provider := &HostMetricProvider{config: HostMetricConfig{NodeID: labels["com.teamaibox.node-id"], ProcRoot: filepath.Join(root, "proc"), SysRoot: filepath.Join(root, "sys")}, docker: &http.Client{Transport: transport}}
	_, workers, models, _ := provider.containerMetrics(context.Background())
	if len(workers) != 1 || workers[0].WorkerID != labels["com.teamaibox.phone-run-id"] || workers[0].State != "busy" || workers[0].Cgroup == nil || workers[0].Cgroup.CurrentBytes != 4<<30 || len(models) != 0 {
		t.Fatalf("phone measurement missing: %+v", workers)
	}
	live, err := provider.phoneWorkerMemory(context.Background())
	if err != nil || len(live) != 1 || live[0].WorkerID != labels["com.teamaibox.phone-run-id"] || live[0].CurrentBytes != 4<<30 {
		t.Fatalf("direct signed capacity stats missing: %+v %v", live, err)
	}
	state = "exited"
	_, workers, _, _ = provider.containerMetrics(context.Background())
	if len(workers) != 0 {
		t.Fatal("stopped phone still discounts reservation")
	}
}

func TestPhoneMetricsDoNotDropContainersAboveOldCountLimits(t *testing.T) {
	const count = 601
	containers := make([]dockerContainer, count)
	for i := range containers {
		labels := phoneMetricLabels()
		labels["com.teamaibox.phone-run-id"] = fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1)
		containers[i] = dockerContainer{ID: fmt.Sprintf("%064x", i+1), State: "running", Labels: labels}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1.48/containers/json" {
			json.NewEncoder(w).Encode(containers)
		} else if strings.HasSuffix(r.URL.Path, "/stats") {
			json.NewEncoder(w).Encode(map[string]any{"memory_stats": map[string]any{"usage": 4096}})
		} else {
			json.NewEncoder(w).Encode(map[string]any{"State": map[string]any{"Pid": 0, "OOMKilled": false}})
		}
	}))
	defer server.Close()
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}}
	defer transport.CloseIdleConnections()
	provider := &HostMetricProvider{config: HostMetricConfig{NodeID: phoneMetricLabels()["com.teamaibox.node-id"], ProcRoot: t.TempDir()}, docker: &http.Client{Transport: transport}}
	live, err := provider.phoneWorkerMemory(context.Background())
	if err != nil || len(live) != count {
		t.Fatalf("capacity metrics truncated: %d %v", len(live), err)
	}
	processes, workers, _, _ := provider.containerMetrics(context.Background())
	if len(processes) != count || len(workers) != count || workers[count-1].WorkerID != live[count-1].WorkerID {
		t.Fatalf("snapshot lost its tail: %d processes, %d workers", len(processes), len(workers))
	}
}
