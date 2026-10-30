package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

type usbInventoryFixture struct {
	cameraFixture
	reads int
}

func (f *usbInventoryFixture) PhoneUsbInventory(context.Context) (json.RawMessage, error) {
	f.reads++
	return json.RawMessage(`{"nodeId":"test-node","data":[]}`), nil
}

func TestUsbInventoryCannotChooseHostDeviceOrNode(t *testing.T) {
	for i, payload := range []any{map[string]any{}, map[string]any{"nodeId": "other"}, map[string]any{"path": "/dev/video0"}, nil} {
		s, runtime, _ := serviceFixture(t)
		f := &usbInventoryFixture{}
		s.phones = f
		e := envelope(t, "00000000-0000-4000-8000-000000000993", "android-phone.camera.usb.inventory", payload, 1)
		if _, err := s.Handle(context.Background(), e, AuthProof{}); err == nil {
			t.Fatal("unsigned inventory accepted")
		}
		result, err := s.Handle(context.Background(), e, proof(t, e, "nonce-phone-usb-1"))
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			if result.Status != "succeeded" || f.reads != 1 {
				t.Fatalf("inventory failed: %+v", result)
			}
		} else if result.ErrorCode != "phone_camera_payload_invalid" || f.reads != 0 {
			t.Fatal("untrusted target accepted")
		}
		if runtime.starts != 0 || runtime.stops != 0 {
			t.Fatal("inventory mutated workers")
		}
	}
}

func TestUsbStartRequiresGrantAndAttachment(t *testing.T) {
	p := cameraPayload()
	p.Action = "usb"
	p.SourceKind = "usb"
	p.LeaseExpiresAt = 0
	p.DeviceID = newUUID()
	p.AttachmentID = strings.Repeat("a", 64)
	if !validPhoneCamera(p, time.Now()) {
		t.Fatal("USB start rejected")
	}
	result := PhoneCameraResult{PhoneCameraGrant: p.Grant(), State: "receiving", ResourceScope: "phone-run"}
	if !ValidPhoneCameraResult(p, result) {
		t.Fatal("USB acknowledgement rejected")
	}
	for _, change := range []func(*PhoneCameraPayload){func(p *PhoneCameraPayload) { p.DeviceID = "/dev/video0" }, func(p *PhoneCameraPayload) { p.AttachmentID = "old" }, func(p *PhoneCameraPayload) { p.Action = "image" }, func(p *PhoneCameraPayload) { p.SourceKind = "image" }} {
		q := p
		change(&q)
		if validPhoneCamera(q, time.Now()) {
			t.Fatal("invalid USB start accepted")
		}
	}
}
