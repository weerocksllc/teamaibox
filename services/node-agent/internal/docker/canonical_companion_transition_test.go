package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"teamaibox.local/node-agent/internal/agent"
)

// Fake Docker applies every individual mutation, including failures after the
// mutation completed (lost response), so recovery is tested at each boundary.
func canonicalCompanionFixture(t *testing.T, failAt int) (*EngineRuntime, agent.ProtectedSetTransitionTarget, agent.Ownership, map[string]*inspectDocument, *[]string) {
	t.Helper()
	_, _, spec, owner := dockerFixture(t)
	spec.Network = "compute-internal"
	spec.Devices, spec.Mounts, spec.Environment = nil, nil, nil
	spec.PlacementClass, spec.MaintenanceGeneration = agent.PlacementProtectedResident, 2
	spec.ConfigDigest = "sha256:" + strings.Repeat("c", 64)
	spec.HealthCheck = &agent.ContainerHealthCheck{Test: []string{"CMD", "true"}, Interval: 1_000_000_000, Timeout: 1_000_000_000, Retries: 1}
	target := agent.ExclusiveDrainTarget{TargetKey: "ocr", WorkerID: spec.WorkerID, ModelProfileID: spec.ModelProfileID,
		ContainerName: containerName(spec.WorkerID), PlacementClass: spec.PlacementClass, MaintenanceGeneration: 2,
		RequiredImageID: "sha256:" + strings.Repeat("a", 64), RequiredImageDigest: spec.Image, RequiredConfigDigest: spec.ConfigDigest,
		RequiredStartSpecDigest: agent.WorkerStartSpecDigest(spec)}
	companion := agent.ProtectedCompanionStartPayload{ContainerName: "ocr-provider", ParentWorkerID: spec.WorkerID,
		Image: "registry.local/provider@sha256:" + strings.Repeat("b", 64), RequiredImageID: "sha256:" + strings.Repeat("b", 64),
		ConfigDigest: spec.ConfigDigest, Network: spec.Network, Limits: spec.Limits, Security: spec.Security,
		Command: []string{"provider"}, HealthCheck: spec.HealthCheck, RequiredLabels: map[string]string{"com.teamaibox.placement-class": agent.PlacementProtectedResident, "com.teamaibox.maintenance-generation": "2"}}
	target.DependentContainers = []agent.ExclusiveDependentContainer{{ContainerName: companion.ContainerName,
		RequiredImageID: companion.RequiredImageID, RequiredImageDigest: companion.Image, RequiredConfigDigest: companion.ConfigDigest,
		RequiredLabels: companion.RequiredLabels, RequiredStartSpecDigest: "sha256:" + companionSpecDigest(companion)}}
	prior := target
	prior.RequiredConfigDigest = "sha256:" + strings.Repeat("d", 64)
	prior.DependentContainers = append([]agent.ExclusiveDependentContainer(nil), target.DependentContainers...)
	prior.DependentContainers[0].RequiredConfigDigest = prior.RequiredConfigDigest
	docs := map[string]*inspectDocument{}
	for index, member := range canonicalPriorMembers(agent.ProtectedSetTransitionTarget{PreviousTarget: &prior}) {
		doc := &inspectDocument{ID: fmt.Sprintf("old-%d", index), Name: "/" + member.ContainerName, Image: member.RequiredImageID}
		doc.Config.Image = member.RequiredImageDigest
		doc.Config.Labels = engineLabels(owner, spec)
		if index > 0 {
			doc.Config.Labels = companionLabels(companion, owner)
		}
		doc.Config.Labels["com.teamaibox.config-digest"] = prior.RequiredConfigDigest
		_ = json.Unmarshal([]byte(`{"Status":"running","Health":{"Status":"healthy"}}`), &doc.State)
		docs[member.ContainerName] = doc
	}
	images := map[string]string{spec.Image: target.RequiredImageID, companion.Image: companion.RequiredImageID}
	calls := []string{}
	mutations := 0
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		path := strings.TrimPrefix(req.URL.Path, "/"+engineAPIVersion)
		if strings.HasPrefix(path, "/images/") {
			ref := strings.TrimSuffix(strings.TrimPrefix(path, "/images/"), "/json")
			img := imageInspectDocument{ID: images[ref], RepoDigests: []string{ref}}
			raw, _ := json.Marshal(img)
			return response(200, string(raw)), nil
		}
		name := strings.TrimPrefix(path, "/containers/")
		action := ""
		if at := strings.LastIndex(name, "/"); at >= 0 {
			action = name[at+1:]
			name = name[:at]
		}
		doc := docs[name]
		if doc == nil {
			for _, v := range docs {
				if v.ID == name {
					doc = v
					name = strings.TrimPrefix(v.Name, "/")
					break
				}
			}
		}
		if req.Method == http.MethodGet {
			if doc == nil {
				return response(404, `{}`), nil
			}
			raw, _ := json.Marshal(doc)
			return response(200, string(raw)), nil
		}
		code := 204
		body := `{}`
		if path == "/containers/create" {
			name = req.URL.Query().Get("name")
			if docs[name] != nil {
				return response(409, `{}`), nil
			}
			var create createRequest
			if err := json.NewDecoder(req.Body).Decode(&create); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(create.HostConfig)
			doc = &inspectDocument{ID: fmt.Sprintf("new-%d", len(calls)), Name: "/" + name, Image: images[create.Image]}
			_ = json.Unmarshal(raw, &doc.HostConfig)
			doc.HostConfig.IpcMode = "private"
			raw, _ = json.Marshal(create)
			_ = json.Unmarshal(raw, &doc.Config)
			_ = json.Unmarshal([]byte(`{"Status":"created","Health":{"Status":"healthy"}}`), &doc.State)
			doc.NetworkSettings.Networks = map[string]struct {
				IPAddress string `json:"IPAddress"`
			}{spec.Network: {IPAddress: "172.30.0.2"}}
			docs[name] = doc
			action = "create"
			code = 201
			body = `{"Id":"` + doc.ID + `"}`
		} else if doc == nil {
			return response(404, `{}`), nil
		} else if req.Method == http.MethodDelete {
			delete(docs, name)
			action = "delete"
		} else {
			switch action {
			case "stop":
				doc.State.Status = "exited"
			case "start":
				doc.State.Status = "running"
			case "rename":
				delete(docs, name)
				newName := req.URL.Query().Get("name")
				doc.Name = "/" + newName
				docs[newName] = doc
			default:
				t.Fatalf("unexpected mutation %s %s", req.Method, path)
			}
		}
		calls = append(calls, action+":"+name)
		mutations++
		if failAt > 0 && mutations == failAt {
			return response(500, `{"message":"lost response"}`), nil
		}
		return response(code, body), nil
	})}
	return &EngineRuntime{client: client, baseURL: "http://docker/" + engineAPIVersion}, agent.ProtectedSetTransitionTarget{
		DesiredWorker: spec, DesiredTarget: target, PreviousTarget: &prior, DesiredCompanions: []agent.ProtectedCompanionStartPayload{companion}}, owner, docs, &calls
}

