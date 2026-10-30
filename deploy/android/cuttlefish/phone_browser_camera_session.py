#!/usr/bin/python3
"""One disposable WebRTC decoder. Its parent is the phone-private controller.

No files hold SDP or frames. Native media faults cannot terminate Android or
the neutral-frame server. Authorization expires in the existing input broker.
"""
import json
import os
from pathlib import Path
import signal
import select
import socket
import sys
import threading

from phone_browser_camera import BrowserCameraReceiver, BrowserCameraError, address, offer_sdp
from phone_camera_client import control
from phone_camera_input import CameraInput, CameraInputError
from phone_network import recipe
from phone_runtime import closed_json, validate_config


def validate_start(value, config):
    if not isinstance(value, dict) or set(value) != {'grant','allowedAddresses','offerSdp'}:
        raise CameraInputError('phone_camera_request_invalid')
    grant = CameraInput.binding(type('Binding', (), {'config':config})(), value['grant'])
    if grant['sourceKind'] != 'browser':
        raise CameraInputError('phone_camera_source_unsupported')
    peers = value['allowedAddresses']
    if not isinstance(peers, list) or not 1 <= len(peers) <= 8 or len(set(peers)) != len(peers):
        raise CameraInputError('phone_camera_request_invalid')
    peers = [address(p) for p in peers]
    sdp = offer_sdp(value['offerSdp'], peers)
    return dict(grant=grant, allowedAddresses=peers, offerSdp=sdp)


def main():
    if os.getuid() != 10001:
        raise CameraInputError('phone_camera_uid_invalid')
    parent = os.getppid()
    if parent == 1:
        raise CameraInputError('phone_camera_source_stopped')
    # PR_SET_PDEATHSIG follows the spawning THREAD, not the whole parent.
    # A short-lived Unix RPC handler ends immediately after SDP negotiation.
    # Observe the process pidfd instead: it cannot be confused by PID reuse
    # and does not terminate capture when that harmless request thread exits.
    parent_fd = os.pidfd_open(parent)
    parent_poll = select.poll()
    parent_poll.register(parent_fd, select.POLLIN)
    if os.getppid() != parent or parent_poll.poll(0):
        raise CameraInputError('phone_camera_source_stopped')
    stopped = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopped.set())
    # A stalled parent cannot leave an uninitialized media process alive.
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(CameraInputError('phone_camera_request_expired')))
    signal.alarm(3)
    config = validate_config(closed_json(Path('/run/phone/config.json').read_bytes()))
    raw = sys.stdin.buffer.readline(73729)
    if not raw.endswith(b'\n') or len(raw) > 73728 or sys.stdin.buffer.read(1):
        raise CameraInputError('phone_camera_request_invalid')
    value = validate_start(closed_json(raw), config)
    grant = value['grant']
    if control({'action':'status','grant':grant})['state'] != 'waiting':
        raise CameraInputError('phone_camera_source_stopped')
    signal.alarm(0)
    # The packet-free UDP connect only selects the private namespace's local
    # interface. It does not change host routing or access a caller URL.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
        route.connect((value['allowedAddresses'][0], 9))
        bind = route.getsockname()[0]
    ports = recipe(config['instance'])
    receiver = None
    failure = threading.Event()
    def watch():
        while not stopped.wait(.1):
            try:
                if parent_poll.poll(0):
                    try:
                        control({'action':'close','grant':grant})
                    finally:
                        # Parent is gone, so no supervisor remains to bound a
                        # stuck native teardown. Reclaim this exact process.
                        os._exit(0)
                if failure.is_set() or control({'action':'status','grant':grant})['state'] not in ('waiting','receiving'):
                    stopped.set()
            except Exception:
                stopped.set()
    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        def deliver(frame, sequence):
            if stopped.is_set():
                raise CameraInputError('phone_camera_source_stopped')
            control({'action':'frame','grant':grant,'sequence':sequence}, frame)
        receiver = BrowserCameraReceiver(bind_address=bind, first_port=ports['mediaLast']-9,
            last_port=ports['mediaLast'], allowed_addresses=value['allowedAddresses'], deliver=deliver,
            on_failure=lambda _: failure.set())
        answer = receiver.offer(value['offerSdp'])
        if stopped.is_set():
            raise CameraInputError('phone_camera_source_stopped')
        print(json.dumps({'sourceId':grant['sourceId'],'answerSdp':answer,'bindAddress':bind}), flush=True)
        stopped.wait()
        return 0
    finally:
        stopped.set()
        # Clear first, before native pipeline teardown; this never closes a
        # replacement source because the input broker checks the entire grant.
        try:
            control({'action':'close','grant':grant})
        except Exception:
            pass
        if receiver is not None:
            receiver.close()
        watcher.join(2)
        os.close(parent_fd)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        code = str(error) if isinstance(error, (CameraInputError, BrowserCameraError)) else 'phone_camera_browser_runtime_unavailable'
        print(json.dumps({'errorCode':code}), flush=True)
        raise SystemExit(1)
