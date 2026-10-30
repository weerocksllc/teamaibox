"""Owned room/publisher lifecycle used by PairedReceiverSupervisor.

The public signalling gateway is a separate, mandatory authorization boundary.
It must consume the same issuer's admission using independently authenticated
user/browser context and must make every reconnect obtain a fresh admission.
Nothing in this adapter exposes the internal SFU or grants viewing by itself.
"""
from threading import RLock

from .publisher_credentials import PublisherCredentialIssuer
from .viewer_token_issuer import LiveKitViewerTokenIssuer, UUID
from .webrtc_media_output import WebRtcMediaOutput, OUTPUT_FAILURE_CODES

BROWSER_SINK_FAILURE_CODES = OUTPUT_FAILURE_CODES | frozenset((
    "browser_room", "browser_publisher", "browser_sink",
))


class BrowserSinkError(RuntimeError):
    def __init__(self, code="browser_sink"):
        self.failure_code = code if code in BROWSER_SINK_FAILURE_CODES else "browser_sink"
        super().__init__("cast_browser_sink_unavailable")


class LiveKitBrowserSink:
    def __init__(self, *, session_id: str, expires_at: float, room_control,
                 publisher_issuer: PublisherCredentialIssuer, viewer_issuer: LiveKitViewerTokenIssuer,
                 output_factory=WebRtcMediaOutput):
        if (not isinstance(session_id, str) or not UUID.fullmatch(session_id)
                or not all(callable(getattr(room_control, name, None)) for name in ("create", "remove_viewer", "delete"))
                or not isinstance(publisher_issuer, PublisherCredentialIssuer)
                or not isinstance(viewer_issuer, LiveKitViewerTokenIssuer) or not callable(output_factory)):
            raise ValueError("cast_browser_sink_configuration_invalid")
        self._session, self._expiry = session_id, expires_at
        self._rooms, self._publisher, self._viewers = room_control, publisher_issuer, viewer_issuer
        self._output_factory = output_factory
        self._output = None
        self._room_owned = self._started = self._closed = False
        self._ready = self._failed = False
        self._failure_code = None
        self._lock = RLock()

    def start(self):
        with self._lock:
            if self._started or self._closed:
                raise BrowserSinkError()
            self._started = self._room_owned = True  # Own even a lost CreateRoom response.
            try:
                self._rooms.create(session_id=self._session, expires_at=self._expiry)
                self._ready = True
            except Exception:
                self._failed = True
                self._failure_code = "browser_room"
                raise BrowserSinkError(self._failure_code) from None  # Supervisor cleans this exact handle.

    def push(self, media, sample):
        with self._lock:
            if self._closed or self._failed or not self._ready:
                raise BrowserSinkError()
            if self._output is None:
                # The receiver may advertise for minutes before pairing.
                # The supervisor forwards only authenticated source samples;
                # issue the short-lived join credential at that boundary,
                # not when the room/advertisement is opened.
                try:
                    credential = self._publisher.issue(
                        session_id=self._session, session_expires_at=int(self._expiry))
                    self._output = self._output_factory(credential=credential)
                except Exception:
                    self._failed = True
                    self._failure_code = "browser_publisher"
                    raise BrowserSinkError(self._failure_code) from None
            try:
                self._output.push(media, sample)
            except Exception as error:
                self._failed = True
                code = getattr(error, "failure_code", "browser_sink")
                self._failure_code = code if code in BROWSER_SINK_FAILURE_CODES else "browser_sink"
                raise BrowserSinkError(self._failure_code) from None

    def snapshot(self):
        with self._lock:
            if self._failed and not self._closed:
                return {"healthy": False, "state": "failed"}
            if self._closed or self._output is None:
                return {"healthy": False, "state": "closed" if self._closed else "waiting"}
            value = self._output.snapshot()
            if value.get("state") == "failed":
                self._failed = True
                self._failure_code = self._output_failure_code()
            return value

    def _output_failure_code(self):
        method = getattr(self._output, "failure_code", None)
        code = method() if callable(method) else "browser_sink"
        return code if code in BROWSER_SINK_FAILURE_CODES else "browser_sink"

    def failure_code(self):
        with self._lock:
            return self._failure_code or self._output_failure_code()

    def disconnect_viewer(self, *, viewer_identity_id: str, browser_instance_id=None):
        with self._lock:
            self._viewers.revoke_viewer(session_id=self._session, viewer_identity_id=viewer_identity_id,
                                        browser_instance_id=browser_instance_id)
            # Expired JWTs do not make connected participants disappear from
            # this ledger. RemoveParticipant plus ListParticipants read-back
            # must complete before freeing their slots. Old bearers remain
            # consumed/revoked at the separate mandatory ingress boundary.
            for participant in self._viewers.connected_participants(
                    session_id=self._session, viewer_identity_id=viewer_identity_id,
                    browser_instance_id=browser_instance_id):
                try:
                    self._rooms.remove_viewer(session_id=self._session, participant_identity=participant)
                    self._viewers.confirm_disconnected(session_id=self._session, participant_identity=participant)
                except Exception:
                    raise BrowserSinkError() from None

    def close(self):
        with self._lock:
            self._ready = False
            # Stop authorization first; still try deleting the room if the
            # publisher cannot close, and vice versa. Never lose a failed
            # handle or call a failed cleanup a successful stop.
            self._viewers.clear_session(self._session)
            failed = False
            if self._output is not None:
                try:
                    self._output.close()
                    self._output = None
                except Exception:
                    failed = True
            if self._room_owned:
                try:
                    self._rooms.delete(session_id=self._session)
                    self._room_owned = False
                except Exception:
                    failed = True
            if failed:
                raise BrowserSinkError()
            self._closed = True
