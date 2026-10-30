package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

type phoneResourcesFixture struct {
	binding           PhoneResourceBinding
	status            PhoneRuntimeStatus
	readError         error
	prepared, deleted int
	retiredError      error
	retiredGeneration int64
}

func (r *phoneResourcesFixture) ResolveRetiredRun(context.Context, agent.PhoneCommandPayload) (PhoneResourceBinding, error) {
	b := r.binding
	b.RetiredNodeGeneration = r.retiredGeneration
	return b, r.retiredError
}

func (r *phoneResourcesFixture) PrepareData(context.Context, agent.PhoneCommandPayload) error {
	r.prepared++
	return nil
}
func (r *phoneResourcesFixture) BindRun(context.Context, agent.PhoneCommandPayload) (PhoneResourceBinding, error) {
	return r.binding, nil
}
func (r *phoneResourcesFixture) ResolveRun(context.Context, agent.PhoneCommandPayload) (PhoneResourceBinding, error) {
	return r.binding, nil
}
func (r *phoneResourcesFixture) ReadStatus(context.Context, agent.PhoneCommandPayload) (PhoneRuntimeStatus, error) {
	return r.status, r.readError
}
func (r *phoneResourcesFixture) DeleteData(context.Context, agent.PhoneCommandPayload) error {
	r.deleted++
	return nil
}
func (r *phoneResourcesFixture) ReleaseRun(context.Context, agent.PhoneCommandPayload) error {
	return nil
}
func (r *phoneResourcesFixture) CancelUnstartedRun(context.Context, agent.PhoneCommandPayload) (bool, error) {
	return false, nil
}

func phoneDriverFixture(t *testing.T) (*PhoneDriver, *phoneResourcesFixture, *phoneEngineState, agent.PhoneCommandPayload) {
	t.Helper()
	policy, p := phoneRecipeFixture(t)
	_, state := phoneObservedFixture(t)
	state.State.Running = true
	state.State.Status = "running"
	r := &phoneResourcesFixture{binding: PhoneResourceBinding{Identity: p.PhoneIdentity, RunID: p.Run.ID, Generation: p.Generation, NetworkID: strings.Repeat("b", 64), QuotaBytes: agent.PhoneStorageBytes},
		status: PhoneRuntimeStatus{PhoneID: p.PhoneID, OwnerID: p.OwnerID, VolumeID: p.VolumeID, RunID: p.Run.ID, Generation: p.Generation, BuildID: p.BaseBuildID, Phase: "running", AndroidReady: true, MediaReady: true, UpdatedAtUnixMs: time.Now().UnixMilli()}}
	engine := &EngineRuntime{baseURL: "http://docker/v1.48", client: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodGet {
			t.Fatalf("unexpected mutation %s", req.Method)
		}
		raw, _ := json.Marshal(state)
		return response(http.StatusOK, string(raw)), nil
	})}}
	d, err := NewPhoneDriver(engine, policy, r)
	if err != nil {
		t.Fatal(err)
	}
	return d, r, &state, p
}

func TestPhoneDriverRequiresActualResourceAdapter(t *testing.T) {
	policy, _ := phoneRecipeFixture(t)
	if _, err := NewPhoneDriver(&EngineRuntime{}, policy, nil); err == nil {
		t.Fatal("nil storage/network adapter accepted")
	}
}

