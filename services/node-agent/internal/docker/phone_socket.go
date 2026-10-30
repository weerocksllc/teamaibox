package docker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
)

// Linux sockaddr_un is limited to 108 bytes. The encrypted pool's stable UUID
// paths are longer than that. Pin the validated phone directory and resolve
// the socket through its descriptor, without adding a listener, symlink, mount
// alias or changing the process working directory.
func dialPhoneSocket(ctx context.Context, dialer *net.Dialer, root *os.Root, dataRoot, volumeID, name string) (net.Conn, error) {
	if !managedWorkerID.MatchString(volumeID) || (name != ".media-control.sock" && name != ".adb-stream.sock") {
		return nil, errors.New("phone_socket_binding_invalid")
	}
	relative := filepath.Join(volumeID, "phone")
	before, err := root.Lstat(relative)
	if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("phone_socket_binding_invalid")
	}
	directory, err := root.Open(relative)
	if err != nil {
		return nil, errors.New("phone_socket_binding_invalid")
	}
	defer directory.Close()
	current, err := directory.Stat()
	if err != nil || !os.SameFile(before, current) {
		return nil, errors.New("phone_socket_binding_invalid")
	}
	path := filepath.Join(dataRoot, relative, name)
	if runtime.GOOS == "linux" {
		path = fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), name)
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0600 {
		return nil, errors.New("phone_socket_binding_invalid")
	}
	return dialer.DialContext(ctx, "unix", path)
}
