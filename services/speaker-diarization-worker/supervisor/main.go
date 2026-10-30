package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultListenAddress = "0.0.0.0:8080"
	defaultNativeAddress = "127.0.0.1:18081"
	defaultModelPath     = "/models/diar_streaming_sortformer_4spk-v2.q8_0.gguf"
	defaultNativeBinary  = "/opt/nemo-speech/bin/nemo-speech"
	maximumUploadBytes   = int64(64 * 1024 * 1024)
	maximumResponseBytes = int64(16 * 1024 * 1024)
)

type configuration struct {
	listenAddress  string
	nativeAddress  string
	nativeBinary   string
	nativeArgs     []string
	modelPath      string
	modelName      string
	idleTimeout    time.Duration
	prepareTimeout time.Duration
}

type workerSupervisor struct {
	configuration configuration
	client        *http.Client
	mu            sync.Mutex
	command       *exec.Cmd
	done          chan error
	active        int
	lastUsed      time.Time
	stopping      bool
}

func durationFromEnvironment(name string, fallback, minimum, maximum time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	seconds, err := strconv.Atoi(raw)
	value := time.Duration(seconds) * time.Second
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s is invalid", name)
	}
	return value, nil
}

func environmentConfiguration() (configuration, error) {
	idle, err := durationFromEnvironment("TEAMAIBOX_DIARIZATION_IDLE_UNLOAD_SECONDS", 300*time.Second, time.Second, 24*time.Hour)
	if err != nil {
		return configuration{}, err
	}
	prepare, err := durationFromEnvironment("TEAMAIBOX_DIARIZATION_PREPARE_TIMEOUT_SECONDS", 120*time.Second, time.Second, 30*time.Minute)
	if err != nil {
		return configuration{}, err
	}
	listenAddress := strings.TrimSpace(os.Getenv("TEAMAIBOX_DIARIZATION_LISTEN_ADDRESS"))
	if listenAddress == "" {
		listenAddress = defaultListenAddress
	}
	nativeAddress := strings.TrimSpace(os.Getenv("TEAMAIBOX_DIARIZATION_NATIVE_ADDRESS"))
	if nativeAddress == "" {
		nativeAddress = defaultNativeAddress
	}
	modelPath := strings.TrimSpace(os.Getenv("TEAMAIBOX_DIARIZATION_MODEL_PATH"))
	if modelPath == "" {
		modelPath = defaultModelPath
	}
	nativeBinary := strings.TrimSpace(os.Getenv("TEAMAIBOX_DIARIZATION_NATIVE_BINARY"))
	if nativeBinary == "" {
		nativeBinary = defaultNativeBinary
	}
	if filepath.Clean(modelPath) != modelPath || !filepath.IsAbs(modelPath) || filepath.Clean(nativeBinary) != nativeBinary || !filepath.IsAbs(nativeBinary) {
		return configuration{}, errors.New("native model or executable path is invalid")
	}
	_, nativePort, err := net.SplitHostPort(nativeAddress)
	if err != nil {
		return configuration{}, errors.New("native address is invalid")
	}
	return configuration{
		listenAddress: listenAddress,
		nativeAddress: nativeAddress,
		nativeBinary:  nativeBinary,
		nativeArgs: []string{
			"serve", "--host", "127.0.0.1", "--port", nativePort, "--threads", "2",
			"--max-upload-mb", "64", "--log-format", "json", "--no-ui",
			"--diar-model", modelPath, "--backend", "cuda",
		},
		modelPath: modelPath, modelName: "diar_streaming_sortformer_4spk-v2",
		idleTimeout: idle, prepareTimeout: prepare,
	}, nil
}

func newWorkerSupervisor(configuration configuration) *workerSupervisor {
	return &workerSupervisor{
		configuration: configuration,
		client:        &http.Client{Timeout: 30 * time.Minute},
		lastUsed:      time.Now(),
	}
}

func (supervisor *workerSupervisor) nativeURL(path string) string {
	return "http://" + supervisor.configuration.nativeAddress + path
}

