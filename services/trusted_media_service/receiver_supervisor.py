"""Single-session owner joining native paired input to independent outputs.

No Docker access, shell, host configuration, recording or persistent state.
The service composition supplies only fixed, separately admitted sink
factories. A missing HDMI factory rejects HDMI before receiver advertisement;
it is never silently substituted by a browser sink or a fake success.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import math
import os
from threading import Event, RLock, Thread, current_thread
import time

from .gdp_media_ingress import GdpMediaIngress, MediaIngressError
from .native_receiver_process import NativeReceiverProcess
from .native_pairing_bridge import PairingBridgeError
from .native_failure import native_assertion_code
from .livekit_browser_sink import BROWSER_SINK_FAILURE_CODES
from .runtime_api import UUID, RECEIVER_NAME, PRIVACY_POLICY

FAILURE_CODES = MediaIngressError.CODES | PairingBridgeError.CODES | BROWSER_SINK_FAILURE_CODES | frozenset(("native_sigsegv", "native_sigabrt", "session_expired", "native_exit", "native_stopped",
    "native_pairing_channel", "discovery_exit", "outputs_failed", "source_binding", "streaming_callback", "supervisor"))


class ReceiverSupervisorError(RuntimeError):
    def __init__(self, code="supervisor"):
        self.failure_code = code if code in FAILURE_CODES or native_assertion_code(code) else "supervisor"
        super().__init__("cast_receiver_supervisor_unavailable")


@dataclass(repr=False)
class _Session:
    session_id: str
    expires_at: float
    stop: Event = field(default_factory=Event)
    receiver: object = None
    ingress: object = None
    outputs: dict = field(default_factory=dict)
    # A failed close remains owned, including an output replaced by PATCH.
    pending_cleanup: list = field(default_factory=list)
    failed_outputs: set = field(default_factory=set)
    output_failure_code: str = "outputs_failed"
    streaming_reported: bool = False
    source_state: str = "waiting"
    source_state_revision: int = 1
    thread: Thread | None = None


class PairedReceiverSupervisor:
    """Concrete runtime API supervisor, with fail-closed cleanup ownership.

    Each output factory receives only session UUID/expiry. It must implement
    push(media, Gst.Sample), snapshot() and idempotent close(). A browser sink
    additionally implements disconnect_viewer(viewer_identity_id). Factories
    own their exact room/transport resources, including uncertain startup.
    The caller owns session lifecycle and the independently authenticated
    single-use signalling ingress, neither of which is inferred here.
    """
    def __init__(self, *, callback_client, output_factories: dict,
                 receiver_factory=None, ingress_factory=GdpMediaIngress, clock=time.time):
        if (not all(callable(getattr(callback_client, name, None)) for name in ("pair_source", "mark_streaming"))
                or not isinstance(output_factories, dict) or not output_factories
                or set(output_factories) != {"browser"}
                or not all(callable(factory) for factory in output_factories.values())
                or not callable(ingress_factory) or not callable(clock)):
            raise ValueError("cast_supervisor_configuration_invalid")
        self._callback, self._factories = callback_client, dict(output_factories)
        self._receiver_factory = receiver_factory or (lambda: NativeReceiverProcess(callback_client=callback_client))
        self._ingress_factory, self._clock = ingress_factory, clock
        self._lock = RLock()
        self._active = None
        self._last_failure = None  # At most one session; only UUID and fixed enum.

    def _owned(self, session_id):
        if (not isinstance(session_id, str) or not UUID.fullmatch(session_id)
                or self._active is None or self._active.session_id != session_id):
            raise ReceiverSupervisorError()
        return self._active

    def _sinks(self, request):
        value = request.get("outputSinks")
        if (value != ["browser"] or "browser" not in self._factories
                or request.get("browserStartsMuted") is not False
                or request.get("mediaPrivacyPolicy") != PRIVACY_POLICY):
            raise ReceiverSupervisorError()
        return tuple(value)

    def _new_output(self, session, sink):
        # Factory returns a not-yet-started handle so even failed/uncertain
        # startup remains owned. It must not open a room in __init__.
        output = self._factories[sink](session_id=session.session_id, expires_at=session.expires_at)
        session.pending_cleanup.append(output)
        methods = ("start", "push", "snapshot", "close") + (("disconnect_viewer",) if sink == "browser" else ())
        if not all(callable(getattr(output, name, None)) for name in methods):
            raise ReceiverSupervisorError()
        output.start()
        session.outputs[sink] = output
        session.pending_cleanup.remove(output)

    def start(self, request):
        with self._lock:
            if self._active is not None:
                raise ReceiverSupervisorError()
            sinks = self._sinks(request)
            try:
                session_id, expires = request["sessionId"], datetime.fromisoformat(request["expiresAt"].replace("Z", "+00:00"))
                if not isinstance(session_id, str) or not UUID.fullmatch(session_id) or expires.tzinfo is None:
                    raise ValueError()
                lifetime = math.floor(expires.timestamp() - self._clock())
                if not 1 <= lifetime <= 14400 or not RECEIVER_NAME.fullmatch(request["receiverName"]):
                    raise ValueError()
            except Exception:
                raise ReceiverSupervisorError() from None
            session = self._active = _Session(session_id=session_id, expires_at=expires.timestamp())
            self._last_failure = None
            try:
                # All requested outputs are admitted before UxPlay can
                # advertise. No source name or PIN enters output factories.
                for sink in sinks:
                    self._new_output(session, sink)
                session.receiver = self._receiver_factory()
                session.receiver.start(session_id=session_id, receiver_name=request["receiverName"],
                                       pin=request["pairingPin"], lifetime_seconds=lifetime)
                video, audio = session.receiver.duplicate_media_readers()
                try:
                    session.ingress = self._ingress_factory(video_fd=video, audio_fd=audio)
                finally:
                    os.close(video)
                    os.close(audio)
                session.thread = Thread(target=self._run, args=(session,), daemon=True, name="cast-media-session")
                session.thread.start()
            except Exception:
                session.stop.set()
                self._cleanup(session)
                raise ReceiverSupervisorError() from None

    def _tick(self, session):
        with self._lock:
            if self._active is not session or session.stop.is_set():
                return
            if self._clock() >= session.expires_at:
                raise ReceiverSupervisorError("session_expired")
            if not session.receiver.running():
                method = getattr(session.receiver, "failure_code", None)
                raise ReceiverSupervisorError(method() if callable(method) else "native_stopped")
            # Detect unplug/sink failure even while the sender is paused or
            # has not paired. "waiting" is not a fault; no content is inspected.
            for sink, output in list(session.outputs.items()):
                if sink not in session.failed_outputs:
                    try:
                        if output.snapshot().get("state") in ("failed", "closed"):
                            raise ReceiverSupervisorError()
                    except Exception as error:
                        self._fail_output(session, sink, output, error)
            if not set(session.outputs) - session.failed_outputs:
                raise ReceiverSupervisorError(session.output_failure_code)
            source_id = session.receiver.authorized_source_id()
            snapshot_method = getattr(session.receiver, "source_state_snapshot", None)
            if callable(snapshot_method):
                snapshot = snapshot_method()
                source_state, source_revision = snapshot.get("state"), snapshot.get("revision")
            else:
                state_method = getattr(session.receiver, "source_state", None)
                source_state = state_method() if callable(state_method) else ("connected" if source_id else "waiting")
                source_revision = session.source_state_revision + int(source_state != session.source_state)
            if (source_state not in ("waiting", "connected", "disconnected")
                    or type(source_revision) is not int or source_revision < session.source_state_revision):
                raise ReceiverSupervisorError("source_binding")
            if source_revision > session.source_state_revision or source_state != session.source_state:
                session.source_state, session.source_state_revision = source_state, source_revision
                if source_state != "connected":
                    discard = getattr(session.ingress, "discard_pending", None)
                    if callable(discard):
                        discard()
            if source_id is None:
                return  # No PID/log/unauthenticated packet implies pairing.
            if not UUID.fullmatch(source_id):
                raise ReceiverSupervisorError("source_binding")
            if session.source_state != "connected":
                return
            # Never wait for a video frame while 8 ms audio packets arrive.
            # Pull at most two samples per track per tick; audio's bounded
            # jitter queue is separate from video's two-frame queue. The
            # bounded loop preserves stop/health responsiveness.
            for media in ("audio", "video"):
                for _ in range(2):
                    sample = session.ingress.pull(media, timeout_ms=0)
                    if sample is None:
                        break
                    if not session.streaming_reported:
                        try:
                            result = self._callback.mark_streaming(session_id=session.session_id, source_connection_id=source_id)
                        except Exception:
                            raise ReceiverSupervisorError("streaming_callback") from None
                        if (not isinstance(result, dict) or result.get("state") != "streaming"
                                or result.get("session_id") != session.session_id or session.stop.is_set()):
                            raise ReceiverSupervisorError("streaming_callback")
                        session.streaming_reported = True
                    for sink, output in list(session.outputs.items()):
                        if sink in session.failed_outputs or session.stop.is_set():
                            continue
                        try:
                            output.push(media, sample)
                            if output.snapshot().get("state") == "failed":
                                raise ReceiverSupervisorError()
                        except Exception as error:
                            self._fail_output(session, sink, output, error)
                    sample = None
                    if not set(session.outputs) - session.failed_outputs:
                        raise ReceiverSupervisorError(session.output_failure_code)

    @staticmethod
    def _fail_output(session, sink, output, error=None):
        session.failed_outputs.add(sink)
        code = getattr(error, "failure_code", None)
        if code not in BROWSER_SINK_FAILURE_CODES:
            method = getattr(output, "failure_code", None)
            code = method() if callable(method) else "outputs_failed"
        session.output_failure_code = code if code in BROWSER_SINK_FAILURE_CODES else "outputs_failed"
        # Keep the exact handle until cleanup is confirmed. Other outputs live.
        try:
            output.close()
        except Exception:
            pass

    def _run(self, session):
        while not session.stop.wait(0.005):
            try:
                self._tick(session)
            except Exception as error:
                with self._lock:
                    if not session.stop.is_set():
                        code = getattr(error, "failure_code", "supervisor")
                        self._last_failure = (session.session_id, code if code in FAILURE_CODES or native_assertion_code(code) else "supervisor")
                session.stop.set()
        # Unexpected native exit or TTL performs the same exact cleanup as
        # DELETE. No callback text, sender label, PIN or frame is logged.
        with self._lock:
            if self._active is session:
                try:
                    self._cleanup(session)
                except ReceiverSupervisorError:
                    pass  # Retained for an explicit/expiry cleanup retry.

    def _cleanup(self, session):
        failed = False
        for field_name in ("receiver", "ingress"):
            owned = getattr(session, field_name)
            if owned is not None:
                try:
                    owned.close()
                    setattr(session, field_name, None)
                except Exception:
                    failed = True
        for sink, output in list(session.outputs.items()):
            try:
                output.close()
                del session.outputs[sink]
            except Exception:
                failed = True
        for output in list(session.pending_cleanup):
            try:
                output.close()
                session.pending_cleanup.remove(output)
            except Exception:
                failed = True
        if failed:
            raise ReceiverSupervisorError()
        if self._active is session:
            self._active = None

    def stop(self, request):
        # Stop the producer before waiting on a potentially in-flight network
        # callback, so no late response can resume media after revocation.
        session = self._active
        if session is None:
            return  # Idempotent cleanup after the native/expiry watchdog.
        if session.session_id != request.get("sessionId"):
            raise ReceiverSupervisorError()
        session.stop.set()
        if session.receiver is not None:
            try:
                session.receiver.close()
            except Exception:
                pass  # Still attempt every owned sink/room below.
        with self._lock:
            self._cleanup(session)
        if session.thread is not None and session.thread is not current_thread():
            session.thread.join(2)
            if session.thread.is_alive():
                raise ReceiverSupervisorError()

    def update(self, request):
        with self._lock:
            session = self._owned(request.get("sessionId"))
            if session.stop.is_set():
                raise ReceiverSupervisorError()
            if session.pending_cleanup:
                # Never stack new partial resources over an uncertain PATCH.
                for output in list(session.pending_cleanup):
                    try:
                        output.close()
                        session.pending_cleanup.remove(output)
                    except Exception:
                        raise ReceiverSupervisorError() from None
            sinks = self._sinks(request)
            # Never remove a working sink until the added sink can start.
            added = []
            previously_failed = set(session.failed_outputs)
            try:
                for sink in sinks:
                    if sink in session.failed_outputs and sink in session.outputs:
                        # Recovery is an explicit PATCH, not an automatic retry
                        # loop. Do not allocate over an uncertain old handle.
                        session.outputs[sink].close()
                        del session.outputs[sink]
                    if sink not in session.outputs:
                        self._new_output(session, sink)
                        added.append(sink)
                        session.failed_outputs.discard(sink)
            except Exception:
                for sink in added:
                    session.pending_cleanup.append(session.outputs.pop(sink))
                    if sink in previously_failed:
                        session.failed_outputs.add(sink)
                for output in list(session.pending_cleanup):
                    try:
                        output.close()
                        session.pending_cleanup.remove(output)
                    except Exception:
                        pass
                raise ReceiverSupervisorError() from None
            for sink in list(session.outputs):
                if sink not in sinks:
                    session.outputs[sink].close()
                    del session.outputs[sink]
                    session.failed_outputs.discard(sink)

    def disconnect_viewer(self, request):
        with self._lock:
            session = self._owned(request.get("sessionId"))
            viewer = request.get("viewerIdentityId")
            if not isinstance(viewer, str) or not UUID.fullmatch(viewer):
                raise ReceiverSupervisorError()
            if "browser" in session.outputs:
                scope = {"browser_instance_id": request["browserInstanceId"]} if "browserInstanceId" in request else {}
                session.outputs["browser"].disconnect_viewer(viewer_identity_id=viewer, **scope)

    def health(self, session_id):
        with self._lock:
            if self._last_failure is not None and self._last_failure[0] == session_id:
                return {"healthy": False, "outputs": {"browser": {"healthy": False}},
                        "receiverState": "failed", "failureCode": self._last_failure[1]}
            session = self._owned(session_id)
            outputs = {"browser": {"healthy": False}}
            receiver_healthy = not session.stop.is_set() and session.receiver.running()
            if receiver_healthy:
                for sink, output in session.outputs.items():
                    if sink not in session.failed_outputs:
                        try:
                            snapshot = output.snapshot()
                            outputs[sink]["healthy"] = snapshot.get("healthy") is True
                            if snapshot.get("state") == "failed":
                                receiver_healthy = False
                        except Exception:
                            receiver_healthy = False
                    else:
                        receiver_healthy = False
            # Receiver liveness and delivered-media readiness are separate.
            # Before pairing, a running receiver has no frames yet; reporting
            # it failed made the real UI contradict its waiting-for-PIN state.
            result = {"healthy": receiver_healthy, "outputs": outputs}
            if session.ingress is not None and callable(getattr(session.ingress, 'snapshot', None)):
                from .media_progress import project_progress
                browser = session.outputs.get('browser')
                geometry = getattr(session.receiver, 'video_geometry', None)
                result['progress'] = project_progress(session.ingress.snapshot(),
                    browser.snapshot() if browser is not None else {},
                    geometry() if callable(geometry) else {},
                    session.source_state, session.source_state_revision)
            return result
