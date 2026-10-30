"""One ephemeral receiver child with private pairing and decoded-media pipes.

This is process plumbing, not the API supervisor or a media-readiness claim.
Only a separately admitted pipeline may consume the two GDP streams. No LAN
RTP listener, log parser, file recording, shell command or sender-controlled
GStreamer argument is used. HDMI/SFU health still needs real downstream events.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import select
import signal
import socket
import subprocess
import sys
from threading import Event, Lock, Thread, Timer, current_thread
import time

from .native_pairing_bridge import NativePairingBridge, PairingBridgeError
from .runtime_api import RECEIVER_NAME, UUID
from .service_child_process import spawn_service_child
from .native_failure import assertion_code
from .video_geometry import parse_geometry

VIDEO_SINK_PIPELINE = "gdppay ! fdsink fd=4 sync=false"
AUDIO_SINK_PIPELINE = "gdppay ! fdsink fd=5 sync=false"
# Apple H.264 decoders can negotiate Y444/Y42B instead of a browser-compatible
# 4:2:0 format. Normalize before GDP instead of treating valid input as a crash.
# videorate really drops excess frames; it does not merely relabel caps and
# never duplicates frames while a sender is paused. No resolution upscaling.
VIDEO_CONVERTER_PIPELINE = "videoconvert ! videorate drop-only=true max-rate=30 ! video/x-raw,format=I420,framerate=30/1"


class NativeReceiverProcessError(RuntimeError):
    def __init__(self):
        super().__init__("cast_native_receiver_unavailable")


class NativeReceiverProcess:
    def __init__(self, *, callback_client, executable: Path = Path("/usr/bin/uxplay"), private_discovery_bus=None):
        # This is package configuration, never an HTTP body field.
        if not isinstance(executable, Path) or not executable.is_absolute() \
                or not callable(getattr(callback_client, "pair_source", None)):
            raise ValueError("cast_native_receiver_configuration_invalid")
        if private_discovery_bus not in (None, "unix:path=/run/teamaibox/discovery/bus"):
            raise ValueError("cast_native_receiver_configuration_invalid")
        self._callback, self._executable = callback_client, str(executable)
        self._discovery_bus = private_discovery_bus
        self._lock = Lock()
        self._closed = Event()
        self._process = None
        self._bridge = None
        self._thread = None
        self._expiry = None
        self._video = self._audio = None
        self._launched = False
        self._failure_code = None
        self._assertion_code = None
        self._diagnostic_thread = None
        self._geometry = None
        self._source_state = "waiting"
        self._source_state_revision = 1

    def start(self, *, session_id: str, receiver_name: str, pin: str, lifetime_seconds: int) -> None:
        if (not isinstance(session_id, str) or not UUID.fullmatch(session_id)
                or not isinstance(receiver_name, str) or not RECEIVER_NAME.fullmatch(receiver_name)
                or not isinstance(pin, str) or not re.fullmatch(r"[1-9][0-9]{3}", pin)
                or type(lifetime_seconds) is not int or not 1 <= lifetime_seconds <= 14400):
            raise ValueError("cast_native_receiver_request_invalid")
        with self._lock:
            if self._launched or self._closed.is_set():
                raise NativeReceiverProcessError()
            self._launched = True  # A failed instance is not silently reused.
            channel, child = socket.socketpair()
            video_read, video_write = os.pipe()
            audio_read, audio_write = os.pipe()
            secret = bytearray(pin.encode("ascii") + b"\n")
            try:
                self._bridge = NativePairingBridge(channel=channel, callback_client=self._callback,
                                                  session_id=session_id, pin=pin)
                self._video, self._audio = video_read, audio_read
                # Fixed 1080p30 request and package-owned output pipelines.
                # GDP carries caps/timestamps through bounded anonymous pipes;
                # no device, media path or URL can arrive from a Web request.
                arguments = [self._executable, "-n", receiver_name, "-nh", "-m",
                    "-s", "1920x1080@30", "-fps", "30", "-nofreeze", "-nc", "no",
                    # UxPlay's Linux default wraps -vc in a second RGB
                    # conversion. Our -vc already owns a complete caps/rate
                    # pipeline; wrapping it creates incompatible adjacent
                    # caps and a partially parsed GStreamer graph.
                    "-srgb", "no", "-vd", "avdec_h264", "-vc", VIDEO_CONVERTER_PIPELINE, "-vs", VIDEO_SINK_PIPELINE,
                    "-as", AUDIO_SINK_PIPELINE]
                trampoline = str(Path(__file__).with_name("native_receiver_exec.py"))
                environment = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent",
                    "XDG_CONFIG_HOME": "/nonexistent", "GST_DEBUG": "0",
                    "GST_REGISTRY": "/run/teamaibox/gstreamer-registry.bin"}
                if self._discovery_bus is not None:
                    environment["DBUS_SYSTEM_BUS_ADDRESS"] = self._discovery_bus
                self._process = spawn_service_child(
                    [sys.executable, "-I", trampoline, str(os.getpid()), str(child.fileno()), str(video_write),
                     str(audio_write), *arguments], stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, cwd="/",
                    env=environment, close_fds=True,
                    pass_fds=(child.fileno(), video_write, audio_write), start_new_session=True)
                self._process.stdin.write(secret)
                self._process.stdin.close()
                self._diagnostic_thread = Thread(target=self._read_assertion, daemon=True,
                                                name="cast-native-failure")
                self._diagnostic_thread.start()
                deadline = time.monotonic() + lifetime_seconds
                self._thread = Thread(target=self._watch, args=(channel, deadline), daemon=True,
                                      name="cast-native-receiver")
                self._expiry = Timer(lifetime_seconds, self.close)
                self._expiry.daemon = True
                self._expiry.start()
                self._thread.start()
            except Exception:
                self._closed.set()
                self._terminate()
                if self._bridge is not None:
                    self._bridge.close()
                else:
                    channel.close()
                for fd in (video_read, audio_read):
                    os.close(fd)
                self._video = self._audio = None
                raise NativeReceiverProcessError() from None
            finally:
                secret[:] = b"\0" * len(secret)
                child.close()
                os.close(video_write)
                os.close(audio_write)

    def _watch(self, channel: socket.socket, deadline: float) -> None:
        try:
            while not self._closed.is_set() and time.monotonic() < deadline:
                if self._process.poll() is not None:
                    self._failure_code = self._exit_code(self._process.returncode)
                    break
                ready, _, _ = select.select([channel], [], [], min(0.2, max(0, deadline - time.monotonic())))
                if ready:
                    # Only start the bounded proof deadline when the child
                    # actually sends a proof, not while waiting for a sender.
                    self._bridge.serve_one()
        except Exception as error:
            if not self._closed.is_set():
                self._failure_code = (error.failure_code if isinstance(error, PairingBridgeError)
                                      else "native_pairing_channel")
                # EOF may be observed just before poll sees a native exit.
                # Retain only its bounded class, never native stderr/core data.
                if self._failure_code == "pairing_eof":
                    try:
                        status = self._process.wait(timeout=0.1)
                        self._failure_code = self._exit_code(status)
                    except subprocess.TimeoutExpired:
                        pass
        finally:
            self.close()

    def _read_assertion(self):
        # Stderr is consumed only in bounded transient memory. Discard every
        # line except an allowlisted compiler source location or four bounded
        # dimensions. Native stdout, labels, keys and user text are discarded.
        pending = b""
        discarding = False
        try:
            while True:
                chunk = os.read(self._process.stderr.fileno(), 4096)
                if not chunk:
                    break
                for part in chunk.splitlines(keepends=True):
                    if not discarding:
                        pending += part
                        if len(pending) > 2048:
                            pending = b""
                            discarding = True
                    if part.endswith(b"\n"):
                        if not discarding:
                            # Package-owned fixed events, not a heuristic over
                            # frame timing or a parse of sender-controlled logs.
                            if pending in (b"TBS1 0\n", b"TBS1 1\n"):
                                next_state = "connected" if pending == b"TBS1 1\n" else "disconnected"
                                if next_state != self._source_state:
                                    self._source_state = next_state
                                    self._source_state_revision = getattr(self, "_source_state_revision", 1) + 1
                            geometry = parse_geometry(pending)
                            if geometry is not None:
                                self._geometry = geometry
                            if self._assertion_code is None:
                                self._assertion_code = assertion_code(pending)
                        pending, discarding = b"", False
        except (OSError, ValueError):
            pass

    def _exit_code(self, status):
        if self._diagnostic_thread is not None:
            self._diagnostic_thread.join(0.2)
        if status == -signal.SIGABRT:
            return self._assertion_code or "native_sigabrt"
        return "native_sigsegv" if status == -signal.SIGSEGV else "native_exit"

    def failure_code(self):
        # A fixed classification only, never native output, sender keys or PIN.
        return self._failure_code or "native_stopped"

    def video_geometry(self):
        # A format report cannot authorize a source. Never expose it before
        # the existing pairing bridge has accepted the sender, or after close.
        geometry = self._geometry
        return dict(geometry) if geometry is not None and self.authorized_source_id() is not None else {}

    def source_state(self):
        if self._closed.is_set():
            return "disconnected"
        # A SETUP event alone can never replace successful Platform pairing.
        return self._source_state if self.authorized_source_id() is not None else "waiting"

    def source_state_snapshot(self):
        """Return only the versioned, package-owned source lifecycle state."""
        state = self.source_state()
        revision = getattr(self, "_source_state_revision", 1)
        return {"state": state, "revision": revision if state != "waiting" else 1}

    def duplicate_media_readers(self) -> tuple[int, int]:
        """Internal pipeline handoff. Caller owns/closes the returned read FDs."""
        with self._lock:
            if self._closed.is_set() or self._process is None or self._process.poll() is not None:
                raise NativeReceiverProcessError()
            video = os.dup(self._video)
            try:
                return video, os.dup(self._audio)
            except Exception:
                os.close(video)
                raise NativeReceiverProcessError() from None

    def running(self) -> bool:
        # Process liveness does NOT mean mDNS, decoding, HDMI or SFU readiness.
        with self._lock:
            return not self._closed.is_set() and self._process is not None and self._process.poll() is None

    def authorized_source_id(self) -> str | None:
        bridge = self._bridge
        if self._closed.is_set() or bridge is None:
            return None
        return bridge.authorized_source_id()

    def _terminate(self) -> None:
        process = self._process
        if process is None:
            return
        if process.stdin is not None and not process.stdin.closed:
            process.stdin.close()
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except PermissionError:
                # Darwin can deny a group signal during an exec/exit race.
                # The unreaped Popen child still has an exact owned PID; do
                # not widen the signal target or treat denial as cleanup.
                if process.poll() is None:
                    process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    if process.poll() is None:
                        process.kill()
                process.wait(timeout=3)

    def close(self) -> None:
        self._closed.set()
        if self._expiry is not None:
            self._expiry.cancel()
        # Shutdown pairing immediately before waiting for a callback or the
        # child: an in-flight callback must not deliver a late authorization.
        if self._bridge is not None:
            self._bridge.close()
        with self._lock:
            self._terminate()
            if self._process is not None and self._process.stderr is not None:
                self._process.stderr.close()
            for field in ("_video", "_audio"):
                fd = getattr(self, field)
                if fd is not None:
                    os.close(fd)
                    setattr(self, field, None)
        if self._thread is not None and self._thread is not current_thread():
            self._thread.join(timeout=1)
