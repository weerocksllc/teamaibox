package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

func stoppedComputerFixture(t *testing.T, p agent.ComputerCommand, b ComputerContainerBinding) phoneEngineState {
	t.Helper()
	spec, err := buildComputerContainer(p, b)
	if err != nil {
		t.Fatal(err)
	}
	s := phoneEngineState{ID: strings.Repeat("c", 64), Image: p.RuntimeImage, Config: phoneNormalized(spec).(map[string]any), HostConfig: phoneNormalized(spec["HostConfig"]).(map[string]any)}
	s.State.Status = "exited"
	return s
}

func TestComputerStoppedNetworksAreReclaimedWithoutReplacingGuest(t *testing.T) {
	r, p, _, states := computerResourcesFixture(t)
	ctx := context.Background()
	guest := filepath.Join(r.storage.dataRoot, p.VolumeID, "guest", "system.qcow2")
	original, _ := os.Stat(guest)
	for i := 1; i <= 20; i++ {
		p.Generation = uint64(i)
		p.Run = &agent.ComputerRun{ID: fmt.Sprintf("21111111-1111-4111-8111-%012d", i), Generation: p.Generation, RuntimeImage: p.RuntimeImage}
		binding, err := r.BindComputerRun(ctx, p)
		if err != nil {
			t.Fatalf("cycle %d bind: %v", i, err)
		}
		saved, _ := r.readRun(p)
		states[computerContainerName(p)] = stoppedComputerFixture(t, p, binding)
		if err = r.ReleaseComputerRun(ctx, p); err != nil {
			t.Fatal(err)
		}
		if _, err = r.computerNetwork(ctx, saved, false); !phoneEngineNotFound(err) {
			t.Fatalf("cycle %d leaked a subnet: %v", i, err)
		}
		resolved, err := r.ResolveComputerRun(ctx, p)
		if err != nil || !reflect.DeepEqual(resolved, binding) {
			t.Fatalf("stopped result lost: %v", err)
		}
		if err = r.ReleaseComputerRun(ctx, p); err != nil {
			t.Fatal("shutdown retry failed", err)
		}
		current, _ := os.Stat(guest)
		if !os.SameFile(original, current) {
			t.Fatal("guest disk replaced")
		}
	}
}

func TestComputerNextAdmissionReclaimsLegacyExitedNetwork(t *testing.T) {
	r, p, _, states := computerResourcesFixture(t)
	ctx := context.Background()
	b, err := r.BindComputerRun(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	old, _ := r.readRun(p)
	states[computerContainerName(p)] = stoppedComputerFixture(t, p, b)
	p.Generation++
	p.Run = &agent.ComputerRun{ID: "21111111-1111-4111-8111-111111111118", Generation: p.Generation, RuntimeImage: p.RuntimeImage}
	if _, err = r.BindComputerRun(ctx, p); err != nil {
		t.Fatal(err)
	}
	if _, err = r.computerNetwork(ctx, old, false); !phoneEngineNotFound(err) {
		t.Fatal("legacy subnet retained", err)
	}
}

func TestComputerNetworkReleaseRefusesLiveCreatedMissingOrChangedContainer(t *testing.T) {
	for _, mode := range []string{"running", "created", "missing", "foreign-owner"} {
		t.Run(mode, func(t *testing.T) {
			r, p, _, states := computerResourcesFixture(t)
			ctx := context.Background()
			b, err := r.BindComputerRun(ctx, p)
			if err != nil {
				t.Fatal(err)
			}
			s := stoppedComputerFixture(t, p, b)
			switch mode {
			case "running":
				s.State.Running, s.State.Status = true, "running"
			case "created":
				s.State.Status = "created"
			case "foreign-owner":
				s.Config["Labels"].(map[string]any)["com.teamaibox.owner-identity-id"] = "other"
			}
			if mode != "missing" {
				states[computerContainerName(p)] = s
			}
			if err = r.ReleaseComputerRun(ctx, p); err == nil {
				t.Fatal("unproven terminal runtime released")
			}
			saved, _ := r.readRun(p)
			if _, err = r.computerNetwork(ctx, saved, false); err != nil {
				t.Fatal("network changed", err)
			}
			if err = r.engine.request(ctx, http.MethodDelete, "/networks/"+b.NetworkID, nil, nil, http.StatusNoContent); err != nil {
				t.Fatal(err)
			}
			if _, err = r.ResolveComputerRun(ctx, p); err == nil {
				t.Fatal("missing live network accepted")
			}
		})
	}
}

func TestPhoneRepeatedRunsDoNotAccumulateNetworks(t *testing.T) {
	r, f, _, p := resourcesFixture(t)
	ctx := context.Background()
	for i := 1; i <= 20; i++ {
		p.Generation = uint64(i)
		run := *p.Run
		run.ID = fmt.Sprintf("61111111-1111-4111-8111-%012d", i)
		p.Run = &run
		b, err := r.BindRun(ctx, p)
		if err != nil {
			t.Fatalf("cycle %d bind: %v", i, err)
		}
		spec, _ := buildPhoneContainer(r.policy.forInstance(b.Instance), p, b.NetworkID)
		s := phoneEngineState{ID: strings.Repeat("c", 64), Image: p.Run.ImageDigest, Config: phoneNormalized(spec).(map[string]any), HostConfig: phoneNormalized(spec["HostConfig"]).(map[string]any)}
		s.State.Status = "exited"
		f.container = &s
		if err = r.ReleaseRun(ctx, p); err != nil {
			t.Fatal(err)
		}
		if len(f.networks) != 0 {
			t.Fatal("stopped run leaked a subnet")
		}
		if _, err = r.ResolveRun(ctx, p); err != nil {
			t.Fatal("stopped result lost", err)
		}
	}
}

func TestPhoneLegacyNetworkReclamationRefusesForeignOrActiveResources(t *testing.T) {
	for _, mode := range []string{"released", "foreign", "active", "endpoint"} {
		t.Run(mode, func(t *testing.T) {
			r, f, _, p := resourcesFixture(t)
			ctx := context.Background()
			b, err := r.BindRun(ctx, p)
			if err != nil {
				t.Fatal(err)
			}
			old, _ := r.readRun(p.Run.ID)
			old.Released = true
			if err = r.writeRun(old); err != nil {
				t.Fatal(err)
			}
			spec, _ := buildPhoneContainer(r.policy.forInstance(b.Instance), p, b.NetworkID)
			s := phoneEngineState{ID: strings.Repeat("c", 64), Image: p.Run.ImageDigest, Config: phoneNormalized(spec).(map[string]any), HostConfig: phoneNormalized(spec["HostConfig"]).(map[string]any)}
			s.State.Status = "exited"
			f.container = &s
			n := f.networks[b.NetworkID]
			if mode == "foreign" {
				n.Labels["com.teamaibox.owner-identity-id"] = "other"
			}
			if mode == "active" {
				s.State.Running, s.State.Status = true, "running"
			}
			if mode == "endpoint" {
				n.Containers = map[string]json.RawMessage{s.ID: json.RawMessage(`{}`)}
			}
			f.networks[b.NetworkID] = n
			fresh, err := r.BindRun(ctx, otherPhone(p, "2"))
			if err != nil {
				t.Fatalf("%s: %v", mode, err)
			}
			if mode != "released" && fresh.Instance == b.Instance {
				t.Fatal("reused the instance of an unproven historical resource")
			}
			_, retained := f.networks[b.NetworkID]
			if retained != (mode != "released") {
				t.Fatal("incorrect legacy network reclamation")
			}
		})
	}
}
