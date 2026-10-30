//go:build linux || darwin

package agent

import (
	"os"
	"syscall"
)

func lockPhoneJournal(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}
