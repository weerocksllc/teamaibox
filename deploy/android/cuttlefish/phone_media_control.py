"""Local, single-phone media leases. No network listener or guest commands.

Cuttlefish's operator disconnects individual WebRTC peers when their signalling
socket closes. Confirm that both the client socket and media sockets are gone
before preserving the shared streamer. Killing it is a last-resort revocation:
it also breaks crosvm's display/audio transports and is not a reconnect path.
"""
import ipaddress
import json
import os
from pathlib import Path
import select
import signal
import socket
import stat
import struct
import threading
import time

KEYS = ('id', 'phoneId', 'ownerId', 'runId', 'generation', 'sessionId', 'kind')


class MediaError(RuntimeError):
    pass


def _socket_loopback(endpoint):
    # Linux procfs stores IPv4 addresses and each IPv6 word little-endian.
    raw = bytes.fromhex(endpoint.split(':', 1)[0])
    raw = b''.join(raw[i:i+4][::-1] for i in range(0, len(raw), 4))
    address = ipaddress.ip_address(raw)
    return address.is_loopback or bool(getattr(address, 'ipv4_mapped', None)
                                       and address.ipv4_mapped.is_loopback)


class Streamer:
    """Resolve by exact executable + supervisor in this private PID namespace.

    pidfd binds signalling/waiting to this process, never a reused numeric PID.
    There is deliberately no pkill, stop_cvd, Docker or host process operation.
    """
    def __init__(self, base=Path('/opt/cuttlefish'), proc=Path('/proc'), instance=None):
        self.base, self.proc = base, proc
        self.instance = instance

    def peers_gone(self, expected):
        """Read kernel socket ownership; never infer revocation from WSS alone.

        The fixed private operator is loopback for the streamer and receives
        Node Agent clients on the isolated Docker address. Every peer media
        socket belongs to the exact streamer and uses the approved LAN range.
        Missing/unreadable observations are not an empty set.
        """
        if type(self.instance) is not int or not 21 <= self.instance <= 21+(65535-20049)//100 or self.identity(expected['pid']) != expected:
            return False
        try:
            inodes = set()
            for f in (self.proc/str(expected['pid'])/'fd').iterdir():
                try:
                    target = os.readlink(f)
                except FileNotFoundError:
                    continue  # A concurrently closed descriptor is absent.
                if target.startswith('socket:[') and target.endswith(']'):
                    inodes.add(target[8:-1])
            operator_port = 8443+self.instance-1
            for protocol in ('udp', 'udp6', 'tcp', 'tcp6'):
                for row in (self.proc/'net'/protocol).read_text().splitlines()[1:]:
                    fields = row.split()
                    if len(fields) < 10:
                        return False
                    local_port = int(fields[1].rsplit(':', 1)[1], 16)
                    # The streamer also owns a permanent loopback HTTP server
                    # and a loopback operator connection. Their ephemeral TCP
                    # ports can numerically overlap any phone's media slot.
                    # They are private infrastructure, not browser media: do
                    # not kill the shared Wayland/audio server because of them.
                    # Keep checking every owned UDP socket and non-loopback
                    # TCP media socket, including stale slots after recovery.
                    private_tcp = protocol.startswith('tcp') and _socket_loopback(fields[1])
                    if fields[9] in inodes and not private_tcp and 20000 <= local_port <= 65449 and (local_port-20000)%100 < 50:
                        return False
                    # TIME_WAIT has no owning process and cannot exchange
                    # application data. Its kernel cleanup timer is not a
                    # live browser connection (and must not restart Android).
                    retired = fields[3] == '06' and fields[9] == '0'
                    if protocol.startswith('tcp') and local_port == operator_port and fields[3] != '0A' and not retired:
                        if not _socket_loopback(fields[2]):
                            return False
            return self.identity(expected['pid']) == expected
        except (OSError, ValueError, IndexError):
            return False

    def identity(self, pid):
        entry = self.proc / str(pid)
        try:
            if os.readlink(entry / 'exe') != str(self.base / 'bin/webRTC.elf'):
                return None
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            if fields[0] in ('Z', 'X'):
                return None
            parent = int(fields[1])
            if os.readlink(self.proc / str(parent) / 'exe') != str(self.base / 'bin/process_restarter'):
                return None
            return {'pid': pid, 'startTicks': int(fields[19])}
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            # Other processes can be non-dumpable after dropping privileges.
            # An unreadable entry is not an identified streamer. Never widen
            # permissions or select/signal it; continue scanning this namespace.
            return None

    def current(self):
        values = [value for entry in self.proc.iterdir() if entry.name.isdecimal()
                  if (value := self.identity(int(entry.name))) is not None]
        if len(values) != 1:
            raise MediaError('phone_media_process_unavailable')
        return values[0]

    def close(self, expected):
        # Node Agent first closes this grant's proxy. Give the native operator
        # time to destroy its peer, then verify socket removal. Do not restart
        # the Wayland/audio server on every page refresh.
        deadline = time.monotonic()+1.0
        while time.monotonic() < deadline:
            if self.peers_gone(expected):
                time.sleep(0.05)
                if self.peers_gone(expected):
                    return True
            time.sleep(0.05)
        pid = expected['pid']
        try:
            fd = os.pidfd_open(pid, 0)
        except ProcessLookupError:
            return True
        try:
            current = self.identity(pid)
            if current is None:
                # Gone or no longer the selected executable. Do not signal it.
                return bool(select.select([fd], [], [], 0)[0])
            if current != expected:
                # A replaced process is not the old peer. Do not signal it.
                return current['startTicks'] != expected['startTicks']
            signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
            if not select.select([fd], [], [], 3)[0]:
                raise MediaError('phone_media_close_unconfirmed')
            return True
        finally:
            os.close(fd)