func (supervisor *workerSupervisor) ready() bool {
	response, err := supervisor.client.Get(supervisor.nativeURL("/ready"))
	if err != nil {
		return false
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return response.StatusCode >= 200 && response.StatusCode < 300
}

func (supervisor *workerSupervisor) startLocked(ctx context.Context) error {
	if supervisor.command != nil && supervisor.ready() {
		return nil
	}
	if supervisor.command != nil || supervisor.stopping {
		return errors.New("worker transition is already in progress")
	}
	command := exec.Command(supervisor.configuration.nativeBinary, supervisor.configuration.nativeArgs...)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.Env = os.Environ()
	if err := command.Start(); err != nil {
		return errors.New("native worker could not start")
	}
	done := make(chan error, 1)
	supervisor.command = command
	supervisor.done = done
	go func() {
		err := command.Wait()
		done <- err
		close(done)
		supervisor.mu.Lock()
		if supervisor.command == command {
			supervisor.command = nil
			supervisor.done = nil
		}
		supervisor.mu.Unlock()
	}()
	deadline := time.Now().Add(supervisor.configuration.prepareTimeout)
	for time.Now().Before(deadline) {
		if supervisor.ready() {
			supervisor.lastUsed = time.Now()
			return nil
		}
		select {
		case <-ctx.Done():
			_ = supervisor.stopLocked(true)
			return errors.New("native worker preparation was cancelled")
		case <-done:
			supervisor.command = nil
			supervisor.done = nil
			return errors.New("native worker exited during preparation")
		case <-time.After(250 * time.Millisecond):
		}
	}
	_ = supervisor.stopLocked(true)
	return errors.New("native worker preparation timed out")
}

func (supervisor *workerSupervisor) acquire(ctx context.Context) (func(), error) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if err := supervisor.startLocked(ctx); err != nil {
		return nil, err
	}
	supervisor.active++
	supervisor.lastUsed = time.Now()
	var once sync.Once
	return func() {
		once.Do(func() {
			supervisor.mu.Lock()
			supervisor.active--
			supervisor.lastUsed = time.Now()
			supervisor.mu.Unlock()
		})
	}, nil
}

func (supervisor *workerSupervisor) stopLocked(force bool) error {
	if supervisor.command == nil {
		return nil
	}
	if supervisor.active > 0 && !force {
		return errors.New("worker is busy")
	}
	command := supervisor.command
	done := supervisor.done
	supervisor.stopping = true
	if err := command.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		supervisor.stopping = false
		return errors.New("native worker could not stop")
	}
	supervisor.mu.Unlock()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		_ = command.Process.Kill()
		<-done
	}
	supervisor.mu.Lock()
	if supervisor.command == command {
		supervisor.command = nil
		supervisor.done = nil
	}
	supervisor.stopping = false
	return nil
}

func (supervisor *workerSupervisor) unload(force bool) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.stopLocked(force)
}

func (supervisor *workerSupervisor) state() (loaded bool, active int, idleFor time.Duration) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.command != nil, supervisor.active, time.Since(supervisor.lastUsed)
}

func (supervisor *workerSupervisor) idleLoop(ctx context.Context) {
	interval := supervisor.configuration.idleTimeout / 4
	if interval < 250*time.Millisecond {
		interval = 250 * time.Millisecond
	}
	if interval > 15*time.Second {
		interval = 15 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			supervisor.mu.Lock()
			if supervisor.command != nil && supervisor.active == 0 && time.Since(supervisor.lastUsed) >= supervisor.configuration.idleTimeout {
				_ = supervisor.stopLocked(false)
			}
			supervisor.mu.Unlock()
		}
	}
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	payload, _ := json.Marshal(value)
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Content-Length", strconv.Itoa(len(payload)))
	response.WriteHeader(status)
	_, _ = response.Write(payload)
}

func (supervisor *workerSupervisor) health(response http.ResponseWriter, _ *http.Request) {
	loaded, active, _ := supervisor.state()
	_, binaryErr := os.Stat(supervisor.configuration.nativeBinary)
	_, modelErr := os.Stat(supervisor.configuration.modelPath)
	accepting := binaryErr == nil && modelErr == nil
	status := http.StatusOK
	if !accepting {
		status = http.StatusServiceUnavailable
	}
	writeJSON(response, status, map[string]any{
		"status": "ready", "accepting": accepting, "loaded": loaded, "active_requests": active,
		"model": supervisor.configuration.modelName, "idle_unload_seconds": int(supervisor.configuration.idleTimeout.Seconds()),
	})
}

func (supervisor *workerSupervisor) models(response http.ResponseWriter, _ *http.Request) {
	loaded, _, _ := supervisor.state()
	writeJSON(response, http.StatusOK, map[string]any{"object": "list", "data": []any{map[string]any{
		"id": supervisor.configuration.modelName, "object": "model", "owned_by": "teamaibox",
		"capability": "diarization", "device": "cuda", "loaded": loaded,
	}}})
}

