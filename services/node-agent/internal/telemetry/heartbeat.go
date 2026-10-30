package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

type InventoryProvider interface {
	Snapshot(context.Context) (Inventory, error)
}

type FileInventoryProvider struct {
	Filename string
}

func (provider FileInventoryProvider) Snapshot(_ context.Context) (Inventory, error) {
	if !filepath.IsAbs(provider.Filename) {
		return Inventory{}, errors.New("inventory file path must be absolute")
	}
	file, err := os.Open(provider.Filename)
	if err != nil {
		return Inventory{}, err
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, maximumResponseBytes+1))
	if err != nil {
		return Inventory{}, err
	}
	if len(body) > maximumResponseBytes {
		return Inventory{}, errors.New("appliance inventory file is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	value := Inventory{}
	if err := decoder.Decode(&value); err != nil {
		return Inventory{}, errors.New("appliance inventory file is invalid")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return Inventory{}, errors.New("appliance inventory file contains trailing data")
	}
	if value.SchemaVersion != 1 || value.Architecture != "arm64" || value.AgentVersion == "" || value.Resources.CPU == nil || value.Resources.UnifiedMemory == nil || value.Resources.Accelerator == nil || value.Resources.Codecs == nil || value.Resources.Storage == nil || value.Resources.Network == nil || value.Reservations == nil {
		return Inventory{}, errors.New("appliance inventory file is incomplete")
	}
	return value, nil
}

type heartbeatClient interface {
	Heartbeat(context.Context, string, int64, Inventory) (*HeartbeatResponse, error)
}

type GenerationReconciler interface {
	Advance(current, next int64) error
}

type HeartbeatRunner struct {
	client     heartbeatClient
	provider   InventoryProvider
	nodeID     string
	generation int64
	interval   time.Duration
	maxSilence time.Duration
	clock      func() time.Time
	reconciler GenerationReconciler
}

func NewHeartbeatRunner(client heartbeatClient, provider InventoryProvider, nodeID string, generation int64, interval, maxSilence time.Duration) (*HeartbeatRunner, error) {
	if client == nil || provider == nil || nodeID == "" || generation < 1 || interval < time.Second || interval > 30*time.Second || maxSilence < 2*interval || maxSilence > 45*time.Second {
		return nil, errors.New("appliance heartbeat runner configuration is invalid")
	}
	return &HeartbeatRunner{client: client, provider: provider, nodeID: nodeID, generation: generation, interval: interval, maxSilence: maxSilence, clock: time.Now}, nil
}

func (runner *HeartbeatRunner) SetGenerationReconciler(reconciler GenerationReconciler) error {
	if reconciler == nil || runner.reconciler != nil {
		return errors.New("appliance generation reconciler is invalid")
	}
	runner.reconciler = reconciler
	return nil
}

func terminalHeartbeatError(err error) bool {
	failure := new(APIError)
	if !errors.As(err, &failure) {
		return false
	}
	if failure.Status == 401 || failure.Status == 403 {
		return true
	}
	return failure.Code == "stale_node_generation" || failure.Code == "managed_node_disabled" || failure.Code == "managed_node_not_found" || !failure.Retryable && failure.Status >= 400 && failure.Status < 500
}

func (runner *HeartbeatRunner) Run(ctx context.Context) error {
	return runner.RunWithReady(ctx, nil)
}

// Maintenance must hand off an accepted heartbeat before stopping the ordinary
// Agent. Readiness is not just a running process or a local inventory sample.
func (runner *HeartbeatRunner) RunWithReady(ctx context.Context, ready func()) error {
	lastInventory := runner.clock()
	ticker := time.NewTicker(runner.interval)
	defer ticker.Stop()
	for {
		inventory, err := runner.provider.Snapshot(ctx)
		if err == nil {
			lastInventory = runner.clock()
			_, err = runner.client.Heartbeat(ctx, runner.nodeID, runner.generation, inventory)
			if err == nil && ready != nil {
				ready()
				ready = nil
			}
		} else if runner.clock().Sub(lastInventory) >= runner.maxSilence {
			return errors.New("appliance inventory exceeded maximum silence")
		}
		if failure := new(APIError); errors.As(err, &failure) && failure.Code == "stale_node_generation" &&
			runner.reconciler != nil && failure.Details.CurrentGeneration > runner.generation {
			if reconcileError := runner.reconciler.Advance(runner.generation, failure.Details.CurrentGeneration); reconcileError != nil {
				return fmt.Errorf("appliance generation reconciliation failed: %w", reconcileError)
			}
			return fmt.Errorf("appliance generation advanced; restart required: %w", err)
		} else if terminalHeartbeatError(err) {
			return fmt.Errorf("appliance heartbeat was fenced: %w", err)
		}
		// A platform restart or temporary local transport failure is not a local
		// process failure. Keep the same agent and retry, just like metrics.
		// The scheduler independently stops admitting work after stale
		// heartbeats. Expiring commands and generation fences still apply;
		// explicit revocation above is never retried as a transport failure.
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
