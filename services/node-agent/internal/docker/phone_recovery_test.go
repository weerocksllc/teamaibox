package docker

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestPhoneRecoveryResolvesOriginalBoundResourcesWithoutMutation(t *testing.T) {
	for _, damage := range []string{"none", "owner", "future-generation", "network-id", "container-image", "mount"} {
		t.Run(damage, func(t *testing.T) {
			r, f, _, p := resourcesFixture(t)
			ctx := context.Background()
			b, err := r.BindRun(ctx, p)
			if err != nil {
				t.Fatal(err)
			}
			spec, err := buildPhoneContainer(r.policy.forBinding(b), p, b.NetworkID)
			if err != nil {
				t.Fatal(err)
			}
			state := &phoneEngineState{ID: strings.Repeat("c", 64), Image: r.policy.ImageID, Config: phoneNormalized(spec).(map[string]any), HostConfig: phoneNormalized(spec["HostConfig"]).(map[string]any)}
			state.State.Running = true
			state.State.Status = "running"
			f.container = state
			network := f.networks[b.NetworkID]
			network.Containers = map[string]json.RawMessage{state.ID: json.RawMessage(`{}`)}
			r.policy.NodeGeneration++
			switch damage {
			case "owner":
				network.Labels["com.teamaibox.owner-id"] = "foreign"
			case "future-generation":
				network.Labels["com.teamaibox.node-generation"] = "9999"
			case "network-id":
				network.ID = strings.Repeat("d", 64)
			case "container-image":
				state.Image = "sha256:" + strings.Repeat("e", 64)
			case "mount":
				state.HostConfig["Binds"] = []any{"/:/host:rw"}
			}
			f.networks[b.NetworkID] = network
			before, _ := r.control.ReadFile(p.Run.ID + "/binding.json")
			got, err := r.ResolveRun(ctx, p)
			if damage == "none" {
				if err != nil || got != b {
					t.Fatal("original runtime not resolved", got, err)
				}
			} else if err == nil {
				t.Fatal("foreign resource recovered", damage)
			}
			after, _ := r.control.ReadFile(p.Run.ID + "/binding.json")
			if !reflect.DeepEqual(before, after) || f.creates != 1 {
				t.Fatal("recovery mutated allocation")
			}
		})
	}
}

func TestPhoneDriverRecoveryNeverRestartsOriginalContainer(t *testing.T) {
	for _, running := range []bool{true, false} {
		d, r, state, p := phoneDriverFixture(t)
		r.binding.NodeGeneration = d.policy.NodeGeneration
		d.policy.NodeGeneration++
		state.State.Running = running
		if !running {
			state.State.Status = "exited"
		}
		// The fixture rejects every non-GET Docker request, including start/create.
		for _, action := range []string{"inspect", "start"} {
			var err error
			if action == "inspect" {
				_, err = d.InspectPhone(context.Background(), p)
			} else {
				_, err = d.StartPhone(context.Background(), p)
			}
			if err != nil {
				t.Fatal(action, err)
			}
		}
	}
}
