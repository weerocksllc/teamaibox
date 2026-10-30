package docker

import (
	"context"
	"errors"
	"net"

	"teamaibox.local/node-agent/internal/agent"
)

func (d *ComputerDriver) OpenComputerDesktop(ctx context.Context, p agent.ComputerCommand, kind string) (net.Conn, error) {
	port := map[string]string{"rdp": "3389", "console": "5900", "audio": "4713"}[kind]
	if port == "" || p.Run == nil || p.Run.ContainerID == nil {
		return nil, errors.New("computer_desktop_unavailable")
	}
	b, err := d.resources.ResolveComputerRun(ctx, p)
	if err != nil {
		return nil, err
	}
	result, err := d.inspect(ctx, p, b)
	if err != nil || !result.Running {
		return nil, errors.New("computer_desktop_unavailable")
	}
	state, exists, err := d.engine.inspectComputerContainer(ctx, p, b)
	if err != nil || !exists || !state.State.Running || len(state.NetworkSettings.Networks) != 1 {
		return nil, errors.New("computer_desktop_unavailable")
	}
	for _, network := range state.NetworkSettings.Networks {
		ip := net.ParseIP(network.IPAddress)
		if network.NetworkID != b.NetworkID || ip == nil || ip.To4() == nil || !ip.IsPrivate() {
			return nil, errors.New("computer_desktop_network_invalid")
		}
		// The local Agent deliberately does not share each guest's isolated
		// bridge. Open the fixed loopback service through Docker's authenticated
		// exec transport instead of publishing a host port or weakening ICC.
		return d.engine.openComputerDesktop(ctx, state.ID, port)
	}
	return nil, errors.New("computer_desktop_unavailable")
}
