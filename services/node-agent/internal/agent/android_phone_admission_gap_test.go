package agent

import "testing"

func TestPhonePlatformAdmissionGapFromStopped(t *testing.T) {
	for _, action := range []string{"start", "delete"} {
		t.Run(action, func(t *testing.T) {
			d := &phoneDriverStub{}
			c := newPhoneTestCoordinator(t, t.TempDir(), d)
			p := phonePayload()
			provisionPhone(t, c, p)
			p.Generation = 3 // generations 1 and 2 were rejected before dispatch
			if action == "delete" {
				p.Run = nil
			}
			if _, err := executePhone(c, action, p); err != nil {
				t.Fatal(err)
			}
			if _, err := c.read(); err != nil {
				t.Fatalf("accepted command wrote unreadable journal: %v", err)
			}
			p.Generation = 2
			if _, err := executePhone(c, action, p); err == nil {
				t.Fatal("accepted stale generation")
			}
		})
	}
}

func TestPhoneAdmissionGapDeletedJournalSurvivesCoordinatorRestart(t *testing.T) {
	dir := t.TempDir()
	d := &phoneDriverStub{}
	c := newPhoneTestCoordinator(t, dir, d)
	p := phonePayload()
	provisionPhone(t, c, p)
	p.Run = nil
	p.Generation = 2
	if _, err := executePhone(c, "delete", p); err != nil {
		t.Fatal(err)
	}
	c.Close()
	c = newPhoneTestCoordinator(t, dir, d)
	if _, err := executePhone(c, "delete", p); err != nil {
		t.Fatal(err)
	}
	q := phonePayload()
	q.PhoneID = newUUID()
	q.VolumeID = newUUID()
	q.OwnerID = newUUID()
	provisionPhone(t, c, q)
}

func TestPhoneNewerGenerationCannotDeleteRunning(t *testing.T) {
	d := &phoneDriverStub{}
	c := newPhoneTestCoordinator(t, t.TempDir(), d)
	p := phonePayload()
	provisionPhone(t, c, p)
	if _, err := executePhone(c, "start", p); err != nil {
		t.Fatal(err)
	}
	p.Generation = 5
	p.Run = nil
	if _, err := executePhone(c, "delete", p); err == nil {
		t.Fatal("deleted running phone through generation gap")
	}
	if d.calls[len(d.calls)-1] == "delete" {
		t.Fatal("invoked deletion driver")
	}
}

func TestPhoneAdmissionGapCannotReuseStoppedRun(t *testing.T) {
	d := &phoneDriverStub{}
	c := newPhoneTestCoordinator(t, t.TempDir(), d)
	p := phonePayload()
	provisionPhone(t, c, p)
	if _, err := executePhone(c, "start", p); err != nil {
		t.Fatal(err)
	}
	if _, err := executePhone(c, "stop", p); err != nil {
		t.Fatal(err)
	}
	p.Generation = 4
	if _, err := executePhone(c, "start", p); err == nil {
		t.Fatal("reused old run across generation gap")
	}
	if d.starts != 1 {
		t.Fatal("started duplicate run")
	}
}
