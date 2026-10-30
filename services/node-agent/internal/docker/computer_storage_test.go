package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
	"teamaibox.local/node-agent/internal/phonepool"
)

type computerStorageFixture struct {
	calls []phonepool.Request
	alter func(*phonepool.Result)
}

func (s *computerStorageFixture) Handle(_ context.Context, q phonepool.Request) (phonepool.Result, error) {
	s.calls = append(s.calls, q)
	i := *q.Computer
	r := phonepool.Result{Computer: &i, ProjectID: 100000, QuotaBytes: i.DiskBytes + 2<<30, Deleted: q.Action == "computer-delete"}
	if s.alter != nil {
		s.alter(&r)
	}
	return r, nil
}

func computerStorageTest(t *testing.T) (*InstalledComputerStorage, *computerStorageFixture, agent.ComputerCommand, *phoneEngineState) {
	t.Helper()
	p, _, state := computerFixture(t)
	state.State.Status = "exited"
	state.State.Running = false
	f := &computerStorageFixture{}
	engine := &EngineRuntime{baseURL: "http://docker/v1.48", client: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodGet {
			t.Fatal("storage must not stop/kill Docker containers")
		}
		var raw []byte
		if strings.HasSuffix(req.URL.Path, "/containers/json") {
			raw, _ = json.Marshal([]map[string]string{{"Id": state.ID}})
		} else {
			raw, _ = json.Marshal(state)
		}
		return response(http.StatusOK, string(raw)), nil
	})}}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s, err := newComputerStorage(p.NodeID, p.PoolID, root, f, engine)
	if err != nil {
		t.Fatal(err)
	}
	return s, f, p, &state
}

func TestInstalledComputerStorageUsesSelectedDiskAndStableIdentity(t *testing.T) {
	s, f, p, _ := computerStorageTest(t)
	p.Resources.DiskBytes = 128 << 30
	v, err := s.Prepare(context.Background(), p)
	if err != nil || v.QuotaBytes != 130<<30 || len(f.calls) != 1 {
		t.Fatalf("%+v %v", v, err)
	}
	i := f.calls[0].Computer
	if i.ComputerID != p.ComputerID || i.OwnerID != p.OwnerID || i.NodeID != p.NodeID || i.FirmwareID != p.FirmwareID || i.DiskBytes != 128<<30 || v.GuestDirectory != filepath.Join(s.dataRoot, p.VolumeID, "guest") {
		t.Fatal("wrong allocation identity")
	}
}

func TestInstalledComputerStorageRejectsBadReplies(t *testing.T) {
	for _, fault := range []string{"missing", "owner", "disk", "quota", "deleted", "phone"} {
		t.Run(fault, func(t *testing.T) {
			s, f, p, _ := computerStorageTest(t)
			f.alter = func(r *phonepool.Result) {
				switch fault {
				case "missing":
					r.Computer = nil
				case "owner":
					r.Computer.OwnerID = "foreign"
				case "disk":
					r.Computer.DiskBytes++
				case "quota":
					r.QuotaBytes = 16 << 30
				case "deleted":
					r.Deleted = true
				case "phone":
					r.Identity.PhoneID = p.ComputerID
				}
			}
			if _, err := s.Inspect(context.Background(), p); err == nil {
				t.Fatal("invalid response accepted")
			}
		})
	}
}

func TestInstalledComputerStorageDeleteChecksActualContainer(t *testing.T) {
	for _, fault := range []string{"running", "restarting", "foreign", "unreachable", "stopped"} {
		t.Run(fault, func(t *testing.T) {
			s, f, p, state := computerStorageTest(t)
			switch fault {
			case "running":
				state.State.Status = "running"
				state.State.Running = true
			case "restarting":
				state.State.Status = "restarting"
			case "foreign":
				state.Config["Labels"].(map[string]any)["com.teamaibox.owner-identity-id"] = "foreign"
			case "unreachable":
				s.engine.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("offline") })
			}
			v, err := s.Delete(context.Background(), p)
			if fault == "stopped" {
				if err != nil || !v.Deleted || len(f.calls) != 1 {
					t.Fatalf("%+v %v", v, err)
				}
			} else if err == nil || len(f.calls) != 0 {
				t.Fatal("deleted active/uncertain/foreign disk")
			}
		})
	}
}

func TestInstalledComputerStorageCancelAndWrongNodeHaveNoEffects(t *testing.T) {
	s, f, p, _ := computerStorageTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.Prepare(ctx, p); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	p.NodeID = "70000000-0000-4000-8000-000000000001"
	if _, err := s.Prepare(context.Background(), p); err == nil || len(f.calls) != 0 {
		t.Fatal("wrong node allocated")
	}
}
