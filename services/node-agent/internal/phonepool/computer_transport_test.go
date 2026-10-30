package phonepool

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestComputerClientCanReadDeletedTombstoneWithoutDeletingAgain(t *testing.T) {
	_, _, q := computerFixture(t)
	q.Action = "computer-inspect"
	dir, e := os.MkdirTemp("/tmp", "computer-socket-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "storage.sock")
	listener, e := net.Listen("unix", socket)
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	finished := make(chan error, 1)
	go func() {
		conn, e := listener.Accept()
		if e != nil {
			finished <- e
			return
		}
		defer conn.Close()
		_, e = bufio.NewReader(conn).ReadBytes('\n')
		if e != nil {
			finished <- e
			return
		}
		result := Result{Computer: q.Computer, ProjectID: 100000, QuotaBytes: q.Computer.DiskBytes + 2<<30, Deleted: true}
		e = json.NewEncoder(conn).Encode(reply{Result: &result})
		finished <- e
	}()
	result, e := (Client{Socket: socket}).Handle(context.Background(), q)
	if e != nil || !result.Deleted {
		t.Fatalf("%+v %v", result, e)
	}
	if e = <-finished; e != nil {
		t.Fatal(e)
	}
}
