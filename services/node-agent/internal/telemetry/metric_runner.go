package telemetry

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type MetricProvider interface {
	Snapshot(context.Context) (MetricSnapshot, error)
}

type metricClient interface {
	Metrics(context.Context, string, int64, MetricSnapshot) (*MetricResponse, error)
}

type MetricRunner struct {
	client     metricClient
	provider   MetricProvider
	nodeID     string
	generation int64
	interval   time.Duration
	reconciler GenerationReconciler
}

func NewMetricRunner(client metricClient, provider MetricProvider, nodeID string, generation int64, interval time.Duration) (*MetricRunner, error) {
	if client == nil || provider == nil || nodeID == "" || generation < 1 || interval < 5*time.Second || interval > 30*time.Second {
		return nil, errors.New("appliance metric runner configuration is invalid")
	}
	return &MetricRunner{client: client, provider: provider, nodeID: nodeID, generation: generation, interval: interval}, nil
}

func (runner *MetricRunner) SetGenerationReconciler(reconciler GenerationReconciler) error {
	if reconciler == nil || runner.reconciler != nil {
		return errors.New("appliance metric generation reconciler is invalid")
	}
	runner.reconciler = reconciler
	return nil
}

func (runner *MetricRunner) Run(ctx context.Context) error {
	ticker := time.NewTicker(runner.interval)
	defer ticker.Stop()
	for {
		snapshot, err := runner.provider.Snapshot(ctx)
		if err == nil {
			_, err = runner.client.Metrics(ctx, runner.nodeID, runner.generation, snapshot)
		}
		if failure := new(APIError); errors.As(err, &failure) && failure.Code == "stale_node_generation" &&
			runner.reconciler != nil && failure.Details.CurrentGeneration > runner.generation {
			if reconcileError := runner.reconciler.Advance(runner.generation, failure.Details.CurrentGeneration); reconcileError != nil {
				return fmt.Errorf("appliance metric generation reconciliation failed: %w", reconcileError)
			}
			return fmt.Errorf("appliance generation advanced; restart required: %w", err)
		}
		if err != nil && terminalMetricError(err) {
			return fmt.Errorf("appliance metric reporting was fenced: %w", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func terminalMetricError(err error) bool {
	failure := new(APIError)
	// After a control-plane outage a node can be offline until its next
	// heartbeat is accepted. Metrics are not a heartbeat and cannot make it
	// ready. Wait for the normal heartbeat loop instead of restarting the
	// whole Agent (and losing its active connections).
	if errors.As(err, &failure) && failure.Status == 409 && failure.Code == "managed_node_not_reporting" {
		return false
	}
	// A rejected measurement is not revoked node authority. Keep heartbeats,
	// guest control and the HTTP server alive; the next sample may be valid.
	// The server continues rejecting the bad sample rather than accepting it.
	if errors.As(err, &failure) && failure.Status == 400 &&
		(failure.Code == "node_metric_invalid" || failure.Code == "node_metric_sensitive") {
		return false
	}
	return terminalHeartbeatError(err)
}
