package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

const (
	workerControlNetwork      = "compute-internal"
	workerControlPort         = 8080
	maximumWorkerControlBytes = 512 << 10
	workerPrepareStartupGrace = 30 * time.Second
	workerPrepareRetryDelay   = 200 * time.Millisecond
)

func workerControlHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Client{Transport: &http.Transport{
		Proxy: nil, DialContext: dialer.DialContext, DisableCompression: true,
		MaxIdleConns: 16, MaxIdleConnsPerHost: 8, IdleConnTimeout: 30 * time.Second,
	}, Timeout: 120 * time.Second}
}

func workerControlTarget(document inspectDocument, workerID string, ownership agent.Ownership, requestType string) (string, error) {
	labels := document.Config.Labels
	placement, _, _, placementErr := placementState(labels)
	kind := labels["com.teamaibox.kind"]
	network := document.NetworkSettings.Networks[workerControlNetwork]
	ip := net.ParseIP(network.IPAddress)
	if placementErr != nil || labels["com.teamaibox.managed"] != "true" || (kind != "compute-worker" && kind != "compute-plugin") ||
		labels["com.teamaibox.node-id"] != ownership.NodeID || labels["com.teamaibox.worker-id"] != workerID ||
		!runtimeGenerationMatches(document, ownership) ||
		labels["com.teamaibox.lease-id"] != ownership.LeaseID ||
		labels["com.teamaibox.fencing-token"] != strconv.FormatUint(ownership.FencingToken, 10) ||
		document.HostConfig.NetworkMode != workerControlNetwork || document.State.Status != "running" || ip == nil || !ip.IsPrivate() {
		return "", fmt.Errorf("worker control ownership or internal network boundary does not match")
	}
	if agent.IsProtectedPlacement(placement) {
		if !agent.ProtectedControlRequestAllowed(requestType) {
			return "", fmt.Errorf("protected_resident_operation_denied")
		}
	}
	if document.State.Health != nil && document.State.Health.Status != "healthy" &&
		!(requestType == "worker.prepare.request" && document.State.Health.Status == "starting") {
		return "", fmt.Errorf("worker control target is unhealthy")
	}
	return "http://" + net.JoinHostPort(ip.String(), strconv.Itoa(workerControlPort)), nil
}

func forwardWorkerControl(ctx context.Context, client *http.Client, target string, payload agent.WorkerControlPayload) (json.RawMessage, error) {
	if client == nil {
		client = workerControlHTTPClient()
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" ||
		net.ParseIP(parsed.Hostname()) == nil || parsed.Port() != strconv.Itoa(workerControlPort) {
		return nil, fmt.Errorf("worker control target is invalid")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target+"/v1/worker/control", bytes.NewReader(payload.Request))
	if err != nil {
		return nil, fmt.Errorf("worker control request could not be constructed")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("worker control target is unavailable")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumWorkerControlBytes+1))
	if err != nil || len(body) == 0 || len(body) > maximumWorkerControlBytes || response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker control response is invalid")
	}
	var document map[string]any
	if json.Unmarshal(body, &document) != nil || document == nil {
		return nil, fmt.Errorf("worker control response is invalid")
	}
	return json.RawMessage(body), nil
}

func (r *EngineRuntime) ForwardWorkerControl(ctx context.Context, payload agent.WorkerControlPayload, ownership agent.Ownership) (json.RawMessage, error) {
	var requestIdentity struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload.Request, &requestIdentity); err != nil || requestIdentity.Type == "" {
		return nil, fmt.Errorf("worker control request type is invalid")
	}
	deadline := time.Now().Add(workerPrepareStartupGrace)
	for {
		var document inspectDocument
		endpoint := "/containers/" + url.PathEscape(containerName(payload.WorkerID)) + "/json"
		if err := r.request(ctx, http.MethodGet, endpoint, nil, &document, http.StatusOK); err != nil {
			return nil, ErrNotFound
		}
		target, err := workerControlTarget(document, payload.WorkerID, ownership, requestIdentity.Type)
		if err != nil {
			return nil, err
		}
		response, err := forwardWorkerControl(ctx, r.applicationClient, target, payload)
		if err == nil || requestIdentity.Type != "worker.prepare.request" || !time.Now().Before(deadline) {
			return response, err
		}
		timer := time.NewTimer(workerPrepareRetryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
