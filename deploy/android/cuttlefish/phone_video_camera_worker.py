#!/usr/bin/python3
"""Disposable uploaded-video decoder, supervised inside the phone cgroup."""
import json
import os
from pathlib import Path
import select
import signal
import sys
import threading
import time

from phone_camera_client import control
from phone_camera_input import CameraInputError
from phone_runtime import closed_json, validate_config, atomic_json
from phone_video_camera import VideoCameraError
from phone_video_camera_session import VideoCameraSession, validate_start


def parent_is_alive(parent, parent_fd):
    # A poll object cannot be polled concurrently: Python raises RuntimeError.
    # Capture, source watch and parent watch call this from different threads.
    # select() has per-call state; retain pidfd identity and immediate exit check.
    return os.getppid()==parent and not select.select([parent_fd],[],[],0)[0]


def record_exit(value, source, error=None):
    reason = str(error) if error is not None else getattr(source, 'reason', None)
    if not isinstance(reason,str) or not reason.startswith('phone_camera_') or not reason.replace('_','').isalnum():
        reason='phone_camera_runtime_unavailable' if error is not None else 'phone_camera_source_stopped'
    atomic_json(Path('/tmp/phone-camera-input/last-source-exit.json'),dict(
        sourceId=value['grant']['sourceId'],reason=reason,frames=getattr(source,'frames',0),
        errorType=type(error).__name__ if error is not None else None,
        watchErrorType=getattr(source,'watch_error_type',None),
        sourceDiagnostic=getattr(source,'last_source_diagnostic',None)))


def main(session_type=VideoCameraSession, validate=validate_start):
    if os.getuid()!=10001 or len(sys.argv)!=2 or not sys.argv[1].isdecimal():
        raise CameraInputError('phone_camera_request_invalid')
    fd=int(sys.argv[1])
    if fd<3:raise CameraInputError('phone_camera_request_invalid')
    parent=os.getppid()
    if parent==1:raise CameraInputError('phone_camera_source_stopped')
    parent_fd=os.pidfd_open(parent)
    alive=lambda:parent_is_alive(parent,parent_fd)
    if not alive():raise CameraInputError('phone_camera_source_stopped')
    stopped=threading.Event()
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:stopped.set())
    signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(CameraInputError('phone_camera_request_expired')))
    signal.alarm(3)
    config=validate_config(closed_json(Path('/run/phone/config.json').read_bytes()))
    raw=sys.stdin.buffer.readline(4097)
    if len(raw)>4096 or not raw.endswith(b'\n') or sys.stdin.buffer.read(1):
        raise CameraInputError('phone_camera_request_invalid')
    value=validate(closed_json(raw),config);signal.alarm(0)
    source=None;failure=None
    def watch_parent():
        while not stopped.wait(.1):
            if not alive():
                try:control({'action':'close','grant':value['grant']})
                finally:os._exit(0)  # No remaining supervisor to bound native teardown.
    watcher=threading.Thread(target=watch_parent,daemon=True);watcher.start()
    try:
        source=session_type(value,config,fd,broker=control,parent_alive=alive)
        os.close(fd);fd=None
        deadline=time.monotonic()+2
        while not source.ready.wait(.02):
            if source.done.is_set() or stopped.is_set() or time.monotonic()>=deadline:
                raise CameraInputError('phone_camera_source_stopped')
        if source.done.is_set() or stopped.is_set():raise CameraInputError('phone_camera_source_stopped')
        print(json.dumps({'sourceId':value['grant']['sourceId'],'state':'receiving'}),flush=True)
        while not stopped.wait(.1) and not source.done.is_set():pass
        return 0
    except Exception as error:
        failure=error
        raise
    finally:
        stopped.set()
        # Record before native cleanup: the supervisor can terminate a stuck
        # decoder, and initialization can fail before a session is returned.
        try:record_exit(value,source,failure)
        except OSError:pass
        try:control({'action':'close','grant':value['grant']})
        except Exception:pass
        if source is not None:
            source.close()
        watcher.join(1)
        if fd is not None:os.close(fd)
        os.close(parent_fd)


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        code='phone_camera_runtime_unavailable'
        if isinstance(error,VideoCameraError) and str(error) in {
            'phone_camera_video_format_unsupported','phone_camera_video_duration_unsupported',
            'phone_camera_video_input_invalid','phone_camera_video_decode_failed'}:
            code='phone_camera_video_unsupported'
        if isinstance(error,CameraInputError) and str(error)=='phone_camera_source_stopped':code=str(error)
        print(json.dumps({'errorCode':code}),flush=True)
        raise SystemExit(1)
