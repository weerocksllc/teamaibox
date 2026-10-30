package agent

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestRuntimeUpgradePreservesOnlyDeletedPhoneHistory(t *testing.T) {
	for _, phase := range []string{"deleted", "stopped", "running", "starting", "stopping", "deleting"} {
		t.Run(phase, func(t *testing.T) {
			dir, driver := t.TempDir(), &phoneDriverStub{}
			c := newPhoneTestCoordinator(t, dir, driver)
			p := phonePayload()
			provisionPhone(t, c, p)
			for _, action := range []string{"start", "stop"} {
				if _, err := executePhone(c, action, p); err != nil {
					t.Fatal(err)
				}
			}
			if phase == "deleted" {
				deletion := p
				deletion.Run = nil
				if _, err := executePhone(c, "delete", deletion); err != nil {
					t.Fatal(err)
				}
			} else {
				j, err := c.read()
				if err != nil {
					t.Fatal(err)
				}
				r := j.Phones[p.PhoneID]
				r.Phase = phase
				j.Phones[p.PhoneID] = r
				if err = c.write(j); err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.ReadFile(filepath.Join(dir, "phones.json"))
			if err != nil {
				t.Fatal(err)
			}
			policy, calls := c.policy, len(driver.calls)
			c.Close()
			policy.ImageDigest = "sha256:" + strings.Repeat("d", 64)
			next, err := NewPhoneCoordinator(dir, policy, driver)
			if phase == "deleted" {
				if err != nil {
					t.Fatal(err)
				}
				defer next.Close()
				if _, err = executePhone(next, "start", p); err == nil {
					t.Fatal("old image restarted")
				}
			} else if err == nil {
				next.Close()
				t.Fatal("live or stopped old image silently adopted")
			}
			after, err := os.ReadFile(filepath.Join(dir, "phones.json"))
			if err != nil || !bytes.Equal(before, after) || len(driver.calls) != calls {
				t.Fatal("upgrade mutated history or runtime")
			}
		})
	}
}

func TestQualifiedRuntimeUpgradePreservesClosedHistoryWithoutAdoption(t *testing.T) {
	for _, phase := range []string{"stopped", "deleting", "running", "starting", "stopping", "provisioning"} {
		t.Run(phase, func(t *testing.T) {
			dir, driver := t.TempDir(), &phoneDriverStub{}
			c := newPhoneTestCoordinator(t, dir, driver)
			p := phonePayload()
			provisionPhone(t, c, p)
			for _, action := range []string{"start", "stop"} {
				if _, err := executePhone(c, action, p); err != nil {
					t.Fatal(err)
				}
			}
			j, _ := c.read()
			record := j.Phones[p.PhoneID]
			record.Phase = phase
			j.Phones[p.PhoneID] = record
			if err := c.write(j); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(filepath.Join(dir, "phones.json"))
			policy, calls := c.policy, len(driver.calls)
			c.Close()
			policy.RetiredImageDigests = []string{policy.ImageDigest}
			policy.ImageDigest = "sha256:" + strings.Repeat("d", 64)
			next, err := NewPhoneCoordinator(dir, policy, driver)
			closed := phase == "stopped" || phase == "deleting"
			if (err == nil) != closed {
				t.Fatalf("unexpected history adoption: %v", err)
			}
			after, _ := os.ReadFile(filepath.Join(dir, "phones.json"))
			if !bytes.Equal(before, after) || len(driver.calls) != calls {
				t.Fatal("upgrade changed history")
			}
			if !closed {
				return
			}
			defer next.Close()
			for _, action := range []string{"start", "stop", "inspect"} {
				if _, err = executePhone(next, action, p); err == nil {
					t.Fatal("old run reached driver")
				}
			}
			if len(driver.calls) != calls {
				t.Fatal("old runtime accessed")
			}
			if phase == "stopped" {
				if err = next.ConfigurePhoneProtection(&phoneMemoryFixture{}); err != nil {
					t.Fatal(err)
				}
				fresh := p
				run := *p.Run
				fresh.Run = &run
				fresh.Generation++
				run.ID, run.ReservationID, run.ImageDigest = newUUID(), newUUID(), policy.ImageDigest
				if _, err = executePhone(next, "start", fresh); err == nil || err.Error() != "phone_rom_version_mismatch" {
					t.Fatal("a retired ROM disk must not be silently upgraded", err)
				}
			}
			p.Run = nil
			if _, err = executePhone(next, "delete", p); err != nil {
				t.Fatal("closed deletion failed", err)
			}
		})
	}
}

func TestRetiredPhoneImagePolicyIsExplicitAndBounded(t *testing.T) {
	current, old := "sha256:"+strings.Repeat("a", 64), "sha256:"+strings.Repeat("b", 64)
	if !ValidRetiredPhoneImages(current, nil) || !ValidRetiredPhoneImages(current, []string{old}) {
		t.Fatal("valid policy rejected")
	}
	for _, images := range [][]string{{current}, {old, old}, {"unqualified"}, make([]string, 9)} {
		if ValidRetiredPhoneImages(current, images) {
			t.Fatal("invalid policy accepted")
		}
		policy := PhoneRuntimePolicy{NodeID: nodeID, NodeGeneration: nodeGeneration, PoolID: "phones-luks", ImageDigest: current, RetiredImageDigests: images}
		if c, err := NewPhoneCoordinator(t.TempDir(), policy, &phoneDriverStub{}); err == nil {
			c.Close()
			t.Fatal("constructor accepted invalid policy")
		}
	}
}

func TestClosedPhoneJournalFollowsAuthenticatedGenerationWithoutReset(t *testing.T) {
	for _, phase := range []string{"stopped", "deleted"} {
		t.Run(phase, func(t *testing.T) {
			dir, driver := t.TempDir(), &phoneDriverStub{}
			c := newPhoneTestCoordinator(t, dir, driver)
			p := phonePayload()
			provisionPhone(t, c, p)
			for _, action := range []string{"start", "stop"} {
				if _, err := executePhone(c, action, p); err != nil {
					t.Fatal(err)
				}
			}
			if phase == "deleted" {
				deletion := p
				deletion.Run = nil
				if _, err := executePhone(c, "delete", deletion); err != nil {
					t.Fatal(err)
				}
			}
			before, err := c.read()
			if err != nil {
				t.Fatal(err)
			}
			policy := c.policy
			if err = c.Close(); err != nil {
				t.Fatal(err)
			}
			calls := len(driver.calls)
			policy.NodeGeneration++
			next, err := NewPhoneCoordinator(dir, policy, driver)
			if err != nil {
				t.Fatal(err)
			}
			after, err := next.read()
			if err != nil || after.NodeGeneration != policy.NodeGeneration || !reflect.DeepEqual(before.Phones, after.Phones) || len(driver.calls) != calls {
				t.Fatal("journal recovery reset records or touched Android", err)
			}
			deletion := p
			deletion.Run = nil
			if _, err = executePhone(next, "delete", deletion); err == nil || len(driver.calls) != calls {
				t.Fatal("old node authority reached driver")
			}
			if _, err = next.ExecutePhone(context.Background(), "delete", deletion, Ownership{NodeID: nodeID,
				NodeGeneration: policy.NodeGeneration, LeaseID: p.PhoneID, FencingToken: p.Generation + 1}); err != nil {
				t.Fatal("new authority failed", err)
			}
			if err = next.Close(); err != nil {
				t.Fatal(err)
			}
			// The successor persists even if the process restarts before any command.
			path := filepath.Join(dir, "phones.json")
			persisted, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			policy.NodeGeneration--
			if rolledBack, err := NewPhoneCoordinator(dir, policy, driver); err == nil {
				rolledBack.Close()
				t.Fatal("older node generation accepted successor journal")
			}
			unchanged, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(persisted, unchanged) {
				t.Fatal("failed rollback changed journal")
			}
		})
	}
}

func TestPhoneJournalRecoveryPreservesRunsAndRejectsOldCommands(t *testing.T) {
	for _, phase := range []string{"provisioning", "starting", "running", "stopping", "deleting"} {
		t.Run(phase, func(t *testing.T) {
			dir, driver := t.TempDir(), &phoneDriverStub{}
			c := newPhoneTestCoordinator(t, dir, driver)
			p := phonePayload()
			provisionPhone(t, c, p)
			if _, err := executePhone(c, "start", p); err != nil {
				t.Fatal(err)
			}
			journal, err := c.read()
			if err != nil {
				t.Fatal(err)
			}
			record := journal.Phones[p.PhoneID]
			record.Phase = phase
			journal.Phones[p.PhoneID] = record
			if err = c.write(journal); err != nil {
				t.Fatal(err)
			}
			policy := c.policy
			policy.NodeGeneration++
			c.Close()
			calls := len(driver.calls)
			successor, err := NewPhoneCoordinator(dir, policy, driver)
			if err != nil {
				t.Fatal("control service could not recover", err)
			}
			defer successor.Close()
			after, err := successor.read()
			if phase == "starting" {
				record.RecoveryInspectOnly = true
			}
			if err != nil || after.NodeGeneration != policy.NodeGeneration || !reflect.DeepEqual(after.Phones[p.PhoneID], record) || len(driver.calls) != calls {
				t.Fatal("recovery changed phone identity, history, or runtime", err)
			}
			for _, action := range []string{"inspect", "start", "stop"} {
				if _, err = executePhone(successor, action, p); err == nil || len(driver.calls) != calls {
					t.Fatal("stale command reached runtime", action)
				}
			}
			if phase == "running" || phase == "starting" {
				authority := Ownership{NodeID: nodeID, NodeGeneration: policy.NodeGeneration, LeaseID: p.PhoneID, FencingToken: p.Generation + 1}
				if result, err := successor.ExecutePhone(context.Background(), "start", p, authority); err != nil || !result.AndroidReady || driver.calls[len(driver.calls)-1] != "inspect" {
					t.Fatal("fresh command must reattach without starting Android", err)
				}
				driver.live[p.Run.ID] = false
				starts := driver.starts
				if _, err = successor.ExecutePhone(context.Background(), "start", p, authority); err == nil || driver.starts != starts || driver.live[p.Run.ID] {
					t.Fatal("missing old runtime was revived")
				}
			}
		})
	}
}
