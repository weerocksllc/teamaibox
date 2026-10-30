package telemetry

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const maximumResponseBytes = 1 << 20

var applianceIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type APIError struct {
	Status    int
	Code      string
	Message   string
	Retryable bool
	Details   APIErrorDetails
}

type APIErrorDetails struct {
	CurrentGeneration int64  `json:"currentGeneration"`
	Field             string `json:"field"`
}

func (failure *APIError) Error() string {
	if failure.Details.Field != "" {
		return fmt.Sprintf("appliance API failed: status=%d code=%s field=%s", failure.Status, failure.Code, failure.Details.Field)
	}
	return fmt.Sprintf("appliance API failed: status=%d code=%s", failure.Status, failure.Code)
}

type Client struct {
	origin    *url.URL
	mutualTLS *http.Client
}

func noRedirectClient(value *http.Client) *http.Client {
	copy := *value
	copy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	if copy.Timeout == 0 || copy.Timeout > 30*time.Second {
		copy.Timeout = 30 * time.Second
	}
	return &copy
}

func NewClient(origin string, mutualTLS *http.Client) (*Client, error) {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" || net.ParseIP(parsed.Hostname()) == nil || !net.ParseIP(parsed.Hostname()).IsLoopback() {
		return nil, errors.New("appliance origin must be a loopback HTTPS origin")
	}
	if mutualTLS == nil {
		return nil, errors.New("mutual TLS client is required")
	}
	parsed.Path = ""
	return &Client{origin: parsed, mutualTLS: noRedirectClient(mutualTLS)}, nil
}

func NewTLSClient(rootsPEM []byte, certificate *tls.Certificate, serverName string) (*http.Client, error) {
	if certificate == nil || len(certificate.Certificate) == 0 || strings.TrimSpace(serverName) == "" {
		return nil, errors.New("appliance TLS client identity and server name are required")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(rootsPEM) {
		return nil, errors.New("appliance CA contains no certificate")
	}
	configuration := &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: serverName}
	if certificate != nil {
		configuration.Certificates = []tls.Certificate{*certificate}
	}
	return &http.Client{Transport: &http.Transport{TLSClientConfig: configuration, ForceAttemptHTTP2: true}, Timeout: 30 * time.Second}, nil
}

func (client *Client) request(ctx context.Context, transport *http.Client, path string, input, output any) error {
	payload, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.origin.String()+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	response, err := transport.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return &APIError{Status: response.StatusCode, Code: "redirect_denied"}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil {
		return err
	}
	if len(body) > maximumResponseBytes {
		return errors.New("appliance API response is too large")
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		failure := struct {
			Error struct {
				Code, Message string
				Retryable     bool
				Details       APIErrorDetails
			} `json:"error"`
		}{}
		_ = json.Unmarshal(body, &failure)
		code := failure.Error.Code
		if code == "" {
			code = "request_failed"
		}
		return &APIError{Status: response.StatusCode, Code: code, Message: failure.Error.Message, Retryable: failure.Error.Retryable, Details: failure.Error.Details}
	}
	if !strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "application/json") {
		return errors.New("appliance API returned a non-JSON response")
	}
	if err := json.Unmarshal(body, output); err != nil {
		return errors.New("appliance API returned invalid JSON")
	}
	return nil
}

func (client *Client) Heartbeat(ctx context.Context, nodeID string, generation int64, inventory Inventory) (*HeartbeatResponse, error) {
	if !applianceIDPattern.MatchString(nodeID) || generation < 1 {
		return nil, errors.New("appliance heartbeat identity is invalid")
	}
	result := new(HeartbeatResponse)
	if err := client.request(ctx, client.mutualTLS, "/api/v1/appliance/heartbeat", struct {
		Generation int64     `json:"generation"`
		Inventory  Inventory `json:"inventory"`
	}{generation, inventory}, result); err != nil {
		return nil, err
	}
	if result.NodeID != nodeID || result.Generation != generation {
		return nil, errors.New("appliance heartbeat response identity does not match")
	}
	return result, nil
}

func (client *Client) Metrics(ctx context.Context, nodeID string, generation int64, snapshot MetricSnapshot) (*MetricResponse, error) {
	if !applianceIDPattern.MatchString(nodeID) || generation < 1 {
		return nil, errors.New("appliance metric identity is invalid")
	}
	result := new(MetricResponse)
	if err := client.request(ctx, client.mutualTLS, "/api/v1/appliance/metrics", struct {
		Generation int64          `json:"generation"`
		Snapshot   MetricSnapshot `json:"snapshot"`
	}{generation, snapshot}, result); err != nil {
		return nil, err
	}
	if result.NodeID != nodeID || result.NodeGeneration != generation {
		return nil, errors.New("appliance metric response identity does not match")
	}
	return result, nil
}
