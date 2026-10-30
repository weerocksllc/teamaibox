package agent

import (
	"context"
	"encoding/json"
	"errors"
)

type PhoneStorageProvider interface {
	PhoneStorage(context.Context) (json.RawMessage, error)
}

func (s *Service) ConfigurePhoneStorage(provider PhoneStorageProvider) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if provider == nil || s.phoneStorage != nil || len(s.commands) != 0 {
		return errors.New("phone_storage_configuration_locked")
	}
	s.phoneStorage = provider
	return nil
}
