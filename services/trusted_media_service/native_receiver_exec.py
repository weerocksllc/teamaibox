"""Private exec trampoline: map inherited anonymous IPC/media FDs, then exec.

Not a public command runner. The parent supplies only its package-owned native
receiver and fixed arguments. Mapping happens after spawn, never in a Python
preexec_fn while the threaded supervisor is running.
"""
import fcntl
import os
import signal
import sys
import resource


def main() -> None:
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if len(sys.argv) < 7:
            raise ValueError()
        parent_pid = int(sys.argv[1])
        # The supervisor legitimately runs as PID 1 inside its container.
        if parent_pid < 1 or os.getppid() != parent_pid:
            raise ValueError()
        if sys.platform == "linux":
            import ctypes
            libc = ctypes.CDLL(None, use_errno=True)
            # Exit with the supervisor rather than retaining a stale receiver
            # after its crash. Check PPID again to close the prctl setup race.
            if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0 or os.getppid() != parent_pid:
                raise ValueError()
        inherited = [int(value) for value in sys.argv[2:5]]
        if len(set(inherited)) != 3 or any(value < 3 for value in inherited):
            raise ValueError()
        # Duplicate first so a source descriptor numbered 3/4/5 cannot be
        # overwritten while mapping another source to its fixed destination.
        copies = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 6) for fd in inherited]
        for source, target in zip(copies, (3, 4, 5)):
            os.dup2(source, target, inheritable=True)
        for fd in set(inherited + copies) - {3, 4, 5}:
            os.close(fd)
        os.execve(sys.argv[5], sys.argv[5:], os.environ)
    except Exception:
        # Never expose launch arguments, inherited environment or media/PIN.
        os._exit(64)


if __name__ == "__main__":
    main()
