package docker

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

const maximumApplicationResponseBytes = 16 << 20

func applicationTarget(document inspectDocument, workerID string, ownership agent.Ownership) (string, error) {
	labels := document.Config.Labels
	port, portError := strconv.Atoi(labels["com.teamaibox.application-port"])
	if labels["com.teamaibox.managed"] != "true" || labels["com.teamaibox.kind"] != "application-plugin" ||
		labels["com.teamaibox.node-id"] != ownership.NodeID || labels["com.teamaibox.worker-id"] != workerID ||
		!runtimeGenerationMatches(document, ownership) ||
		labels["com.teamaibox.lease-id"] != ownership.LeaseID ||
		labels["com.teamaibox.fencing-token"] != strconv.FormatUint(ownership.FencingToken, 10) ||
		labels["com.teamaibox.plugin-id"] == "" || document.HostConfig.NetworkMode != "plugin-ingress" ||
		document.State.Status != "running" || portError != nil || port < 1024 || port > 65535 {
		return "", fmt.Errorf("application worker ownership or ingress boundary does not match")
	}
	if document.State.Health != nil && document.State.Health.Status != "healthy" {
		return "", fmt.Errorf("application worker is unhealthy")
	}
	return "http://" + containerName(workerID) + ":" + strconv.Itoa(port), nil
}

func applicationHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Client{Transport: &http.Transport{
		Proxy: nil, DialContext: dialer.DialContext, DisableCompression: true,
		MaxIdleConns: 16, MaxIdleConnsPerHost: 8, IdleConnTimeout: 30 * time.Second,
	}, Timeout: 20 * time.Second}
}

func fetchApplication(ctx context.Context, client *http.Client, target string, payload agent.ApplicationFetchPayload) (agent.ApplicationContent, error) {
	if client == nil {
		client = applicationHTTPClient()
	}
	parsed, err := url.ParseRequestURI(payload.Path)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || !strings.HasPrefix(parsed.Path, "/plugins/") ||
		(payload.Method != http.MethodGet && payload.Method != http.MethodHead) {
		return agent.ApplicationContent{}, fmt.Errorf("application request path is invalid")
	}
	request, err := http.NewRequestWithContext(ctx, payload.Method, target+payload.Path, nil)
	if err != nil {
		return agent.ApplicationContent{}, fmt.Errorf("application request could not be constructed")
	}
	request.Header.Set("Accept", "text/html,application/xhtml+xml,application/javascript,text/css,image/*,*/*;q=0.8")
	response, err := client.Do(request)
	if err != nil {
		return agent.ApplicationContent{}, fmt.Errorf("application worker is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 599 {
		return agent.ApplicationContent{}, fmt.Errorf("application worker returned an invalid status")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumApplicationResponseBytes+1))
	if err != nil || len(body) > maximumApplicationResponseBytes {
		return agent.ApplicationContent{}, fmt.Errorf("application response exceeds the bounded size")
	}
	headers := map[string]string{}
	for _, name := range []string{"Content-Type", "Cache-Control", "ETag", "Last-Modified", "Content-Language"} {
		if value := response.Header.Get(name); value != "" && len(value) <= 1024 && !strings.ContainsAny(value, "\r\n") {
			headers[strings.ToLower(name)] = value
		}
	}
	return agent.ApplicationContent{Status: response.StatusCode, Headers: headers, Body: body}, nil
}
