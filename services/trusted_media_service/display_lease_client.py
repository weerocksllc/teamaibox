"""Fixed local greeter handoff; never accepts a command or device from HTTP."""
import json
import math
import os
import socket
import stat
import time
from .hdmi_media_output import KmsDevice, HdmiOutputError

SOCKET = '/run/teamaibox/display-lease/control.sock'

def request_display(operation, session_id=None, expires_at=None):
    channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        channel.settimeout(15)
        channel.connect(SOCKET)
        body = {'operation': operation}
        if operation == 'acquire': body.update(sessionId=session_id, expiresAt=expires_at)
        channel.sendall(json.dumps(body, separators=(',', ':')).encode()+b'\n')
        response = bytearray()
        while not response.endswith(b'\n') and len(response) < 512:
            part=channel.recv(1)
            if not part: break
            response.extend(part)
        result=json.loads(response)
        allowed = {'cast_hdmi_display_busy', 'cast_hdmi_disconnected_or_unsupported'}
        if (type(result) is not dict or set(result) != {'available', 'reasonCode'}
                or type(result['available']) is not bool
                or (result['available'] and result['reasonCode'] is not None)
                or (not result['available'] and result['reasonCode'] not in allowed)):
            raise HdmiOutputError('cast_hdmi_display_busy')
        if not result['available']: raise HdmiOutputError(result['reasonCode'])
        return channel
    except Exception as error:
        channel.close()
        if isinstance(error,HdmiOutputError): raise
        raise HdmiOutputError('cast_hdmi_display_busy') from None

class ManagedKmsDevice(KmsDevice):
    """Closing the held socket restores only the greeter we actually stopped."""
    def bind_lease(self, session_id, expires_at):
        self._lease_request=(session_id,expires_at)

    def probe(self):
        try:
            for path, major, code in ((self.path,226,'cast_hdmi_unavailable'),
                    (self.audio_path,116,'cast_hdmi_audio_unavailable')):
                info=os.stat(path,follow_symlinks=False)
                if not stat.S_ISCHR(info.st_mode) or os.major(info.st_rdev)!=major or not os.access(path,os.R_OK|os.W_OK):
                    raise HdmiOutputError(code)
        except OSError:
            raise HdmiOutputError('cast_hdmi_unavailable') from None
        channel=request_display('status')
        channel.close()

    def acquire(self):
        if getattr(self,'_display_channel',None) is not None or not hasattr(self,'_lease_request'):
            raise HdmiOutputError('cast_hdmi_display_busy')
        session, expiry=self._lease_request
        if not isinstance(expiry,(int,float)) or not math.isfinite(expiry) or expiry<=time.time(): raise HdmiOutputError()
        self._display_channel=request_display('acquire', session, expiry)
        try: super().acquire(refresh_connector=True)
        except Exception:
            self.release()
            raise

    def release(self):
        super().release()
        channel=getattr(self,'_display_channel',None)
        if channel is not None:
            channel.close()
            self._display_channel=None
