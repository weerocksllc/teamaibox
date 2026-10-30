package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"teamaibox.local/node-agent/internal/agent"
)

func (d *PhoneDriver) ExecutePhoneCamera(ctx context.Context, p agent.PhoneCameraPayload, input io.Reader) (agent.PhoneCameraResult, error) {
	var empty agent.PhoneCameraResult
	b, err := d.resources.ResolveRun(ctx, p.PhoneCommandPayload)
	if err != nil {
		return empty, err
	}
	state, err := d.inspect(ctx, p.PhoneCommandPayload, b)
	if err != nil {
		return empty, err
	}
	if state.RuntimeStopped && p.Action == "close" {
		zero := int64(0)
		return agent.PhoneCameraResult{PhoneCameraGrant: p.Grant(), State: "stopped", ResourceScope: "phone-run", RetainedFrameBytes: &zero}, nil
	}
	if state.RuntimeStopped || !state.AndroidReady {
		return empty, errors.New("phone_camera_not_ready")
	}
	if p.Action == "usb" || p.Action == "udp" {
		request := map[string]any{"action": "start", "nodeId": d.policy.NodeID,
			"deadline": p.Deadline, "containerId": state.ContainerID, "grant": p.Grant()}
		if p.Action == "udp" {
			request["action"] = "udp-start"
			request["policy"] = p.UDPPolicy
		} else {
			request["deviceId"] = p.DeviceID
			request["attachmentId"] = p.AttachmentID
		}
		raw, err := d.usbCameraRequest(ctx, request)
		if err != nil {
			return empty, err
		}
		var result agent.PhoneCameraResult
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&result) != nil || !errors.Is(decoder.Decode(&struct{}{}), io.EOF) || !agent.ValidPhoneCameraResult(p, result) {
			return empty, errors.New("phone_camera_result_invalid")
		}
		return result, nil
	}
	header := map[string]any{"action": p.Action, "grant": p.Grant(), "deadline": p.Deadline}
	if p.Action == "open" || p.Action == "renew" {
		header["leaseExpiresAt"] = p.LeaseExpiresAt
	}
	if p.Action == "image" || p.Action == "video" || p.Action == "browser-offer" {
		header["sizeBytes"] = p.SizeBytes
		header["sha256"] = p.SHA256
	}
	if p.Action == "video" {
		header["loop"] = p.Loop
	}
	if p.Action == "browser-offer" {
		header["peerAddress"] = p.PeerAddress
	}
	raw, err := json.Marshal(header)
	if err != nil {
		return empty, errors.New("phone_camera_payload_invalid")
	}
	defer clear(raw)
	var output bytes.Buffer
	err = d.engine.execPhoneInput(ctx, state.ContainerID, "camera", io.MultiReader(bytes.NewReader(append(raw, '\n')), input), &output)
	defer clear(output.Bytes())
	if err != nil {
		return empty, cameraWorkerError(output.Bytes())
	}
	decoder := json.NewDecoder(&output)
	decoder.DisallowUnknownFields()
	var result agent.PhoneCameraResult
	if decoder.Decode(&result) != nil || !errors.Is(decoder.Decode(&struct{}{}), io.EOF) {
		return empty, errors.New("phone_camera_result_invalid")
	}
	if p.Action == "browser-offer" {
		// Reuse the already-installed phone network declaration. The decoder
		// may report its own namespace address, never choose the public node.
		endpoint, err := d.PhoneSignalEndpoint(ctx, agent.PhoneMediaPayload{PhoneCommandPayload: p.PhoneCommandPayload})
		if err != nil || result.ContainerAddress != endpoint.MediaContainerAddress || endpoint.MediaAddress == "" || result.NodeAddress != "" || result.FirstPort != 0 || result.LastPort != 0 {
			return empty, errors.New("phone_camera_network_invalid")
		}
		result.NodeAddress = endpoint.MediaAddress
		result.FirstPort = endpoint.MediaFirstPort + 40
		result.LastPort = endpoint.MediaLastPort
	}
	if !agent.ValidPhoneCameraResult(p, result) {
		return empty, errors.New("phone_camera_result_invalid")
	}
	return result, nil
}

func cameraWorkerError(raw []byte) error {
	// Only small, known public errors are forwarded; never exception strings,
	// paths, decoder stderr or a private image embedded in an error response.
	var result struct {
		Code string `json:"errorCode"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if len(raw) <= 256 && d.Decode(&result) == nil && errors.Is(d.Decode(&struct{}{}), io.EOF) {
		switch result.Code {
		case "phone_camera_image_unsupported", "phone_camera_image_too_large", "phone_camera_video_unsupported", "phone_camera_video_too_large", "phone_camera_source_stopped", "phone_camera_storage_full", "phone_camera_video_memory_unavailable":
			return errors.New(result.Code)
		}
	}
	return errors.New("phone_camera_worker_failed")
}
