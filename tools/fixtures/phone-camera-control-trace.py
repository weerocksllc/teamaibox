"""Diagnostic-only private socket proxy for one disposable test phone.

Forward the exact broker protocol unchanged. Never retain frame bytes, grants,
owner IDs, credentials, or arbitrary exception text. Not a production service.
"""
import collections
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import stat
import struct
import threading
import time

DIRECTORY = Path('/tmp/phone-camera-input')
LIVE = DIRECTORY / 'control.sock'
ORIGINAL = DIRECTORY / 'control-trace-original.sock'
REPORT = DIRECTORY / 'control-trace.json'
events = collections.deque(maxlen=512)
frames = 0
started = time.monotonic()


def receive(sock, size):
    chunks = []
    while size:
        chunk = sock.recv(size)
        if not chunk:
            raise EOFError()
        chunks.append(chunk)
        size -= len(chunk)
    return b''.join(chunks)


def save(event):
    events.append(event)
    pending = REPORT.with_suffix('.pending')
    fd = os.open(pending, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(dict(diagnosticOnly=True, frames=frames, events=list(events)), output)
    os.replace(pending, REPORT)


class Server(socketserver.UnixStreamServer):
    def verify_request(self, request, address):
        return struct.unpack('3i', request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1] == 10001

    def handle_error(self, request, address):
        pass


class Proxy(socketserver.BaseRequestHandler):
    def handle(self):
        global frames
        begin = time.monotonic()
        event = dict(at=time.time(), elapsed=begin-started, action='unknown')
        frame = None
        try:
            self.request.settimeout(1)
            size_raw = receive(self.request, 4)
            size = struct.unpack('!I', size_raw)[0]
            if not 1 <= size <= 4096:
                raise ValueError()
            raw = receive(self.request, size)
            request = json.loads(raw)
            action = request.get('action')
            if action not in ('open', 'renew', 'frame', 'close', 'status'):
                raise ValueError()
            event['action'] = action
            if action in ('open', 'renew'):
                event['leaseExpiresAt'] = request['leaseExpiresAt']
                event['remainingMs'] = request['leaseExpiresAt'] - time.time()*1000
            if action == 'frame':
                frame_size = receive(self.request, 4)
                size = struct.unpack('!I', frame_size)[0]
                if not 4 < size <= 640*480*2:
                    raise ValueError()
                frame = receive(self.request, size)
                frames += 1
            with socket.socket(socket.AF_UNIX) as upstream:
                upstream.settimeout(1)
                upstream.connect(str(ORIGINAL))
                upstream.sendall(size_raw+raw)
                if frame is not None:
                    upstream.sendall(frame_size+frame)
                response_size = receive(upstream, 4)
                length = struct.unpack('!I', response_size)[0]
                if not 1 <= length <= 4096:
                    raise ValueError()
                response = receive(upstream, length)
            self.request.sendall(response_size+response)
            result = json.loads(response)
            error = result.get('error')
            if isinstance(error, str) and error.startswith('phone_camera_') and error.replace('_', '').isalnum():
                event['error'] = error
            event['state'] = result.get('result', {}).get('state')
            event['milliseconds'] = (time.monotonic()-begin)*1000
            if action in ('open', 'renew', 'close') or error or event['state'] == 'stopped' or event['milliseconds'] > 100:
                save(event)
        except Exception as error:
            event['errorType'] = type(error).__name__
            event['milliseconds'] = (time.monotonic()-begin)*1000
            save(event)
        finally:
            frame = None


def main():
    assert os.getuid() == 10001
    info = LIVE.lstat()
    assert stat.S_ISSOCK(info.st_mode) and info.st_uid == 10001
    assert not ORIGINAL.exists() and not REPORT.exists()
    os.rename(LIVE, ORIGINAL)
    server = None
    try:
        server = Server(str(LIVE), Proxy)
        os.chmod(LIVE, 0o600)
        proxy_inode = LIVE.stat().st_ino
        def stop(*args):
            threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        save(dict(action='trace-ready', at=time.time()))
        server.serve_forever(poll_interval=.1)
    finally:
        if server:
            server.server_close()
            if LIVE.exists() and LIVE.stat().st_ino == proxy_inode:
                LIVE.unlink()
        if not LIVE.exists() and ORIGINAL.exists() and ORIGINAL.stat().st_ino == info.st_ino:
            os.rename(ORIGINAL, LIVE)


if __name__ == '__main__':
    main()
