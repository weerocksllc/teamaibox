package docker

import "testing"

func TestCleanupPolicyAcceptsInstalledAndRetiredROMsOnly(t *testing.T) {
	p := PhoneContainerPolicy{ImageID: "default", AdditionalImageDigests: []string{"camera", "google"}, RetiredImageDigests: []string{"old"}}
	for _, image := range []string{"default", "camera", "google", "old"} {
		selected, err := p.forRetiredImage(image)
		if err != nil || selected.ImageID != image {
			t.Fatalf("installed/retired ROM cannot be cleaned: %s: %v", image, err)
		}
	}
	if _, err := p.forRetiredImage("unknown"); err == nil {
		t.Fatal("unapproved image accepted")
	}
	if p.ImageID != "default" {
		t.Fatal("default policy mutated")
	}
}
