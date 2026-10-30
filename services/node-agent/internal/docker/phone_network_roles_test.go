package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestPhoneNetworkRolesExecIsFixedAndCachedByStart(t *testing.T) {
	d, resources, state, _ := phoneDriverFixture(t)
	d.policy.NetworkProfile = phoneLANProfile
	d.policy.ControlNetworkID = strings.Repeat("c", 64)
	resources.binding.Instance = 21
	state.NetworkSettings.Networks = map[string]struct {
		NetworkID string `json:"NetworkID"`
		IPAddress string `json:"IPAddress"`
	}{
		"primary": {resources.binding.NetworkID, "192.168.80.2"}, "control": {d.policy.ControlNetworkID, "172.21.0.3"},
	}
	state.State.StartedAt = "first-start"
	created := 0
	d.engine.client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/containers/"+state.ID+"/exec") {
			var payload struct {
				User       string
				Privileged bool
				Cmd        []string
			}
			if json.NewDecoder(req.Body).Decode(&payload) != nil || payload.User != "0:0" || payload.Privileged || len(payload.Cmd) != 6 || payload.Cmd[2] != phoneNetworkRolesProgram || strings.Join(payload.Cmd[3:], ",") != "21,192.168.80.2,172.21.0.3" {
				t.Fatal("unexpected network exec recipe")
			}
			created++
			return response(http.StatusCreated, `{"Id":"`+strings.Repeat("d", 64)+`"}`), nil
		}
		if strings.HasSuffix(req.URL.Path, "/start") {
			return response(http.StatusOK, ""), nil
		}
		return response(http.StatusOK, `{"Running":false,"ExitCode":0}`), nil
	})
	for i := 0; i < 2; i++ {
		if err := d.ensurePhoneNetworkRoles(context.Background(), *state, resources.binding); err != nil {
			t.Fatal(err)
		}
	}
	if created != 1 {
		t.Fatal("network subprocess repeated on each media request")
	}
	state.State.StartedAt = "second-start"
	if err := d.ensurePhoneNetworkRoles(context.Background(), *state, resources.binding); err != nil || created != 2 {
		t.Fatal("restarted namespace incorrectly cached", err)
	}
	value := state.NetworkSettings.Networks["primary"]
	value.NetworkID = strings.Repeat("f", 64)
	state.NetworkSettings.Networks["primary"] = value
	if err := d.ensurePhoneNetworkRoles(context.Background(), *state, resources.binding); err == nil || created != 2 {
		t.Fatal("foreign network executed")
	}
}
