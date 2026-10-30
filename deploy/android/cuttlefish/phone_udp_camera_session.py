"""Network camera uses the same per-phone source lease as other inputs.

The host passes an already-bound socket, not a URL or permission to bind ports.
Waiting for a sender remains subject to lease expiry, stop and parent lifetime.
"""
import socket

from phone_camera_input import CameraInput, CameraInputError
from phone_udp_camera import UdpCameraSource
from phone_udp_ingress import UdpPolicy
from phone_video_camera_session import VideoCameraSession


def validate_start(value, config):
    if not isinstance(value, dict) or set(value) != {'grant', 'policy'}:
        raise CameraInputError('phone_camera_request_invalid')
    grant = CameraInput.binding(type('Binding', (), {'config': config})(), value['grant'])
    if grant['sourceKind'] != 'udp':
        raise CameraInputError('phone_camera_source_unsupported')
    UdpPolicy.from_admin(value['policy'])
    return {'grant': grant, 'policy': dict(value['policy'])}


class UdpCameraSession(VideoCameraSession):
    validate = staticmethod(validate_start)

    def __init__(self, value, config, fd, *, broker, parent_alive, factory=UdpCameraSource):
        super().__init__(value, config, fd, broker=broker, parent_alive=parent_alive, factory=factory)

    def make_source(self, factory, fd):
        # Both this wrapper and UdpIngress own duplicates. Neither closes the
        # host's original descriptor or changes its network namespace.
        with socket.fromfd(fd, socket.AF_INET, socket.SOCK_DGRAM) as incoming:
            return factory(incoming, UdpPolicy.from_admin(self.value['policy']),
                deliver=lambda frame, sequence, pts, received: self._deliver(frame, sequence, pts, 0),
                on_end=self._end)
