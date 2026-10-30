#!/usr/bin/python3
"""Small phone-private decoder supervisor. Not an HTTP/auth/media service.

The Node Agent authenticates requests and opens/renews the existing camera
grant. This process only starts one fixed decoder for that grant, inside the
same phone budget, and reaps it on close, expiry or decoder failure.
"""
import json
import os
from pathlib import Path
import selectors
import signal
import socketserver
import stat
import struct
import subprocess
import threading
import time

from phone_browser_camera_session import validate_start
from phone_camera_client import control
from phone_camera_input import CameraInput, CameraInputError, PrivateServer, receive
from phone_runtime import closed_json, validate_config

SOCKET = Path('/tmp/phone-camera-input/browser.sock')


class ReceiverProcess:
    def __init__(self, value):
        self._lock = threading.Lock()
        self.process = subprocess.Popen(['/usr/bin/python3','-B','/opt/teamaibox/phone_browser_camera_session.py'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.raw = (json.dumps(value, separators=(',',':'))+'\n').encode()

    def answer(self):
        output = bytearray()
        deadline = time.monotonic()+10
        with selectors.DefaultSelector() as selected:
            for stream in (self.process.stdin, self.process.stdout):
                os.set_blocking(stream.fileno(), False)
            selected.register(self.process.stdin, selectors.EVENT_WRITE)
            selected.register(self.process.stdout, selectors.EVENT_READ)
            offset = 0
            while time.monotonic() < deadline and self.process.poll() is None:
                for key, mask in selected.select(.1):
                    if mask & selectors.EVENT_WRITE:
                        offset += os.write(key.fd, self.raw[offset:offset+16384])
                        if offset == len(self.raw):
                            selected.unregister(key.fileobj)
                            self.process.stdin.close()
                            self.raw = b''
                    else:
                        block = os.read(key.fd, 8192)
                        if not block:
                            raise CameraInputError('phone_camera_browser_runtime_unavailable')
                        output.extend(block)
                        if len(output) > 73728:
                            raise CameraInputError('phone_camera_browser_response_invalid')
                        if b'\n' in output:
                            if not output.endswith(b'\n') or output.count(b'\n') != 1:
                                raise CameraInputError('phone_camera_browser_response_invalid')
                            value = closed_json(output)
                            if 'errorCode' in value:
                                raise CameraInputError('phone_camera_browser_negotiation_failed')
                            return value
        raise CameraInputError('phone_camera_browser_negotiation_failed')

    def alive(self):
        return self.process.poll() is None

    def exit_code(self):
        return self.process.poll()

    def close(self):
        with self._lock:
            self.raw = b''
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(.5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(1)
            # No more reads are possible after the worker has exited. The
            # negotiation thread may be cancelled concurrently; it fails shut.
            for stream in (self.process.stdin, self.process.stdout):
                if not stream.closed:
                    stream.close()


class BrowserCameraControl:
    def __init__(self, config, broker=control, factory=ReceiverProcess):
        self.config, self.broker, self.factory = config, broker, factory
        self.lock = threading.RLock()
        self.active = None
        self.closed = False
        self.last = None

    def binding(self, grant):
        value = CameraInput.binding(type('Binding', (), {'config':self.config})(), grant)
        if value['sourceKind'] != 'browser':
            raise CameraInputError('phone_camera_source_unsupported')
        return value

    def _drop(self):
        active, self.active = self.active, None
        if active is not None:
            # This close is source-specific. It cannot revoke a newer source.
            try:
                self.broker({'action':'close','grant':active['grant']})
            finally:
                active['process'].close()
                self.last = {'sourceId':active['grant']['sourceId'], 'workerRunning':False,
                             'exitCode':active['process'].exit_code() if hasattr(active['process'],'exit_code') else None}

    def offer(self, value):
        value = validate_start(value, self.config)
        grant = value['grant']
        with self.lock:
            if self.closed:
                raise CameraInputError('phone_camera_source_stopped')
            if self.active is not None:
                raise CameraInputError('phone_camera_browser_already_started')
            if self.broker({'action':'status','grant':grant})['state'] != 'waiting':
                raise CameraInputError('phone_camera_source_stopped')
            active = {'grant':grant,'process':self.factory(value)}
            self.active = active
        try:
            # Never hold the state lock during SDP gathering. Close/expiry can
            # interrupt a stalled negotiation, without blocking grant renewal.
            result = active['process'].answer()
            with self.lock:
                if self.closed or self.active is not active or not active['process'].alive():
                    raise CameraInputError('phone_camera_source_stopped')
                if self.broker({'action':'status','grant':grant})['state'] not in ('waiting','receiving'):
                    raise CameraInputError('phone_camera_source_stopped')
                if not isinstance(result, dict) or set(result) != {'sourceId','answerSdp','bindAddress'} or result['sourceId'] != grant['sourceId']:
                    raise CameraInputError('phone_camera_browser_response_invalid')
                if not isinstance(result['answerSdp'], str) or not 1 <= len(result['answerSdp'].encode()) <= 65536:
                    raise CameraInputError('phone_camera_browser_response_invalid')
                return result
        except BaseException:
            with self.lock:
                if self.active is active:
                    self._drop()
            raise

    def stop(self, grant):
        grant = self.binding(grant)
        with self.lock:
            # Always revoke the requested grant, including a late close after
            # its process has failed. Never kill a different active source.
            self.broker({'action':'close','grant':grant})
            if self.active is not None and self.active['grant'] == grant:
                self._drop()
            state = self.broker({'action':'status','grant':grant})
            if state['state'] != 'stopped' or state['retainedFrameBytes'] != 0:
                raise CameraInputError('phone_camera_runtime_unavailable')
            return {'sourceId':grant['sourceId'],'state':'stopped','retainedFrameBytes':0}

    def check(self):
        with self.lock:
            if self.active is None:
                return
            try:
                state = self.broker({'action':'status','grant':self.active['grant']})
                healthy = self.active['process'].alive() and state['state'] in ('waiting','receiving')
            except Exception:
                healthy = False
            if not healthy:
                self._drop()

    def status(self, grant):
        grant = self.binding(grant)
        with self.lock:
            if self.active is not None and self.active['grant'] == grant:
                process = self.active['process']
                return {'sourceId':grant['sourceId'],'workerRunning':process.alive(),
                        'exitCode':process.exit_code() if hasattr(process,'exit_code') else None}
            if self.last is not None and self.last['sourceId'] == grant['sourceId']:
                return dict(self.last)
            return {'sourceId':grant['sourceId'],'workerRunning':False,'exitCode':None}

    def close(self):
        with self.lock:
            self.closed = True
            self._drop()


def serve(config, path=SOCKET):
    manager = BrowserCameraControl(config)
    stopped = threading.Event()
    slots = threading.BoundedSemaphore(3)
    class Server(socketserver.ThreadingMixIn, PrivateServer):
        daemon_threads = True
        block_on_close = False
        def process_request(self, request, address):
            if not slots.acquire(blocking=False):
                request.close()
                return
            try:
                super().process_request(request,address)
            except BaseException:
                slots.release()
                raise
        def process_request_thread(self, request, address):
            try:
                super().process_request_thread(request,address)
            finally:
                slots.release()
    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.settimeout(2)
            try:
                size = struct.unpack('!I', receive(self.request,4))[0]
                if not 1 <= size <= 73728:
                    raise CameraInputError('phone_camera_request_invalid')
                value = closed_json(receive(self.request,size))
                action = value.pop('action', None)
                if action == 'offer':
                    result = manager.offer(value)
                elif action == 'close' and set(value) == {'grant'}:
                    result = manager.stop(value['grant'])
                elif action == 'status' and set(value) == {'grant'}:
                    result = manager.status(value['grant'])
                else:
                    raise CameraInputError('phone_camera_request_invalid')
                response = {'result':result}
            except Exception as error:
                response = {'error':str(error) if isinstance(error,CameraInputError) else 'phone_camera_browser_runtime_unavailable'}
            raw = json.dumps(response).encode()
            self.request.sendall(struct.pack('!I',len(raw))+raw)
    if path.exists() or path.is_symlink():
        raise CameraInputError('phone_camera_socket_occupied')
    server = Server(str(path), Handler)
    os.chmod(path, 0o600)
    def watch():
        while not stopped.wait(.1):
            try:
                manager.check()
            except Exception:
                pass  # Broker also expires independently; retry cleanup.
    thread = threading.Thread(target=watch, daemon=True)
    thread.start()
    try:
        server.serve_forever(poll_interval=.1)
    finally:
        stopped.set()
        manager.close()
        server.server_close()
        thread.join(2)


if __name__ == '__main__':
    if os.getuid() != 10001:
        raise CameraInputError('phone_camera_uid_invalid')
    directory = SOCKET.parent.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 10001 or stat.S_IMODE(directory.st_mode) != 0o700:
        raise CameraInputError('phone_camera_directory_invalid')
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    serve(validate_config(closed_json(Path('/run/phone/config.json').read_bytes())))
