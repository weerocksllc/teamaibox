package agent

import (
	"context"
	"errors"
	"net"
	"time"
)

type PhoneADBRuntime interface {
	OpenPhoneADB(context.Context, PhoneMediaPayload) (net.Conn, error)
}

func (s *Service) OpenPhoneADB(ctx context.Context, p PhoneMediaPayload) (net.Conn, error) {
	if p.Kind != "adb" || !s.PhoneSignalLive(p) {
		return nil, errors.New("phone_adb_grant_expired")
	}
	r, ok := s.phones.(PhoneADBRuntime)
	if !ok {
		return nil, errors.New("phone_adb_not_configured")
	}
	return r.OpenPhoneADB(ctx, p)
}

func (c *PhoneCoordinator) OpenPhoneADB(ctx context.Context, p PhoneMediaPayload) (net.Conn, error) {
	c.mediaMu.RLock()
	defer c.mediaMu.RUnlock()
	if c.root == nil || p.Kind != "adb" || !validPhoneMedia("renew", p, time.Now()) {
		return nil, errors.New("phone_adb_binding_invalid")
	}
	j, err := c.read()
	if err != nil {
		return nil, err
	}
	r, ok := j.Phones[p.PhoneID]
	if !ok || r.Phase != "running" || r.Identity != p.PhoneIdentity || r.Generation != p.Generation || !samePhoneRun(r.Run, p.Run) {
		return nil, errors.New("phone_adb_stale_run")
	}
	d, ok := c.driver.(PhoneADBRuntime)
	if !ok {
		return nil, errors.New("phone_adb_not_configured")
	}
	return d.OpenPhoneADB(ctx, p)
}
