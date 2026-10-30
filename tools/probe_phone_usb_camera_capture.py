"""Real USB capture probe; no frame, audio or recording is retained in output."""
import json
import os
from pathlib import Path
import threading
import time

from phone_usb_camera_source import DEVICE, UsbCameraSource


def open_camera_fds():
    wanted = os.stat(DEVICE).st_rdev
    result = []
    for item in Path('/proc/self/fd').iterdir():
        try:
            if item.stat().st_rdev == wanted:
                result.append(int(item.name))
        except FileNotFoundError:
            pass
    return result


def main():
    result = dict(status='failed', physicalUsb=True, androidTested=False,
                  mediaSaved=False, microphoneUsed=False, cases=[])
    source = None
    permitted = threading.Event()
    permitted.set()
    count, last_sequence, last_pts, largest = 0, 0, -1, 0
    arrivals = []
    def delivered(frame, sequence, pts):
        nonlocal count, last_sequence, last_pts, largest
        assert len(frame) > 512 and frame[:2] == b'\xff\xd8' and frame[-2:] == b'\xff\xd9'
        assert sequence == last_sequence + 1 and pts > last_pts
        count += 1
        last_sequence, last_pts = sequence, pts
        largest = max(largest, len(frame))
        arrivals.append(time.monotonic())
        assert len(arrivals) <= 1200
    try:
        assert os.getuid() == 10001 and not open_camera_fds()
        try:
            UsbCameraSource(pixel_format='MJPG', deliver=delivered, authorized=lambda: False)
            raise AssertionError('unapproved_capture_started')
        except RuntimeError as error:
            assert str(error) == 'phone_camera_usb_permission_required'
        assert not open_camera_fds()
        result['cases'].append('permission-denial')
        source = UsbCameraSource(pixel_format='MJPG', deliver=delivered, authorized=permitted.is_set)
        time.sleep(8)
        assert source.status()['state'] == 'receiving' and count >= 70, source.status()
        result['mjpeg'] = source.status()
        # Kernel REQBUFS ownership must reject the competitor without stopping
        # the existing stream. A software flag alone would not prove this.
        before = count
        competitor = None
        try:
            competitor = UsbCameraSource(pixel_format='MJPG', deliver=lambda *_: None, authorized=lambda: True)
            raise AssertionError('busy_device_was_stolen')
        except RuntimeError as error:
            result['busyError'] = str(error)
        finally:
            if competitor is not None:
                competitor.close()
        time.sleep(2)
        assert count > before + 10 and source.status()['state'] == 'receiving'
        result['cases'].append('busy-rejected-original-continuing')
        at = time.monotonic()
        permitted.clear()
        while source.status()['state'] != 'stopped' and time.monotonic() - at < 3:
            time.sleep(.02)
        source.close()
        result['revokeSeconds'] = round(time.monotonic() - at, 4)
        assert result['revokeSeconds'] < 3 and not open_camera_fds()
        assert source.status()['errorCode'] == 'phone_camera_usb_permission_revoked'
        before = count
        time.sleep(.5)
        assert count == before
        result['cases'].append('revoke-closes-real-device')
        result['captureFrameCount'] = count
        result['observedFps'] = round((len(arrivals) - 1) / (arrivals[-1] - arrivals[0]), 3)
        result['maxDeliveryGapSeconds'] = round(max(b-a for a, b in zip(arrivals, arrivals[1:])), 4)
        result['largestJpegBytes'] = largest
        count, last_sequence, last_pts = 0, 0, -1
        arrivals.clear()
        permitted.set()
        # Reopen the same device in its other advertised format, not a second
        # camera. No special reset, process kill or driver reconfiguration.
        source = UsbCameraSource(pixel_format='YUYV', deliver=delivered, authorized=permitted.is_set)
        time.sleep(6)
        assert count >= 50 and source.status()['state'] == 'receiving', source.status()
        result['yuyv'] = source.status()
        result['cases'].append('raw-yuyv-reopen')
        at = time.monotonic()
        source.close()
        result['stopSeconds'] = round(time.monotonic() - at, 4)
        before = count
        time.sleep(.5)
        assert count == before and not open_camera_fds()
        assert result['stopSeconds'] < 3
        result['cases'].append('stop-closes-real-device')
        result['status'] = 'passed'
    except Exception as error:
        result['failure'] = str(error) if isinstance(error, (RuntimeError, AssertionError)) else type(error).__name__
        if getattr(error, 'diagnostic', None):
            result['deviceDiagnostic'] = error.diagnostic
    finally:
        permitted.clear()
        if source is not None:
            try:
                source.close()
            except Exception as error:
                result.update(status='failed', cleanupError=type(error).__name__)
        root = Path('/sys/fs/cgroup')
        result.update(remainingDeviceFds=len(open_camera_fds()),
            memoryPeakBytes=int((root/'memory.peak').read_text()),
            memorySwapBytes=int((root/'memory.swap.current').read_text()))
    print(json.dumps(result), flush=True)
    return result['status'] != 'passed'


if __name__ == '__main__':
    raise SystemExit(main())
