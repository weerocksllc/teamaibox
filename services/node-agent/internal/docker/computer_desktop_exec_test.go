package docker

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"testing"
)

func desktopFrame(stream byte, payload []byte) []byte {
	header := make([]byte, 8)
	header[0] = stream
	binary.BigEndian.PutUint32(header[4:], uint32(len(payload)))
	return append(header, payload...)
}

func TestComputerDesktopConnectionPreservesMultiplexedBinaryBytes(t *testing.T) {
	want := bytes.Repeat([]byte{0, 255, 3, 7}, 20000)
	left, right := net.Pipe()
	defer left.Close()
	go func() {
		defer right.Close()
		for offset := 0; offset < len(want); offset += 32768 {
			end := min(offset+32768, len(want))
			_, _ = right.Write(desktopFrame(1, want[offset:end]))
		}
		_, _ = right.Write(desktopFrame(2, []byte("private diagnostic not forwarded")))
	}()
	connection := &dockerDesktopConnection{Conn: left, reader: bufio.NewReader(left)}
	got, err := io.ReadAll(connection)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatal("raw desktop bytes changed", err)
	}
}

func TestComputerDesktopConnectionRejectsMalformedFrames(t *testing.T) {
	for _, raw := range [][]byte{{1, 0, 0}, {3, 0, 0, 0, 0, 0, 0, 1, 'x'}, {1, 1, 0, 0, 0, 0, 0, 1, 'x'}} {
		connection := &dockerDesktopConnection{reader: bufio.NewReader(bytes.NewReader(raw))}
		if _, err := io.ReadAll(connection); err == nil {
			t.Fatal("accepted malformed desktop frame")
		}
	}
}

func TestComputerDesktopProxyDoesNotUsePTY(t *testing.T) {
	if bytes.Contains([]byte(computerDesktopProxyProgram), []byte("tty")) {
		t.Fatal("desktop proxy must not use a pseudo-terminal for binary data")
	}
}

func TestComputerDesktopProxyUsesTimeoutOnlyForConnect(t *testing.T) {
	program := []byte(computerDesktopProxyProgram)
	if !bytes.Contains(program, []byte(`socket.create_connection(("127.0.0.1",p),3);s.settimeout(None)`)) {
		t.Fatal("desktop proxy must restore blocking mode after its bounded connect")
	}
}
