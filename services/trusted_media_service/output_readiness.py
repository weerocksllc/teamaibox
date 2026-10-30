"""Fresh, non-advertising output checks on the private control boundary.

This is admission input, not proof of an Apple connection or rendered media.
No display, local audio device or desktop lease is probed. Only the browser
receiver/codec/SFU dependencies participate; this creates no media graph.
"""
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import stat
import time

from .gdp_media_ingress import _gstreamer


def node_identity(value):
    if (type(value) is not dict or set(value) != {"nodeId", "nodeGeneration"}
            or not isinstance(value["nodeId"], str)
            or not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", value["nodeId"])
            or type(value["nodeGeneration"]) is not int or not 1 <= value["nodeGeneration"] <= 2**53 - 1):
        raise ValueError("cast_readiness_node_invalid")
    return dict(value)


class OutputReadiness:
    def __init__(self, *, identity, interface, rooms, hdmi=None, clock=time.time, gst=_gstreamer):
        self._identity = node_identity(identity)
        if (not isinstance(interface, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,14}", interface)
                or not callable(getattr(rooms, "probe", None)) or not callable(clock) or not callable(gst)):
            raise ValueError("cast_readiness_configuration_invalid")
        if hdmi is not None:
            raise ValueError("cast_runtime_output_invalid")
        self._interface, self._rooms = interface, rooms
        self._clock, self._gst = clock, gst

    def _network_and_receiver(self):
        # No discovery daemon is started to answer this request.
        flags = int(Path(f"/sys/class/net/{self._interface}/flags").read_text().strip(), 16)
        if flags & 0x1001 != 0x1001:  # UP + MULTICAST
            return False
        for name in ("/usr/bin/uxplay", "/usr/bin/dbus-daemon", "/usr/sbin/avahi-daemon"):
            info = os.stat(name)
            if not stat.S_ISREG(info.st_mode) or not os.access(name, os.X_OK):
                return False
        return True

    def snapshot(self):
        result = {**self._identity, "outputs": {
            "browser": {"available": False, "reasonCode": "cast_media_runtime_unavailable"}}}
        try:
            if not self._network_and_receiver():
                raise ValueError("not ready")
            Gst = self._gst()
            present = lambda names: all(Gst.ElementFactory.find(name) is not None for name in names)
            # Match the package's actual decoder / VP8-Opus publisher, not a
            # claim that NVENC/NVDEC has been exercised by a registry lookup.
            if not present(("avdec_h264", "gdppay", "gdpdepay", "fdsink", "fdsrc", "appsink", "appsrc")):
                raise ValueError("not ready")
        except Exception:
            for sink in result["outputs"]:
                result["outputs"][sink] = {"available": False, "reasonCode": "cast_media_runtime_unavailable"}
        else:
            try:
                # webrtcbin is installed by plugins-bad, but its ICE agent
                # comes from the separately packaged gstreamer1.0-nice. A
                # registered sink alone cannot prove a publishable pipeline.
                if not present(("livekitwebrtcsink", "vp8enc", "opusenc", "webrtcbin",
                                "nicesrc", "nicesink", "dtlssrtpenc", "dtlssrtpdec",
                                "sctpenc", "sctpdec", "rtpbin")) or self._rooms.probe() is not True:
                    raise ValueError("not ready")
                result["outputs"]["browser"] = {"available": True, "reasonCode": None}
            except Exception:
                result["outputs"]["browser"]["reasonCode"] = "cast_sfu_unavailable"
        # The timestamp is taken after real checks; callers additionally bound
        # the complete round-trip and match the configured node generation.
        result["observedAt"] = datetime.fromtimestamp(self._clock(), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return result
