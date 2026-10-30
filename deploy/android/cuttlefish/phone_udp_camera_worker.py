#!/usr/bin/python3
"""Supervised network camera: a connected sender is not required at startup."""
import json
import os
from pathlib import Path
import signal
import sys
import threading

from phone_camera_client import control
from phone_camera_input import CameraInputError
from phone_runtime import closed_json,validate_config
from phone_udp_camera_session import UdpCameraSession,validate_start
from phone_udp_ingress import UdpIngressError
from phone_video_camera_worker import parent_is_alive,record_exit


def main():
    if os.getuid()!=10001 or len(sys.argv)!=2 or not sys.argv[1].isdecimal() or int(sys.argv[1])<3:
        raise CameraInputError('phone_camera_request_invalid')
    fd=int(sys.argv[1]);parent=os.getppid()
    if parent==1:raise CameraInputError('phone_camera_source_stopped')
    parent_fd=os.pidfd_open(parent);alive=lambda:parent_is_alive(parent,parent_fd)
    source=None;value=None;failure=None;stopped=threading.Event()
    try:
        for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:stopped.set())
        signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(CameraInputError('phone_camera_request_expired')))
        signal.alarm(3)
        config=validate_config(closed_json(Path('/run/phone/config.json').read_bytes()))
        raw=sys.stdin.buffer.readline(4097)
        if len(raw)>4096 or not raw.endswith(b'\n') or sys.stdin.buffer.read(1):raise CameraInputError('phone_camera_request_invalid')
        value=validate_start(closed_json(raw),config);signal.alarm(0)
        if not alive():raise CameraInputError('phone_camera_source_stopped')
        source=UdpCameraSession(value,config,fd,broker=control,parent_alive=alive)
        os.close(fd);fd=None
        if source.done.is_set():raise CameraInputError('phone_camera_source_stopped')
        print(json.dumps({'sourceId':value['grant']['sourceId'],'state':'receiving' if source.ready.is_set() else 'waiting'}),flush=True)
        while not stopped.wait(.1) and not source.done.is_set():
            if not alive():break
        return 0
    except Exception as error:
        failure=error;raise
    finally:
        signal.alarm(0)
        if value:
            try:record_exit(value,source,failure)
            except OSError:pass
            try:control({'action':'close','grant':value['grant']})
            except Exception:pass
        if source:source.close()
        if fd is not None:os.close(fd)
        os.close(parent_fd)


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        code=str(error) if isinstance(error,(CameraInputError,UdpIngressError)) else 'phone_camera_runtime_unavailable'
        print(json.dumps({'errorCode':code}),flush=True);raise SystemExit(1)
