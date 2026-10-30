package docker

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
	"teamaibox.local/node-agent/internal/phonepool"
)

type quotaFixture struct {
	calls  []phonepool.Request
	denied bool
}

func TestPhoneStatusCleanupDiagnosticsRemainClosedAndBackwardCompatible(t *testing.T) {
	for _, raw := range []string{
		`{"phase":"stopped","shutdownDiagnostics":{"before":[],"after":[],"requestExitCode":0,"requestReportedFailure":false}}`,
		`{"phase":"stopped","shutdownDiagnostics":{"runtimeCleanup":[{"attempt":1,"exitCode":4,"remainingGuestProcesses":0},{"attempt":2,"exitCode":0,"remainingGuestProcesses":0}]}}`,
		`{"phase":"stopped","shutdownDiagnostics":{"runtimeCleanup":[{"attempt":1,"error":"os_error","errno":3},{"attempt":2,"exitCode":0,"remainingGuestProcesses":0}]}}`,
	} {
		var status PhoneRuntimeStatus
		if err := phoneDecodeFile([]byte(raw), &status); err != nil {
			t.Fatal(err)
		}
	}
	var status PhoneRuntimeStatus
	if phoneDecodeFile([]byte(`{"shutdownDiagnostics":{"runtimeCleanup":[{"attempt":1,"command":"arbitrary"}]}}`), &status) == nil {
		t.Fatal("unexpected diagnostic field accepted")
	}
}

func (q *quotaFixture) Handle(_ context.Context, p phonepool.Request) (phonepool.Result, error) {
	q.calls = append(q.calls, p)
	if q.denied {
		return phonepool.Result{}, errors.New("phone_pool_locked")
	}
	return phonepool.Result{Identity: p.Identity, ProjectID: 100000, QuotaBytes: 16 << 30, Deleted: p.Action == "delete"}, nil
}

type networkFixture struct {
	networks  map[string]phoneNetworkState
	creates   int
	loseReply bool
	container *phoneEngineState
}

func (f *networkFixture) engine(t *testing.T) *EngineRuntime {
	t.Helper()
	return &EngineRuntime{baseURL: "http://docker/v1.48", client: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		path := strings.TrimPrefix(req.URL.Path, "/v1.48")
		if strings.HasPrefix(path, "/containers/") && req.Method == http.MethodGet {
			if f.container == nil {
				return response(404, "{}"), nil
			}
			raw, _ := json.Marshal(f.container)
			return response(200, string(raw)), nil
		}
		if path == "/networks/create" && req.Method == http.MethodPost {
			var n phoneNetworkState
			if json.NewDecoder(req.Body).Decode(&n) != nil {
				t.Fatal("invalid request")
			}
			sum := sha256.Sum256([]byte(n.Name))
			n.ID = hex.EncodeToString(sum[:])
			n.Scope = "local"
			f.networks[n.ID] = n
			f.creates++
			if f.loseReply {
				f.loseReply = false
				return nil, errors.New("explicit lost response fixture")
			}
			raw, _ := json.Marshal(map[string]string{"Id": n.ID})
			return response(201, string(raw)), nil
		}
		if strings.HasPrefix(path, "/networks/") {
			id := strings.TrimPrefix(path, "/networks/")
			for key, n := range f.networks {
				if n.ID == id || n.Name == id {
					if req.Method == http.MethodDelete {
						delete(f.networks, key)
						return response(204, ""), nil
					}
					if req.Method != http.MethodGet {
						t.Fatal("unexpected mutation")
					}
					raw, _ := json.Marshal(n)
					return response(200, string(raw)), nil
				}
			}
			return response(404, "{}"), nil
		}
		t.Fatalf("unexpected Docker call %s %s", req.Method, path)
		return nil, nil
	})}}
}