func TestPhoneDriverDoesNotConfuseContainerRunningWithAndroidReady(t *testing.T) {
	d, r, _, p := phoneDriverFixture(t)
	r.status.Phase = "starting"
	r.status.AndroidReady = false
	r.status.MediaReady = false
	r.status.UpdatedAtUnixMs = time.Now().Add(-50 * time.Second).UnixMilli()
	got, err := d.InspectPhone(context.Background(), p)
	if err != nil || got.AndroidReady || got.MediaReady || got.RuntimeStopped {
		t.Fatalf("%+v %v", got, err)
	}
	r.status.Phase = "running"
	r.status.AndroidReady = true
	r.status.MediaReady = true
	if _, err = d.InspectPhone(context.Background(), p); err == nil {
		t.Fatal("stale readiness accepted")
	}
	r.status.UpdatedAtUnixMs = time.Now().UnixMilli()
	got, err = d.InspectPhone(context.Background(), p)
	if err != nil || !got.AndroidReady || !got.MediaReady {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestPhoneDriverRejectsForeignStorageStatusAndGeneration(t *testing.T) {
	for _, field := range []string{"owner", "run", "generation", "quota", "status"} {
		t.Run(field, func(t *testing.T) {
			d, r, _, p := phoneDriverFixture(t)
			switch field {
			case "owner":
				r.binding.Identity.OwnerID = "foreign"
			case "run":
				r.binding.RunID = "foreign"
			case "generation":
				r.binding.Generation++
			case "quota":
				r.binding.QuotaBytes++
			case "status":
				r.status.RunID = "old-run"
			}
			if _, err := d.InspectPhone(context.Background(), p); err == nil {
				t.Fatal("foreign resource accepted")
			}
		})
	}
}

func TestPhoneDriverCleanShutdownNeedsGuestExitNotOnlyDockerExit(t *testing.T) {
	d, r, state, p := phoneDriverFixture(t)
	state.State.Running = false
	state.State.Status = "exited"
	r.status.Phase = "stopped"
	r.status.CleanShutdown = true
	got, err := d.InspectPhone(context.Background(), p)
	if err != nil || !got.RuntimeStopped || got.CleanShutdown {
		t.Fatalf("unproven clean stop: %+v %v", got, err)
	}
	r.status.ShutdownEvidence.SyncCompleted = true
	r.status.ShutdownEvidence.AndroidShutdownRequested = true
	r.status.ShutdownEvidence.GuestExitedBeforeRuntimeStop = true
	got, err = d.InspectPhone(context.Background(), p)
	if err != nil || !got.CleanShutdown {
		t.Fatalf("proven stop rejected: %+v %v", got, err)
	}
	state.State.OOMKilled = true
	got, err = d.InspectPhone(context.Background(), p)
	if err != nil || got.CleanShutdown {
		t.Fatal("OOM declared clean")
	}
	r.readError = errors.New("unreadable")
	got, err = d.InspectPhone(context.Background(), p)
	if err != nil || !got.RuntimeStopped || got.CleanShutdown {
		t.Fatal("known stopped must not fabricate clean status")
	}
}

func TestPhoneDriverDeleteValidatesAllRunsBeforeAnyRemoval(t *testing.T) {
	for _, foreign := range []bool{true, false} {
		t.Run(map[bool]string{true: "reject-foreign", false: "delete-exact-stopped"}[foreign], func(t *testing.T) {
			d, r, state, p := phoneDriverFixture(t)
			state.State.Running = false
			state.State.Status = "exited"
			if foreign {
				state.Config["Labels"].(map[string]any)["com.teamaibox.owner-identity-id"] = "foreign"
			}
			removed := false
			d.engine.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if strings.HasSuffix(req.URL.Path, "/containers/json") {
					return response(http.StatusOK, `[{"Id":"`+state.ID+`"}]`), nil
				}
				if req.Method == http.MethodDelete {
					if foreign || req.URL.Query().Get("force") == "1" {
						t.Fatal("unsafe removal")
					}
					removed = true
					return response(http.StatusNoContent, ""), nil
				}
				raw, _ := json.Marshal(state)
				return response(http.StatusOK, string(raw)), nil
			})}
			p.Run = nil
			got, err := d.DeletePhoneData(context.Background(), p)
			if foreign {
				if err == nil || r.deleted != 0 || removed {
					t.Fatal("foreign data/container affected")
				}
			} else if err != nil || !got.DataDeleted || !removed || r.deleted != 1 {
				t.Fatalf("%+v %v", got, err)
			}
		})
	}
}

func TestPhoneDriverDeletesOnlyVerifiedReleasedRuntimeHistory(t *testing.T) {
	for _, mode := range []string{"qualified", "unapproved", "unreleased", "running", "foreign", "future-generation"} {
		t.Run(mode, func(t *testing.T) {
			d, r, state, p := phoneDriverFixture(t)
			state.State.Running = false
			state.State.Status = "exited"
			r.retiredGeneration = d.policy.NodeGeneration
			d.policy.NodeGeneration++
			old := d.policy.ImageID
			d.policy.ImageID = "sha256:" + strings.Repeat("d", 64)
			if mode != "unapproved" {
				d.policy.RetiredImageDigests = []string{old}
			}
			if mode == "unreleased" {
				r.retiredError = errors.New("phone_stop_unconfirmed")
			}
			if mode == "running" {
				state.State.Running = true
				state.State.Status = "running"
			}
			if mode == "foreign" {
				state.Config["Labels"].(map[string]any)["com.teamaibox.owner-identity-id"] = "foreign"
			}
			if mode == "future-generation" {
				state.Config["Labels"].(map[string]any)["com.teamaibox.node-generation"] = "9999"
			}
			removed := false
			d.engine.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if strings.HasSuffix(req.URL.Path, "/containers/json") {
					return response(200, `[{"Id":"`+state.ID+`"}]`), nil
				}
				if req.Method == http.MethodDelete {
					if mode != "qualified" || req.URL.Query().Get("force") == "1" {
						t.Fatal("unsafe historical deletion")
					}
					removed = true
					return response(204, ""), nil
				}
				raw, _ := json.Marshal(state)
				return response(200, string(raw)), nil
			})}
			p.Run = nil
			got, err := d.DeletePhoneData(context.Background(), p)
			if mode == "qualified" {
				if err != nil || !got.DataDeleted || !removed || r.deleted != 1 {
					t.Fatal("qualified deletion failed", err)
				}
			} else if err == nil || removed || r.deleted != 0 {
				t.Fatal("unverified history deleted")
			}
		})
	}
}
