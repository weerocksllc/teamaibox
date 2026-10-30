//go:build !linux

package phonepool

import "net"

func peerUID(*net.UnixConn, uint32) bool { return false }
