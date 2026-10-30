//go:build linux

package telemetry

import (
	"os"
	"syscall"
)

func phoneKVMVersion() (int, error) {
	file, err := os.OpenFile("/dev/kvm", os.O_RDWR, 0)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	// Linux UAPI _IO(KVMIO=0xAE, 0x00), no VM allocation.
	// https://docs.kernel.org/virt/kvm/api.html#kvm-get-api-version
	version, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), 0xAE00, 0)
	if errno != 0 {
		return 0, errno
	}
	return int(version), nil
}
