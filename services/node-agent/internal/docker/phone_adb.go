package docker

import (
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

func (d *PhoneDriver) OpenPhoneADB(ctx context.Context, p agent.PhoneMediaPayload) (net.Conn, error) {
	if p.Kind != "adb" || p.Run == nil {
		return nil, errors.New("phone_adb_binding_invalid")
	}
	b, err := d.resources.ResolveRun(ctx, p.PhoneCommandPayload)
	if err != nil {
		return nil, err
	}
	state, err := d.inspect(ctx, p.PhoneCommandPayload, b)
	if err != nil || state.RuntimeStopped || !state.AndroidReady {
		return nil, errors.New("phone_adb_not_ready")
	}
	return phoneADBSocket(ctx, d.policy.DataRoot, p)
}

func phoneADBSocket(ctx context.Context, dataRoot string, p agent.PhoneMediaPayload) (net.Conn, error) {
	if !phonePrivateRoot(dataRoot) || !managedWorkerID.MatchString(p.VolumeID) || p.Kind != "adb" || p.Run == nil {
		return nil, errors.New("phone_adb_binding_invalid")
	}
	root, err := os.OpenRoot(dataRoot)
	if err != nil {
		return nil, errors.New("phone_storage_unavailable")
	}
	defer root.Close()
	for _, path := range []string{p.VolumeID, filepath.Join(p.VolumeID, "phone")} {
		info, err := root.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("phone_adb_socket_invalid")
		}
	}
	relative := filepath.Join(p.VolumeID, "phone", ".adb-stream.sock")
	info, err := root.Lstat(relative)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		return nil, errors.New("phone_adb_socket_invalid")
	}
	connection, err := dialPhoneSocket(ctx, &net.Dialer{Timeout: time.Second}, root, dataRoot, p.VolumeID, ".adb-stream.sock")
	if err != nil {
		return nil, errors.New("phone_adb_unavailable")
	}
	accepted := false
	stopCancellation := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer func() {
		stopCancellation()
		if !accepted {
			_ = connection.Close()
		}
	}()
	if connection.SetDeadline(time.Now().Add(2*time.Second)) != nil || json.NewEncoder(connection).Encode(p.Grant()) != nil {
		return nil, errors.New("phone_adb_unavailable")
	}
	// Exact fixed acknowledgement, without buffering any subsequent ADB bytes.
	want := "{\"ready\":true}\n"
	raw := make([]byte, len(want))
	if _, err = io.ReadFull(connection, raw); err != nil || string(raw) != want || ctx.Err() != nil {
		return nil, errors.New("phone_adb_rejected")
	}
	if connection.SetDeadline(time.Time{}) != nil {
		return nil, errors.New("phone_adb_unavailable")
	}
	accepted = true
	return connection, nil
}
