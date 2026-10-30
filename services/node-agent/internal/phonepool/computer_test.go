package phonepool

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type computerKernelFixture struct {
	*kernelFixture
	busy bool
}

func (k *computerKernelFixture) computerQuota(_ *os.File, id uint32, bytes uint64, set, clear bool) (uint64, error) {
	if set {
		if old := k.quotas[id]; old != 0 && old != bytes {
			return 0, errors.New("quota changed")
		}
		k.quotas[id] = bytes
	}
	if clear {
		if k.used[id] != 0 {
			return 0, errors.New("used")
		}
		delete(k.quotas, id)
		return 0, nil
	}
	if k.quotas[id] != bytes {
		return 0, errors.New("quota missing")
	}
	return k.used[id], nil
}

func (k *computerKernelFixture) lock(*os.File) error {
	if k.busy {
		return errors.New("locked")
	}
	return nil
}

func computerFixture(t *testing.T) (*Pool, *computerKernelFixture, Request) {
	t.Helper()
	p, old, _ := fixture(t)
	k := &computerKernelFixture{kernelFixture: old}
	p.kernel = k
	p.config.ComputerOverheadBytes = 2 << 30
	k.available = 256 << 30
	q := Request{Action: "computer-prepare", Computer: &ComputerVolumeIdentity{
		ComputerID: "30000000-0000-4000-8000-000000000001", OwnerID: "30000000-0000-4000-8000-000000000002",
		NodeID: "30000000-0000-4000-8000-000000000003", VolumeID: "30000000-0000-4000-8000-000000000004",
		FirmwareID: "30000000-0000-4000-8000-000000000005", TPMID: "30000000-0000-4000-8000-000000000006",
		PoolID: p.config.PoolID, ProfileID: "windows-11-arm64", DiskBytes: 96 << 30}}
	return p, k, q
}

