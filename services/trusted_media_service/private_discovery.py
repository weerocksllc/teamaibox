"""Session-owned DNS-SD on a private Unix bus, with no host service access.

This is not a receiver or proof of an Apple pairing. No AirPlay service is
registered here: only the paired native receiver may register its own name.
All daemon configuration/socket state is under two container tmpfs mounts.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from threading import RLock
import time

from .service_child_process import spawn_service_child

BUS_ROOT = Path("/run/teamaibox/discovery")
AVAHI_ROOT = Path("/run/avahi-daemon")
BUS_ADDRESS = "unix:path=/run/teamaibox/discovery/bus"


class PrivateDiscoveryError(RuntimeError):
    def __init__(self):
        super().__init__("cast_private_discovery_unavailable")


def configuration(*, receiver_name: str, interface: str) -> tuple[str, str]:
    if (not isinstance(receiver_name, str) or not re.fullmatch(r"Team-AI-[A-F0-9]{10}", receiver_name)
            or not isinstance(interface, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,14}", interface)):
        raise ValueError("cast_private_discovery_configuration_invalid")
    # No includes of system policies, system socket, external TCP or UID
    # switching. The private 0700 socket directory admits only this uid.
    bus = '''<busconfig>
  <type>system</type>
  <listen>unix:path=/run/teamaibox/discovery/bus</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <deny own="*"/><deny send_destination="*"/>
  </policy>
  <policy user="teamaibox">
    <allow own="org.freedesktop.Avahi"/>
    <allow send_destination="*"/>
    <allow send_requested_reply="true"/>
    <allow receive_sender="*"/>
  </policy>
  <limit name="max_connections_per_user">16</limit>
  <limit name="max_completed_connections">32</limit>
  <limit name="max_message_size">65536</limit>
</busconfig>
'''
    avahi = f'''[server]
host-name={receiver_name.lower()}
domain-name=local
use-ipv4=yes
use-ipv6=no
allow-interfaces={interface}
check-response-ttl=yes
use-iff-running=yes
enable-dbus=yes
disallow-other-stacks=no
ratelimit-interval-usec=1000000
ratelimit-burst=100
[wide-area]
enable-wide-area=no
[publish]
publish-hinfo=no
publish-workstation=no
publish-domain=no
publish-addresses=no
publish-resolv-conf-dns-servers=no
[reflector]
enable-reflector=no
'''
    return bus, avahi


def private_bus_environment() -> dict:
    return {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent",
            "DBUS_SYSTEM_BUS_ADDRESS": BUS_ADDRESS}


class PrivateDiscovery:
    def __init__(self, *, interface: str):
        configuration(receiver_name="Team-AI-0123456789", interface=interface)
        self._interface, self._lock = interface, RLock()
        self._children, self._owned_files = [], []
        self._started = self._ready = self._owned_directory = False
        self._address = None

    def _spawn(self, executable, *arguments):
        trampoline = str(Path(__file__).with_name("discovery_exec.py"))
        child = spawn_service_child([sys.executable, "-I", trampoline, str(os.getpid()), executable, *arguments],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=private_bus_environment(), cwd="/", close_fds=True, start_new_session=True)
        self._children.append(child)

    def _state(self):
        if any(child.poll() is not None for child in self._children):
            return False
        try:
            result = subprocess.run(["/usr/bin/dbus-send", "--system", "--type=method_call",
                "--dest=org.freedesktop.Avahi", "--print-reply", "--reply-timeout=250", "/",
                "org.freedesktop.Avahi.Server.GetState"], env=private_bus_environment(),
                stdin=subprocess.DEVNULL, capture_output=True, timeout=1)
            return result.returncode == 0 and re.search(rb"\n\s+int32 2\s*$", result.stdout) is not None
        except (OSError, subprocess.TimeoutExpired):
            return False

    def start(self, *, receiver_name: str):
        configs = configuration(receiver_name=receiver_name, interface=self._interface)
        with self._lock:
            if self._started or os.getuid() != 65532 or sys.platform != "linux":
                raise PrivateDiscoveryError()
            self._started = True
            try:
                # A mount or path from an HTTP body is never accepted. Do not
                # remove pre-existing daemon state or follow a foreign link.
                for root in (BUS_ROOT.parent, AVAHI_ROOT):
                    info = root.lstat()
                    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 65532
                            or info.st_mode & 0o077):
                        raise PrivateDiscoveryError()
                if any(AVAHI_ROOT.iterdir()):
                    raise PrivateDiscoveryError()
                BUS_ROOT.mkdir(mode=0o700)
                self._owned_directory = True
                for name, content in zip(("dbus.conf", "avahi.conf"), configs):
                    path = BUS_ROOT / name
                    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    self._owned_files.append(path)
                    with os.fdopen(fd, "w") as output:
                        output.write(content)
                self._spawn("/usr/bin/dbus-daemon", "--nofork", "--nopidfile",
                            "--config-file=" + str(BUS_ROOT / "dbus.conf"))
                deadline = time.monotonic() + 8
                while not (BUS_ROOT / "bus").exists():
                    if self._children[0].poll() is not None or time.monotonic() >= deadline:
                        raise PrivateDiscoveryError()
                    time.sleep(0.025)
                self._spawn("/usr/sbin/avahi-daemon", "--no-drop-root", "--no-chroot",
                            "--no-rlimits", "--no-proc-title", "--file=" + str(BUS_ROOT / "avahi.conf"))
                while not self._state():
                    if any(child.poll() is not None for child in self._children) or time.monotonic() >= deadline:
                        raise PrivateDiscoveryError()
                    time.sleep(0.05)
                # The host already owns the IP's reverse PTR. Publishing a
                # second reverse hostname causes endless collisions on a real
                # appliance (unseen on an isolated Docker test network).
                from .private_discovery_address import PrivateAddressRecord
                self._address = PrivateAddressRecord(bus_address=BUS_ADDRESS,
                    interface=self._interface, receiver_name=receiver_name)
                self._ready = True
            except Exception:
                self.close()
                raise PrivateDiscoveryError() from None

    def running(self):
        with self._lock:
            # Called by the frame loop. Do not spawn a bus probe per frame.
            return (self._ready and len(self._children) == 2
                    and all(child.poll() is None for child in self._children)
                    and self._address is not None and self._address.running())

    def close(self):
        with self._lock:
            self._ready = False
            failed = False
            if self._address is not None:
                try:
                    self._address.close()
                except Exception:
                    failed = True
                self._address = None
            # Avahi withdraws records before its private bus goes away.
            for child in reversed(self._children):
                try:
                    if child.poll() is None:
                        child.terminate()
                        try:
                            child.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait(timeout=3)
                except Exception:
                    failed = True
            self._children = [child for child in self._children if child.poll() is None]
            if failed or self._children:
                raise PrivateDiscoveryError()
            if self._owned_directory:
                # These are exact files of our dead private bus; no recursive
                # deletion, host pathname, glob or pre-existing state cleanup.
                for path in self._owned_files + [BUS_ROOT / "bus"]:
                    path.unlink(missing_ok=True)
                self._owned_files.clear()
                BUS_ROOT.rmdir()
                self._owned_directory = False
            if self._started and any(AVAHI_ROOT.iterdir()):
                # Do not claim removal or wipe an unexpected leftover.
                raise PrivateDiscoveryError()
