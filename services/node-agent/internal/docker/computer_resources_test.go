package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type computerMemoryFixture struct {
	available uint64
	swap      bool
}

func (m *computerMemoryFixture) PhoneMemorySamples(context.Context) ([]agent.PhoneMemorySample, error) {
	samples := []agent.PhoneMemorySample{}
	now := time.Now()
	for i := 0; i < 16; i++ {
		swap := uint64(0)
		if m.swap {
			swap = uint64(i) * 4096
		}
		samples = append(samples, agent.PhoneMemorySample{ObservedAt: now.Add(time.Duration(i-15) * 2 * time.Second).Format(time.RFC3339Nano), AvailableBytes: m.available, SwapOutBytes: swap})
	}
	return samples, nil
}
func writeComputerIdentityFixture(t *testing.T, p agent.ComputerCommand, profile ComputerRuntimeProfile, guest string) {
	t.Helper()
	if err := os.MkdirAll(guest, 0700); err != nil {
		t.Fatal(err)
	}
	c, err := buildComputerRuntimeConfig(p, profile)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(c)
	var identity map[string]any
	_ = json.Unmarshal(raw, &identity)
	for _, k := range []string{"runId", "generation", "runtimeImage", "shutdownSeconds"} {
		delete(identity, k)
	}
	raw, _ = json.Marshal(map[string]any{"phase": "ready", "identity": identity})
	if err = os.WriteFile(filepath.Join(guest, "identity.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"system.qcow2", "VARS.fd"} {
		if err = os.WriteFile(filepath.Join(guest, name), []byte("synthetic fixture only"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if p.TPMID != nil {
		if err = os.Mkdir(filepath.Join(guest, "tpm"), 0700); err != nil {
			t.Fatal(err)
		}
	}
}
func computerResourcesFixture(t *testing.T) (*InstalledComputerResources, agent.ComputerCommand, *computerMemoryFixture, map[string]phoneEngineState) {
	t.Helper()
	storage, _, p, _ := computerStorageTest(t)
	profile := installedComputerProfile()
	p.ProfileID = profile.ProfileID
	p.RuntimeImage = profile.RuntimeImage
	p.Run.RuntimeImage = p.RuntimeImage
	p.Allocation = &agent.ComputerAllocation{MemoryBytes: 10 << 30, CPUIds: []int{0, 1, 2, 3}}
	control, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	policy := ComputerResourcePolicy{ControlRoot: control, Profiles: []InstalledComputerProfile{{ComputerRuntimeProfile: profile, FirmwareDirectory: "/opt/windows/firmware", MediaDirectory: "/opt/windows/media"}}, CPUGroups: [][]int{{0, 1, 2, 3, 4, 5, 6, 7}, {10, 11, 12, 13}}, KVMGroup: 108, ProvisionMemoryBytes: 512 << 20}
	memory := &computerMemoryFixture{available: 40 << 30}
	resources, e := NewInstalledComputerResources(policy, storage, memory)
	if e != nil {
		t.Fatal(e)
	}
	resources.chown = func(string, int, int) error { return nil }
	t.Cleanup(func() { resources.Close() })
	writeComputerIdentityFixture(t, p, profile, filepath.Join(storage.dataRoot, p.VolumeID, "guest"))
	networks := map[string]phoneNetworkState{}
	networkSerial := 0
	states := map[string]phoneEngineState{}
	storage.engine.client.Transport = roundTripFunc(func(q *http.Request) (*http.Response, error) {
		path := strings.TrimPrefix(q.URL.Path, "/v1.48")
		if q.Method == "POST" && path == "/networks/create" {
			var n phoneNetworkState
			if json.NewDecoder(q.Body).Decode(&n) != nil {
				t.Fatal("bad network")
			}
			n.ID = strings.Repeat("b", 63) + string("0123456789abcdef"[networkSerial%16])
			networkSerial++
			n.Scope = "local"
			networks[n.ID] = n
			networks[n.Name] = n
			raw, _ := json.Marshal(map[string]string{"Id": n.ID})
			return response(201, string(raw)), nil
		}
		if strings.HasPrefix(path, "/networks/") {
			n, ok := networks[strings.TrimPrefix(path, "/networks/")]
			if !ok {
				return response(404, "{}"), nil
			}
			if q.Method == http.MethodDelete {
				delete(networks, n.ID)
				delete(networks, n.Name)
				return response(204, ""), nil
			}
			raw, _ := json.Marshal(n)
			return response(200, string(raw)), nil
		}
		if strings.HasPrefix(path, "/containers/") && strings.HasSuffix(path, "/json") {
			key := strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/json")
			s, ok := states[key]
			if !ok {
				return response(404, "{}"), nil
			}
			raw, _ := json.Marshal(s)
			return response(200, string(raw)), nil
		}
		if strings.HasSuffix(path, "/stats") {
			return response(200, `{"memory_stats":{"usage":8589934592,"stats":{"inactive_file":0}}}`), nil
		}
		t.Fatalf("unexpected Docker operation %s %s", q.Method, path)
		return nil, nil
	})
	return resources, p, memory, states
}
func TestComputerResourceBindingSurvivesAgentReopenAndUsesCommittedResources(t *testing.T) {
	r, p, _, _ := computerResourcesFixture(t)
	ctx := context.Background()
	b, e := r.BindComputerRun(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	if b.MemoryBytes != p.Allocation.MemoryBytes || !reflect.DeepEqual(b.CPUIds, p.Allocation.CPUIds) {
		t.Fatal("allocation changed")
	}
	config := filepath.Join(b.ConfigDirectory, "config.json")
	before, e := os.Stat(config)
	if e != nil {
		t.Fatal(e)
	}
	if before.Mode().Perm() != 0444 {
		t.Fatal("runtime cannot read configuration")
	}
	r.Close()
	r2, e := NewInstalledComputerResources(r.policy, r.storage, r.memory)
	if e != nil {
		t.Fatal(e)
	}
	defer r2.Close()
	r2.chown = r.chown
	p.OperationID = "11111111-1111-4111-8111-111111111119"
	p.Allocation = nil
	resolved, e := r2.ResolveComputerRun(ctx, p)
	if e != nil || !reflect.DeepEqual(b, resolved) {
		t.Fatalf("reopen: %+v %v", resolved, e)
	}
	after, _ := os.Stat(config)
	if !os.SameFile(before, after) {
		t.Fatal("replaced configuration")
	}
	if e = r2.RequestComputerShutdown(ctx, p); e != nil {
		t.Fatal(e)
	}
	request := filepath.Join(b.ControlDirectory, "shutdown.json")
	i, _ := os.Stat(request)
	if i.Mode().Perm() != 0644 {
		t.Fatal("runtime cannot read shutdown")
	}
	var got map[string]any
	raw, _ := os.ReadFile(request)
	_ = json.Unmarshal(raw, &got)
	if len(got) != 3 || got["runId"] != p.Run.ID {
		t.Fatal("wrong shutdown")
	}
}
func TestComputerResourceBindingRejectsChangedReservationAndUnreadableIdentity(t *testing.T) {
	for _, fault := range []string{"cpu", "memory", "owner", "disk", "marker", "symlink"} {
		t.Run(fault, func(t *testing.T) {
			r, p, _, _ := computerResourcesFixture(t)
			ctx := context.Background()
			b, e := r.BindComputerRun(ctx, p)
			if e != nil {
				t.Fatal(e)
			}
			switch fault {
			case "cpu":
				p.Allocation.CPUIds = []int{4, 5, 6, 7}
			case "memory":
				p.Allocation.MemoryBytes++
			case "owner":
				p.OwnerID = "11111111-1111-4111-8111-111111111119"
			case "disk":
				p.Resources.DiskBytes += 512
			case "marker":
				_ = os.WriteFile(filepath.Join(b.GuestDirectory, "identity.json"), []byte(`{}`), 0600)
			case "symlink":
				path := filepath.Join(b.GuestDirectory, "system.qcow2")
				_ = os.Remove(path)
				_ = os.Symlink("VARS.fd", path)
			}
			if _, e = r.BindComputerRun(ctx, p); e == nil {
				t.Fatal("changed binding accepted")
			}
		})
	}
}

func TestComputerHistoricalRunSurvivesRuntimeMaintenance(t *testing.T) {
	r, p, _, _ := computerResourcesFixture(t)
	ctx := context.Background()
	before, err := r.BindComputerRun(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	r.policy.Profiles[0].RuntimeImage = "sha256:" + strings.Repeat("f", 64)
	after, err := r.ResolveComputerRun(ctx, p)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("old run binding lost: %v", err)
	}
	if err := r.RequestComputerShutdown(ctx, p); err != nil {
		t.Fatal(err)
	}
	q := p
	q.RuntimeImage = r.policy.Profiles[0].RuntimeImage
	if _, err := r.ResolveComputerRun(ctx, q); err == nil {
		t.Fatal("rewrote old run image")
	}
}
func TestComputerResourceBindingRejectsInvalidCPUConfiguration(t *testing.T) {
	for _, fault := range []string{"missing", "mixed", "duplicate"} {
		t.Run(fault, func(t *testing.T) {
			r, p, _, _ := computerResourcesFixture(t)
			switch fault {
			case "missing":
				p.Allocation = nil
			case "mixed":
				p.Allocation.CPUIds = []int{0, 1, 10, 11}
			case "duplicate":
				p.Allocation.CPUIds = []int{0, 0, 1, 2}
			}
			if _, e := r.BindComputerRun(context.Background(), p); e == nil {
				t.Fatal("bad admission accepted")
			}
			if _, e := os.Stat(filepath.Join(r.policy.ControlRoot, "runs", p.Run.ID)); !os.IsNotExist(e) {
				t.Fatal("created a run before admission")
			}
		})
	}
}
func TestComputerResourceStatusIsBoundToExactRun(t *testing.T) {
	r, p, _, _ := computerResourcesFixture(t)
	ctx := context.Background()
	b, e := r.BindComputerRun(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	s := ComputerRuntimeStatus{ComputerID: p.ComputerID, OwnerID: p.OwnerID, NodeID: p.NodeID, VolumeID: p.VolumeID, FirmwareID: p.FirmwareID, TPMID: p.TPMID, RunID: p.Run.ID, Generation: p.Generation, RuntimeImage: p.RuntimeImage, Phase: "running", UpdatedAtUnixMs: time.Now().UnixMilli()}
	raw, _ := json.Marshal(s)
	_ = os.WriteFile(filepath.Join(b.ControlDirectory, "status.json"), raw, 0600)
	got, e := r.ReadComputerStatus(ctx, p)
	if e != nil || !got.matches(p) {
		t.Fatal(e)
	}
	s.Generation++
	raw, _ = json.Marshal(s)
	_ = os.WriteFile(filepath.Join(b.ControlDirectory, "status.json"), raw, 0600)
	if _, e = r.ReadComputerStatus(ctx, p); e == nil {
		t.Fatal("old run status accepted")
	}
}
func TestDifferentComputersShareCPUsWithoutAdvanceMemoryBooking(t *testing.T) {
	for _, fault := range []string{"cpu", "memory", "distinct"} {
		t.Run(fault, func(t *testing.T) {
			r, p, m, _ := computerResourcesFixture(t)
			ctx := context.Background()
			if _, e := r.BindComputerRun(ctx, p); e != nil {
				t.Fatal(e)
			}
			p.ComputerID = "21111111-1111-4111-8111-111111111111"
			p.VolumeID = "21111111-1111-4111-8111-111111111114"
			p.Run.ID = "21111111-1111-4111-8111-111111111118"
			if fault != "cpu" {
				p.Allocation.CPUIds = []int{4, 5, 6, 7}
			}
			if fault == "memory" {
				m.available = 27 << 30
			}
			profile, _ := r.profile(p)
			writeComputerIdentityFixture(t, p, profile.ComputerRuntimeProfile, filepath.Join(r.storage.dataRoot, p.VolumeID, "guest"))
			_, e := r.BindComputerRun(ctx, p)
			if e != nil {
				t.Fatalf("%s: %v", fault, e)
			}
		})
	}
}
