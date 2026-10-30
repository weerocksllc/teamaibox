package docker

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Opt-in Docker contract test. NEVER starts the container or touches a guest
// disk. A private SSH-forwarded Docker socket and five empty fixture folders
// must be explicitly supplied by the caller. Cleanup uses returned exact IDs.
func TestComputerRealDockerCreateInspectNoGuest(t *testing.T) {
	socket, root, image := os.Getenv("COMPUTER_DOCKER_TEST_SOCKET"), os.Getenv("COMPUTER_DOCKER_TEST_ROOT"), os.Getenv("COMPUTER_DOCKER_TEST_IMAGE")
	if socket == "" {
		t.Skip("isolated Docker contract fixture not configured")
	}
	if !phonePrivateRoot(root) || !digestID.MatchString(image) {
		t.Fatal("explicit empty fixture required")
	}
	p, b, _ := computerFixture(t)
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	nonce[6] = (nonce[6] & 15) | 64
	nonce[8] = (nonce[8] & 63) | 128
	p.Run.ID = fmt.Sprintf("%x-%x-%x-%x-%x", nonce[:4], nonce[4:6], nonce[6:8], nonce[8:10], nonce[10:])
	p.RuntimeImage = image
	p.Run.RuntimeImage = image
	b.GuestDirectory = filepath.Join(root, "guest")
	b.ControlDirectory = filepath.Join(root, "control")
	b.ConfigDirectory = filepath.Join(root, "config")
	b.FirmwareDirectory = filepath.Join(root, "firmware")
	b.MediaDirectory = filepath.Join(root, "media")
	engine, err := NewEngineRuntime(socket)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var network struct {
		ID string `json:"Id"`
	}
	err = engine.request(ctx, http.MethodPost, "/networks/create", map[string]any{"Name": "computer-contract-" + p.Run.ID, "Driver": "bridge", "Internal": true,
		"Labels": map[string]string{"com.teamaibox.test": "computer-contract-" + p.Run.ID}}, &network, http.StatusCreated)
	if err != nil {
		t.Fatal(err)
	}
	if !phoneExactContainerID.MatchString(network.ID) {
		t.Fatal("invalid network identity")
	}
	t.Cleanup(func() {
		if err := engine.request(context.Background(), http.MethodDelete, "/networks/"+network.ID, nil, nil, http.StatusNoContent); err != nil {
			t.Error(err)
		}
	})
	b.NetworkID = network.ID
	spec, err := buildComputerContainer(p, b)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		ID string `json:"Id"`
	}
	err = engine.request(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(computerContainerName(p)), spec, &created, http.StatusCreated)
	if err != nil {
		t.Fatal(err)
	}
	if !phoneExactContainerID.MatchString(created.ID) {
		t.Fatal("invalid container identity")
	}
	t.Cleanup(func() {
		if err := engine.request(context.Background(), http.MethodDelete, "/containers/"+created.ID, nil, nil, http.StatusNoContent); err != nil {
			t.Error(err)
		}
	})
	state, exists, err := engine.inspectComputerContainer(ctx, p, b)
	if err != nil {
		for _, key := range []string{"Image", "User", "WorkingDir", "Entrypoint", "Cmd", "Labels", "StopSignal", "StopTimeout", "Env"} {
			if !phoneRequiredEqual(phoneNormalized(spec[key]), state.Config[key]) {
				t.Logf("Config %s expected=%v actual=%v", key, spec[key], state.Config[key])
			}
		}
		for key, value := range spec["HostConfig"].(map[string]any) {
			if !phoneRequiredEqual(phoneNormalized(value), state.HostConfig[key]) {
				t.Logf("HostConfig %s expected=%v actual=%v", key, value, state.HostConfig[key])
			}
		}
		t.Logf("network=%+v", state.NetworkSettings)
		t.Fatal(err)
	}
	if !exists || state.ID != created.ID || state.State.Running || state.State.Status != "created" {
		t.Fatal("unexpected fixture state")
	}
	t.Logf("Docker create/inspect matched; container never started; exact cleanup registered: %s", created.ID)
}
