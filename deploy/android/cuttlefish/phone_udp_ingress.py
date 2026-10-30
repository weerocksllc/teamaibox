"""Bounded datagram ingress for a future UDP/MPEG-TS camera adapter.

Not a public API and not enabled by any product runtime. A trusted host service
must authorize the owner/run and hand in an already-bound socket. This component
never binds a port, changes firewall rules or gives a socket to Android. Packet
framing checks are not a substitute for the subsequent H.264 decoder checks.
"""
from dataclasses import dataclass
import ipaddress
import socket
import threading
import time

MAX_DATAGRAM=188*348  # Whole TS packets, below the IPv4 UDP payload maximum.

class UdpIngressError(RuntimeError):
    pass

@dataclass(frozen=True)
class UdpPolicy:
    address: str
    port: int
    sources: tuple

    @classmethod
    def from_admin(cls, value):
        if not isinstance(value,dict) or set(value)!={'listenAddress','listenPort','allowedSources'}:
            raise UdpIngressError('phone_camera_udp_policy_invalid')
        try:
            if not isinstance(value['listenAddress'],str):raise ValueError()
            address=ipaddress.IPv4Address(value['listenAddress'])
            port=value['listenPort'];sources=value['allowedSources']
            if address.is_unspecified or address.is_multicast or address.is_link_local or int(address)==0xffffffff:
                raise ValueError()
            if type(port) is not int or not 1024<=port<=65535 or not isinstance(sources,list) or not sources:
                raise ValueError()
            if any(not isinstance(v,str) for v in sources):raise ValueError()
            networks=tuple(ipaddress.IPv4Network(v,strict=True) for v in sources)
            # The administrator chooses explicit source networks. Do not
            # impose an arbitrary subnet size or number-of-networks quota.
            # A wildcard source or listener is still not an explicit scope.
            if len(set(networks))!=len(networks) or any(n.prefixlen==0 or n.network_address.is_unspecified or n.network_address.is_multicast or n.network_address.is_link_local for n in networks):
                raise ValueError()
            return cls(str(address),port,networks)
        except (TypeError,ValueError,ipaddress.AddressValueError,ipaddress.NetmaskValueError):
            raise UdpIngressError('phone_camera_udp_policy_invalid') from None

    def allows(self,address):
        try:return any(ipaddress.IPv4Address(address) in n for n in self.sources)
        except (TypeError,ValueError):return False

def ts_datagram(value):
    """Recognize only whole 188-byte TS packets (not RTP, raw H.264 or M2TS)."""
    return isinstance(value,bytes) and 188<=len(value)<=MAX_DATAGRAM and len(value)%188==0 and all(value[i]==0x47 for i in range(0,len(value),188))

class UdpIngress:
    def __init__(self, bound_socket, policy, *, deliver, on_end=lambda reason:None, stall_seconds=3):
        if not isinstance(policy,UdpPolicy) or not callable(deliver) or not callable(on_end) or stall_seconds!=3:
            raise UdpIngressError('phone_camera_udp_configuration_invalid')
        if (bound_socket.family!=socket.AF_INET or bound_socket.getsockopt(socket.SOL_SOCKET,socket.SO_TYPE)!=socket.SOCK_DGRAM
                or bound_socket.getsockname()!=(policy.address,policy.port)
                or bound_socket.getsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR)
                or hasattr(socket,'SO_REUSEPORT') and bound_socket.getsockopt(socket.SOL_SOCKET,socket.SO_REUSEPORT)):
            raise UdpIngressError('phone_camera_udp_socket_invalid')
        # Caller keeps the original fd for its lease. Close releases only this
        # duplicate; the host lease owner closes its own fd on revocation.
        self.socket=bound_socket.dup();self.socket.settimeout(.1)
        self.socket.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,128*1024)
        self.policy=policy;self.deliver=deliver;self.on_end=on_end
        self.stopped=threading.Event()
        self.counts=dict(received=0,accepted=0,bytes=0,wrongSource=0,wrongFormat=0)
        # The user may open the receiver before starting their encoder. An
        # empty, still-authorized receiver is waiting, not a broken stream.
        # Once packets arrive the existing stall deadline applies. Its caller
        # owns the renewable authorization lease and closes this socket on stop.
        self.last_accepted=None;self.started=time.monotonic();self.reason=None
        self.thread=threading.Thread(target=self._receive,daemon=True);self.thread.start()

    def _receive(self):
        try:
            while not self.stopped.is_set():
                if self.last_accepted is not None and time.monotonic()-self.last_accepted>=3:
                    self.reason='phone_camera_udp_input_stalled';break
                try:data,peer=self.socket.recvfrom(MAX_DATAGRAM+1)
                except socket.timeout:continue
                except OSError:
                    if not self.stopped.is_set():self.reason='phone_camera_udp_socket_lost'
                    break
                now=time.monotonic();self.counts['received']+=1
                # No arbitrary bitrate or packets-per-second product limit.
                # Kernel receive buffers and the decoder's bounded queue,
                # together with the phone cgroup, contain resource use.
                if not self.policy.allows(peer[0]):self.counts['wrongSource']+=1;continue
                if not ts_datagram(data):self.counts['wrongFormat']+=1;continue
                try:self.deliver(data,time.monotonic_ns())
                except Exception:self.reason='phone_camera_udp_delivery_failed';break
                self.counts['accepted']+=1;self.counts['bytes']+=len(data);self.last_accepted=now
        finally:
            self.stopped.set();self.socket.close()
            if self.reason:
                try:self.on_end(self.reason)
                except Exception:pass

    def status(self):
        return dict(**self.counts,stopped=self.stopped.is_set(),errorCode=self.reason,
                    transport='udp',container='mpeg-ts',externalInputEncrypted=False)

    def close(self):
        self.stopped.set()
        if self.thread is not threading.current_thread():self.thread.join(1)
        if self.thread.is_alive():raise UdpIngressError('phone_camera_udp_stop_unconfirmed')
