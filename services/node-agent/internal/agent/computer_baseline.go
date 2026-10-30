package agent

import (
	"context"
	"encoding/json"
	"errors"
)

type ComputerBaselineProvider interface {
	ComputerBaseline(context.Context) (json.RawMessage, error)
}

func (c *ComputerCoordinator) ComputerBaseline(ctx context.Context) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	provider, ok := c.driver.(ComputerBaselineProvider)
	if !ok || c.root == nil {
		return nil, errors.New("computer_baseline_unavailable")
	}
	raw, err := provider.ComputerBaseline(ctx)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if json.Unmarshal(raw, &result) != nil || result == nil {
		return nil, errors.New("computer_baseline_unavailable")
	}
	result["nodeId"] = c.policy.NodeID
	result["nodeGeneration"] = c.policy.NodeGeneration
	return json.Marshal(result)
}
