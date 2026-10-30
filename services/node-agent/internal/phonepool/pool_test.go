package phonepool

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

type kernelFixture struct {
	available uint64
	broken    bool
	projects  map[string]uint32
	quotas    map[uint32]uint64
	used      map[uint32]uint64
}

func (k *kernelFixture) verify(Config) (uint64, error) {
	if k.broken {
		return 0, errors.New("locked")
	}
	return k.available, nil
}
func (k *kernelFixture) project(f *os.File, id uint32, set bool) error {
	if set {
		k.projects[f.Name()] = id
	}
	if !set && k.projects[f.Name()] != id && k.projects[filepath.Dir(f.Name())] != id {
		return errors.New("project mismatch")
	}
	return nil
}
func (k *kernelFixture) quota(_ *os.File, id uint32, set, clear bool) (uint64, error) {
	if set {
		k.quotas[id] = 16 << 30
	}
	if clear {
		if k.used[id] != 0 {
			return 0, errors.New("used")
		}
		delete(k.quotas, id)
		return 0, nil
	}
	if k.quotas[id] != 16<<30 {
		return 0, errors.New("quota missing")
	}
	return k.used[id], nil
}
func (k *kernelFixture) ownership(*os.Root, string, uint32, os.FileMode) error { return nil }
func (k *kernelFixture) lock(*os.File) error                                   { return nil }
func fixture(t *testing.T) (*Pool, *kernelFixture, Request) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := Config{PoolID: "phone.pool", Root: root, LUKSUUID: "10000000-0000-4000-8000-000000000001", FilesystemUUID: "10000000-0000-4000-8000-000000000002", ClientUID: 10001}
	k := &kernelFixture{available: 60 << 30, projects: map[string]uint32{}, quotas: map[uint32]uint64{}, used: map[uint32]uint64{}}
	p, err := newPool(c, k)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p, k, Request{Action: "prepare", Identity: agent.PhoneIdentity{PhoneID: "20000000-0000-4000-8000-000000000001", OwnerID: "20000000-0000-4000-8000-000000000002", VolumeID: "20000000-0000-4000-8000-000000000003", PoolID: c.PoolID, BaseBuildID: agent.PhoneBaseBuild}}
}
func TestPoolSamePhoneRetryDoesNotDuplicateQuota(t *testing.T) {
	p, k, q := fixture(t)
	first, e := p.Handle(q)
	if e != nil {
		t.Fatal(e)
	}
	again, e := p.Handle(q)
	if e != nil || again != first || len(k.quotas) != 1 {
		t.Fatalf("%+v %v", again, e)
	}
}

func TestPoolHistoricalDeletionsDoNotExhaustPhoneCapacity(t *testing.T) {
	p, _, q := fixture(t)
	j, err := p.read()
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 16000; i++ {
		identity := q.Identity
		identity.PhoneID = fmt.Sprintf("30000000-0000-4000-8000-%012x", i)
		identity.VolumeID = identity.PhoneID
		j.Volumes[identity.VolumeID] = record{Identity: identity, ProjectID: j.NextProject, Phase: "deleted"}
		j.NextProject++
	}
	if err = p.write(j); err != nil {
		t.Fatal(err)
	}
	info, err := p.root.Stat("storage-state/allocations.json")
	if err != nil || info.Size() <= 4<<20 {
		t.Fatalf("large journal fixture: %v %v", info, err)
	}
	if _, err = p.Handle(q); err != nil {
		t.Fatal(err)
	}
	got, err := p.read()
	if err != nil || len(got.Volumes) != 16001 {
		t.Fatalf("history lost: %d %v", len(got.Volumes), err)
	}
	if _, err = p.Handle(q); err != nil {
		t.Fatal("retry must remain idempotent", err)
	}
}

