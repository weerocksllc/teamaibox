package agent

import (
	"context"
	"encoding/json"
	"errors"
)

type PhoneUsbInventoryProvider interface {
	PhoneUsbInventory(context.Context) (json.RawMessage, error)
}

func (c *PhoneCoordinator) PhoneUsbInventory(ctx context.Context) (json.RawMessage, error) {
	provider, ok := c.driver.(PhoneUsbInventoryProvider)
	if !ok {
		return nil, errors.New("phone_camera_usb_not_configured")
	}
	return provider.PhoneUsbInventory(ctx)
}
