package module

import "testing"

func TestIdentityIsVersioned(t *testing.T) {
	if Name == "" || ModuleVersion == "" || ProtocolVersion == "" {
		t.Fatal("node-agent identity and protocol version must be non-empty")
	}
}
