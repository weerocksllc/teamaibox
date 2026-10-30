package telemetry

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func atomicWrite(filename string, content []byte, mode os.FileMode, replace bool) error {
	directory := filepath.Dir(filename)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if !replace {
		if _, err := os.Lstat(filename); err == nil {
			return fmt.Errorf("%s already exists", filepath.Base(filename))
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	temporary, err := os.CreateTemp(directory, ".node-identity-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err = temporary.Chmod(mode); err == nil {
		_, err = temporary.Write(content)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temporaryName, filename)
}

type IdentityGenerationFile struct {
	Filename string
}

func (store IdentityGenerationFile) Advance(current, next int64) error {
	if !filepath.IsAbs(store.Filename) || current < 1 || next <= current {
		return errors.New("appliance generation advance is invalid")
	}
	value, err := os.ReadFile(store.Filename)
	if err == nil {
		if len(value) < 2 || len(value) > 32 || string(value) != fmt.Sprintf("%d\n", current) {
			return errors.New("appliance generation changed concurrently")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return atomicWrite(store.Filename, []byte(fmt.Sprintf("%d\n", next)), 0o600, true)
}
