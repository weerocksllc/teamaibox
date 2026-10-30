// One-time maintenance for networks retained by historical Windows runs.
// This command cannot start/stop a guest or alter its persistent files. It calls
// the same exact exited-container/network validation used by the normal Agent.
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
	"regexp"
	"time"

	"teamaibox.local/node-agent/internal/agent"
	"teamaibox.local/node-agent/internal/docker"
)

type unavailableMemory struct{}

func (unavailableMemory) PhoneMemorySamples(context.Context) ([]agent.PhoneMemorySample, error) {
	return nil, errors.New("maintenance_cannot_admit_guests")
}

func run() error {
	if len(os.Args) < 4 || os.Geteuid() != 10001 {
		return errors.New("usage: computer-network-reclaim CONFIG CONFIG_SHA256 RUN_ID...")
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != os.Args[2] {
		return errors.New("installed_configuration_changed")
	}
	var config struct {
		Version                                 int `json:"version"`
		NodeID, PoolID, DataRoot, StorageSocket string
		Resources                               docker.ComputerResourcePolicy
	}
	if json.Unmarshal(raw, &config) != nil || config.Version != 1 {
		return errors.New("installed_configuration_invalid")
	}
	engine, err := docker.NewEngineRuntime("/var/run/docker.sock")
	if err != nil {
		return err
	}
	storage, err := docker.NewInstalledComputerStorage(config.NodeID, config.PoolID, config.DataRoot, config.StorageSocket, engine)
	if err != nil {
		return err
	}
	resources, err := docker.NewInstalledComputerResources(config.Resources, storage, unavailableMemory{})
	if err != nil {
		return err
	}
	defer resources.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	id := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	for _, runID := range os.Args[3:] {
		if !id.MatchString(runID) {
			return errors.New("invalid_run_id")
		}
		raw, err := os.ReadFile(filepath.Join(config.Resources.ControlRoot, "runs", runID, "binding.json"))
		if err != nil {
			return err
		}
		var binding struct{ Command agent.ComputerCommand }
		if json.Unmarshal(raw, &binding) != nil || binding.Command.Run == nil || binding.Command.Run.ID != runID || binding.Command.NodeID != config.NodeID {
			return errors.New("run_binding_mismatch")
		}
		before, err := resources.ResolveComputerRun(ctx, binding.Command)
		if err != nil {
			return err
		}
		if err = resources.ReleaseComputerRun(ctx, binding.Command); err != nil {
			return err
		}
		after, err := resources.ResolveComputerRun(ctx, binding.Command)
		if err != nil || before.NetworkID != after.NetworkID {
			return errors.New("stopped_run_resolution_failed")
		}
		if err = resources.ReleaseComputerRun(ctx, binding.Command); err != nil {
			return err
		}
		if err = json.NewEncoder(os.Stdout).Encode(map[string]any{"runId": runID, "networkId": before.NetworkID, "released": true, "stoppedRunStillResolvable": true, "idempotentRelease": true, "diskTouched": false}); err != nil {
			return err
		}
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