class MediaLeases:
    def __init__(self, config, streamer=None, clock=time.monotonic, wall=time.time, kind='control'):
        if kind not in ('control', 'adb') or kind == 'adb' and streamer is None:
            raise MediaError('phone_media_binding_invalid')
        self.kind = kind
        self.config = config
        self.streamer = streamer or Streamer(instance=config.get('instance'))
        self.clock, self.wall = clock, wall
        self.lock = threading.Lock()
        self.active = None
        self.revoked = {}  # This process's lifetime is exactly one phone run.
        self.failed = False

    def binding(self, grant):
        import re
        uuid = r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
        if not isinstance(grant, dict) or set(grant) != set(KEYS):
            raise MediaError('phone_media_binding_invalid')
        if any(not isinstance(grant[k], str) or not re.fullmatch(uuid, grant[k])
               for k in ('id', 'phoneId', 'ownerId', 'runId', 'sessionId')):
            raise MediaError('phone_media_binding_invalid')
        if grant['kind'] != self.kind or type(grant['generation']) is not int:
            raise MediaError('phone_media_binding_invalid')
        if any(grant[k] != self.config[k] for k in ('phoneId', 'ownerId', 'runId', 'generation')):
            raise MediaError('phone_media_stale_run')
        return {k: grant[k] for k in KEYS}

    def _close(self):
        value = self.active
        if value is None:
            return
        # Fence renewal before the external close. Keep active if it fails so
        # the watchdog retries; never acknowledge a merely closed socket.
        self.revoked[value['grant']['id']] = value['grant']
        if self.streamer.close(value['process']) is not True:
            raise MediaError('phone_media_close_unconfirmed')
        self.active = None

    def expire(self):
        with self.lock:
            if self.active and (self.clock() >= self.active['deadline']
                                or self.active['grant']['id'] in self.revoked):
                self._close()

    def apply(self, request):
        if not isinstance(request, dict) or request.get('action') not in ('open', 'renew', 'close'):
            raise MediaError('phone_media_request_invalid')
        action = request['action']
        allowed = {'action', 'grant'} | ({'leaseExpiresAt'} if action != 'close' else set())
        if set(request) != allowed:
            raise MediaError('phone_media_request_invalid')
        grant = self.binding(request['grant'])
        with self.lock:
            if self.failed:
                raise MediaError('phone_media_unavailable')
            if self.active and self.clock() >= self.active['deadline']:
                self._close()
            old = self.revoked.get(grant['id'])
            if old and old != grant:
                raise MediaError('phone_media_binding_invalid')
            if action == 'close':
                if self.active and self.active['grant']['id'] == grant['id']:
                    if self.active['grant'] != grant:
                        raise MediaError('phone_media_binding_invalid')
                    self._close()
                if len(self.revoked) >= 4096 and not old:
                    self.failed = True
                    if self.active:
                        self._close()
                    raise MediaError('phone_media_run_limit')
                self.revoked[grant['id']] = grant
                return grant | {'peerClosed': True}
            expiry = request['leaseExpiresAt']
            if type(expiry) is not int or not 0 < expiry - self.wall()*1000 <= 5000:
                raise MediaError('phone_media_lease_invalid')
            if old:
                raise MediaError('phone_media_grant_revoked')
            if self.active:
                if self.active['grant'] != grant:
                    raise MediaError('phone_media_busy')
                if self.streamer.current() != self.active['process']:
                    self._close()
                    raise MediaError('phone_media_peer_lost')
            elif action == 'renew':
                raise MediaError('phone_media_grant_missing')
            else:
                if len(self.revoked) >= 4096:
                    raise MediaError('phone_media_run_limit')
                self.active = {'grant': grant, 'process': self.streamer.current(), 'deadline': self.clock()}
            self.active['deadline'] = self.clock() + (expiry - self.wall()*1000)/1000
            return grant | {'peerOpen': True, 'leaseExpiresAt': expiry}


