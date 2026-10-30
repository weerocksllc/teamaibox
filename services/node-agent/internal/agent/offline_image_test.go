package agent

import (
	"strings"
	"testing"
)

func TestOfflineImagePolicyAcceptsOnlyPinnedReferences(t *testing.T) {
	id := "sha256:" + strings.Repeat("a", 64)
	for _, valid := range []string{id, "registry.local/worker@" + id} {
		if !imagePattern.MatchString(valid) {
			t.Fatal("pinned image refused:", valid)
		}
	}
	for _, invalid := range []string{"latest", "worker:latest", "sha256:123456", strings.Repeat("a", 64)} {
		if imagePattern.MatchString(invalid) {
			t.Fatal("unpinned image accepted:", invalid)
		}
	}
}
