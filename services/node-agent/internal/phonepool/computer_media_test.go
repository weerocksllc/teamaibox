package phonepool

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type mediaKernelFixture struct {
	*computerKernelFixture
	failApply bool
}

func (k *mediaKernelFixture) resizeMediaQuota(_ *os.File, id uint32, previous, next uint64, apply bool) (uint64, error) {
	if k.quotas[id] != previous && k.quotas[id] != next {
		return 0, errors.New("changed")
	}
	if k.used[id] > next {
		return 0, errors.New("computer_media_storage_in_use")
	}
	if apply {
		k.quotas[id] = next
		if k.failApply {
			return 0, errors.New("lost after quota applied")
		}
	}
	return k.used[id], nil
}
func mediaFixture(t *testing.T) (*Pool, *mediaKernelFixture, Request, Result) {
	p, base, q := computerFixture(t)
	k := &mediaKernelFixture{computerKernelFixture: base}
	p.kernel = k
	guest, err := p.Handle(q)
	if err != nil {
		t.Fatal(err)
	}
	q.Action, q.MediaBytes = "computer-media-prepare", 8<<30
	return p, k, q, guest
}

func TestInstallationMediaPoolSeparateQuotaAndPersistentResize(t *testing.T) {
	p, k, q, guest := mediaFixture(t)
	path := filepath.Join(p.config.Root, "volumes", q.Computer.VolumeID, "guest", "system.qcow2")
	if err := os.WriteFile(path, []byte("existing guest"), 0600); err != nil {
		t.Fatal(err)
	}
	first, err := p.Handle(q)
	if err != nil || !first.Media || first.ProjectID == guest.ProjectID || first.QuotaBytes != 8<<30+mediaDirectoryOverhead {
		t.Fatalf("%+v %v", first, err)
	}
	again, err := p.Handle(q)
	if err != nil || !reflect.DeepEqual(first, again) || len(k.quotas) != 2 {
		t.Fatalf("%+v %v", again, err)
	}
	q.MediaBytes = 20 << 30
	k.failApply = true
	if _, err = p.Handle(q); err == nil {
		t.Fatal("expected interrupted quota update")
	}
	p.Close()
	k.failApply = false
	p, err = newPool(p.config, k)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	inspect := q
	inspect.Action, inspect.MediaBytes = "computer-media-inspect", 0
	resized, err := p.Handle(inspect)
	if err != nil || resized.ProjectID != first.ProjectID || resized.QuotaBytes != 20<<30+mediaDirectoryOverhead {
		t.Fatalf("%+v %v", resized, err)
	}
	if k.quotas[guest.ProjectID] != guest.QuotaBytes {
		t.Fatal("guest quota changed")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "existing guest" {
		t.Fatal("guest disk changed")
	}
	q.MediaBytes = 1 << 30
	k.used[first.ProjectID] = 2 << 30
	if _, err = p.Handle(q); err == nil {
		t.Fatal("shrunk below existing data")
	}
	k.used[first.ProjectID] = 0
	if _, err = p.Handle(q); err != nil {
		t.Fatal(err)
	}
}

func TestInstallationMediaChecksItsOwnActualCopyNotOtherDisksGrowth(t *testing.T) {
	p, k, q, _ := mediaFixture(t)
	k.available = 114 << 30
	if _, err := p.Handle(q); err != nil {
		t.Fatal("guest logical disk blocked media", err)
	}
	_, _, phone := fixture(t)
	phone.Identity.PoolID = p.config.PoolID
	k.available = 32 << 30
	if _, err := p.Handle(phone); err != nil {
		t.Fatal("unwritten ISO quota blocked phone", err)
	}
}

func TestInstallationMediaPoolDeleteOnlyEmptyOwnedStaging(t *testing.T) {
	p, k, q, guest := mediaFixture(t)
	media, err := p.Handle(q)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(p.config.Root, "installation-media", q.Computer.VolumeID, "installer", "fixture.iso")
	if err = os.WriteFile(file, []byte("media"), 0600); err != nil {
		t.Fatal(err)
	}
	q.Action, q.MediaBytes = "computer-media-delete", 0
	if _, err = p.Handle(q); err == nil {
		t.Fatal("deleted populated staging")
	}
	if err = os.Remove(file); err != nil {
		t.Fatal(err)
	}
	k.used[media.ProjectID] = 4096 // Simulate unlinked file still open by QEMU.
	if _, err = p.Handle(q); err == nil {
		t.Fatal("released live file reservation")
	}
	k.used[media.ProjectID] = 0
	deleted, err := p.Handle(q)
	if err != nil || !deleted.Deleted {
		t.Fatalf("%+v %v", deleted, err)
	}
	if _, err = p.Handle(q); err != nil {
		t.Fatal(err)
	}
	if len(k.quotas) != 1 || k.quotas[guest.ProjectID] != guest.QuotaBytes {
		t.Fatal("changed guest allocation")
	}
	q.Action, q.MediaBytes = "computer-media-prepare", 2<<30
	reused, err := p.Handle(q)
	if err != nil || reused.ProjectID == media.ProjectID {
		t.Fatalf("%+v %v", reused, err)
	}
}

func TestInstallationMediaPoolRejectsForeignIdentityAndLockedStorage(t *testing.T) {
	p, k, q, _ := mediaFixture(t)
	bad := *q.Computer
	bad.OwnerID = "40000000-0000-4000-8000-000000000001"
	foreign := q
	foreign.Computer = &bad
	if _, err := p.Handle(foreign); err == nil {
		t.Fatal("foreign staging")
	}
	k.broken = true
	if _, err := p.Handle(q); err == nil {
		t.Fatal("unverified encrypted pool")
	}
	k.broken = false
	if _, err := p.Handle(q); err != nil {
		t.Fatal(err)
	}
	q.Action, q.MediaBytes = "computer-delete", 0
	if _, err := p.Handle(q); err == nil {
		t.Fatal("guest deleted before media released")
	}
}
