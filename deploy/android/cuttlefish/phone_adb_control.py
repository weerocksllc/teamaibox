"""Single-phone, short-lived ADB relay. No LAN listener, shell or target input.

Only the authenticated Node Agent can reach this private Unix socket. The
normal control/WebRTC grant cannot open it. Grant expiry closes the actual ADB
TCP connection independently of Platform/Node Agent availability.
"""
import json
import os
from pathlib import Path
import selectors
import socket
import stat
import struct
import threading
import time

from phone_media_control import MediaError, MediaLeases

BUFFER_BYTES = 65536


def close_socket(connection):
    try:
        connection.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    connection.close()


def relay(left, right, stopping):
    """Bounded backpressure in both directions, never drop ADB stream bytes."""
    pending = {left: bytearray(), right: bytearray()}
    other = {left: right, right: left}
    try:
        left.setblocking(False)
        right.setblocking(False)
        with selectors.DefaultSelector() as selected:
            while not stopping.is_set():
                # Refresh interest according to capacity; a slow receiver stops
                # reads from its sender rather than growing memory or dropping.
                for connection in (left, right):
                    events = (selectors.EVENT_READ if len(pending[other[connection]]) < BUFFER_BYTES else 0)
                    if pending[connection]:
                        events |= selectors.EVENT_WRITE
                    try:
                        selected.unregister(connection)
                    except KeyError:
                        pass
                    if events:
                        selected.register(connection, events)
                for key, events in selected.select(0.1):
                    connection = key.fileobj
                    if events & selectors.EVENT_WRITE:
                        try:
                            size = connection.send(pending[connection])
                            if not size:
                                return
                            del pending[connection][:size]
                        except BlockingIOError:
                            pass
                    if events & selectors.EVENT_READ:
                        buffer = pending[other[connection]]
                        try:
                            chunk = connection.recv(BUFFER_BYTES-len(buffer))
                        except BlockingIOError:
                            continue
                        if not chunk:
                            # ADB has no half-close operation. Disconnect both
                            # ends instead of retaining an unauthenticated tail.
                            return
                        buffer.extend(chunk)
    except (OSError, ValueError):
        pass  # Revocation/expiry shuts down both exact descriptors.
    finally:
        for buffer in pending.values():
            buffer[:] = b'\0' * len(buffer)
            buffer.clear()
        close_socket(left)
        close_socket(right)


class AdbPeer:
    """MediaLeases' peer interface, but closes ADB sockets, not the streamer."""
    def __init__(self):
        self.identity = object()
        self.lock = threading.Lock()
        self.connection = None

    def current(self):
        return self.identity

    def attach(self, left, right):
        with self.lock:
            if self.connection is not None:
                raise MediaError('phone_adb_busy')
            stop = threading.Event()
            value = (left, right, stop)
            self.connection = value
            return value

    def detach(self, value):
        with self.lock:
            if self.connection is value:
                self.connection = None
        for connection in value[:2]:
            close_socket(connection)

    def close(self, expected):
        with self.lock:
            if expected is not self.identity:
                raise MediaError('phone_adb_binding_invalid')
            if self.connection is not None:
                left, right, stop = self.connection
                stop.set()
                close_socket(left)
                close_socket(right)
                self.connection = None
        return True


class AdbControl:
    def __init__(self, config, path=Path('/phone/.adb-stream.sock'), *, clock=time.monotonic, wall=time.time):
        from phone_runtime import validate_config
        validate_config(config)
        self.path = path
        self.port = 6519 + config['instance']
        self.peer = AdbPeer()
        self.leases = MediaLeases(config, streamer=self.peer, clock=clock, wall=wall, kind='adb')
        self.stopping = threading.Event()
        self.listener = None
        self.threads = []
        self.clients = set()
        self.clients_lock = threading.Lock()

    def start(self):
        if self.path.exists() or self.path.is_symlink():
            info = self.path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid():
                raise MediaError('phone_adb_socket_invalid')
            self.path.unlink()
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(self.path))
        os.chmod(self.path, 0o600)
        self.listener.listen(4)
        self.listener.settimeout(0.25)
        for target in (self._serve, self._watch):
            thread = threading.Thread(target=target, daemon=True)
            self.threads.append(thread)
            thread.start()

    def _watch(self):
        while not self.stopping.wait(0.1):
            self.leases.expire()

    def _serve(self):
        while not self.stopping.is_set():
            try:
                connection, _ = self.listener.accept()
            except (TimeoutError, socket.timeout):
                continue
            except OSError:
                break
            with self.clients_lock:
                if self.stopping.is_set() or len(self.clients) >= 4:
                    connection.close()
                    continue
                self.clients.add(connection)
            threading.Thread(target=self._client, args=(connection,), daemon=True).start()

    def _client(self, connection):
        from phone_runtime import closed_json
        value = None
        upstream = None
        try:
            connection.settimeout(1)
            _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid not in (0, os.geteuid()):
                raise MediaError('phone_adb_permission_required')
            # Do not consume pipelined ADB bytes into a JSON buffer. The fixed
            # small header ends at its first newline, followed by raw ADB.
            raw = bytearray()
            while len(raw) <= 1024:
                part = connection.recv(1)
                if not part:
                    raise MediaError('phone_adb_header_invalid')
                raw.extend(part)
                if part == b'\n':
                    break
            if len(raw) > 1024:
                raise MediaError('phone_adb_header_invalid')
            grant = self.leases.binding(closed_json(raw))
            raw[:] = b'\0' * len(raw)
            # Registration and revocation share this lock. Expiry cannot race
            # a socket into existence after acknowledging peerClosed.
            with self.leases.lock:
                active = self.leases.active
                if (self.stopping.is_set() or active is None or active['grant'] != grant
                        or self.leases.clock() >= active['deadline'] or grant['id'] in self.leases.revoked):
                    raise MediaError('phone_adb_grant_expired')
                upstream = socket.create_connection(('127.0.0.1', self.port), timeout=1)
                value = self.peer.attach(connection, upstream)
            connection.sendall(b'{"ready":true}\n')
            relay(connection, upstream, value[2])
        except (OSError, ValueError, MediaError):
            pass  # No ADB content, target, credentials or error details logged.
        finally:
            if value is not None:
                self.peer.detach(value)
            elif upstream is not None:
                close_socket(upstream)
            close_socket(connection)
            with self.clients_lock:
                self.clients.discard(connection)

    def stop(self):
        self.stopping.set()
        if self.listener:
            self.listener.close()
        with self.leases.lock:
            self.leases._close()
        with self.clients_lock:
            for connection in self.clients:
                close_socket(connection)
        for thread in self.threads:
            thread.join(timeout=2)
