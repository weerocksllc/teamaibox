"""One session-owned forward A record, without claiming the host's reverse PTR.

The address is read from the trusted interface, never from a session request.
The private bus connection owns the record until it is explicitly withdrawn.
"""
import ipaddress
import re
import socket
import struct
import time


def interface_address(interface):
    import fcntl
    if not isinstance(interface, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,14}", interface):
        raise ValueError("cast_private_address_invalid")
    index = socket.if_nametoindex(interface)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as channel:
        value = fcntl.ioctl(channel.fileno(), 0x8915, struct.pack("256s", interface.encode()))
    address = ipaddress.IPv4Address(value[20:24])
    if index <= 0 or address.is_loopback or address.is_unspecified or address.is_multicast:
        raise ValueError("cast_private_address_invalid")
    return index, str(address)


class PrivateAddressRecord:
    def __init__(self, *, bus_address, interface, receiver_name):
        from gi.repository import Gio, GLib
        from .private_discovery import BUS_ADDRESS
        if bus_address != BUS_ADDRESS or not re.fullmatch(r"Team-AI-[A-F0-9]{10}", receiver_name or ""):
            raise ValueError("cast_private_address_invalid")
        self._Gio, self._GLib = Gio, GLib
        self._bus, self._group = None, None
        self._last_check, self._ready = 0, False
        index, address = interface_address(interface)
        try:
            self._bus = Gio.DBusConnection.new_for_address_sync(bus_address,
                Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                None, None)
            self._bus.set_exit_on_close(False)
            self._group = self._call("/", "org.freedesktop.Avahi.Server", "EntryGroupNew")[0]
            if not re.fullmatch(r"/Client[0-9]+/EntryGroup[0-9]+", self._group):
                raise ValueError("cast_private_address_invalid")
            # AVAHI_PROTO_INET=0, AVAHI_PUBLISH_NO_REVERSE=16. Keep normal
            # uniqueness probing; only the system-owned reverse PTR is omitted.
            self._call(self._group, "org.freedesktop.Avahi.EntryGroup", "AddAddress",
                GLib.Variant("(iiuss)", (index, 0, 16, receiver_name.lower() + ".local", address)))
            self._call(self._group, "org.freedesktop.Avahi.EntryGroup", "Commit")
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                state = self._call(self._group, "org.freedesktop.Avahi.EntryGroup", "GetState")[0]
                if state == 2:
                    self._ready = True
                    return
                if state not in (0, 1):
                    break
                time.sleep(0.05)
            raise RuntimeError("cast_private_address_unavailable")
        except Exception:
            self.close()
            raise

    def _call(self, path, interface, method, parameters=None):
        return self._bus.call_sync("org.freedesktop.Avahi", path, interface, method, parameters,
            None, self._Gio.DBusCallFlags.NONE, 250, None).unpack()

    def running(self):
        if not self._ready or self._bus is None or self._bus.is_closed():
            return False
        # A later address collision must fail closed, but never spawn a probe
        # or make one blocking IPC per video frame.
        if time.monotonic() - self._last_check >= 1:
            self._last_check = time.monotonic()
            try:
                self._ready = self._call(self._group, "org.freedesktop.Avahi.EntryGroup", "GetState") == (2,)
            except Exception:
                self._ready = False
        return self._ready

    def close(self):
        self._ready = False
        bus, group = self._bus, self._group
        try:
            if bus is not None and not bus.is_closed() and group is not None:
                self._call(group, "org.freedesktop.Avahi.EntryGroup", "Free")
        finally:
            self._group = None
            self._bus = None
            if bus is not None and not bus.is_closed():
                bus.close_sync(None)
