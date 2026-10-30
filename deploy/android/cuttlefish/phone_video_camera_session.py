"""Candidate video-source lifetime inside one phone's decoder process.

The caller has already opened the exact grant through the existing broker.
This code cannot authorize a source, renew a lease or select another phone.
No controller/API/catalog registration until the new runtime is verified.
"""
import threading

from phone_camera_input import CameraInput, CameraInputError
from phone_video_camera import VideoCameraSource


def validate_start(value, config):
    if not isinstance(value, dict) or set(value) != {'grant', 'loop'} or type(value['loop']) is not bool:
        raise CameraInputError('phone_camera_request_invalid')
    grant = CameraInput.binding(type('Binding', (), {'config':config})(), value['grant'])
    if grant['sourceKind'] != 'video':
        raise CameraInputError('phone_camera_source_unsupported')
    return {'grant':grant, 'loop':value['loop']}


class VideoCameraSession:
    """Release the old frame before native teardown; never extend authority.

    Run this object in a disposable worker process: its parent must enforce
    bounded termination if a native decoder fails to tear down. The explicit
    parent_alive callback can use pidfd without mistaking an RPC thread exit
    for loss of its entire supervising process.
    """
    validate = staticmethod(validate_start)

    def make_source(self, factory, fd):
        return factory(fd, loop=self.value['loop'], deliver=self._deliver, on_end=self._end)

    def __init__(self, value, config, fd, *, broker, parent_alive,
                 factory=VideoCameraSource):
        self.value = self.validate(value, config)
        if not callable(broker) or not callable(parent_alive):
            raise CameraInputError('phone_camera_request_invalid')
        self.grant = self.value['grant']
        self.broker, self.parent_alive = broker, parent_alive
        self.stop_event = threading.Event()
        self.ready = threading.Event()
        self.done = threading.Event()
        self.lock = threading.RLock()
        self.source = None
        self.reason = None
        self.last_source_diagnostic = None
        self.watch_error_type = None
        self.cleanup_error = None
        self.frames = 0
        self.last_pts = None
        self.loop_index = 0
        self.watcher = None
        self._constructing = True
        self._cleared = False
        if not parent_alive() or self.state()['state'] != 'waiting':
            raise CameraInputError('phone_camera_source_stopped')
        self.watcher = threading.Thread(target=self._watch, daemon=True)
        self.watcher.start()
        try:
            source = self.make_source(factory, fd)
            with self.lock:
                self.source = source
                self._constructing = False
            if self.stop_event.is_set():
                self._cleanup()
        except BaseException:
            with self.lock:
                self._constructing = False
            self.close()
            raise

    def state(self):
        return self.broker({'action':'status', 'grant':self.grant})

    def _deliver(self, frame, sequence, pts, iteration):
        if self.stop_event.is_set() or not self.parent_alive():
            raise CameraInputError('phone_camera_source_stopped')
        # The broker independently checks the full current binding and expiry
        # on every frame. There is no cached positive authorization here.
        result = self.broker({'action':'frame', 'grant':self.grant, 'sequence':sequence}, frame)
        if result.get('state') != 'receiving' or result.get('sourceId') != self.grant['sourceId']:
            raise CameraInputError('phone_camera_runtime_unavailable')
        self.frames = sequence
        self.last_pts, self.loop_index = pts, iteration
        self.ready.set()

    def _end(self, reason):
        self.reason = reason
        if self.source is not None:
            self.last_source_diagnostic = {key:getattr(self.source, key, None)
                for key in ('frames','discarded','failure_stage','failure_type')}
        self.stop_event.set()

    def _cleanup(self):
        with self.lock:
            if not self._cleared:
                try:
                    state = self.broker({'action':'close', 'grant':self.grant})
                    # Closing this exact grant clears only its old frame.
                    # A subsequent generic status can legitimately reject the
                    # old grant after another source starts; do not query or
                    # revoke that replacement to make an old cleanup pass.
                    if state.get('state') != 'stopped' or state.get('sourceId') != self.grant['sourceId']:
                        raise CameraInputError('phone_camera_runtime_unavailable')
                    self._cleared = True
                    self.cleanup_error = None
                except Exception:
                    self.cleanup_error = 'phone_camera_runtime_unavailable'
            if self.source is not None:
                source, self.source = self.source, None
                source.close()
            if not self._constructing:
                self.done.set()

    def _watch(self):
        try:
            while not self.stop_event.wait(.1):
                if not self.parent_alive() or self.state()['state'] not in ('waiting','receiving'):
                    self.reason = 'phone_camera_source_stopped'
                    self.stop_event.set()
        except Exception as error:
            self.watch_error_type = type(error).__name__
            self.reason = 'phone_camera_runtime_unavailable'
            self.stop_event.set()
        finally:
            self._cleanup()

    def close(self):
        self.stop_event.set()
        self._cleanup()
        if self.watcher is not None and self.watcher is not threading.current_thread():
            self.watcher.join(2)
        if self.cleanup_error:
            raise CameraInputError(self.cleanup_error)
