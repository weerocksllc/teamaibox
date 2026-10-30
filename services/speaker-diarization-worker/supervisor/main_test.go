package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func freeAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	return address
}

func TestNativeHelper(t *testing.T) {
	if os.Getenv("TEAMAIBOX_DIARIZATION_TEST_HELPER") != "1" {
		return
	}
	port := ""
	for index, value := range os.Args {
		if value == "--port" && index+1 < len(os.Args) {
			port = os.Args[index+1]
		}
	}
	if port == "" {
		os.Exit(2)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ready", func(response http.ResponseWriter, _ *http.Request) { response.WriteHeader(http.StatusOK) })
	mux.HandleFunc("POST /v1/audio/diarizations", func(response http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"object":"audio.diarization","segments":[{"speaker":1,"start":0,"end":1}]}`))
	})
	if err := http.ListenAndServe("127.0.0.1:"+port, mux); err != nil {
		os.Exit(3)
	}
}

func fixture(t *testing.T, idle time.Duration) (*workerSupervisor, *httptest.Server) {
	t.Helper()
	address := freeAddress(t)
	_, port, _ := net.SplitHostPort(address)
	configuration := configuration{
		nativeAddress: address, nativeBinary: os.Args[0], modelPath: os.Args[0], modelName: "fixture",
		nativeArgs:  []string{"-test.run=TestNativeHelper", "--", "--port", port},
		idleTimeout: idle, prepareTimeout: 5 * time.Second,
	}
	supervisor := newWorkerSupervisor(configuration)
	t.Setenv("TEAMAIBOX_DIARIZATION_TEST_HELPER", "1")
	server := httptest.NewServer(supervisor.routes())
	t.Cleanup(func() { server.Close(); _ = supervisor.unload(true) })
	return supervisor, server
}

func document(t *testing.T, response *http.Response) map[string]any {
	t.Helper()
	defer response.Body.Close()
	value := map[string]any{}
	if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestLazyPrepareProxyAndExplicitUnload(t *testing.T) {
	supervisor, server := fixture(t, time.Minute)
	health, err := http.Get(server.URL + "/ready")
	if err != nil {
		t.Fatal(err)
	}
	if health.StatusCode != http.StatusOK || document(t, health)["loaded"] != false {
		t.Fatal("health should be ready without loading the model")
	}
	body := "--fixture\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\nwave\r\n--fixture--\r\n"
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/audio/diarizations", strings.NewReader(body))
	request.Header.Set("Content-Type", "multipart/form-data; boundary=fixture")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || document(t, response)["object"] != "audio.diarization" {
		t.Fatal("diarization proxy failed")
	}
	loaded, active, _ := supervisor.state()
	if !loaded || active != 0 {
		t.Fatalf("unexpected loaded state: %v active=%d", loaded, active)
	}
	unload, err := http.Post(server.URL+"/v1/models/unload", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	if unload.StatusCode != http.StatusOK || document(t, unload)["loaded"] != false {
		t.Fatal("explicit unload failed")
	}
	loaded, _, _ = supervisor.state()
	if loaded {
		t.Fatal("native worker remained loaded")
	}
}

func TestIdleUnloadAndRequestBounds(t *testing.T) {
	supervisor, server := fixture(t, 250*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go supervisor.idleLoop(ctx)
	prepare, err := http.Post(server.URL+"/v1/models/prepare", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	if prepare.StatusCode != http.StatusOK {
		t.Fatalf("prepare status %d", prepare.StatusCode)
	}
	_ = prepare.Body.Close()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		loaded, _, _ := supervisor.state()
		if !loaded {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	loaded, _, _ := supervisor.state()
	if loaded {
		t.Fatal("idle worker was not unloaded")
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/audio/diarizations", strings.NewReader("x"))
	request.ContentLength = maximumUploadBytes + 1
	request.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	recorder := httptest.NewRecorder()
	supervisor.routes().ServeHTTP(recorder, request)
	response := recorder.Result()
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize status %s", strconv.Itoa(response.StatusCode))
	}
	if fmt.Sprint(document(t, response)["error"]) == "" {
		t.Fatal("bounded error response is missing")
	}
}
