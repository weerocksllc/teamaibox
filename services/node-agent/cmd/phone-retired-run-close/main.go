// Local maintenance only: close one exactly bound old-generation run, retaining
// its data, before the normal Agent can adopt the newer authenticated generation.
// This executable has no listener, start, delete, or generation-write operation.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"teamaibox.local/node-agent/internal/agent"
	docker "teamaibox.local/node-agent/internal/docker"
)

type request struct {
	Config, Directory, ConfigSHA256, JournalSHA256, PhoneID, RunID string
	OldGeneration, NewGeneration                                   int64
}
type config struct {
	NodeID, PoolID, ImageID, DataRoot, ControlRoot, StorageSocket, SeccompFile, NetworkProfile, MediaAddress string
	AdditionalImageDigests, RetiredImageDigests                                                              []string
	RuntimeMaintenance                                                                                       []agent.PhoneRuntimeMaintenance
	KVMGroup, VhostGroup                                                                                     uint32
}
type record struct {
	Identity   agent.PhoneIdentity     `json:"identity"`
	Generation uint64                  `json:"generation"`
	Run        *agent.PhoneRunIdentity `json:"run"`
	Phase      string                  `json:"phase"`
}
type journal struct {
	NodeID         string            `json:"nodeId"`
	NodeGeneration int64             `json:"nodeGeneration"`
	Phones         map[string]record `json:"phones"`
}

func readBound(path, expected string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !filepath.IsAbs(path) || !info.Mode().IsRegular() || info.Size() > 4<<20 || len(expected) != 64 {
		return nil, errors.New("maintenance_binding_invalid")
	}
	raw, err := os.ReadFile(path)
	h := sha256.Sum256(raw)
	if err != nil || hex.EncodeToString(h[:]) != expected {
		return nil, errors.New("maintenance_bytes_changed")
	}
	return raw, nil
}

func run() error {
	if os.Geteuid() != 10001 || len(os.Args) != 2 || os.Args[1] != "--close-exact-run" {
		return errors.New("maintenance_invocation_denied")
	}
	var q request
	d := json.NewDecoder(os.Stdin)
	d.DisallowUnknownFields()
	if d.Decode(&q) != nil || q.OldGeneration < 1 || q.NewGeneration <= q.OldGeneration {
		return errors.New("maintenance_request_invalid")
	}
	raw, err := readBound(q.Config, q.ConfigSHA256)
	if err != nil {
		return err
	}
	var c config
	if json.Unmarshal(raw, &c) != nil {
		return errors.New("maintenance_config_invalid")
	}
	raw, err = readBound(filepath.Join(q.Directory, "phones.json"), q.JournalSHA256)
	if err != nil {
		return err
	}
	var j journal
	if json.Unmarshal(raw, &j) != nil || j.NodeID != c.NodeID || j.NodeGeneration != q.OldGeneration {
		return errors.New("maintenance_journal_changed")
	}
	r, ok := j.Phones[q.PhoneID]
	if !ok || r.Phase != "running" || r.Identity.PhoneID != q.PhoneID || r.Run == nil || r.Run.ID != q.RunID {
		return errors.New("maintenance_run_changed")
	}
	for id, other := range j.Phones {
		if id != q.PhoneID && other.Phase != "stopped" && other.Phase != "deleted" {
			return errors.New("maintenance_other_active_phone")
		}
	}
	seccomp, err := os.ReadFile(c.SeccompFile)
	if err != nil {
		return err
	}
	p := docker.PhoneContainerPolicy{NodeID: c.NodeID, NodeGeneration: q.OldGeneration, PoolID: c.PoolID, ImageID: c.ImageID,
		DataRoot: c.DataRoot, ControlRoot: c.ControlRoot, KVMGroup: c.KVMGroup, VhostGroup: c.VhostGroup, Seccomp: seccomp,
		NetworkProfile: c.NetworkProfile, MediaAddress: c.MediaAddress, AdditionalImageDigests: c.AdditionalImageDigests, RetiredImageDigests: c.RetiredImageDigests}
	e, err := docker.NewEngineRuntime("/var/run/docker.sock")
	if err != nil {
		return err
	}
	resources, err := docker.NewInstalledPhoneResources(e, p, c.StorageSocket)
	if err != nil {
		return err
	}
	defer resources.Close()
	driver, err := docker.NewPhoneDriver(e, p, resources)
	if err != nil {
		return err
	}
	coordinator, err := agent.NewPhoneCoordinator(q.Directory, agent.PhoneRuntimePolicy{NodeID: c.NodeID, NodeGeneration: q.OldGeneration, PoolID: c.PoolID,
		ImageDigest: c.ImageID, AdditionalImageDigests: c.AdditionalImageDigests, RetiredImageDigests: c.RetiredImageDigests, RuntimeMaintenance: c.RuntimeMaintenance}, driver)
	if err != nil {
		return err
	}
	defer coordinator.Close()
	// Recheck after obtaining the same cross-process lock as the installed Agent.
	if _, err := readBound(filepath.Join(q.Directory, "phones.json"), q.JournalSHA256); err != nil {
		return err
	}
	payload := agent.PhoneCommandPayload{PhoneIdentity: r.Identity, OperationID: q.PhoneID, Generation: r.Generation, Run: r.Run}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	before, err := driver.InspectPhone(ctx, payload)
	if err != nil || before.RuntimeStopped {
		return errors.New("maintenance_live_run_unconfirmed")
	}
	result, err := coordinator.ExecutePhone(ctx, "stop", payload, agent.Ownership{NodeID: c.NodeID, NodeGeneration: q.OldGeneration, LeaseID: q.PhoneID, FencingToken: r.Generation + 1})
	if err != nil {
		return err
	}
	if !result.RuntimeStopped || !result.CleanShutdown || result.DataDeleted {
		return errors.New("maintenance_clean_stop_unconfirmed")
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
