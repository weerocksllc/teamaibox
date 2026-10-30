package agent

import (
	"context"
	"errors"
	"net"
)

type ComputerDesktopProvider interface {
	OpenComputerDesktop(context.Context, ComputerCommand, string) (net.Conn, error)
}

// HTTP authentication and signed inspect run first. Recheck the stable guest
// binding again when opening the stream; never accept a browser-supplied host.
func (s *Service) OpenComputerDesktop(ctx context.Context, p ComputerCommand, kind string) (net.Conn, error) {
	s.mu.Lock()
	provider, ok := s.computers.(ComputerDesktopProvider)
	s.mu.Unlock()
	if !ok {
		return nil, errors.New("computer_desktop_unavailable")
	}
	return provider.OpenComputerDesktop(ctx, p, kind)
}
func (c *ComputerCoordinator) OpenComputerDesktop(ctx context.Context, p ComputerCommand, kind string) (net.Conn, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	provider, ok := c.driver.(ComputerDesktopProvider)
	if !ok || c.root == nil || !validComputerCommand("inspect", p) || p.Run == nil || p.Run.ContainerID == nil ||
		p.NodeID != c.policy.NodeID || p.PoolID != c.policy.PoolID || c.policy.InstalledProfiles[p.ProfileID] == "" ||
		(kind != "rdp" && kind != "console" && kind != "audio") {
		return nil, errors.New("computer_desktop_unavailable")
	}
	j, err := c.read(false)
	if err != nil {
		return nil, err
	}
	record, exists := j.Computers[p.ComputerID]
	if !exists || record.Command.RuntimeImage != p.RuntimeImage || (record.Phase != "running" && record.Phase != "stopping") || record.Command.OwnerID != p.OwnerID || record.Command.Generation != p.Generation ||
		!sameComputerStorage(record.Command, p) || record.Command.Run == nil || !sameComputerRun(record.Command.Run, p.Run) || computerRecordedContainer(record) != *p.Run.ContainerID {
		return nil, errors.New("computer_desktop_unavailable")
	}
	return provider.OpenComputerDesktop(ctx, p, kind)
}
