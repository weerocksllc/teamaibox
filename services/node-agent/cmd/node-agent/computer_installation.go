package main

import (
	"context"
	"errors"
	"io"
	"teamaibox.local/node-agent/internal/agent"
)

type computerInstallationDelegate interface {
	ExecuteComputerInstallation(context.Context, agent.CommandEnvelope, agent.AuthProof, io.Reader) (agent.ComputerResult, error)
}

func (service commandTypeRestrictedService) ExecuteComputerInstallation(ctx context.Context, envelope agent.CommandEnvelope, proof agent.AuthProof, input io.Reader) (agent.ComputerResult, error) {
	delegate, ok := service.delegate.(computerInstallationDelegate)
	if !ok || envelope.Type != "virtual-computer.installation" || !service.allowed[envelope.Type] {
		return agent.ComputerResult{}, errors.New("computer_installation_unavailable")
	}
	return delegate.ExecuteComputerInstallation(ctx, envelope, proof, input)
}
