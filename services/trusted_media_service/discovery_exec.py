"""Exec only the fixed private discovery daemons; die with the supervisor."""
import os
import signal
import sys


def main():
    try:
        if len(sys.argv) < 4 or sys.platform != "linux":
            raise ValueError()
        parent = int(sys.argv[1])
        if parent < 1 or os.getppid() != parent:
            raise ValueError()
        executable = sys.argv[2]
        if executable not in ("/usr/bin/dbus-daemon", "/usr/sbin/avahi-daemon"):
            raise ValueError()
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0 or os.getppid() != parent:
            raise ValueError()
        os.execve(executable, sys.argv[2:], os.environ)
    except Exception:
        os._exit(64)


if __name__ == "__main__":
    main()
