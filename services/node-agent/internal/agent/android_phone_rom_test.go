package agent

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestPhoneInstalledHistoryHasNoDevelopmentSampleCountLimit(t *testing.T) {
	current := "sha256:" + strings.Repeat("a", 64)
	var images []string
	for i := 0; i < 40; i++ {
		images = append(images, fmt.Sprintf("sha256:%064x", i))
	}
	if !ValidInstalledPhoneImages(current, images, nil) || !ValidRetiredPhoneImages(current, images) {
		t.Fatal("valid installed image history rejected because of count")
	}
}

func TestPhoneROMsRemainBoundAcrossRestartAndAgentReplacement(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	aosp := phonePayload()
	google := phonePayload()
	google.PhoneID, google.OwnerID, google.VolumeID = newUUID(), newUUID(), newUUID()
	google.Run.ID, google.Run.ReservationID = newUUID(), newUUID()
	google.Run.ImageDigest = "sha256:" + strings.Repeat("e", 64)
	policy := PhoneRuntimePolicy{NodeID: nodeID, NodeGeneration: nodeGeneration, PoolID: aosp.PoolID,
		ImageDigest: aosp.Run.ImageDigest, AdditionalImageDigests: []string{google.Run.ImageDigest}}
	driver := &phoneDriverStub{}
	open := func() *PhoneCoordinator {
		c, err := NewPhoneCoordinator(dir, policy, driver)
		if err != nil {
			t.Fatal(err)
		}
		if err = c.ConfigurePhoneProtection(&phoneMemoryFixture{}); err != nil {
			t.Fatal(err)
		}
		return c
	}
	c := open()
	for _, p := range []PhoneCommandPayload{aosp, google} {
		provisionPhone(t, c, p)
		if _, err := executePhone(c, "start", p); err != nil {
			t.Fatal(err)
		}
		if _, err := executePhone(c, "stop", p); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	// Switching the deployment default must not switch either existing phone.
	policy.ImageDigest, policy.AdditionalImageDigests = google.Run.ImageDigest, []string{aosp.Run.ImageDigest}
	c = open()
	defer c.Close()
	for _, p := range []PhoneCommandPayload{aosp, google} {
		p.Generation++
		run := *p.Run
		p.Run = &run
		p.Run.ID, p.Run.ReservationID = newUUID(), newUUID()
		if _, err := executePhone(c, "start", p); err != nil {
			t.Fatal(err)
		}
		if _, err := executePhone(c, "stop", p); err != nil {
			t.Fatal(err)
		}
		p.Generation++
		p.Run.ID, p.Run.ReservationID = newUUID(), newUUID()
		if p.Run.ImageDigest == policy.ImageDigest {
			p.Run.ImageDigest = aosp.Run.ImageDigest
		} else {
			p.Run.ImageDigest = google.Run.ImageDigest
		}
		calls := len(driver.calls)
		if _, err := executePhone(c, "start", p); err == nil || err.Error() != "phone_rom_version_mismatch" {
			t.Fatal("ROM switch accepted", err)
		}
		if len(driver.calls) != calls {
			t.Fatal("ROM switch reached the driver")
		}
	}
}

func TestAdditionalROMImagesAreExplicitBoundedAndDisjointFromRetired(t *testing.T) {
	a, b := phonePayload().Run.ImageDigest, "sha256:"+strings.Repeat("e", 64)
	if !ValidInstalledPhoneImages(a, []string{b}, nil) {
		t.Fatal("valid two-ROM policy rejected")
	}
	for _, values := range [][]string{{a}, {b, b}, {"tag:latest"}, make([]string, 16)} {
		if ValidInstalledPhoneImages(a, values, nil) {
			t.Fatal("invalid policy accepted")
		}
	}
	if ValidInstalledPhoneImages(a, []string{b}, []string{b}) {
		t.Fatal("retired image promoted by ambiguous mapping")
	}
}
