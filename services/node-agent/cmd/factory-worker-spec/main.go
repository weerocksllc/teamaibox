// factory-worker-spec validates and normalizes factory worker declarations
// using the actual Node Agent types/policy. It does not contact Docker, start
// workers, read secrets or install anything. Ship this binary, not a second
// implementation of the Go JSON/start-spec identity contract in Python.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"

	"teamaibox.local/node-agent/internal/agent"
	"teamaibox.local/node-agent/internal/docker"
)

type input struct {
	TargetKey      string                   `json:"targetKey"`
	StageOrder     int                      `json:"stageOrder"`
	Payload        agent.WorkerStartPayload `json:"payload"`
	InstallationID string                   `json:"installationId"`
	NodeID         string                   `json:"nodeId"`
}

type output struct {
	Payload       agent.WorkerStartPayload   `json:"payload"`
	Target        agent.ExclusiveDrainTarget `json:"target"`
	CreateRequest any                        `json:"createRequest"`
}

func normalize(value input) (output, error) {
	s := value.Payload
	identifier := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	if !identifier.MatchString(value.InstallationID) || !identifier.MatchString(value.NodeID) {
		return output{}, errors.New("factory installation identity missing")
	}
	if value.StageOrder < 1 || value.StageOrder > 6 || s.PlacementClass != agent.PlacementProtectedResident || s.MaintenanceGeneration != 1 {
		return output{}, errors.New("invalid factory worker identity")
	}
	target := agent.ExclusiveDrainTarget{
		TargetKey: value.TargetKey, WorkerID: s.WorkerID, ModelProfileID: s.ModelProfileID,
		ContainerName: "teamaibox-worker-" + s.WorkerID, PlacementClass: s.PlacementClass,
		MaintenanceGeneration: 1, StageOrder: value.StageOrder, RequiredImageID: s.Image,
		RequiredImageDigest: s.Image, RequiredConfigDigest: s.ConfigDigest,
		RequiredStartSpecDigest: agent.WorkerStartSpecDigest(s),
		RequiredLabels:          map[string]string{"com.teamaibox.worker-id": s.WorkerID, "com.teamaibox.model-profile-id": s.ModelProfileID},
	}
	policy := agent.DefaultPolicy()
	policy.ExclusiveDrainTargets[value.TargetKey] = target
	if err := policy.ValidateStart(s); err != nil {
		return output{}, err
	}
	request := docker.WorkerCreateRequest(s, agent.Ownership{NodeID: value.NodeID, NodeGeneration: 1})
	// Installation-only ownership is additional metadata; all normal Agent
	// worker identity and start-spec labels are produced by the shared builder.
	raw, _ := json.Marshal(request)
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		return output{}, err
	}
	labels := document["Labels"].(map[string]any)
	labels["com.teamaibox.installation-id"] = value.InstallationID
	labels["com.teamaibox.service-role"] = "factory-worker"
	return output{Payload: s, Target: target, CreateRequest: document}, nil
}

func execute(reader io.Reader, writer io.Writer) error {
	decoder := json.NewDecoder(io.LimitReader(reader, 128<<10))
	decoder.DisallowUnknownFields()
	var value input
	if err := decoder.Decode(&value); err != nil {
		return errors.New("invalid factory worker specification")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("extra factory worker input")
	}
	result, err := normalize(value)
	if err != nil {
		return err
	}
	return json.NewEncoder(writer).Encode(result)
}

func main() {
	if err := execute(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "Factory worker specification rejected:", err)
		os.Exit(1)
	}
}