func (supervisor *workerSupervisor) prepare(response http.ResponseWriter, request *http.Request) {
	release, err := supervisor.acquire(request.Context())
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"error": map[string]any{"code": "worker_prepare_failed"}})
		return
	}
	release()
	writeJSON(response, http.StatusOK, map[string]any{"status": "ready", "loaded": true, "model": supervisor.configuration.modelName})
}

func (supervisor *workerSupervisor) unloadHandler(response http.ResponseWriter, _ *http.Request) {
	if err := supervisor.unload(false); err != nil {
		writeJSON(response, http.StatusConflict, map[string]any{"error": map[string]any{"code": "worker_busy"}})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"status": "unloaded", "loaded": false, "model": supervisor.configuration.modelName})
}

func (supervisor *workerSupervisor) status(response http.ResponseWriter, _ *http.Request) {
	loaded, active, idleFor := supervisor.state()
	writeJSON(response, http.StatusOK, map[string]any{"status": map[bool]string{true: "ready", false: "unloaded"}[loaded],
		"loaded": loaded, "active_requests": active, "idle_seconds": int(idleFor.Seconds()), "model": supervisor.configuration.modelName})
}

func (supervisor *workerSupervisor) diarize(response http.ResponseWriter, request *http.Request) {
	if request.ContentLength < 1 || request.ContentLength > maximumUploadBytes {
		writeJSON(response, http.StatusRequestEntityTooLarge, map[string]any{"error": map[string]any{"code": "request_too_large"}})
		return
	}
	contentType := request.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(contentType), "multipart/form-data;") {
		writeJSON(response, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "invalid_request"}})
		return
	}
	release, err := supervisor.acquire(request.Context())
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"error": map[string]any{"code": "worker_prepare_failed"}})
		return
	}
	defer release()
	upstream, err := http.NewRequestWithContext(request.Context(), http.MethodPost,
		supervisor.nativeURL("/v1/audio/diarizations"), io.LimitReader(request.Body, maximumUploadBytes))
	if err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "invalid_request"}})
		return
	}
	upstream.ContentLength = request.ContentLength
	upstream.Header.Set("Content-Type", contentType)
	upstream.Header.Set("Accept", "application/json")
	result, err := supervisor.client.Do(upstream)
	if err != nil {
		writeJSON(response, http.StatusBadGateway, map[string]any{"error": map[string]any{"code": "worker_execution_failed"}})
		return
	}
	defer result.Body.Close()
	body, err := io.ReadAll(io.LimitReader(result.Body, maximumResponseBytes+1))
	if err != nil || int64(len(body)) > maximumResponseBytes {
		writeJSON(response, http.StatusBadGateway, map[string]any{"error": map[string]any{"code": "worker_response_invalid"}})
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Content-Length", strconv.Itoa(len(body)))
	response.WriteHeader(result.StatusCode)
	_, _ = response.Write(body)
}

func (supervisor *workerSupervisor) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ready", supervisor.health)
	mux.HandleFunc("GET /health/ready", supervisor.health)
	mux.HandleFunc("GET /v1/models", supervisor.models)
	mux.HandleFunc("GET /v1/models/status", supervisor.status)
	mux.HandleFunc("POST /v1/models/prepare", supervisor.prepare)
	mux.HandleFunc("POST /v1/models/unload", supervisor.unloadHandler)
	mux.HandleFunc("POST /v1/audio/diarizations", supervisor.diarize)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(response, request)
	})
}

func run() error {
	configuration, err := environmentConfiguration()
	if err != nil {
		return err
	}
	supervisor := newWorkerSupervisor(configuration)
	contextValue, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	go supervisor.idleLoop(contextValue)
	server := &http.Server{
		Addr: configuration.listenAddress, Handler: supervisor.routes(),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 32 * 1024,
	}
	listener, err := net.Listen("tcp", configuration.listenAddress)
	if err != nil {
		return err
	}
	finished := make(chan error, 1)
	go func() { finished <- server.Serve(listener) }()
	select {
	case <-contextValue.Done():
		shutdown, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		_ = server.Shutdown(shutdown)
		_ = supervisor.unload(true)
		return nil
	case err := <-finished:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "speaker-diarization supervisor failed")
		os.Exit(1)
	}
}
