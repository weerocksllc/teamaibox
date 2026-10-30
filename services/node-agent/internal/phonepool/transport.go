package phonepool

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type reply struct {
	Result *Result `json:"result,omitempty"`
	Error  string  `json:"error,omitempty"`
}

func DecodeRequest(raw []byte) (Request, error) {
	var q Request
	if len(raw) > 2048 {
		return q, errors.New("phone_pool_request_invalid")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	var object func(int) error
	object = func(depth int) error {
		if depth > 1 {
			return errors.New("nested object")
		}
		t, e := d.Token()
		if e != nil || t != json.Delim('{') {
			return errors.New("not object")
		}
		keys := map[string]bool{}
		for d.More() {
			t, e = d.Token()
			key, ok := t.(string)
			if e != nil || !ok || keys[key] {
				return errors.New("duplicate key")
			}
			keys[key] = true
			if depth == 0 && (key == "identity" || key == "computer") {
				if e = object(1); e != nil {
					return e
				}
			} else {
				v, e := d.Token()
				if e != nil {
					return e
				}
				if _, nested := v.(json.Delim); nested {
					return errors.New("nested value")
				}
			}
		}
		_, e = d.Token()
		return e
	}
	if object(0) != nil || decode(raw, &q) != nil {
		return q, errors.New("phone_pool_request_invalid")
	}
	return q, nil
}

// The socket lives in a root-owned directory mounted only into the Node Agent.
// There is no TCP listener, arbitrary path field or raw command endpoint.
func Serve(ctx context.Context, p *Pool, path string) error {
	if p == nil || !filepath.IsAbs(path) || filepath.Base(path) != "storage.sock" || !privatePath(filepath.Dir(path)) {
		return errors.New("phone_pool_socket_invalid")
	}
	parent, err := os.Stat(filepath.Dir(path))
	if err != nil || parent.Mode().Perm()&0007 != 0 {
		return errors.New("phone_pool_socket_invalid")
	}
	if _, err = os.Lstat(path); !os.IsNotExist(err) {
		return errors.New("phone_pool_socket_exists")
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return err
	}
	defer listener.Close()
	if os.Chown(path, 0, int(p.config.ClientUID)) != nil || os.Chmod(path, 0660) != nil {
		return errors.New("phone_pool_socket_permissions")
	}
	stop := context.AfterFunc(ctx, func() { listener.Close() })
	defer stop()
	var wg sync.WaitGroup
	defer wg.Wait()
	slots := make(chan struct{}, 4)
	for {
		connection, e := listener.AcceptUnix()
		if e != nil {
			if ctx.Err() != nil {
				return nil
			}
			return e
		}
		select {
		case slots <- struct{}{}:
		default:
			connection.Close()
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			defer connection.Close()
			if !peerUID(connection, p.config.ClientUID) {
				return
			}
			_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
			raw, e := bufio.NewReader(io.LimitReader(connection, 2049)).ReadBytes('\n')
			if e != nil {
				return
			}
			q, e := DecodeRequest(raw)
			var value Result
			if e == nil {
				value, e = p.Handle(q)
			}
			out := reply{Result: &value}
			if e != nil {
				out = reply{Error: "phone_storage_unavailable"}
				if stringsSafeError(e.Error()) {
					out.Error = e.Error()
				}
			}
			_ = json.NewEncoder(connection).Encode(out)
		}()
	}
}
func stringsSafeError(s string) bool {
	if len(s) > 80 || !(strings.HasPrefix(s, "phone_") || strings.HasPrefix(s, "computer_")) {
		return false
	}
	for _, c := range s {
		if c != '_' && (c < 'a' || c > 'z') {
			return false
		}
	}
	return true
}

type Client struct{ Socket string }

func (c Client) Handle(ctx context.Context, q Request) (Result, error) {
	var empty Result
	if !filepath.IsAbs(c.Socket) || filepath.Base(c.Socket) != "storage.sock" {
		return empty, errors.New("phone_pool_socket_invalid")
	}
	dialer := net.Dialer{Timeout: 5 * time.Second}
	connection, err := dialer.DialContext(ctx, "unix", c.Socket)
	if err != nil {
		return empty, errors.New("phone_storage_unavailable")
	}
	defer connection.Close()
	end := time.Now().Add(10 * time.Second)
	if until, ok := ctx.Deadline(); ok && until.Before(end) {
		end = until
	}
	_ = connection.SetDeadline(end)
	stop := context.AfterFunc(ctx, func() { connection.Close() })
	defer stop()
	if err = json.NewEncoder(connection).Encode(q); err != nil {
		return empty, err
	}
	limit := 4096
	if q.Action == "computer-pool-status" {
		limit = 1 << 20
	}
	raw, err := bufio.NewReader(io.LimitReader(connection, int64(limit+1))).ReadBytes('\n')
	if err != nil || len(raw) > limit {
		return empty, errors.New("phone_pool_reply_invalid")
	}
	var out reply
	if decode(raw, &out) != nil {
		return empty, errors.New("phone_pool_reply_invalid")
	}
	if out.Error != "" {
		if out.Result != nil || !stringsSafeError(out.Error) {
			return empty, errors.New("phone_pool_reply_invalid")
		}
		return empty, errors.New(out.Error)
	}
	if q.Action == "pool-status" {
		if out.Result == nil || !validObservation(out.Result.Pool, q.Identity.PoolID) ||
			*out.Result != (Result{Pool: out.Result.Pool}) {
			return empty, errors.New("phone_pool_reply_invalid")
		}
		return *out.Result, nil
	}
	if q.Action == "computer-pool-status" {
		if out.Result == nil || !validComputerObservation(out.Result.ComputerPool, q.Identity.PoolID) || *out.Result != (Result{ComputerPool: out.Result.ComputerPool}) {
			return empty, errors.New("computer_storage_reply_invalid")
		}
		return *out.Result, nil
	}
	if q.Computer != nil {
		if strings.HasPrefix(q.Action, "computer-media-") {
			if out.Result == nil || out.Result.Computer == nil || *out.Result.Computer != *q.Computer || !out.Result.Media ||
				out.Result.Identity != (agent.PhoneIdentity{}) || out.Result.Pool != nil || out.Result.ComputerPool != nil ||
				out.Result.ProjectID < 100000 || out.Result.QuotaBytes < mediaDirectoryOverhead || out.Result.QuotaBytes >= 1<<53 || out.Result.QuotaBytes%1024 != 0 ||
				(q.Action == "computer-media-delete" && !out.Result.Deleted) || (q.Action == "computer-media-prepare" && out.Result.Deleted) {
				return empty, errors.New("computer_media_storage_reply_invalid")
			}
			return *out.Result, nil
		}
		if !strings.HasPrefix(q.Action, "computer-") || out.Result == nil || out.Result.Computer == nil ||
			*out.Result.Computer != *q.Computer || out.Result.Media || out.Result.Identity != (agent.PhoneIdentity{}) || out.Result.Pool != nil || out.Result.ComputerPool != nil ||
			out.Result.ProjectID < 100000 || out.Result.QuotaBytes <= q.Computer.DiskBytes || out.Result.QuotaBytes >= 1<<53 || out.Result.QuotaBytes%1024 != 0 ||
			q.Action != "computer-inspect" && out.Result.Deleted != (q.Action == "computer-delete") {
			return empty, errors.New("computer_storage_reply_invalid")
		}
		return *out.Result, nil
	}
	if out.Result == nil || out.Result.Media || out.Result.Computer != nil || out.Result.Pool != nil || out.Result.ComputerPool != nil || out.Result.Identity != q.Identity || out.Result.ProjectID < 100000 || out.Result.QuotaBytes != 16<<30 || out.Result.Deleted != (q.Action == "delete") {
		return empty, errors.New("phone_pool_reply_invalid")
	}
	return *out.Result, nil
}
