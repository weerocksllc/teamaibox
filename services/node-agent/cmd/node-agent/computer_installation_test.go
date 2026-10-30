package main

import (
	"context"
	"io"
	"strings"
	"teamaibox.local/node-agent/internal/agent"
	"testing"
)

type installationDelegateFixture struct {
	commandServiceFixture
	calls int
}

func (f *installationDelegateFixture) ExecuteComputerInstallation(_ context.Context, e agent.CommandEnvelope, proof agent.AuthProof, input io.Reader) (agent.ComputerResult, error) {
	f.calls++
	b, _ := io.ReadAll(input)
	if string(b) != "iso bytes" || e.CommandID != "fixture" || proof.KeyID != "fixture" {
		panic("lost authority or bytes")
	}
	return agent.ComputerResult{InstallationRevision: 4}, nil
}
func TestProductionInstallationDelegation(t *testing.T) {
	for _, allowed := range []bool{false, true} {
		f := &installationDelegateFixture{}
		types := "virtual-computer.inspect"
		if allowed {
			types = "virtual-computer.installation"
		}
		s, err := restrictedCommandService(f, types)
		if err != nil {
			t.Fatal(err)
		}
		bridge, ok := s.(computerInstallationDelegate)
		if !ok {
			t.Fatal("production wrapper lost installation interface")
		}
		result, err := bridge.ExecuteComputerInstallation(context.Background(), agent.CommandEnvelope{Type: "virtual-computer.installation", CommandID: "fixture"}, agent.AuthProof{KeyID: "fixture"}, strings.NewReader("iso bytes"))
		if allowed && (err != nil || f.calls != 1 || result.InstallationRevision != 4) {
			t.Fatal("delegation failed", err)
		}
		if !allowed && (err == nil || f.calls != 0) {
			t.Fatal("denied command delegated")
		}
	}
}
