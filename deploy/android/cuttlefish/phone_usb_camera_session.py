"""USB acquisition uses the existing phone grant and camera cleanup lifecycle."""
from phone_camera_input import CameraInput, CameraInputError
from phone_usb_camera_fd_source import UsbCameraFdSource
from phone_video_camera_session import VideoCameraSession


def validate_start(value, config):
    if not isinstance(value, dict) or set(value) != {'grant', 'pixelFormat'} or value['pixelFormat'] not in ('MJPG', 'YUYV'):
        raise CameraInputError('phone_camera_request_invalid')
    grant = CameraInput.binding(type('Binding', (), {'config': config})(), value['grant'])
    if grant['sourceKind'] != 'usb':
        raise CameraInputError('phone_camera_source_unsupported')
    return {'grant': grant, 'pixelFormat': value['pixelFormat']}


class UsbCameraSession(VideoCameraSession):
    validate = staticmethod(validate_start)

    def __init__(self, value, config, fd, *, broker, parent_alive, factory=UsbCameraFdSource):
        super().__init__(value, config, fd, broker=broker, parent_alive=parent_alive, factory=factory)

    def make_source(self, factory, fd):
        return factory(fd, pixel_format=self.value['pixelFormat'],
            deliver=lambda frame, sequence, pts: self._deliver(frame, sequence, pts, 0),
            authorized=lambda: not self.stop_event.is_set() and self.parent_alive()
                and self.state()['state'] in ('waiting', 'receiving'), on_end=self._end)
