package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

const computerDesktopProxyProgram = `import os,socket,sys,threading
p=int(sys.argv[1]);s=socket.create_connection(("127.0.0.1",p),3);s.settimeout(None)
def up():
 try:
  while True:
   b=os.read(0,65536)
   if not b: break
   s.sendall(b)
  s.shutdown(socket.SHUT_WR)
 except (BrokenPipeError,OSError): pass
threading.Thread(target=up,daemon=True).start()
try:
 while True:
  b=s.recv(65536)
  if not b: break
  v=memoryview(b)
  while v:
   n=os.write(1,v)
   if n<=0: raise BrokenPipeError()
   v=v[n:]
finally:s.close()`

// dockerDesktopConnection preserves any bytes read ahead with the HTTP upgrade
// response and removes Docker's non-TTY stdout/stderr frame headers. A PTY is
// intentionally forbidden here: even with a raw termios mode, a pseudo-terminal
// is not a transparent binary transport and can corrupt VNC/RDP bytes. The fixed
// subprocess runs as the unprivileged runtime user inside an already verified
// guest container and can only connect to one allowlisted loopback port.
type dockerDesktopConnection struct {
	net.Conn
	reader    *bufio.Reader
	remaining uint32
}

func (c *dockerDesktopConnection) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for c.remaining == 0 {
		var header [8]byte
		if _, err := io.ReadFull(c.reader, header[:]); err != nil {
			return 0, err
		}
		size := binary.BigEndian.Uint32(header[4:])
		if header[1] != 0 || header[2] != 0 || header[3] != 0 ||
			(header[0] != 1 && header[0] != 2) || size > 64<<20 {
			return 0, errors.New("computer_desktop_transport_unavailable")
		}
		if header[0] == 2 {
			if _, err := io.CopyN(io.Discard, c.reader, int64(size)); err != nil {
				return 0, err
			}
			continue
		}
		c.remaining = size
	}
	if uint32(len(p)) > c.remaining {
		p = p[:c.remaining]
	}
	n, err := c.reader.Read(p)
	c.remaining -= uint32(n)
	return n, err
}

func (r *EngineRuntime) openComputerDesktop(ctx context.Context, containerID, port string) (net.Conn, error) {
	if !phoneExactContainerID.MatchString(containerID) || (port != "3389" && port != "5900" && port != "4713") {
		return nil, errors.New("computer_desktop_unavailable")
	}
	var created struct {
		ID string `json:"Id"`
	}
	recipe := map[string]any{
		"AttachStdin": true, "AttachStdout": true, "AttachStderr": true,
		"Tty": false, "Privileged": false, "User": "10001:10001",
		"Cmd": []string{"/usr/bin/python3", "-u", "-c", computerDesktopProxyProgram, port},
	}
	if err := r.request(ctx, http.MethodPost, "/containers/"+containerID+"/exec", recipe, &created, http.StatusCreated); err != nil || !phoneExactContainerID.MatchString(created.ID) {
		return nil, errors.New("computer_desktop_unavailable")
	}
	transport, ok := r.client.Transport.(*http.Transport)
	if !ok || transport.DialContext == nil {
		return nil, errors.New("computer_desktop_transport_unavailable")
	}
	endpoint, err := url.Parse(r.baseURL)
	if err != nil {
		return nil, errors.New("computer_desktop_transport_unavailable")
	}
	connection, err := transport.DialContext(ctx, "tcp", endpoint.Host)
	if err != nil {
		return nil, errors.New("computer_desktop_transport_unavailable")
	}
	fail := func() (net.Conn, error) {
		_ = connection.Close()
		return nil, errors.New("computer_desktop_transport_unavailable")
	}
	stop := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stop()
	deadline := time.Now().Add(5 * time.Second)
	if value, ok := ctx.Deadline(); ok && value.Before(deadline) {
		deadline = value
	}
	_ = connection.SetDeadline(deadline)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/exec/"+created.ID+"/start", bytes.NewBufferString(`{"Detach":false,"Tty":false}`))
	if err != nil {
		return fail()
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "tcp")
	if request.Write(connection) != nil {
		return fail()
	}
	reader := bufio.NewReaderSize(connection, 32768)
	response, err := http.ReadResponse(reader, request)
	if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
		if response != nil {
			_ = response.Body.Close()
		}
		return fail()
	}
	_ = connection.SetDeadline(time.Time{})
	return &dockerDesktopConnection{Conn: connection, reader: reader}, nil
}
