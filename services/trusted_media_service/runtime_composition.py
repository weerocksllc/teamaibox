"""Compose paired media and separately admitted outputs without startup discovery.

Deployment must supply the admitted private TLS endpoints, RAM-only SFU key
and main-appliance interface. This factory does not perform resource admission
or enable the public casting application: those remain mandatory outside it.
Browser casting never imports a display/ALSA backend or acquires a desktop lease.
Legacy HDMI configuration is rejected, not silently enabled or ignored.
"""
from threading import RLock

from .discoverable_receiver import DiscoverableReceiverProcess
from .livekit_browser_sink import LiveKitBrowserSink
from .publisher_credentials import PublisherCredentialIssuer
from .receiver_supervisor import PairedReceiverSupervisor
from .runtime_api import TrustedMediaRuntimeApi
from .viewer_token_issuer import LiveKitViewerTokenIssuer
from .private_discovery import configuration
from .output_readiness import OutputReadiness


class TrustedMediaRuntime:
    def __init__(self, *, callback_client, room_control, api_key, api_secret,
                 private_publisher_endpoint, viewer_endpoint, interface, hdmi=None, identity=None):
        configuration(receiver_name="Team-AI-0123456789", interface=interface)
        if hdmi is not None:
            raise ValueError("cast_runtime_output_invalid")
        if not all(callable(getattr(room_control, name, None)) for name in ("create", "remove_viewer", "delete", "close")):
            raise ValueError("cast_room_control_configuration_invalid")
        self._lock, self._closed = RLock(), False
        self._rooms = room_control
        self._publisher = PublisherCredentialIssuer(api_key=api_key, api_secret=api_secret,
                                                    endpoint=private_publisher_endpoint)
        try:
            self._viewers = LiveKitViewerTokenIssuer(api_key=api_key, api_secret=api_secret, endpoint=viewer_endpoint)
            outputs = {"browser": lambda **request: LiveKitBrowserSink(**request,
                room_control=self._rooms, publisher_issuer=self._publisher, viewer_issuer=self._viewers)}
            self._supervisor = PairedReceiverSupervisor(callback_client=callback_client,
                receiver_factory=lambda: DiscoverableReceiverProcess(callback_client=callback_client, interface=interface),
                output_factories=outputs)
            readiness = None if identity is None else OutputReadiness(identity=identity, interface=interface,
                rooms=self._rooms).snapshot
            self.api = TrustedMediaRuntimeApi(supervisor=self._supervisor, token_issuer=self._viewers, readiness=readiness)
        except Exception:
            self._publisher.close()
            if getattr(self, "_viewers", None) is not None:
                self._viewers.close()
            raise

    def close(self):
        with self._lock:
            if self._closed:
                return
            # Revoke admissions and stop input/room before destroying issuer
            # secrets. A failed close retains all handles for an exact retry.
            self.api.shutdown()
            self._rooms.close()
            self._publisher.close()
            self._viewers.close()
            self._closed = True


# Existing browser-only callers retain their unchanged, device-free default.
BrowserMediaRuntime = TrustedMediaRuntime
