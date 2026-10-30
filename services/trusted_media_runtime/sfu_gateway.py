"""Private TLS ingress for one local SFU; no public listener or credential log.

Control and viewer connections require a pinned mTLS peer. The GStreamer
publisher uses a separate loopback-only listener (the SFU still authenticates
its short-lived publish-only JWT). Plain HTTP never leaves this host. This
gateway neither grants viewing permission nor manufactures receiver events.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import select
import signal
import socket
import socketserver
import ssl
import sys
import threading
import time

from services.trusted_media_runtime.main import ProtectedInputs, ConfigurationError, exact, unique_object
from services.trusted_media_service.tls_runtime_server import _DeadlineReader, PRIVATE_NETWORKS, HEADER

CONTROL_PATH = re.compile(rb"/twirp/livekit\.RoomService/(?:CreateRoom|DeleteRoom|ListRooms|ListParticipants|RemoveParticipant)")
SIGNALLING_PATH = re.compile(rb"/rtc(?:/validate)?\?[A-Za-z0-9%_.~=&+,-]{1,16384}")


def request_prefix(reader, role):
    """Parse one bounded request before contacting the fixed upstream.

    A control connection carries exactly one request; pipelining is discarded.
    Only an RFC6455 upgrade switches the connection to a streaming relay.
    No external Host, forwarding header, redirect target or API path is used.
    """
    line = reader.readline(17000)
    parts = line.rstrip(b"\r\n").split(b" ")
    if not line.endswith(b"\r\n") or len(parts) != 3 or parts[2] != b"HTTP/1.1":
        raise ValueError("cast_sfu_request_invalid")
    method, path, _ = parts
    if role == "control":
        if method != b"POST" or not CONTROL_PATH.fullmatch(path):
            raise ValueError("cast_sfu_request_invalid")
    elif method != b"GET" or not SIGNALLING_PATH.fullmatch(path):
        raise ValueError("cast_sfu_request_invalid")
    headers, total = {}, len(line)
    while True:
        line = reader.readline(17000)
        total += len(line)
        if total > 24576 or not line.endswith(b"\r\n"):
            raise ValueError("cast_sfu_request_invalid")
        if line == b"\r\n":
            break
        name, colon, value = line[:-2].partition(b":")
        name = name.lower()
        if (not colon or not HEADER.fullmatch(name) or name in headers
                or any(c < 32 and c != 9 or c == 127 for c in value)):
            raise ValueError("cast_sfu_request_invalid")
        headers[name] = value.strip()
    if b"host" not in headers or any(name in headers for name in (b"transfer-encoding", b"expect", b"content-encoding")):
        raise ValueError("cast_sfu_request_invalid")
    length = headers.get(b"content-length", b"0")
    if not re.fullmatch(rb"0|[1-9][0-9]{0,4}", length) or int(length) > 65536:
        raise ValueError("cast_sfu_request_invalid")
    upgrade = role != "control" and path.split(b"?", 1)[0] == b"/rtc"
    result = bytearray(method + b" " + path + b" HTTP/1.1\r\nHost: localhost\r\n")
    authorization = headers.get(b"authorization")
    if authorization is not None:
        if not re.fullmatch(rb"Bearer [A-Za-z0-9_.-]{16,16384}", authorization):
            raise ValueError("cast_sfu_request_invalid")
        # GStreamer's LiveKit client uses the Authorization header, while
        # Platform's viewer hop uses access_token. Preserve either documented
        # form for the SFU to verify, without forwarding arbitrary headers.
        result.extend(b"Authorization: " + authorization + b"\r\n")
    if role == "control":
        if (headers.get(b"content-type") != b"application/json" or int(length) < 2
                or b"upgrade" in headers or authorization is None):
            raise ValueError("cast_sfu_request_invalid")
        result.extend(b"Content-Type: application/json\r\n")
    elif int(length) != 0:
        raise ValueError("cast_sfu_request_invalid")
    if upgrade:
        if (headers.get(b"upgrade", b"").lower() != b"websocket"
                or b"upgrade" not in [part.strip().lower() for part in headers.get(b"connection", b"").split(b",")]
                or headers.get(b"sec-websocket-version") != b"13"
                or not re.fullmatch(rb"[A-Za-z0-9+/]{22}==", headers.get(b"sec-websocket-key", b""))):
            raise ValueError("cast_sfu_request_invalid")
        result.extend(b"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: "
                      + headers[b"sec-websocket-key"] + b"\r\n\r\n")
    else:
        if b"upgrade" in headers:
            raise ValueError("cast_sfu_request_invalid")
        result.extend(b"Connection: close\r\nContent-Length: " + length + b"\r\n\r\n")
        body = reader.read(int(length))
        if len(body) != int(length):
            raise ValueError("cast_sfu_request_invalid")
        result.extend(body)
    return result, upgrade


class _Relay(socketserver.BaseRequestHandler):
    def handle(self):
        server, prefix, reader = self.server, None, None
        channel = upstream = None
        try:
            self.request.settimeout(3)
            channel = server.context.wrap_socket(self.request, server_side=True, do_handshake_on_connect=False)
            server.track(channel)
            channel.do_handshake()
            if channel.version() != "TLSv1.3":
                return
            if server.role != "publisher":
                actual = "sha256:" + hashlib.sha256(channel.getpeercert(binary_form=True)).hexdigest()
                if actual != server.peer_fingerprint:
                    return
            reader = _DeadlineReader(channel, time.monotonic() + 5)
            prefix, websocket = request_prefix(reader, server.role)
            # Only this fixed loopback address is reachable through the relay.
            upstream = socket.create_connection(("127.0.0.1", server.upstream_port), timeout=3)
            server.track(upstream)
            upstream.sendall(prefix)
            prefix[:] = b"\0" * len(prefix)
            if websocket and reader.buffer:
                upstream.sendall(reader.buffer)
            reader.buffer[:] = b"\0" * len(reader.buffer)
            reader.buffer.clear()
            deadline = time.monotonic() + (14430 if websocket else 5)
            channel.settimeout(3)
            upstream.settimeout(3)
            # Small bounded chunks + socket backpressure; no unbounded queue,
            # last-frame cache, media recorder or disk-backed buffering.
            inputs = [channel, upstream] if websocket else [upstream]
            while not server.stopping.is_set() and time.monotonic() < deadline:
                ready, _, _ = select.select(inputs, [], [], 0.1)
                if websocket and channel.pending() and channel not in ready:
                    ready.append(channel)
                for source in ready:
                    data = source.recv(16384)
                    if not data:
                        return
                    (upstream if source is channel else channel).sendall(data)
        except Exception:
            pass  # Never log a URL/JWT, peer error, HTTP body or media byte.
        finally:
            if prefix is not None:
                prefix[:] = b"\0" * len(prefix)
            if reader is not None:
                reader.buffer[:] = b"\0" * len(reader.buffer)
            for stream in (channel, upstream):
                if stream is not None:
                    server.untrack(stream)
                    stream.close()


class PrivateSfuGateway(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    # Rebind after our own closed TCP connections enter TIME_WAIT. This is
    # SO_REUSEADDR, not SO_REUSEPORT: another live listener still conflicts.
    allow_reuse_address = True
    allow_reuse_port = False
    request_queue_size = 16

    def __init__(self, address, *, role, upstream_port, context, peer_fingerprint=None):
        host, port = address
        ip = ipaddress.ip_address(host)
        if (ip.version != 4 or not any(ip in net for net in PRIVATE_NETWORKS)
                or type(port) is not int or not 0 <= port <= 65535 or type(upstream_port) is not int
                or not 1 <= upstream_port <= 65535 or role not in ("control", "viewer", "publisher")
                or context.minimum_version != ssl.TLSVersion.TLSv1_3 or context.maximum_version != ssl.TLSVersion.TLSv1_3):
            raise ConfigurationError()
        if role == "publisher":
            if not ip.is_loopback or context.verify_mode != ssl.CERT_NONE or peer_fingerprint is not None:
                raise ConfigurationError()
        elif context.verify_mode != ssl.CERT_REQUIRED or not re.fullmatch(r"sha256:[a-f0-9]{64}", peer_fingerprint or ""):
            raise ConfigurationError()
        self.role, self.upstream_port, self.context = role, upstream_port, context
        self.peer_fingerprint = peer_fingerprint
        self.stopping, self._lock, self._sockets = threading.Event(), threading.Lock(), set()
        self._capacity = threading.BoundedSemaphore(16 if role == "viewer" else 4)
        super().__init__(address, _Relay)

    def track(self, stream):
        with self._lock:
            if self.stopping.is_set():
                stream.close()
                raise OSError("cast_sfu_stopped")
            self._sockets.add(stream)

    def untrack(self, stream):
        with self._lock:
            self._sockets.discard(stream)

    def process_request(self, request, client_address):
        if self.stopping.is_set() or not self._capacity.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._capacity.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._capacity.release()

    def handle_error(self, request, client_address):
        pass

    def server_close(self):
        self.stopping.set()
        with self._lock:
            for stream in self._sockets:
                try:
                    stream.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                stream.close()
            self._sockets.clear()
        super().server_close()


def assemble_gateways(inputs):
    raw, gateways = inputs.read("sfu-gateway.json"), []
    try:
        config = json.loads(raw, object_pairs_hook=unique_object)
        exact(config, ("schemaVersion", "upstreamPort", "listeners"))
        if type(config["schemaVersion"]) is not int or config["schemaVersion"] != 1 or type(config["listeners"]) is not list:
            raise ConfigurationError()
        if len(config["listeners"]) != 3 or {item.get("role") for item in config["listeners"]} != {"publisher", "control", "viewer"}:
            raise ConfigurationError()
        for item in config["listeners"]:
            exact(item, ("role", "address", "port", "certificate", "privateKey", "clientCa", "peerFingerprint"))
            if type(item["port"]) is not int or item["port"] < 1:
                raise ConfigurationError()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
            context.num_tickets = 0
            context.load_cert_chain(str(inputs.tls_path(item["certificate"])), str(inputs.tls_path(item["privateKey"])))
            if item["role"] != "publisher":
                context.verify_mode = ssl.CERT_REQUIRED
                context.load_verify_locations(cafile=str(inputs.tls_path(item["clientCa"])))
            elif item["clientCa"] is not None:
                raise ConfigurationError()
            gateways.append(PrivateSfuGateway((item["address"], item["port"]), role=item["role"],
                upstream_port=config["upstreamPort"], context=context, peer_fingerprint=item["peerFingerprint"]))
        return gateways
    except Exception:
        for gateway in gateways:
            gateway.server_close()
        raise ConfigurationError() from None
    finally:
        raw[:] = b"\0" * len(raw)


def main():
    gateways, threads = [], []
    try:
        if len(sys.argv) != 1 or os.geteuid() == 0:
            raise ConfigurationError()
        stop = threading.Event()
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, lambda *_: stop.set())
        with ProtectedInputs() as inputs:
            gateways = assemble_gateways(inputs)
        for gateway in gateways:
            thread = threading.Thread(target=gateway.serve_forever, kwargs={"poll_interval":0.1}, daemon=True)
            thread.start()
            threads.append(thread)
        stop.wait()
        return 0
    except Exception:
        print("cast_sfu_gateway_unavailable", file=sys.stderr)
        return 78
    finally:
        for gateway in gateways:
            gateway.server_close()
        for gateway, thread in zip(gateways, threads):
            gateway.shutdown()
            thread.join(timeout=2)


if __name__ == "__main__":
    sys.exit(main())
