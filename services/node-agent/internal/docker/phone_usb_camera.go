package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"path/filepath"
	"time"
)

func (d *PhoneDriver) usbCameraRequest(ctx context.Context, request map[string]any) (json.RawMessage, error) {
	path := d.policy.UsbCameraSocket
	if !filepath.IsAbs(path) || filepath.Base(path) != "camera.sock" {
		return nil, errors.New("phone_camera_usb_not_configured")
	}
	peer, err := (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "unix", path)
	if err != nil {
		return nil, errors.New("phone_camera_usb_runtime_unavailable")
	}
	defer peer.Close()
	deadline := time.Now().Add(5 * time.Second)
	if request["action"] == "start" || request["action"] == "udp-start" {
		deadline = time.Now().Add(14 * time.Second)
	}
	if at, ok := ctx.Deadline(); ok && at.Before(deadline) {
		deadline = at
	}
	if err = peer.SetDeadline(deadline); err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { peer.Close() })
	defer stop()
	if err = json.NewEncoder(peer).Encode(request); err != nil {
		return nil, err
	}
	raw, err := bufio.NewReader(io.LimitReader(peer, 65537)).ReadBytes('\n')
	if err != nil || len(raw) > 65536 {
		return nil, errors.New("phone_camera_usb_result_invalid")
	}
	var reply struct {
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&reply) != nil || !errors.Is(decoder.Decode(&struct{}{}), io.EOF) {
		return nil, errors.New("phone_camera_usb_result_invalid")
	}
	if reply.Error != "" {
		switch reply.Error {
		case "phone_camera_usb_device_busy":
			return nil, errors.New("phone_camera_usb_busy")
		case "phone_camera_usb_device_changed":
			return nil, errors.New(reply.Error)
		case "phone_camera_udp_port_unavailable":
			return nil, errors.New(reply.Error)
		}
		return nil, errors.New("phone_camera_usb_runtime_unavailable")
	}
	if len(reply.Result) == 0 {
		return nil, errors.New("phone_camera_usb_result_invalid")
	}
	return reply.Result, nil
}

func (d *PhoneDriver) PhoneUsbInventory(ctx context.Context) (json.RawMessage, error) {
	raw, err := d.usbCameraRequest(ctx, map[string]any{"action": "inventory", "nodeId": d.policy.NodeID, "deadline": time.Now().Add(4 * time.Second).UnixMilli()})
	if err != nil {
		return nil, err
	}
	var result struct {
		NodeID string `json:"nodeId"`
		Data   []struct {
			DeviceID     string   `json:"deviceId"`
			AttachmentID string   `json:"attachmentId"`
			Name         string   `json:"name"`
			Formats      []string `json:"formats"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || !errors.Is(decoder.Decode(&struct{}{}), io.EOF) || result.NodeID != d.policy.NodeID || result.Data == nil {
		return nil, errors.New("phone_camera_usb_result_invalid")
	}
	return raw, nil
}
