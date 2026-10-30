package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func fileFrame(kind byte, data []byte) []byte {
	header := make([]byte, 8)
	header[0] = kind
	binary.BigEndian.PutUint32(header[4:], uint32(len(data)))
	return append(header, data...)
}

func TestPhoneFileExecFixedRecipeHalfCloseAndBytes(t *testing.T) {
	input := bytes.Repeat([]byte{0, 255, 3}, 150000)
	want := bytes.Repeat([]byte{9, 0, 255}, 170000)
	container, execID := strings.Repeat("a", 64), strings.Repeat("b", 64)
	served := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.48/containers/" + container + "/exec":
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("bad create")
			}
			cmd, _ := json.Marshal(body["Cmd"])
			if string(cmd) != `["/usr/bin/python3","/opt/teamaibox/phone_files.py"]` || body["User"] != "10001:10001" || body["Tty"] != false || body["Privileged"] != false {
				t.Errorf("unsafe recipe: %v", body)
			}
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(map[string]string{"Id": execID})
		case "/v1.48/exec/" + execID + "/start":
			_, _ = io.Copy(io.Discard, r.Body)
			c, b, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer c.Close()
			_, _ = b.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
			_ = b.Flush()
			data, err := io.ReadAll(b)
			if err != nil {
				t.Error(err)
			}
			served <- data
			for offset := 0; offset < len(want); offset += 32768 {
				end := min(offset+32768, len(want))
				_, _ = c.Write(fileFrame(1, want[offset:end]))
			}
			_, _ = c.Write(fileFrame(2, []byte("private diagnostic not forwarded")))
		case "/v1.48/exec/" + execID + "/json":
			_ = json.NewEncoder(w).Encode(map[string]any{"Running": false, "ExitCode": 0})
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
	}}
	r := &EngineRuntime{client: &http.Client{Transport: transport}, baseURL: server.URL + "/v1.48"}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out bytes.Buffer
	if err := r.execPhoneFiles(ctx, container, bytes.NewReader(input), &out); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out.Bytes(), want) || !bytes.Equal(<-served, input) {
		t.Fatal("binary bytes changed")
	}
}

func TestPhoneFileOutputRejectsTruncationAndOversize(t *testing.T) {
	for _, data := range [][]byte{fileFrame(1, []byte("test"))[:10], {1, 0, 0}, fileFrame(3, []byte("bad")), {1, 0, 0, 0, 1, 0, 0, 0}} {
		if phoneFileOutput(bufio.NewReader(bytes.NewReader(data)), io.Discard) == nil {
			t.Fatal("accepted malformed multiplex framing")
		}
	}
}