func TestCanonicalCompanionUpdateStageCommitAndReplay(t *testing.T) {
	r, change, owner, docs, calls := canonicalCompanionFixture(t, 0)
	ctx := context.Background()
	backup := "prior-test"
	if err := r.InspectProtectedSetTransitionTarget(ctx, change, backup, false); err != nil {
		t.Fatal(err)
	}
	if _, err := r.StageProtectedSetTransitionTarget(ctx, change, owner, backup); err != nil {
		t.Fatalf("stage: %v calls=%v", err, *calls)
	}
	if err := r.InspectProtectedSetTransitionTarget(ctx, change, backup, true); err != nil {
		t.Fatal(err)
	}
	if _, err := r.StageProtectedSetTransitionTarget(ctx, change, owner, backup); err != nil {
		t.Fatal(err)
	}
	if err := r.CommitProtectedSetTransitionTarget(ctx, change, owner, backup); err != nil {
		t.Fatal(err)
	}
	if err := r.CommitProtectedSetTransitionTarget(ctx, change, owner, backup); err != nil {
		t.Fatal(err)
	}
	if len(docs) != 2 || (*calls)[0] != "stop:ocr-provider" || !strings.HasPrefix((*calls)[1], "stop:teamaibox-worker-") {
		t.Fatalf("wrong order or leftovers: %v", *calls)
	}
}

func TestCanonicalCompanionUpdateLostResponseRestoresEveryBoundary(t *testing.T) {
	// Eight mutations: stop pair, rename pair, create/start Worker, create/start Provider.
	for point := 1; point <= 8; point++ {
		t.Run(fmt.Sprint(point), func(t *testing.T) {
			r, change, owner, docs, calls := canonicalCompanionFixture(t, point)
			_, _ = r.StageProtectedSetTransitionTarget(context.Background(), change, owner, "prior-test")
			if err := r.RollbackProtectedSetTransitionTarget(context.Background(), change, owner, "prior-test"); err != nil {
				t.Fatalf("rollback: %v calls=%v", err, *calls)
			}
			if err := r.RollbackProtectedSetTransitionTarget(context.Background(), change, owner, "prior-test"); err != nil {
				t.Fatal(err)
			}
			if len(docs) != 2 || docs[change.PreviousTarget.ContainerName].ID != "old-0" || docs["ocr-provider"].ID != "old-1" {
				t.Fatalf("original identities not restored: %v", *calls)
			}
			for _, doc := range docs {
				if !healthyRunningDocument(*doc) {
					t.Fatal("unhealthy restore")
				}
			}
		})
	}
}
