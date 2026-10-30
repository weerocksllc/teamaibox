//go:build linux

package phonepool

import (
	"net"
	"syscall"
)

func peerUID(c *net.UnixConn, uid uint32) bool {
	raw, e := c.SyscallConn()
	if e != nil {
		return false
	}
	ok := false
	e = raw.Control(func(fd uintptr) {
		cred, err := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		ok = err == nil && cred.Uid == uid
	})
	return e == nil && ok
}