func resourcesFixture(t *testing.T) (*InstalledPhoneResources, *networkFixture, *quotaFixture, agent.PhoneCommandPayload) {
	t.Helper()
	policy, p := phoneRecipeFixture(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	policy.DataRoot = filepath.Join(root, "volumes")
	policy.ControlRoot = filepath.Join(root, "control")
	for _, path := range []string{policy.DataRoot, policy.ControlRoot} {
		if err = os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	f := &networkFixture{networks: map[string]phoneNetworkState{}}
	q := &quotaFixture{}
	r, err := newPhoneResources(f.engine(t), policy, q)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	return r, f, q, p
}

func otherPhone(p agent.PhoneCommandPayload, n string) agent.PhoneCommandPayload {
	p.PhoneID = "20000000-0000-4000-8000-00000000000" + n
	p.VolumeID = "40000000-0000-4000-8000-00000000000" + n
	run := *p.Run
	run.ID = "60000000-0000-4000-8000-00000000000" + n
	run.ReservationID = "70000000-0000-4000-8000-00000000000" + n
	p.Run = &run
	return p
}

func TestInstalledPhoneResourcesExactRetryAndReadOnlyResolve(t *testing.T) {
	r, f, _, p := resourcesFixture(t)
	ctx := context.Background()
	first, err := r.BindRun(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := r.control.ReadFile(p.Run.ID + "/certs/server.crt")
	p.OperationID = "50000000-0000-4000-8000-000000000009"
	again, err := r.BindRun(ctx, p)
	if err != nil || first != again || f.creates != 1 {
		t.Fatalf("duplicate %v %v", again, err)
	}
	actual, _ := r.control.ReadFile(p.Run.ID + "/certs/server.crt")
	if string(actual) != string(cert) {
		t.Fatal("retry rotated certificate")
	}
	resolved, err := r.ResolveRun(ctx, p)
	if err != nil || resolved != first || f.creates != 1 {
		t.Fatal("resolve mutated")
	}
	bad := p
	bad.OwnerID = "30000000-0000-4000-8000-000000000009"
	if _, err = r.BindRun(ctx, bad); err == nil {
		t.Fatal("owner rebound")
	}
	if _, err = r.ResolveRun(ctx, bad); err == nil {
		t.Fatal("owner resolved")
	}
}

func TestInstalledPhoneCertificateSelfSignedCompatibility(t *testing.T) {
	r, _, _, p := resourcesFixture(t)
	if _, err := r.BindRun(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	raw, err := r.control.ReadFile(p.Run.ID + "/certs/server.crt")
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(raw)
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil || cert.CheckSignatureFrom(cert) != nil || cert.VerifyHostname("127.0.0.1") != nil ||
		!cert.MaxPathLenZero || cert.MaxPathLen != 0 {
		t.Fatal("not a valid per-run self-signed certificate", err)
	}
	if cert.VerifyHostname("10.64.0.19") == nil {
		t.Fatal("certificate trusted for LAN host")
	}
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("optional OpenSSL compatibility check unavailable")
	}
	path := filepath.Join(r.policy.ControlRoot, p.Run.ID, "certs/server.crt")
	if output, err := exec.Command("openssl", "verify", "-CAfile", path, path).CombinedOutput(); err != nil {
		t.Fatalf("pinned certificate rejected: %s %v", output, err)
	}
	output, err := exec.Command("openssl", "verify", path).CombinedOutput()
	if err == nil || !strings.Contains(strings.ReplaceAll(strings.ToLower(string(output)), "-", " "), "self signed certificate") ||
		strings.Contains(strings.ToLower(string(output)), "unable to get local issuer") {
		t.Fatalf("not recognized as self-signed: %s %v", output, err)
	}
}

func TestInstalledPhoneResourcesLostNetworkReplyRecoversExactAllocation(t *testing.T) {
	r, f, _, p := resourcesFixture(t)
	ctx := context.Background()
	f.loseReply = true
	if _, err := r.BindRun(ctx, p); err == nil {
		t.Fatal("lost reply hidden")
	}
	got, err := r.BindRun(ctx, p)
	if err != nil || got.NetworkID == "" || f.creates != 1 {
		t.Fatal("network duplicated", err)
	}
}

func TestInstalledPhoneResourcesCancelUnstartedRun(t *testing.T) {
	for _, stage := range []string{"before_binding", "lost_network_reply", "bound_no_container"} {
		t.Run(stage, func(t *testing.T) {
			r, f, _, p := resourcesFixture(t)
			ctx := context.Background()
			if stage != "before_binding" {
				f.loseReply = stage == "lost_network_reply"
				_, err := r.BindRun(ctx, p)
				if (err != nil) != (stage == "lost_network_reply") {
					t.Fatal(err)
				}
			}
			got, err := r.CancelUnstartedRun(ctx, p)
			if err != nil || !got {
				t.Fatal("unstarted run not cancelled", err)
			}
			if stage != "before_binding" {
				b, err := r.readRun(p.Run.ID)
				if err != nil || !b.Released || b.NetworkID == "" {
					t.Fatal("lost allocation not retired", err)
				}
				if _, err = r.BindRun(ctx, p); err == nil {
					t.Fatal("retired run revived")
				}
				bad := p
				bad.OwnerID = "30000000-0000-4000-8000-000000000009"
				if ok, err := r.CancelUnstartedRun(ctx, bad); err == nil || ok {
					t.Fatal("foreign run cancelled")
				}
			}
			_, state := phoneObservedFixture(t)
			state.State.Running = true
			state.State.Status = "running"
			f.container = &state
			if ok, err := r.CancelUnstartedRun(ctx, p); err != nil || ok {
				t.Fatal("existing container treated as absent")
			}
		})
	}
}

func TestInstalledPhoneResourcesAllocateDistinctSlotsAndReleaseOnlyAfterStopped(t *testing.T) {
	r, f, _, p := resourcesFixture(t)
	ctx := context.Background()
	a, err := r.BindRun(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	second := otherPhone(p, "2")
	b, err := r.BindRun(ctx, second)
	if err != nil || a.NetworkID == b.NetworkID {
		t.Fatal("shared network", err)
	}
	third, err := r.BindRun(ctx, otherPhone(p, "3"))
	if err != nil || third.Instance != 23 || third.NetworkID == b.NetworkID || third.NetworkID == a.NetworkID {
		t.Fatal("third phone did not receive independent resources", err)
	}
	spec, _ := buildPhoneContainer(r.policy, p, a.NetworkID)
	s := &phoneEngineState{ID: strings.Repeat("c", 64), Image: r.policy.ImageID, Config: phoneNormalized(spec).(map[string]any), HostConfig: phoneNormalized(spec["HostConfig"]).(map[string]any)}
	s.State.Running = true
	s.State.Status = "running"
	f.container = s
	if err = r.ReleaseRun(ctx, p); err == nil {
		t.Fatal("live slot released")
	}
	s.State.Running = false
	s.State.Status = "exited"
	if err = r.ReleaseRun(ctx, p); err != nil {
		t.Fatal(err)
	}
	if _, present := f.networks[a.NetworkID]; present {
		t.Fatal("stopped phone still occupies a subnet")
	}
	if _, err = r.ResolveRun(ctx, p); err != nil {
		t.Fatal("network reclamation broke exact stopped-run inspection", err)
	}
	if err = r.ReleaseRun(ctx, p); err != nil {
		t.Fatal("network reclamation broke stop retry", err)
	}
	if _, err = r.BindRun(ctx, p); err == nil {
		t.Fatal("stopped run resurrected")
	}
	if next, err := r.BindRun(ctx, otherPhone(p, "4")); err != nil || next.Instance != 21 {
		t.Fatal("released slot not reused", err)
	}
	record, _ := r.readRun(second.Run.ID)
	if record.Instance != 22 || record.Released {
		t.Fatal("other slot changed")
	}
}

func TestInstalledPhoneResourcesRespectLegacyImagePortCompatibility(t *testing.T) {
	r, _, _, p := resourcesFixture(t)
	r.policy.InstanceLimitByImage = map[string]int{p.Run.ImageDigest: 22}
	ctx := context.Background()
	if _, err := r.BindRun(ctx, p); err != nil {
		t.Fatal(err)
	}
	if _, err := r.BindRun(ctx, otherPhone(p, "2")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.BindRun(ctx, otherPhone(p, "3")); err == nil {
		t.Fatal("legacy runtime was given an unsupported port allocation")
	}
}

func TestInstalledPhoneResourcesPoolLockBlocksBeforeNetwork(t *testing.T) {
	r, f, q, p := resourcesFixture(t)
	q.denied = true
	if _, err := r.BindRun(context.Background(), p); err == nil || f.creates != 0 {
		t.Fatal("locked pool bypassed")
	}
}

func TestInstalledPhoneResourcesRejectForeignNetworkAndSymlink(t *testing.T) {
	r, f, _, p := resourcesFixture(t)
	ctx := context.Background()
	b, err := r.BindRun(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	n := f.networks[b.NetworkID]
	n.Internal = false
	f.networks[b.NetworkID] = n
	if _, err = r.ResolveRun(ctx, p); err == nil {
		t.Fatal("network policy drift accepted")
	}
	n.Internal = true
	f.networks[b.NetworkID] = n
	if err = r.control.Remove(p.Run.ID + "/config.json"); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink("certs/server.crt", filepath.Join(r.policy.ControlRoot, p.Run.ID, "config.json")); err != nil {
		t.Fatal(err)
	}
	if _, err = r.BindRun(ctx, p); err == nil {
		t.Fatal("symlink adopted")
	}
}

func TestInstalledPhoneResourcesDeleteOnlyReleasedExactRuns(t *testing.T) {
	r, f, _, p := resourcesFixture(t)
	ctx := context.Background()
	_, err := r.BindRun(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	second := otherPhone(p, "2")
	b, err := r.BindRun(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	del := p
	del.Run = nil
	if err = r.DeleteData(ctx, del); err == nil {
		t.Fatal("unreleased deletion")
	}
	if err = r.ReleaseRun(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err = r.DeleteData(ctx, del); err != nil {
		t.Fatal(err)
	}
	if len(f.networks) != 1 || f.networks[b.NetworkID].Name == "" {
		t.Fatal("other network deleted")
	}
	if err = r.DeleteData(ctx, del); err != nil {
		t.Fatal("duplicate deletion", err)
	}
	if _, err = r.ResolveRun(ctx, second); err != nil {
		t.Fatal("other run changed", err)
	}
}

func TestReleasedPhoneHistorySurvivesQualifiedImageAndAuthorityUpgrade(t *testing.T) {
	for _, mode := range []string{"unapproved", "unreleased", "reopen", "delete", "future-generation", "foreign-network"} {
		t.Run(mode, func(t *testing.T) {
			r, f, _, p := resourcesFixture(t)
			ctx := context.Background()
			b, err := r.BindRun(ctx, p)
			if err != nil {
				t.Fatal(err)
			}
			if mode != "unreleased" {
				// Historical Agents retained the network on release. New Agents
				// must still resolve and clean those exact legacy records.
				old, _ := r.readRun(p.Run.ID)
				old.Released = true
				if err = r.writeRun(old); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := r.control.ReadFile(p.Run.ID + "/binding.json")
			oldImage := r.policy.ImageID
			r.policy.ImageID = "sha256:" + strings.Repeat("d", 64)
			r.policy.NodeGeneration++
			if mode != "unapproved" {
				r.policy.RetiredImageDigests = []string{oldImage}
			}
			if mode == "future-generation" || mode == "foreign-network" {
				n := f.networks[b.NetworkID]
				if mode == "future-generation" {
					n.Labels["com.teamaibox.node-generation"] = "9999"
				} else {
					n.Labels["com.teamaibox.owner-identity-id"] = "foreign"
				}
				f.networks[b.NetworkID] = n
			}
			got, err := r.ResolveRetiredRun(ctx, p)
			accepted := mode == "reopen" || mode == "delete"
			if (err == nil) != accepted {
				t.Fatalf("wrong historical resolution: %v", err)
			}
			after, _ := r.control.ReadFile(p.Run.ID + "/binding.json")
			if string(before) != string(after) {
				t.Fatal("history rewritten")
			}
			if !accepted {
				return
			}
			if got.RetiredNodeGeneration != r.policy.NodeGeneration-1 {
				t.Fatal("lost original authority")
			}
			if _, err = r.ResolveRun(ctx, p); err == nil {
				t.Fatal("old live resolution accepted")
			}
			if _, err = r.BindRun(ctx, p); err == nil {
				t.Fatal("old run revived")
			}
			if mode == "reopen" {
				fresh := otherPhone(p, "2")
				fresh.PhoneIdentity = p.PhoneIdentity
				fresh.Generation++
				fresh.Run.ImageDigest = r.policy.ImageID
				if _, err = r.BindRun(ctx, fresh); err != nil {
					t.Fatal("new run blocked by history", err)
				}
				return
			}
			p.Run = nil
			if err = r.DeleteData(ctx, p); err != nil {
				t.Fatal("released old data cannot delete", err)
			}
		})
	}
}

func TestInstalledPhoneResourcesRestartRetainsRunAndQuota(t *testing.T) {
	r, f, q, p := resourcesFixture(t)
	first, err := r.BindRun(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	second, err := newPhoneResources(f.engine(t), r.policy, q)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	got, err := second.ResolveRun(context.Background(), p)
	if err != nil || got != first {
		t.Fatal("restart lost binding", err)
	}
}

func TestInstalledPhoneStatusAcceptsRealShutdownShape(t *testing.T) {
	r, _, _, p := resourcesFixture(t)
	path := filepath.Join(r.policy.DataRoot, p.VolumeID, "phone")
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	status := map[string]any{"phoneId": p.PhoneID, "ownerId": p.OwnerID, "volumeId": p.VolumeID, "runId": p.Run.ID, "generation": p.Generation, "buildId": p.BaseBuildID,
		"phase": "stopped", "shutdownDiagnostics": map[string]any{"before": []any{}, "after": []any{}, "requestExitCode": 0, "requestReportedFailure": false}}
	raw, _ := json.Marshal(status)
	if err := os.WriteFile(filepath.Join(path, ".phone-status.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReadStatus(context.Background(), p); err != nil {
		t.Fatal(err)
	}
}
