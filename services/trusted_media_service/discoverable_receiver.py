"""Own the private discovery daemon and native receiver as one lifecycle."""
from threading import RLock

from .native_receiver_process import NativeReceiverProcess, NativeReceiverProcessError
from .private_discovery import PrivateDiscovery, BUS_ADDRESS


class DiscoverableReceiverProcess:
    def __init__(self, *, callback_client, interface, discovery_factory=None, receiver_factory=None):
        self._discovery = (discovery_factory or (lambda: PrivateDiscovery(interface=interface)))()
        self._receiver = (receiver_factory or (lambda: NativeReceiverProcess(
            callback_client=callback_client, private_discovery_bus=BUS_ADDRESS)))()
        self._lock, self._started, self._closed = RLock(), False, False

    def start(self, **request):
        with self._lock:
            if self._started or self._closed:
                raise NativeReceiverProcessError()
            self._started = True
            try:
                self._discovery.start(receiver_name=request.get("receiver_name"))
                self._receiver.start(**request)
            except Exception:
                self.close()
                raise NativeReceiverProcessError() from None

    def running(self):
        return not self._closed and self._discovery.running() and self._receiver.running()

    def failure_code(self):
        if not self._discovery.running():
            return "discovery_exit"
        method = getattr(self._receiver, "failure_code", None)
        return method() if callable(method) else "native_stopped"

    def duplicate_media_readers(self):
        if not self.running():
            raise NativeReceiverProcessError()
        return self._receiver.duplicate_media_readers()

    def authorized_source_id(self):
        return self._receiver.authorized_source_id() if self.running() else None

    def video_geometry(self):
        return self._receiver.video_geometry() if self.running() else {}

    def source_state(self):
        return self._receiver.source_state() if self.running() else "disconnected"

    def source_state_snapshot(self):
        if self.running() and callable(getattr(self._receiver, "source_state_snapshot", None)):
            return self._receiver.source_state_snapshot()
        return {"state": "disconnected", "revision": 1}

    def close(self):
        with self._lock:
            self._closed = True
            failed = False
            # Native disconnect withdraws its DNS-SD entries first. Discovery
            # still shuts down if the producer's termination was uncertain.
            for owned in (self._receiver, self._discovery):
                try:
                    owned.close()
                except Exception:
                    failed = True
            if failed:
                raise NativeReceiverProcessError()
