"""Private discovery unit checks and opt-in real non-root ARM64 daemon test."""
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import threading
import time
import unittest

from services.trusted_media_service.private_discovery import (
    configuration, PrivateDiscovery, BUS_ADDRESS, BUS_ROOT, AVAHI_ROOT, private_bus_environment)
from services.trusted_media_service.discoverable_receiver import DiscoverableReceiverProcess
from services.trusted_media_service.native_receiver_process import NativeReceiverProcessError


class PrivateDiscoveryTest(unittest.TestCase):
    def test_configuration_is_anonymous_local_only_and_no_host_bus(self):
        bus, avahi = configuration(receiver_name="Team-AI-012ABC6789", interface="eth0")
        self.assertIn("host-name=team-ai-012abc6789", avahi)
        for value in ("enable-wide-area=no", "publish-workstation=no", "publish-hinfo=no",
                      "enable-reflector=no", "publish-resolv-conf-dns-servers=no", "allow-interfaces=eth0"):
            self.assertIn(value, avahi)
        self.assertIn("publish-addresses=no", avahi)
        self.assertNotIn("<include", bus)
        self.assertNotIn("tcp:", bus)
        self.assertNotIn("/run/dbus", bus)
        self.assertEqual(private_bus_environment()["DBUS_SYSTEM_BUS_ADDRESS"], BUS_ADDRESS)

    def test_forward_record_uses_trusted_interface_not_request_address(self):
        from unittest.mock import patch
        from services.trusted_media_service.private_discovery_address import interface_address
        packet = bytes(20) + socket.inet_aton("10.64.0.20") + bytes(16)
        with patch("socket.if_nametoindex", return_value=3), patch("fcntl.ioctl", return_value=packet):
            self.assertEqual(interface_address("eth0"), (3, "10.64.0.20"))
        for interface in ("../eth0", "eth0\n", "", None):
            with self.assertRaises(ValueError): interface_address(interface)
        for address in ("0.0.0.0", "127.0.0.1", "224.0.0.251"):
            with patch("socket.if_nametoindex", return_value=3), patch("fcntl.ioctl", return_value=bytes(20)+socket.inet_aton(address)):
                with self.assertRaises(ValueError): interface_address("eth0")

    def test_record_liveness_rejects_collision_and_lost_bus(self):
        from unittest.mock import Mock, patch
        from services.trusted_media_service.private_discovery_address import PrivateAddressRecord
        record = PrivateAddressRecord.__new__(PrivateAddressRecord)
        record._ready, record._last_check, record._group = True, 0, "/Client1/EntryGroup1"
        record._bus, record._call = Mock(), Mock(return_value=(2,))
        record._bus.is_closed.return_value = False
        with patch("time.monotonic", return_value=10): self.assertTrue(record.running())
        with patch("time.monotonic", return_value=10.5): self.assertTrue(record.running())
        self.assertEqual(record._call.call_count, 1)
        record._call.return_value = (3,)
        with patch("time.monotonic", return_value=12): self.assertFalse(record.running())
        record._ready = True
        record._bus.is_closed.return_value = True
        self.assertFalse(record.running())

    def test_cannot_inject_configuration_or_choose_foreign_bus(self):
        for name, interface in (("Personal iPhone", "eth0"), ("Team-AI-012abc6789", "eth0"),
                               ("Team-AI-012ABC6789", "eth0\npublish-workstation=yes"),
                               ("Team-AI-012ABC6789", "../dbus")):
            with self.assertRaises(ValueError):
                configuration(receiver_name=name, interface=interface)
        from services.trusted_media_service.native_receiver_process import NativeReceiverProcess
        with self.assertRaises(ValueError):
            NativeReceiverProcess(callback_client=Callback(), private_discovery_bus="unix:path=/run/dbus/system_bus_socket")

    def test_wrapped_lifecycle_admits_discovery_first_and_closes_both_after_failure(self):
        events = []
        class Resource:
            def __init__(self, name): self.name, self.alive, self.fail = name, False, False
            def start(self, **_):
                events.append(self.name + ":start")
                self.alive = True
                if self.fail: raise RuntimeError("private detail")
            def running(self): return self.alive
            def close(self):
                events.append(self.name + ":close")
                self.alive = False
        discovery, receiver = Resource("discovery"), Resource("receiver")
        receiver.fail = True
        owner = DiscoverableReceiverProcess(callback_client=Callback(), interface="eth0",
            discovery_factory=lambda: discovery, receiver_factory=lambda: receiver)
        with self.assertRaises(NativeReceiverProcessError):
            owner.start(receiver_name="Team-AI-012ABC6789")
        self.assertEqual(events, ["discovery:start", "receiver:start", "receiver:close", "discovery:close"])
        self.assertFalse(owner.running())


class Callback:
    def pair_source(self, **_):
        # This test never authorizes a sender or claims sender compatibility.
        raise AssertionError("no sender may pair in discovery-only test")


