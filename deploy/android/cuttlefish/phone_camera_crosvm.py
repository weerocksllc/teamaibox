#!/usr/bin/python3
"""Candidate-only media backend bridge; original user runtimes stay untouched."""
import ctypes
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time

REAL = '/opt/teamaibox/camera-host/bin/crosvm'
BACKEND = '/opt/teamaibox/camera-host/bin/vhu_media_v4l2_stream_proxy'
DIRECTORY = Path('/tmp/phone-camera-input')
FIFO = DIRECTORY/'frame.mjpg'
SOCKET = DIRECTORY/'media.sock'


def media_arguments(args):
    if '--simple-media-device' not in args:
        return list(args), False
    command = args[1:] if args[:1] == ['--extended-status'] else args
    if command[:1] != ['run'] or args.count('--simple-media-device') != 1:
        raise RuntimeError('camera_candidate_arguments_invalid')
    result = list(args)
    result[result.index('--simple-media-device')] = '--vhost-user=type=media,socket='+str(SOCKET)
    return result, True


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
    if not FIFO.exists():
        os.mkfifo(FIFO, 0o600)
    info = FIFO.lstat()
    if not stat.S_ISFIFO(info.st_mode) or info.st_uid != 10001 or stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError('camera_candidate_fifo_invalid')
    if SOCKET.exists():
        raise RuntimeError('camera_candidate_socket_occupied')
    parent = os.getpid()

    def parent_death():
        # The backend belongs to this Android VM, not a host service. Reap it
        # even if crosvm exits unexpectedly; no process-name signalling.
        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM, 0, 0, 0) != 0 or os.getppid() != parent:
            os._exit(1)

    with (DIRECTORY/'backend.log').open('xb') as log:
        backend = subprocess.Popen([
            BACKEND, '--socket-path', str(SOCKET), '--verbosity', 'warn',
            '--input_path', str(FIFO), '--input_width', '640', '--input_height', '480', '--input_fps', '15',
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, preexec_fn=parent_death)
    try:
        deadline = time.monotonic()+5
        while not SOCKET.exists() and backend.poll() is None and time.monotonic() < deadline:
            time.sleep(.05)
        if backend.poll() is not None or not SOCKET.exists() or not stat.S_ISSOCK(SOCKET.lstat().st_mode):
            raise RuntimeError('camera_candidate_backend_not_ready')
        os.execv(REAL, [REAL, *args])
    finally:
        if backend.poll() is None:
            backend.terminate()
            try:
                backend.wait(timeout=3)
            except subprocess.TimeoutExpired:
                backend.kill()
                backend.wait(timeout=3)


if __name__ == '__main__':
    main()