class MediaControl:
    def __init__(self, config, path=Path('/phone/.media-control.sock'), adb=None):
        self.path = path
        self.leases = MediaLeases(config)
        self.adb = adb
        self.stopping = threading.Event()
        self.listener = None
        self.threads = []

    def start(self):
        # A new exact run may replace its old socket, never an arbitrary file.
        if self.path.exists() or self.path.is_symlink():
            info = self.path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid():
                raise MediaError('phone_media_socket_invalid')
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
            try:
                self.leases.expire()
                if self.adb:
                    self.adb.leases.expire()
            except Exception:
                # Retry exact closure. No availability/success fabrication.
                pass

    def _serve(self):
        from phone_runtime import closed_json
        while not self.stopping.is_set():
            try:
                connection, _ = self.listener.accept()
            except (TimeoutError, socket.timeout):
                continue
            except OSError:
                break
            with connection:
                try:
                    connection.settimeout(1)
                    _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid not in (0, os.geteuid()):
                        raise MediaError('phone_media_permission_required')
                    raw = bytearray()
                    while b'\n' not in raw and len(raw) <= 8192:
                        part = connection.recv(1024)
                        if not part:
                            break
                        raw.extend(part)
                    if len(raw) > 8192 or not raw.endswith(b'\n') or raw.count(b'\n') != 1:
                        raise MediaError('phone_media_request_invalid')
                    request = closed_json(raw)
                    if isinstance(request, dict) and isinstance(request.get('grant'), dict) and request['grant'].get('kind') == 'adb':
                        if not self.adb:
                            raise MediaError('phone_adb_not_configured')
                        response = self.adb.leases.apply(request)
                    else:
                        response = self.leases.apply(request)
                except Exception as error:
                    response = {'errorCode': str(error) if isinstance(error, MediaError) else 'phone_media_request_invalid'}
                try:
                    connection.sendall(json.dumps(response).encode() + b'\n')
                except OSError:
                    pass  # An accepted lease still expires independently.

    def stop(self):
        self.stopping.set()
        if self.listener:
            self.listener.close()
        for thread in self.threads:
            thread.join(timeout=4)
        with self.leases.lock:
            self.leases._close()
