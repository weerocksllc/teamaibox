package main

import (
	"context"
	"encoding/json"

	"teamaibox.local/node-agent/internal/phonepool"
)

type installedPhoneStorage struct {
	client         phonepool.Client
	poolID, nodeID string
	generation     int64
}

func (p installedPhoneStorage) PhoneStorage(ctx context.Context) (json.RawMessage, error) {
	value, err := p.client.Observe(ctx, p.poolID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		NodeID         string `json:"nodeId"`
		NodeGeneration int64  `json:"nodeGeneration"`
		phonepool.Observation
	}{p.nodeID, p.generation, value})
}