def dns_name(packet, offset, visited=None):
    labels, visited = [], set() if visited is None else visited
    end = None
    while True:
        if offset in visited or offset >= len(packet): raise ValueError("invalid DNS name")
        visited.add(offset)
        size = packet[offset]
        if size & 0xc0 == 0xc0:
            pointer = ((size & 0x3f) << 8) | packet[offset + 1]
            name, _ = dns_name(packet, pointer, visited)
            labels.append(name)
            end = offset + 2
            break
        if size > 63: raise ValueError("invalid DNS label")
        offset += 1
        if size == 0: break
        labels.append(packet[offset:offset+size].decode("utf-8"))
        offset += size
    return ".".join(labels), end if end is not None else offset


def airplay_ptrs(packet):
    if len(packet) < 12: return set()
    _, flags, questions, answers, authorities, additional = struct.unpack("!6H", packet[:12])
    if not flags & 0x8000: return set()
    offset, result = 12, set()
    for _ in range(questions):
        _, offset = dns_name(packet, offset)
        offset += 4
    for _ in range(answers + authorities + additional):
        name, offset = dns_name(packet, offset)
        kind, _, ttl, length = struct.unpack_from("!HHIH", packet, offset)
        offset += 10
        if name == "_airplay._tcp.local" and kind == 12 and ttl > 0:
            target, _ = dns_name(packet, offset)
            result.add(target)
        offset += length
    return result


def query_airplay(seconds):
    # An independent raw DNS-SD client: ask for a unicast response at a fresh
    # ephemeral port; no Avahi client cache can manufacture this observation.
    name = b"".join(bytes([len(part)]) + part for part in (b"_airplay", b"_tcp", b"local")) + b"\0"
    packet = struct.pack("!6H", 123, 0, 1, 0, 0, 0) + name + struct.pack("!HH", 12, 0x8001)
    found, deadline = set(), time.monotonic() + seconds
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as channel:
        channel.bind(("0.0.0.0", 0))
        # An internal Docker network intentionally has no default route. Bind
        # multicast to its exact interface instead of adding any host route.
        import fcntl
        interface = fcntl.ioctl(channel.fileno(), 0x8915, struct.pack("256s", b"eth0"))
        channel.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, interface[20:24])
        channel.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        channel.settimeout(0.25)
        while time.monotonic() < deadline:
            channel.sendto(packet, ("224.0.0.251", 5353))
            try:
                data, _ = channel.recvfrom(9000)
                found.update(airplay_ptrs(data))
            except (socket.timeout, ValueError, IndexError, UnicodeError, struct.error):
                pass
    return found


@unittest.skipUnless(os.environ.get("TEAMAIBOX_TEST_PRIVATE_DISCOVERY") == "1", "isolated Linux container required")
class PrivateDiscoveryRealTest(unittest.TestCase):
    def test_real_nonroot_private_bus_receiver_advertises_then_withdraws(self):
        self.assertEqual(os.getuid(), 65532)
        self.assertFalse(Path("/var/run/dbus/system_bus_socket").exists())
        owner = DiscoverableReceiverProcess(callback_client=Callback(), interface="eth0")
        self.addCleanup(owner.close)
        name = "Team-AI-012ABC6789"
        errors = []
        def request():
            try:
                owner.start(session_id="6cb7a018-aad1-4ea6-a8c2-039ea0291573", receiver_name=name,
                            pin="9876", lifetime_seconds=45)
            except Exception as error:
                errors.append(type(error).__name__)
        # HTTP handlers are short-lived threads. Linux parent-death signals
        # follow the creating thread, not just the supervisor's process PID.
        handler = threading.Thread(target=request, name="test-cast-start-request")
        handler.start()
        handler.join(timeout=12)
        self.assertFalse(handler.is_alive())
        self.assertEqual(errors, [])
        time.sleep(1)
        self.assertTrue(owner.running())
        self.assertEqual(query_airplay(4), {name + "._airplay._tcp.local"})
        self.assertIsNone(owner.authorized_source_id())
        # No host bus descriptor, no PIN argument, same unprivileged children.
        native = owner._receiver._process
        cmdline = Path(f"/proc/{native.pid}/cmdline").read_bytes()
        self.assertNotIn(b"9876", cmdline)
        self.assertEqual(os.stat(f"/proc/{native.pid}").st_uid, 65532)
        children = [child.pid for child in owner._discovery._children] + [native.pid]
        owner.close()
        self.assertFalse(owner.running())
        self.assertFalse(BUS_ROOT.exists())
        self.assertEqual(list(AVAHI_ROOT.iterdir()), [])
        for pid in children: self.assertFalse(Path(f"/proc/{pid}").exists())
        self.assertEqual(query_airplay(2), set())
        print(json.dumps({"privateDnsSdObserved": True, "hostBusMounted": False, "nonRootUid": 65532,
            "survivedRequestThreadExit": True,
            "nativeReceiverAdvertisedInIsolatedNetwork": True, "advertisementWithdrawn": True,
            "ownedChildrenReaped": 3, "ephemeralDiscoveryStateRemoved": True,
            "senderPaired": False, "appleSenderAccepted": False, "productAccepted": False}), flush=True)


if __name__ == "__main__":
    unittest.main()