func TestPoolProjectIDExhaustionDoesNotWrap(t *testing.T) {
	p, _, q := fixture(t)
	j, err := p.read()
	if err != nil {
		t.Fatal(err)
	}
	j.NextProject = math.MaxUint32
	if err = p.write(j); err != nil {
		t.Fatal(err)
	}
	if _, err = p.Handle(q); err == nil || err.Error() != "phone_storage_project_ids_exhausted" {
		t.Fatalf("%v", err)
	}
	got, err := p.read()
	if err != nil || got.NextProject != math.MaxUint32 || len(got.Volumes) != 0 {
		t.Fatal("exhaustion changed journal")
	}
}
func TestPoolDoesNotBookOtherPhonesLogicalDiskGrowth(t *testing.T) {
	p, _, q := fixture(t)
	for _, id := range []string{"3", "4", "5"} {
		q.Identity.VolumeID = "20000000-0000-4000-8000-00000000000" + id
		q.Identity.PhoneID = q.Identity.VolumeID
		if _, e := p.Handle(q); e != nil {
			t.Fatal(e)
		}
	}
	q.Identity.VolumeID = "20000000-0000-4000-8000-000000000006"
	q.Identity.PhoneID = q.Identity.VolumeID
	if _, e := p.Handle(q); e != nil {
		t.Fatal("future disk growth blocked creation", e)
	}
}
func TestPoolRejectsLockedMountAndForeignBinding(t *testing.T) {
	p, k, q := fixture(t)
	if _, e := p.Handle(q); e != nil {
		t.Fatal(e)
	}
	q.Identity.OwnerID = "20000000-0000-4000-8000-000000000007"
	if _, e := p.Handle(q); e == nil {
		t.Fatal("foreign owner")
	}
	k.broken = true
	if _, e := p.Handle(q); e == nil {
		t.Fatal("locked")
	}
}
func TestPoolDeletionRetiresOnlyExactDataAndCannotResurrect(t *testing.T) {
	p, k, q := fixture(t)
	if _, e := p.Handle(q); e != nil {
		t.Fatal(e)
	}
	other := q
	other.Identity.VolumeID = "20000000-0000-4000-8000-000000000004"
	other.Identity.PhoneID = "20000000-0000-4000-8000-000000000005"
	if _, e := p.Handle(other); e != nil {
		t.Fatal(e)
	}
	target := "volumes/" + other.Identity.VolumeID + "/phone/saved"
	if e := p.root.WriteFile(target, []byte("retained"), 0600); e != nil {
		t.Fatal(e)
	}
	q.Action = "delete"
	result, e := p.Handle(q)
	if e != nil || !result.Deleted || len(k.quotas) != 1 {
		t.Fatalf("%+v %v", result, e)
	}
	raw, _ := p.root.ReadFile(target)
	if string(raw) != "retained" {
		t.Fatal("other phone lost")
	}
	if _, e = p.Handle(q); e != nil {
		t.Fatal(e)
	}
	q.Action = "prepare"
	if _, e = p.Handle(q); e == nil {
		t.Fatal("revived deleted phone")
	}
}
func TestPoolDeletionNeverTraversesSymlink(t *testing.T) {
	p, _, q := fixture(t)
	if _, e := p.Handle(q); e != nil {
		t.Fatal(e)
	}
	outside := t.TempDir()
	saved := filepath.Join(outside, "saved")
	if e := os.WriteFile(saved, []byte("retained"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := p.root.Symlink(outside, "volumes/"+q.Identity.VolumeID+"/phone/escape"); e != nil {
		t.Fatal(e)
	}
	q.Action = "delete"
	if _, e := p.Handle(q); e != nil {
		t.Fatal(e)
	}
	if raw, _ := os.ReadFile(saved); string(raw) != "retained" {
		t.Fatal("traversed symlink")
	}
}
func TestPoolFailedDeleteKeepsReservationAndRetries(t *testing.T) {
	p, k, q := fixture(t)
	r, e := p.Handle(q)
	if e != nil {
		t.Fatal(e)
	}
	k.used[r.ProjectID] = 4096
	q.Action = "delete"
	if _, e = p.Handle(q); e == nil {
		t.Fatal("released used quota")
	}
	j, e := p.read()
	if e != nil || j.Volumes[q.Identity.VolumeID].Phase != "deleting" {
		t.Fatal(e)
	}
	k.used[r.ProjectID] = 0
	if _, e = p.Handle(q); e != nil {
		t.Fatal(e)
	}
}
func TestPoolRejectsUnknownDataBeforeAdoption(t *testing.T) {
	p, _, q := fixture(t)
	if e := p.root.Mkdir("volumes/"+q.Identity.VolumeID, 0700); e != nil {
		t.Fatal(e)
	}
	if _, e := p.Handle(q); e == nil {
		t.Fatal("adopted unowned directory")
	}
}
func TestPoolReopensJournalRetainsProjectAndData(t *testing.T) {
	p, k, q := fixture(t)
	first, e := p.Handle(q)
	if e != nil {
		t.Fatal(e)
	}
	same, e := newPool(p.config, k)
	if e != nil {
		t.Fatal(e)
	}
	defer same.Close()
	q.Action = "inspect"
	got, e := same.Handle(q)
	if e != nil || got != first {
		t.Fatalf("%+v %v", got, e)
	}
}
func TestPoolClosedInputRejectsDuplicateAndPaths(t *testing.T) {
	for _, raw := range []string{`{"action":"inspect","action":"delete","identity":{}}`, `{"action":"prepare","path":"/etc","identity":{}}`, `{"action":"prepare","identity":{"ownerId":"a","ownerId":"b"}}`, strings.Repeat(" ", 2049), `[]`, `{} {}`} {
		if _, e := DecodeRequest([]byte(raw)); e == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	p, _, q := fixture(t)
	q.Identity.VolumeID = "../other"
	if _, e := p.Handle(q); e == nil {
		t.Fatal("accepted traversal")
	}
}