func TestComputerPoolRetryKeepsDataIdentityAndSelectedSize(t *testing.T) {
	p, k, q := computerFixture(t)
	first, err := p.Handle(q)
	if err != nil || first.QuotaBytes != 98<<30 {
		t.Fatalf("%+v %v", first, err)
	}
	path := filepath.Join(p.config.Root, "volumes", q.Computer.VolumeID, "guest", "system.qcow2")
	if err = os.WriteFile(path, []byte("original guest"), 0600); err != nil {
		t.Fatal(err)
	}
	// Reopening the helper and even changing future-allocation policy must not
	// resize, replace or wipe an already allocated computer.
	p.Close()
	c := p.config
	c.ComputerOverheadBytes = 4 << 30
	other, err := newPool(c, k)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	again, err := other.Handle(q)
	if err != nil || !reflect.DeepEqual(first, again) || len(k.quotas) != 1 {
		t.Fatalf("%+v %v", again, err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "original guest" {
		t.Fatal("guest changed")
	}
}

func TestComputerPoolNoWindowsAllocationUnlessInstalled(t *testing.T) {
	p, k, q := computerFixture(t)
	p.config.ComputerOverheadBytes = 0
	if _, err := p.Handle(q); err == nil || len(k.quotas) != 0 {
		t.Fatal("allocated without policy")
	}
}

func TestComputerPoolRejectsIdentityAndDiskChanges(t *testing.T) {
	for _, field := range []string{"owner", "computer", "node", "firmware", "tpm", "profile", "disk"} {
		t.Run(field, func(t *testing.T) {
			p, _, q := computerFixture(t)
			if _, err := p.Handle(q); err != nil {
				t.Fatal(err)
			}
			bad := *q.Computer
			switch field {
			case "owner":
				bad.OwnerID = "40000000-0000-4000-8000-000000000001"
			case "computer":
				bad.ComputerID = "40000000-0000-4000-8000-000000000001"
			case "node":
				bad.NodeID = "40000000-0000-4000-8000-000000000001"
			case "firmware":
				bad.FirmwareID = "40000000-0000-4000-8000-000000000001"
			case "tpm":
				bad.TPMID = ""
			case "profile":
				bad.ProfileID = "windows-10-arm64"
			case "disk":
				bad.DiskBytes = 128 << 30
			}
			q.Computer = &bad
			if _, err := p.Handle(q); err == nil {
				t.Fatal("changed binding")
			}
		})
	}
}

func TestComputerAndAndroidDoNotPrebookEachOthersGrowth(t *testing.T) {
	for _, firstComputer := range []bool{true, false} {
		t.Run(map[bool]string{true: "computer-first", false: "phone-first"}[firstComputer], func(t *testing.T) {
			p, k, q := computerFixture(t)
			_, _, phone := fixture(t)
			phone.Identity.PoolID = p.config.PoolID
			k.available = 120 << 30 // Physical free bytes, regardless of logical maxima.
			first, second := q, phone
			if !firstComputer {
				first, second = phone, q
			}
			if _, err := p.Handle(first); err != nil {
				t.Fatal(err)
			}
			if _, err := p.Handle(second); err != nil {
				t.Fatal("speculative allocation blocked creation", err)
			}
			if len(k.quotas) != 2 {
				t.Fatal("missing independent project isolation")
			}
		})
	}
}

func TestComputerPoolCountsOnlyUnwrittenCommitment(t *testing.T) {
	p, k, q := computerFixture(t)
	r, err := p.Handle(q)
	if err != nil {
		t.Fatal(err)
	}
	k.used[r.ProjectID] = 90 << 30
	k.available = 130 << 30
	second := *q.Computer
	second.VolumeID = "50000000-0000-4000-8000-000000000001"
	second.ComputerID = "50000000-0000-4000-8000-000000000002"
	q.Computer = &second
	if _, err = p.Handle(q); err != nil {
		t.Fatal("double counted written bytes", err)
	}
}

func TestComputerPoolDeletionKeepsOtherVolumesAndPreventsRecreation(t *testing.T) {
	p, k, q := computerFixture(t)
	_, _, phone := fixture(t)
	phone.Identity.PoolID = p.config.PoolID
	if _, err := p.Handle(phone); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Handle(q); err != nil {
		t.Fatal(err)
	}
	q.Action = "computer-delete"
	r, err := p.Handle(q)
	if err != nil || !r.Deleted {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err = p.Handle(q); err != nil {
		t.Fatal(err)
	}
	if len(k.quotas) != 1 {
		t.Fatal("deleted other allocation")
	}
	q.Action = "computer-inspect"
	if observed, e := p.Handle(q); e != nil || !observed.Deleted {
		t.Fatalf("read-only tombstone: %+v %v", observed, e)
	}
	phone.Action = "inspect"
	if _, err = p.Handle(phone); err != nil {
		t.Fatal(err)
	}
	q.Action = "computer-prepare"
	if _, err = p.Handle(q); err == nil {
		t.Fatal("recreated deleted disk")
	}
}

func TestComputerPoolCannotDeleteRunningOrUnreleasedDisk(t *testing.T) {
	for _, busy := range []bool{true, false} {
		t.Run(map[bool]string{true: "running", false: "open-data"}[busy], func(t *testing.T) {
			p, k, q := computerFixture(t)
			r, err := p.Handle(q)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(p.config.Root, "volumes", q.Computer.VolumeID, "guest", "runtime.lock")
			if err = os.WriteFile(path, nil, 0600); err != nil {
				t.Fatal(err)
			}
			k.busy = busy
			if !busy {
				k.used[r.ProjectID] = 4096
			}
			q.Action = "computer-delete"
			if _, err = p.Handle(q); err == nil {
				t.Fatal("false deletion")
			}
			j, err := p.read()
			if err != nil || j.Computers[q.Computer.VolumeID].Phase == "deleted" {
				t.Fatal("false completion", err)
			}
			if busy {
				if _, err = os.Stat(path); err != nil {
					t.Fatal("removed live data")
				}
			}
		})
	}
}

func TestComputerPoolRejectsUnownedDirectoryAndSymlink(t *testing.T) {
	for _, link := range []bool{false, true} {
		t.Run(map[bool]string{true: "symlink", false: "existing"}[link], func(t *testing.T) {
			p, k, q := computerFixture(t)
			path := filepath.Join(p.config.Root, "volumes", q.Computer.VolumeID)
			var err error
			if link {
				err = os.Symlink(t.TempDir(), path)
			} else {
				err = os.Mkdir(path, 0700)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = p.Handle(q); err == nil || len(k.quotas) != 0 {
				t.Fatal("adopted unowned data")
			}
		})
	}
}

func TestComputerPoolRefusesLockedPool(t *testing.T) {
	p, k, q := computerFixture(t)
	if _, err := p.Handle(q); err != nil {
		t.Fatal(err)
	}
	k.broken = true
	for _, action := range []string{"computer-prepare", "computer-inspect", "computer-delete"} {
		q.Action = action
		if _, err := p.Handle(q); err == nil {
			t.Fatal("used unavailable encryption")
		}
	}
}

func TestComputerPoolWireGrammar(t *testing.T) {
	_, _, q := computerFixture(t)
	raw, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeRequest(raw)
	if err != nil || !reflect.DeepEqual(q, got) {
		t.Fatalf("%+v %v", got, err)
	}
	for _, raw := range []string{`{"action":"computer-prepare","computer":{"diskBytes":1,"diskBytes":2}}`,
		`{"action":"computer-prepare","computer":{"path":"/"}}`,
		`{"action":"computer-prepare","computer":{"diskBytes":{}}}`} {
		if _, err = DecodeRequest([]byte(raw)); err == nil {
			t.Fatal("invalid request accepted")
		}
	}
}
