package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

var _ agent.PhoneMediaDriver = (*PhoneDriver)(nil)

func (d *PhoneDriver) ControlPhoneMedia(ctx context.Context, action string, p agent.PhoneMediaPayload) (agent.PhoneMediaResult, error) {
	var empty agent.PhoneMediaResult
	b, err := d.resources.ResolveRun(ctx, p.PhoneCommandPayload)
	if err != nil {
		return empty, err
	}
	state, err := d.inspect(ctx, p.PhoneCommandPayload, b)
	if err != nil {
		return empty, err
	}
	if action == "close" && state.RuntimeStopped {
		return agent.PhoneMediaResult{PhoneMediaGrant: p.Grant(), PeerClosed: true}, nil
	}
	if state.RuntimeStopped || action != "close" && (!state.AndroidReady || !state.MediaReady) {
		return empty, errors.New("phone_media_not_ready")
	}
	return phoneMediaSocket(ctx, d.policy.DataRoot, p, action)
}

// Only a fixed, exact-run socket in the private phone volume. No Docker exec,
// host command, browser URL, path parameter, or raw operator/ADB port is used.
func phoneMediaSocket(ctx context.Context, dataRoot string, p agent.PhoneMediaPayload, action string) (agent.PhoneMediaResult, error) {
	var value agent.PhoneMediaResult
	if !phonePrivateRoot(dataRoot) || !managedWorkerID.MatchString(p.VolumeID) || p.Run == nil || (action != "open" && action != "renew" && action != "close") {
		return value, errors.New("phone_media_binding_invalid")
	}
	root, err := os.OpenRoot(dataRoot)
	if err != nil {
		return value, errors.New("phone_storage_unavailable")
	}
	defer root.Close()
	for _, path := range []string{p.VolumeID, filepath.Join(p.VolumeID, "phone")} {
		info, err := root.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return value, errors.New("phone_media_socket_invalid")
		}
	}
	relative := filepath.Join(p.VolumeID, "phone", ".media-control.sock")
	info, err := root.Lstat(relative)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		return value, errors.New("phone_media_socket_invalid")
	}
	deadline := time.Now().Add(4 * time.Second)
	if end, ok := ctx.Deadline(); ok && end.Before(deadline) {
		deadline = end
	}
	dialer := net.Dialer{Deadline: deadline}
	connection, err := dialPhoneSocket(ctx, &dialer, root, dataRoot, p.VolumeID, ".media-control.sock")
	if err != nil {
		return value, errors.New("phone_media_unavailable")
	}
	defer connection.Close()
	if connection.SetDeadline(deadline) != nil {
		return value, errors.New("phone_media_unavailable")
	}
	stopCancel := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stopCancel()
	request := map[string]any{"action": action, "grant": p.Grant()}
	if action != "close" {
		request["leaseExpiresAt"] = p.LeaseExpiresAt
	}
	if json.NewEncoder(connection).Encode(request) != nil {
		return value, errors.New("phone_media_unavailable")
	}
	raw, err := bufio.NewReader(io.LimitReader(connection, 8193)).ReadBytes('\n')
	if err != nil || len(raw) > 8192 {
		return value, errors.New("phone_media_unavailable")
	}
	defer func() {
		for i := range raw {
			raw[i] = 0
		}
	}()
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&value) != nil {
		return value, errors.New("phone_media_rejected")
	}
	if err := d.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return value, errors.New("phone_media_rejected")
	}
	if value.PhoneMediaGrant != p.Grant() || action == "close" && (!value.PeerClosed || value.PeerOpen || value.LeaseExpiresAt != 0) ||
		action != "close" && (!value.PeerOpen || value.PeerClosed || value.LeaseExpiresAt != p.LeaseExpiresAt) {
		return value, errors.New("phone_media_result_invalid")
	}
	return value, nil
}
