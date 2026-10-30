#!/usr/bin/python3
"""Keep camera services beside crosvm, not among crosvm's device children.

Crosvm reaps its children on reset. A long-lived camera service must not be
in that set: otherwise crosvm's emergency process-group kill kills the
Cuttlefish restarter as well. Preserve crosvm's reset exit code after cleanup.
"""
import ctypes
import fcntl
import os
import signal
import stat
import subprocess
import sys
import time
from phone_camera_crosvm_base import media_arguments, REAL, BACKEND, DIRECTORY, SOCKET


def supervise(commands, vm_command, paths, directory):
    parent = os.getpid()
    children = []
    vm = None
    interrupted = False
    previous = {}
    owned = {}
    # A vhost backend may replace its listening socket after VM disconnect.
    # Own the private directory and named endpoints for this entire lifecycle,
    # not only their first inode (which is not stable across accept/rebind).
    directory_info = directory.lstat()
    if not stat.S_ISDIR(directory_info.st_mode) or directory_info.st_uid != os.getuid() or stat.S_IMODE(directory_info.st_mode) != 0o700:
        raise RuntimeError('camera_source_directory_invalid')
    lock = os.open(directory / 'owner.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        lock_info = os.fstat(lock)
        if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.getuid() or lock_info.st_nlink != 1:
            raise RuntimeError('camera_source_lock_invalid')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if any(path.parent != directory or path.exists() or path.is_symlink() for path in paths):
            raise RuntimeError('camera_source_path_occupied')
    except BaseException:
        os.close(lock)
        raise

    def parent_death():
        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) or os.getppid() != parent:
            os._exit(1)

    def stop_requested(signum, frame):
        nonlocal interrupted
        interrupted = True

    def terminate(child):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)

    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous[sig] = signal.signal(sig, stop_requested)
        for command, logname in commands:
            # Each VM reset has already removed this supervisor's sockets.
            # Logs are bounded diagnostics, never camera payloads.
            logpath = directory / logname
            fd = os.open(logpath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as log:
                child = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=log, preexec_fn=parent_death,
                    start_new_session=True)
            children.append(child)
        deadline = time.monotonic() + 5
        while not all(p.exists() for p in paths) and all(c.poll() is None for c in children) and time.monotonic() < deadline and not interrupted:
            time.sleep(.05)
        for path in paths:
            if path.exists():
                info = path.lstat()
                if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                    raise RuntimeError('camera_source_socket_invalid')
                owned[path] = (info.st_dev, info.st_ino)
        if interrupted or any(c.poll() is not None for c in children) or len(owned) != len(paths):
            raise RuntimeError('camera_source_not_ready')
        # A separate process group contains crosvm's own emergency cleanup.
        # Helpers are siblings, so normal reset does not wait on them.
        vm = subprocess.Popen(vm_command, preexec_fn=parent_death, start_new_session=True)
        while vm.poll() is None:
            if interrupted or any(c.poll() is not None for c in children):
                terminate(vm)
                return 1
            time.sleep(.05)
        # Extended crosvm reset status must reach process_restarter unchanged.
        return vm.returncode if vm.returncode >= 0 else 128 - vm.returncode
    finally:
        if vm is not None:
            terminate(vm)
        for child in reversed(children):
            terminate(child)
        try:
            current = directory.lstat()
            if (current.st_dev, current.st_ino) != (directory_info.st_dev, directory_info.st_ino):
                raise RuntimeError('camera_source_directory_changed')
            # Children are reaped, the directory is still exclusively owned,
            # and every exact endpoint was absent before these children started.
            for path in paths:
                try:
                    info = path.lstat()
                    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                        raise RuntimeError('camera_source_cleanup_identity_changed')
                    path.unlink()
                except FileNotFoundError:
                    pass
        finally:
            os.close(lock)
            for sig, handler in previous.items():
                signal.signal(sig, handler)


def main():
    args, media = media_arguments(sys.argv[1:])
    if not media:
        os.execv(REAL, [REAL, *args])
    if os.getuid() != 10001:
        raise RuntimeError('camera_candidate_uid_invalid')
    DIRECTORY.mkdir(mode=0o700, exist_ok=True)
    info = DIRECTORY.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 10001 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError('camera_candidate_directory_invalid')
    paths = (SOCKET, *(DIRECTORY / name for name in ('frames.sock', 'control.sock', 'browser.sock', 'video.sock', 'usb.sock', 'udp.sock')))
    if any(p.exists() or p.is_symlink() for p in paths):
        raise RuntimeError('camera_candidate_socket_occupied')
    commands = [
        (['python3', '-B', '/opt/teamaibox/phone_camera_input.py'], 'input.log'),
        ([BACKEND, '--socket-path', str(SOCKET), '--verbosity', 'warn', '--input_path', str(DIRECTORY / 'frames.sock'),
          '--input_width', '640', '--input_height', '480', '--input_fps', '15'], 'backend.log'),
        (['python3', '-B', '/opt/teamaibox/phone_browser_camera_control.py'], 'browser-control.log'),
        (['python3', '-B', '/opt/teamaibox/phone_video_camera_control.py'], 'video-control.log'),
        (['python3', '-B', '/opt/teamaibox/phone_usb_camera_control.py'], 'usb-control.log'),
        (['python3', '-B', '/opt/teamaibox/phone_udp_camera_control.py'], 'udp-control.log'),
    ]
    return supervise(commands, [REAL, *args], paths, DIRECTORY)


if __name__ == '__main__':
    raise SystemExit(main())
