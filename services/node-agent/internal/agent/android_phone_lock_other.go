//go:build !linux && !darwin

package agent

import (
	"errors"
	"os"
)

func lockPhoneJournal(*os.File) error { return errors.New("phone_platform_unsupported") }
