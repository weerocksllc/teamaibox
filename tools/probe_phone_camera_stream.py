#!/usr/bin/python3
"""Synthetic frames -> FIFO -> virtio-media -> actual Android Camera2 result."""
import json
import os
from pathlib import Path
import select
import stat
import subprocess
import time


def main():
    config = json.loads(Path('/run/phone/config.json').read_bytes())
    assert os.getuid() == 10001 and config['instance'] == 21, 'synthetic_instance_required'
    adb = ['/opt/cuttlefish/bin/adb', '-s', '127.0.0.1:6540']
    package = 'com.teamaibox.phonecameratest'

    def command(*args):
        result = subprocess.run([*adb, *args], capture_output=True, timeout=12)
        if result.returncode:
            raise RuntimeError('guest_command_failed')
        return result.stdout

    result = dict(status='failed', syntheticOnly=True, microphoneUsed=False,
                  transport='fifo-i420-vhost-user-media', framesSent=0)
    fifo = Path('/tmp/phone-camera-input/frame.mjpg')
    descriptor = None
    try:
        assert stat.S_ISFIFO(fifo.lstat().st_mode), 'camera_fifo_missing'
        result['cameraServiceBefore'] = command('shell', 'dumpsys', 'media.camera').decode(errors='replace').splitlines()[:28]
        result['guestVideoDevices'] = command('shell', 'ls', '/sys/class/video4linux').decode().splitlines()
        result['providerApex'] = command('shell', 'getprop', 'ro.boot.vendor.apex.com.google.emulated.camera.provider.hal').decode().strip()
        assert b'Success' in command('install', '/opt/teamaibox/test-camera.apk'), 'fixture_install_failed'
        command('shell', 'pm', 'grant', package, 'android.permission.CAMERA')
        command('shell', 'am', 'start', '-W', '-n', package+'/.MainActivity')
        jpeg = Path('/opt/teamaibox/camera-checker.jpg').read_bytes()
        assert jpeg[:2]==b'\xff\xd8' and jpeg[-2:]==b'\xff\xd9' and len(jpeg)<640*480*2, 'source_jpeg_invalid'
        # Public host-created input, not the fixture APK's source.jpg and not
        # the Android camera's output. The guest still independently captures.
        frame = jpeg + bytes(640*480*2-len(jpeg))
        result.update(transport='fifo-mjpeg-slot-vhost-user-media',sourceJpegBytes=len(jpeg))
        deadline = time.monotonic()+55
        next_frame = time.monotonic()
        next_sample = 0
        offset = 0
        while time.monotonic() < deadline:
            if descriptor is None:
                try:
                    descriptor = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
                    offset = 0
                except OSError as error:
                    if error.errno != 6:
                        raise
                    time.sleep(.05)
            now = time.monotonic()
            if descriptor is not None and now >= next_frame:
                if select.select([], [descriptor], [], .02)[1]:
                    try:
                        offset += os.write(descriptor, frame[offset:])
                        if offset == len(frame):
                            result['framesSent'] += 1
                            offset = 0
                            next_frame = time.monotonic()+1/15
                    except BlockingIOError:
                        pass
                    except BrokenPipeError:
                        os.close(descriptor)
                        descriptor = None
            elif descriptor is not None:
                time.sleep(min(.02, max(0, next_frame-now)))
            if now >= next_sample:
                next_sample = now+1
                try:
                    sample = json.loads(command('exec-out', 'run-as', package, 'cat', 'files/sample.json'))
                except (RuntimeError, ValueError):
                    continue
                result['guest'] = sample
                if sample.get('error'):
                    raise RuntimeError(sample['error'])
                if sample.get('jpegCaptured'):
                    break
        sample = result.get('guest', {})
        assert result['framesSent'] >= 30 and sample.get('previewFrames', 0) >= 30, 'camera_preview_missing'
        assert sample.get('jpegCaptured'), 'camera_photo_missing'
        for key in ('previewY', 'photoRgb'):
            a, b, c, d = sample[key]
            assert a < 40 and b > 210 and c > 210 and d < 40, 'guest_pattern_mismatch'
        result['status'] = 'passed'
    except Exception as error:
        result['failure'] = str(error) if isinstance(error, (RuntimeError, AssertionError)) else type(error).__name__
        if isinstance(error, OSError):
            result['errno'] = error.errno
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            command('shell', 'am', 'force-stop', package)
            result['appStopped'] = True
            result['cameraServiceAfter'] = command('shell', 'dumpsys', 'media.camera').decode(errors='replace').splitlines()[:28]
            if result['status'] != 'passed':
                # This guest contains only the public test APK and synthetic
                # pattern. Retain component errors, not a whole device log.
                lines = command('logcat', '-d', '-t', '1500').decode(errors='replace').splitlines()
                result['cameraErrors'] = [line[:350] for line in lines if
                    any(word in line.lower() for word in ('camera', 'v4l2', 'virtio_media')) and
                    any(word in line.lower() for word in ('error', 'fail', 'unsupported', 'invalid', 'unable', 'denied'))][-30:]
                result['guestVideoListing'] = command('shell', 'ls', '-l', '/sys/class/video4linux', '/dev/video0').decode(errors='replace')[:1500]
                # adb shell joins arguments again. Send this script as one
                # argument, not sh -c with an unquoted command that only runs ls.
                result['virtioDevices'] = command('shell', 'for d in /sys/bus/virtio/devices/virtio*; do echo "$d"; cat "$d/device"; readlink "$d/driver"; done').decode(errors='replace')[-5000:]
                for name in ('kernel.log', 'launcher.log'):
                    path=Path('/phone/cuttlefish/instances/cvd-21/logs')/name
                    rows=path.read_text(errors='replace').splitlines() if path.exists() else []
                    result[name]=[line[:500] for line in rows if any(word in line.lower() for word in ('virtio_media','vhost','camera','video4linux','video0','failed','error'))][-45:]
            log = Path('/tmp/phone-camera-input/backend.log')
            result['backendDiagnostic'] = log.read_text(errors='replace')[-1800:] if log.exists() else ''
        except Exception:
            result['appStopped'] = False
            result['status'] = 'failed'
    print(json.dumps(result))
    return result['status'] != 'passed'


if __name__ == '__main__':
    raise SystemExit(main())
