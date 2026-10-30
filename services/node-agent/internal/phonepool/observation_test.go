package phonepool

import (
	"os"
	"reflect"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

func (k *kernelFixture) capacity(c Config) (uint64, uint64, error) {
	a, e := k.verify(c)
	return 64 << 30, a, e
}

func TestPoolObservationReadOnlyAndLiveEncryptionRequired(t *testing.T) {
	p, k, q := fixture(t)
	if _, err := p.Handle(q); err != nil {
		t.Fatal(err)
	}
	before, err := p.root.ReadFile("storage-state/allocations.json")
	if err != nil {
		t.Fatal(err)
	}
	projects, quotas := len(k.projects), len(k.quotas)
	request := Request{Action: "pool-status", Identity: agent.PhoneIdentity{PoolID: p.config.PoolID}}
	r, err := p.Handle(request)
	if err != nil || !validObservation(r.Pool, p.config.PoolID) || r.Pool.TotalBytes != 64<<30 || r.Pool.AvailableBytes != k.available {
		t.Fatalf("invalid live observation: %+v %v", r, err)
	}
	after, _ := p.root.ReadFile("storage-state/allocations.json")
	if !reflect.DeepEqual(before, after) || len(k.projects) != projects || len(k.quotas) != quotas {
		t.Fatal("observation mutated storage")
	}
	k.broken = true
	if _, err := p.Handle(request); err == nil {
		t.Fatal("locked pool reported ready")
	}
	k.broken = false
	request.Identity.OwnerID = q.Identity.OwnerID
	if _, err := p.Handle(request); err == nil {
		t.Fatal("observation accepted phone fields")
	}
	request.Identity = agent.PhoneIdentity{PoolID: "another.pool"}
	if _, err := p.Handle(request); err == nil {
		t.Fatal("foreign pool accepted")
	}
	if _, err := DecodeRequest([]byte(`{"action":"pool-status","identity":{"poolId":"phone.pool"},"path":"/etc/shadow"}`)); err == nil {
		t.Fatal("arbitrary host path accepted")
	}
	if _, err := os.Stat(p.config.Root); err != nil {
		t.Fatal(err)
	}
}

func TestPoolObservationRejectsStaleAndInvalidCapacity(t *testing.T) {
	p, _, _ := fixture(t)
	r, err := p.Handle(Request{Action: "pool-status", Identity: agent.PhoneIdentity{PoolID: p.config.PoolID}})
	if err != nil {
		t.Fatal(err)
	}
	for _, delta := range []time.Duration{-11 * time.Second, 2 * time.Second} {
		v := *r.Pool
		v.ObservedAt = time.Now().Add(delta).UTC().Format(time.RFC3339Nano)
		if validObservation(&v, p.config.PoolID) {
			t.Fatal("invalid observation time accepted")
		}
	}
	v := *r.Pool
	v.AvailableBytes = v.TotalBytes + 1
	if validObservation(&v, p.config.PoolID) {
		t.Fatal("capacity accepted")
	}
}
func TestComputerPoolObservationIncludesActualAndroidAndWindowsUsage(t *testing.T) {
	p, k, q := computerFixture(t)
	q.Computer.DiskBytes = 4 << 30
	k.available = 32 << 30
	computer, e := p.Handle(q)
	if e != nil {
		t.Fatal(e)
	}
	k.used[computer.ProjectID] = 1 << 30
	_, _, phone := fixture(t)
	phone.Identity.PoolID = p.config.PoolID
	r, e := p.Handle(phone)
	if e != nil {
		t.Fatal(e)
	}
	k.used[r.ProjectID] = 2 << 30
	before, _ := p.root.ReadFile("storage-state/allocations.json")
	observed, e := p.Handle(Request{Action: "computer-pool-status", Identity: agent.PhoneIdentity{PoolID: p.config.PoolID}})
	if e != nil || !validComputerObservation(observed.ComputerPool, p.config.PoolID) {
		t.Fatalf("%+v %v", observed, e)
	}
	usage := map[string]uint64{}
	for _, v := range observed.ComputerPool.Volumes {
		usage[v.VolumeID] = v.UsedBytes
	}
	if len(usage) != 2 || usage[q.Computer.VolumeID] != 1<<30 || usage[phone.Identity.VolumeID] != 2<<30 {
		t.Fatal(usage)
	}
	after, _ := p.root.ReadFile("storage-state/allocations.json")
	if !reflect.DeepEqual(before, after) {
		t.Fatal("capacity observation mutated journal")
	}
	k.broken = true
	if _, e = p.Handle(Request{Action: "computer-pool-status", Identity: agent.PhoneIdentity{PoolID: p.config.PoolID}}); e == nil {
		t.Fatal("locked pool counted")
	}
}
