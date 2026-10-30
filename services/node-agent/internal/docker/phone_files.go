package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

// Refresh the idle deadline as bytes move; it is not a wall-clock file limit.
type phoneProgressConnection struct{ net.Conn }

func (c phoneProgressConnection) Read(p []byte) (int, error) {
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	return c.Conn.Read(p)
}
func (c phoneProgressConnection) Write(p []byte) (int, error) {
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	return c.Conn.Write(p)
}
func (c phoneProgressConnection) CloseWrite() error {
	if half, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return half.CloseWrite()
	}
	return errors.New("phone_file_transport_unavailable")
}

// Exact installed program only. This is not a general Docker exec interface:
// container/image/mount/run are verified before creating the fixed subprocess;
// user data can only be a validated metadata header and framed file bytes.
func (d *PhoneDriver) TransferPhoneFile(ctx context.Context, p agent.PhoneFilePayload, input io.Reader, output io.Writer) error {
	b, err := d.resources.ResolveRun(ctx, p.PhoneCommandPayload)
	if err != nil {
		return err
	}
	state, err := d.inspect(ctx, p.PhoneCommandPayload, b)
	if err != nil || state.RuntimeStopped || !state.AndroidReady {
		return errors.New("phone_file_not_ready")
	}
	header := map[string]any{"phoneId": p.PhoneID, "ownerId": p.OwnerID, "runId": p.Run.ID, "generation": p.Generation,
		"action": p.Action, "transferId": p.OperationID, "deadline": p.Deadline}
	if p.Action != "list" {
		header["name"] = p.Name
	}
	if p.Action == "upload" || p.Action == "install" {
		header["sizeBytes"] = p.SizeBytes
		header["sha256"] = p.SHA256
	}
	raw, err := json.Marshal(header)
	if err != nil {
		return errors.New("phone_file_payload_invalid")
	}
	defer clear(raw)
	return d.engine.execPhoneFiles(ctx, state.ContainerID, io.MultiReader(bytes.NewReader(append(raw, '\n')), input), output)
}

func (r *EngineRuntime) execPhoneFiles(ctx context.Context, containerID string, input io.Reader, output io.Writer) error {
	return r.execPhoneInput(ctx, containerID, "files", input, output)
}
func (r *EngineRuntime) execPhoneInput(ctx context.Context, containerID, kind string, input io.Reader, output io.Writer) error {
	program := "/opt/teamaibox/phone_files.py"
	maximumInput, maximumOutput := int64(agent.PhoneFileMaximum+16384), int64(agent.PhoneFileMaximum+65536)
	if kind == "camera" {
		program = "/opt/teamaibox/phone_camera_client.py"
		maximumInput = agent.PhoneCameraMaximum + 8192
		maximumOutput = 73728 // Bounded SDP answer; image/status acknowledgements remain small.
	} else if kind == "computer-optical" {
		program = "/opt/teamaibox/optical_client.py"
		maximumInput, maximumOutput = 4097, 4096
	} else if kind != "files" {
		return errors.New("phone_program_invalid")
	}
	if !phoneExactContainerID.MatchString(containerID) {
		return errors.New("phone_container_identity_mismatch")
	}
	var created struct {
		ID string `json:"Id"`
	}
	recipe := map[string]any{"AttachStdin": true, "AttachStdout": true, "AttachStderr": true, "Tty": false, "Privileged": false, "User": "10001:10001",
		"Cmd": []string{"/usr/bin/python3", program}}
	if err := r.request(ctx, http.MethodPost, "/containers/"+containerID+"/exec", recipe, &created, http.StatusCreated); err != nil {
		return errors.New("phone_file_worker_unavailable")
	}
	if !phoneExactContainerID.MatchString(created.ID) {
		return errors.New("phone_file_worker_unavailable")
	}
	transport, ok := r.client.Transport.(*http.Transport)
	if !ok || transport.DialContext == nil {
		return errors.New("phone_file_transport_unavailable")
	}
	endpoint, err := url.Parse(r.baseURL)
	if err != nil {
		return errors.New("phone_file_transport_unavailable")
	}
	connection, err := transport.DialContext(ctx, "tcp", endpoint.Host)
	if err != nil {
		return errors.New("phone_file_transport_unavailable")
	}
	if kind == "files" {
		connection = phoneProgressConnection{connection}
	}
	defer connection.Close()
	stop := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stop()
	deadline := time.Now().Add(120 * time.Second)
	if value, ok := ctx.Deadline(); ok && value.Before(deadline) {
		deadline = value
	}
	_ = connection.SetDeadline(deadline)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/exec/"+created.ID+"/start", bytes.NewBufferString(`{"Detach":false,"Tty":false}`))
	if err != nil {
		return errors.New("phone_file_transport_unavailable")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "tcp")
	if request.Write(connection) != nil {
		return errors.New("phone_file_transport_unavailable")
	}
	reader := bufio.NewReaderSize(connection, 32768)
	response, err := http.ReadResponse(reader, request)
	if err != nil || response.StatusCode != 101 {
		if response != nil {
			response.Body.Close()
		}
		return errors.New("phone_file_transport_unavailable")
	}
	// Half-close stdin so the worker can reject trailing bytes. Keep stdout open
	// to receive the authenticated result. Both Unix and test TCP sockets support it.
	half, ok := connection.(interface{ CloseWrite() error })
	if !ok {
		return errors.New("phone_file_transport_unavailable")
	}
	sent := make(chan error, 1)
	go func() {
		buffer := make([]byte, 65536)
		_, e := io.CopyBuffer(connection, io.LimitReader(input, maximumInput), buffer)
		clear(buffer)
		if e == nil {
			e = half.CloseWrite()
		}
		sent <- e
	}()
	if err = phoneBoundedOutput(reader, output, maximumOutput); err != nil {
		return err
	}
	select {
	case err = <-sent:
		if err != nil {
			return errors.New("phone_file_transfer_failed")
		}
	case <-ctx.Done():
		return errors.New("phone_file_transfer_cancelled")
	}
	var status struct {
		Running  bool `json:"Running"`
		ExitCode int  `json:"ExitCode"`
	}
	if r.request(ctx, http.MethodGet, "/exec/"+created.ID+"/json", nil, &status, http.StatusOK) != nil || status.Running || status.ExitCode != 0 {
		return errors.New("phone_file_worker_failed")
	}
	return nil
}

func phoneFileOutput(input io.Reader, output io.Writer) error {
	return phoneBoundedOutput(input, output, agent.PhoneFileMaximum+65536)
}
func phoneBoundedOutput(input io.Reader, output io.Writer, maximum int64) error {
	var header [8]byte
	total := int64(0)
	stderr := int64(0)
	buffer := make([]byte, 65536)
	defer clear(buffer)
	for {
		_, err := io.ReadFull(input, header[:])
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return errors.New("phone_file_worker_failed")
		}
		size := int64(binary.BigEndian.Uint32(header[4:]))
		if header[1] != 0 || header[2] != 0 || header[3] != 0 || (header[0] != 1 && header[0] != 2) || size > 1<<20 {
			return errors.New("phone_file_worker_failed")
		}
		target := output
		if header[0] == 2 {
			stderr += size
			if stderr > 16384 {
				return errors.New("phone_file_worker_failed")
			}
			target = io.Discard
		} else {
			total += size
			if total > maximum {
				return errors.New("phone_upload_too_large")
			}
		}
		var written int64
		if written, err = io.CopyBuffer(target, io.LimitReader(input, size), buffer); err != nil || written != size {
			return errors.New("phone_file_transfer_failed")
		}
	}
}
