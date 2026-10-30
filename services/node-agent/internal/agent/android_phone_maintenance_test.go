package agent

import (
	"os"
	"strings"
	"testing"
)

func TestHostRuntimeRepairOnlyAfterExactStopAndPersistsAcrossAgentRestart(t *testing.T) {
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	p := phonePayload()
	target := "sha256:" + strings.Repeat("e", 64)
	repair := PhoneRuntimeMaintenance{PhoneID: p.PhoneID, OwnerID: p.OwnerID, VolumeID: p.VolumeID, ROMVersionID: "google-test",
		FromImageDigest: p.Run.ImageDigest, ToImageDigest: target, AndroidSystemDigest: "sha256:" + strings.Repeat("c", 64)}
	policy := PhoneRuntimePolicy{NodeID: nodeID, NodeGeneration: nodeGeneration, PoolID: p.PoolID, ImageDigest: p.Run.ImageDigest,
		AdditionalImageDigests: []string{target}, RuntimeMaintenance: []PhoneRuntimeMaintenance{repair}}
	driver := &phoneDriverStub{}
	open := func() *PhoneCoordinator {
		c, e := NewPhoneCoordinator(dir, policy, driver)
		if e != nil {
			t.Fatal(e)
		}
		if e = c.ConfigurePhoneProtection(&phoneMemoryFixture{}); e != nil {
			t.Fatal(e)
		}
		return c
	}
	c := open()
	provisionPhone(t, c, p)
	if _, e := executePhone(c, "start", p); e != nil {
		t.Fatal(e)
	}
	next := p
	newRun := *p.Run
	next.Run = &newRun
	next.Generation++
	next.Run.ID, next.Run.ReservationID = newUUID(), newUUID()
	next.Run.ImageDigest = target
	if _, e := executePhone(c, "start", next); e == nil {
		t.Fatal("running phone was replaced")
	}
	if _, e := executePhone(c, "stop", p); e != nil {
		t.Fatal(e)
	}
	for _, action := range []string{"stop", "inspect", "delete"} {
		if _, e := executePhone(c, action, next); e == nil {
			t.Fatal("repair authorized wrong action", action)
		}
	}
	for _, change := range []func(*PhoneRuntimeMaintenance){func(v *PhoneRuntimeMaintenance) { v.PhoneID = newUUID() }, func(v *PhoneRuntimeMaintenance) { v.OwnerID = newUUID() }, func(v *PhoneRuntimeMaintenance) { v.VolumeID = newUUID() }} {
		v := repair
		change(&v)
		c.policy.RuntimeMaintenance = []PhoneRuntimeMaintenance{v}
		if _, e := executePhone(c, "start", next); e == nil {
			t.Fatal("repair crossed identity")
		}
	}
	c.policy.RuntimeMaintenance = []PhoneRuntimeMaintenance{repair}
	if _, e := executePhone(c, "start", next); e != nil {
		t.Fatal(e)
	}
	if _, e := executePhone(c, "stop", next); e != nil {
		t.Fatal(e)
	}
	c.Close()
	c = open()
	defer c.Close()
	next.Generation++
	next.Run.ID, next.Run.ReservationID = newUUID(), newUUID()
	if _, e := executePhone(c, "start", next); e != nil {
		t.Fatal(e)
	}
	if _, e := executePhone(c, "stop", next); e != nil {
		t.Fatal(e)
	}
	next.Generation++
	next.Run.ID, next.Run.ReservationID = newUUID(), newUUID()
	next.Run.ImageDigest = repair.FromImageDigest
	if _, e := executePhone(c, "start", next); e == nil {
		t.Fatal("unapproved downgrade accepted")
	}
}

func TestHostRuntimeMaintenancePolicyRejectsInvalidOrAmbiguousMappings(t *testing.T) {
	p := phonePayload()
	target := "sha256:" + strings.Repeat("e", 64)
	r := PhoneRuntimeMaintenance{PhoneID: p.PhoneID, OwnerID: p.OwnerID, VolumeID: p.VolumeID, ROMVersionID: "google-test",
		FromImageDigest: p.Run.ImageDigest, ToImageDigest: target, AndroidSystemDigest: "sha256:" + strings.Repeat("c", 64)}
	if !ValidPhoneRuntimeMaintenance(p.Run.ImageDigest, []string{target}, []PhoneRuntimeMaintenance{r}) {
		t.Fatal("valid repair rejected")
	}
	for _, values := range [][]PhoneRuntimeMaintenance{{r, r}, make([]PhoneRuntimeMaintenance, 9)} {
		if ValidPhoneRuntimeMaintenance(p.Run.ImageDigest, []string{target}, values) {
			t.Fatal("ambiguous repair accepted")
		}
	}
	for _, change := range []func(*PhoneRuntimeMaintenance){func(v *PhoneRuntimeMaintenance) { v.AndroidSystemDigest = "" }, func(v *PhoneRuntimeMaintenance) { v.OwnerID = "" }, func(v *PhoneRuntimeMaintenance) { v.ToImageDigest = v.FromImageDigest }, func(v *PhoneRuntimeMaintenance) { v.ToImageDigest = "sha256:" + strings.Repeat("f", 64) }} {
		v := r
		change(&v)
		if ValidPhoneRuntimeMaintenance(p.Run.ImageDigest, []string{target}, []PhoneRuntimeMaintenance{v}) {
			t.Fatal("invalid repair accepted")
		}
	}
}

func TestSuccessiveHostRepairsAllowExactIntermediateRuntime(t *testing.T) {
	p := phonePayload()
	intermediate := "sha256:" + strings.Repeat("e", 64)
	target := "sha256:" + strings.Repeat("f", 64)
	v := PhoneRuntimeMaintenance{PhoneID: p.PhoneID, OwnerID: p.OwnerID, VolumeID: p.VolumeID,
		ROMVersionID: "google-test", FromImageDigest: p.Run.ImageDigest, ToImageDigest: target,
		AndroidSystemDigest: "sha256:" + strings.Repeat("c", 64), PreviousImageDigests: []string{intermediate}}
	if !ValidPhoneRuntimeMaintenance(p.Run.ImageDigest, []string{intermediate, target}, []PhoneRuntimeMaintenance{v}) {
		t.Fatal("chain rejected")
	}
	c := &PhoneCoordinator{policy: PhoneRuntimePolicy{RuntimeMaintenance: []PhoneRuntimeMaintenance{v}}}
	oldRun := *p.Run
	oldRun.ImageDigest = intermediate
	old := phoneRecord{Phase: "stopped", Generation: p.Generation, Run: &oldRun}
	next := p
	nextRun := *p.Run
	next.Run = &nextRun
	next.Generation++
	next.Run.ID, next.Run.ReservationID = newUUID(), newUUID()
	next.Run.ImageDigest = target
	if !c.allowsHostRepair("start", old, next) {
		t.Fatal("intermediate upgrade rejected")
	}
	old.Phase = "running"
	if c.allowsHostRepair("start", old, next) {
		t.Fatal("running replacement allowed")
	}
	old.Phase = "stopped"
	next.OwnerID = newUUID()
	if c.allowsHostRepair("start", old, next) {
		t.Fatal("foreign owner allowed")
	}
	for _, previous := range [][]string{{intermediate, intermediate}, {target}, {"sha256:" + strings.Repeat("9", 64)}} {
		v.PreviousImageDigests = previous
		if ValidPhoneRuntimeMaintenance(p.Run.ImageDigest, []string{intermediate, target}, []PhoneRuntimeMaintenance{v}) {
			t.Fatal("invalid history accepted")
		}
	}
}
