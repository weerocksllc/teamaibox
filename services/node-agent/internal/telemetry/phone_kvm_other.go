//go:build !linux

package telemetry

import "errors"

func phoneKVMVersion() (int, error) { return 0, errors.New("phone_kvm_unavailable") }
