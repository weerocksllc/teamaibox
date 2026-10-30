"""Physical USB -> private broker -> guest Camera2, without saving real media.

Test-only control of a new instance 21. This is not a member API endpoint.
Image samples are compared in memory; the report contains error/counts only.
"""
from collections import deque
import io
import json
import os
import select
from pathlib import Path
import stat
import struct
import subprocess
import sys
import threading
import time
import uuid

sys.path[:0] = ['/run/phone-test', '/opt/teamaibox', '/opt/teamaibox/camera-python']
from PIL import Image
from phone_camera_client import control
from phone_usb_camera_source import UsbCameraSource, DEVICE


def device_fds():
    target = os.stat(DEVICE).st_rdev
    count = 0
    for path in Path('/proc/self/fd').iterdir():
        try:
            value = path.stat()
            count += stat.S_ISCHR(value.st_mode) and value.st_rdev == target
        except FileNotFoundError:
            pass
    return count


def main(source_factory=UsbCameraSource, count_device_fds=device_fds):
    config = json.loads(Path('/run/phone/config.json').read_bytes())
    assert os.getuid() == 10001 and config['instance'] == 21, 'disposable_instance_required'
    adb = ['/opt/cuttlefish/bin/adb', '-s', '127.0.0.1:6540']
    package = 'com.teamaibox.phonecamerausb'
    result = dict(status='failed', physicalUsb=True, androidTested=True, mediaSaved=False,
                  microphoneUsed=False, memberEnabled=False, cycles=[])
    current = None; source = None; renew = threading.Event(); finished = threading.Event()
    grids = deque(maxlen=60); grid_lock = threading.Lock(); renew_errors = []
    decoder = None; decode_results = []

    def decode_summary(rows):
        failures = [row for row in rows if row.get('decodeResult') != 0 or row.get('fullDecodeResult', 0) != 0]
        return dict(frames=len(rows), failedFrames=len(failures),
                    first=rows[:2], last=rows[-2:], failures=failures[:5])

    def command(*args):
        r = subprocess.run([*adb, *args], capture_output=True, timeout=12)
        if r.returncode:result['failedGuestCommand']=dict(arguments=list(args),exitCode=r.returncode,stderr=r.stderr.decode(errors='replace')[-800:],stdout=r.stdout.decode(errors='replace')[-800:])
        assert r.returncode == 0, 'guest_command_failed'
        return r.stdout

    def sample():
        r = subprocess.run([*adb, 'exec-out', 'run-as', package, 'cat', 'files/sample.json'],
                           capture_output=True, timeout=12)
        if r.returncode:
            result['sampleReadFailure'] = dict(exitCode=r.returncode, stderr=r.stderr.decode(errors='replace')[-600:])
            return {}
        try:
            value = json.loads(r.stdout)
            assert not value.get('error'), value.get('error')
            return value
        except (ValueError, subprocess.TimeoutExpired):
            result['sampleReadFailure'] = dict(invalidJson=True, stdoutBytes=len(r.stdout), stderr=r.stderr.decode(errors='replace')[-600:])
            return {}

    def call(action, binding=None, frame=None, **extra):
        return control(dict(action=action, grant=binding or current, **extra), frame)

    def renewal():
        while not finished.wait(.7):
            binding = current
            if renew.is_set() and binding is not None:
                try:
                    call('renew', binding, leaseExpiresAt=int(time.time()*1000)+4000)
                except Exception:
                    if renew.is_set() and current == binding:
                        renew_errors.append('lease_renewal_failed')

    def authorized():
        try:
            return current is not None and call('status')['state'] in ('waiting', 'receiving')
        except Exception:
            return False

    def deliver(frame, sequence, pts):
        if decoder is not None and len(decode_results)<60:
            decoder.stdin.write(struct.pack('!I',len(frame))+frame);decoder.stdin.flush()
            assert select.select([decoder.stdout],[],[],2)[0], 'guest_decoder_timeout'
            value=decoder.stdout.readline()
            assert value, 'guest_decoder_exited'
            decode_results.append(json.loads(value))
        # Downsample only in memory for end-to-end content comparison. No
        # camera JPEG or reconstructable thumbnail is written to evidence.
        with Image.open(io.BytesIO(frame)) as image:
            rgb = image.convert('RGB')
            grid = []
            for y in range(30, 480, 60):
                for x in range(40, 640, 80):
                    r, g, b = rgb.getpixel((x, y))
                    grid.append((299*r+587*g+114*b+500)//1000)
            rgb.close()
        call('frame', frame=frame, sequence=sequence)
        with grid_lock:
            grids.append((time.monotonic(), grid))

    def nearest_error(grid):
        assert len(grid) == 64 and all(type(x) is int and 0 <= x <= 255 for x in grid), 'guest_sample_invalid'
        now = time.monotonic()
        with grid_lock:
            recent = [v for at, v in grids if now-at < 3]
        assert recent, 'host_frame_sample_missing'
        # Camera HAL conversion can use full or limited-range luminance.
        return min(sum(abs(a-b) for a, b in zip(grid, candidate))/64
                   for v in recent for candidate in (v, [16+219*x/255 for x in v]))

    def start_app():
        command('shell', 'am', 'force-stop', package)
        command('exec-out', 'run-as', package, 'rm', '-f', 'files/sample.json', 'files/sample.pending')
        command('shell', 'am', 'start', '-W', '-n', package+'/.MainActivity')

    def observe(seconds):
        at = time.monotonic(); last = -1; errors = []; photo_error = None; first_frame = None
        while time.monotonic()-at < seconds:
            value = sample()
            grid = value.get('previewGrid')
            count = value.get('previewFrames', 0)
            if grid and count > last:
                assert value['physicalInputTest'] and not value['mediaSaved'], 'guest_scope_changed'
                assert (value['width'], value['height']) == (640, 480), 'guest_size_changed'
                # A neutral/black input cannot pass merely by increasing its
                # frame counter. Real camera input must also match host pixels.
                assert max(grid) > 35, 'guest_received_neutral_only'
                error = nearest_error(grid)
                errors.append(error); last = count
                if first_frame is None:
                    first_frame = time.monotonic()-at
            if value.get('jpegCaptured') and photo_error is None:
                assert (value['jpegWidth'], value['jpegHeight']) == (640, 480), 'photo_size_changed'
                photo_error = nearest_error(value['photoGrid'])
            time.sleep(.12)
        result['lastObservation']=dict(seconds=round(time.monotonic()-at,3),comparedSamples=len(errors),
            previewFrames=last,photoReceived=photo_error is not None,capture=source.status())
        assert len(errors) >= 12 and last >= 60, 'android_preview_incomplete'
        assert sum(e <= 20 for e in errors)/len(errors) >= .9, 'android_preview_content_mismatch'
        assert photo_error is not None and photo_error <= 20, 'android_photo_content_mismatch'
        assert source.status()['frames'] >= 60 and source.status()['state'] == 'receiving', 'usb_source_stopped'
        return dict(previewFrames=last, comparedSamples=len(errors),
                    matchedSamples=sum(e <= 20 for e in errors),
                    meanLumaError=round(sum(errors)/len(errors), 4),
                    maxLumaError=round(max(errors), 4), photoLumaError=round(photo_error, 4),
                    firstObservedFrameSeconds=round(first_frame, 4), jpegCaptured=True,
                    output=[640, 480], capture=source.status())

    def cleared(at):
        before = sample().get('previewFrames', 0)
        while time.monotonic()-at < 7:
            value = sample(); state = call('status')
            if (value.get('previewFrames', 0) > before and value.get('previewGrid') and
                    max(value['previewGrid']) < 30 and state['state'] == 'stopped' and
                    state['retainedFrameBytes'] == 0 and count_device_fds() == 0):
                source.close()
                return dict(seconds=round(time.monotonic()-at, 4), deviceFds=0,
                            retainedFrameBytes=0, androidNeutral=True,
                            beforeFrames=before, afterFrames=value['previewFrames'])
            time.sleep(.1)
        raise AssertionError('usb_revoke_did_not_clear_guest')

    thread = threading.Thread(target=renewal, daemon=True); thread.start()
    try:
        assert count_device_fds() == 0, 'camera_already_open'
        result['installedDriverSha256']=command('shell','su','0','sha256sum','/vendor_dlkm/lib/modules/virtio-media.ko').decode().split()[0]
        candidate=Path('/run/phone-test/guest-driver.json')
        if candidate.exists():
            import hashlib
            build=json.loads(candidate.read_bytes())
            module=Path('/run/phone-test/virtio-media.ko')
            assert hashlib.sha256(module.read_bytes()).hexdigest()==build['moduleSha256'], 'guest_driver_transfer_changed'
            command('push',str(module),'/data/local/tmp/virtio-media.ko')
            # Only this freshly created, account-free guest. Normal module
            # version/signature/CFI checks remain enabled; never force a load.
            command('shell','su','0','rmmod','virtio_media')
            loaded=subprocess.run([*adb,'shell','su','0','insmod','/data/local/tmp/virtio-media.ko'],capture_output=True,timeout=15)
            result['guestDriverLoadDiagnostic']=(loaded.stdout+loaded.stderr).decode(errors='replace')[-1200:]
            assert loaded.returncode==0, 'guest_driver_load_failed'
            assert b'virtio_media ' in command('shell','cat','/proc/modules'), 'guest_driver_missing'
            result['guestDriver']=dict(loaded=True,moduleSha256=build['moduleSha256'])
        assert b'Success' in command('install', '/run/phone-test/phone-camera-usb-v3.apk'), 'fixture_install_failed'
        command('shell', 'pm', 'grant', package, 'android.permission.CAMERA')
        command('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
        command('shell', 'wm', 'dismiss-keyguard')
        result['providerApex'] = command('shell', 'getprop', 'ro.boot.vendor.apex.com.google.emulated.camera.provider.hal').decode().strip()
        libraries=command('shell','find /system /vendor /apex -name "*yuv*.so" 2>/dev/null; true').decode().splitlines()
        result['decoderLibraries']=libraries
        if libraries:
            command('push','/run/phone-test/decode-jpeg-v1','/data/local/tmp/decode-jpeg')
            command('shell','chmod','700','/data/local/tmp/decode-jpeg')
            decoder=subprocess.Popen([*adb,'shell','-T','/data/local/tmp/decode-jpeg',libraries[0]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            command('push','/run/phone-test/capture-jpeg-v3','/data/local/tmp/capture-jpeg')
            command('shell','chmod','700','/data/local/tmp/capture-jpeg')
        for kind in ('explicit-stop', 'lease-expiry'):
            current = {k:config[k] for k in ('phoneId', 'ownerId', 'runId', 'generation')}
            current.update({k:str(uuid.uuid4()) for k in ('id', 'sessionId', 'sourceId')}, sourceKind='usb')
            call('open', leaseExpiresAt=int(time.time()*1000)+4000); renew.set()
            grids.clear()
            source = source_factory(pixel_format='MJPG', deliver=deliver, authorized=authorized)
            if kind=='explicit-stop' and libraries:
                raw=command('shell','su','0','/data/local/tmp/capture-jpeg',libraries[0])
                result['virtualDeviceDecode']=decode_summary([json.loads(v) for v in raw.splitlines()])
                raw=command('shell','su','0','/data/local/tmp/capture-jpeg',libraries[0],'remap')
                result['virtualDeviceRemapDecode']=decode_summary([json.loads(v) for v in raw.splitlines()])
                raw=command('shell','su','0','/data/local/tmp/capture-jpeg',libraries[0],'hal-queue')
                result['virtualDeviceHalQueueDecode']=decode_summary([json.loads(v) for v in raw.splitlines()])
            start_app(); observed = observe(8)
            renew.clear(); at = time.monotonic()
            if kind == 'explicit-stop':
                call('close')
            clear = cleared(at)
            result['cycles'].append(dict(kind=kind, **observed, clear=clear))
            current = None; source = None; grids.clear()
        assert not renew_errors, 'lease_renewal_failed'
        logs=command('logcat','-d','-s','ExtCamDevSsn').decode(errors='replace')
        result['decodeFailures']=logs.count('Convert V4L2 frame to YU12 failed')
        result['kernelTimeWarnings']=logs.count('shutterTs is in the future')
        assert result['decodeFailures']==0, 'android_dropped_corrupt_camera_frame'
        result['status'] = 'passed'
    except Exception as error:
        result['failure'] = str(error) if isinstance(error, (AssertionError, RuntimeError)) else type(error).__name__
        # Disposable, account-free test guest only. No frames, thumbnails or
        # microphone data; keep the device/service cause instead of just a count.
        result['cameraDiagnostics']={}
        for name,args in (
            ('devices',('shell','ls','-l','/dev/video*')),
            ('service',('shell','dumpsys','-t','1','media.camera')),
            ('sampleFiles',('exec-out','run-as',package,'ls','-l','files')),
            ('logs',('logcat','-d','-t','400','-s','PhoneUsbTest','AndroidRuntime','CameraService','ExtCamDevSsn','ExternalCameraDeviceSession','Camera3-Device','Camera3-OutputStream','libyuv','libjpeg','CameraProviderManager'))):
            try:result['cameraDiagnostics'][name]=command(*args).decode(errors='replace')[-4000:]
            except Exception as diagnostic:result['cameraDiagnostics'][name]=type(diagnostic).__name__
        try:
            value=json.loads(command('exec-out','run-as',package,'cat','files/sample.json'))
            result['cameraDiagnostics']['app']={k:value[k] for k in ('previewFrames','error','captureFailureReason','captureFailureFrame','captureImageCaptured') if k in value}
        except Exception:pass
        if source is not None and getattr(source,'diagnostic',None):
            result['captureDiagnostic'] = source.diagnostic
    finally:
        renew.clear(); finished.set(); thread.join(2)
        if current is not None:
            try:
                call('close')
            except Exception:
                result.update(status='failed', closeFailed=True)
        if source is not None:
            try:
                source.close()
            except Exception:
                result.update(status='failed', sourceStopFailed=True)
        if decoder is not None:
            decoder.stdin.close()
            try:decoder.wait(3)
            except subprocess.TimeoutExpired:decoder.kill();decoder.wait(3)
            result['directGuestDecode']=dict(**decode_summary(decode_results),exitCode=decoder.returncode)
            command('shell','rm','-f','/data/local/tmp/decode-jpeg','/data/local/tmp/capture-jpeg')
        try:
            command('shell', 'am', 'force-stop', package)
            command('exec-out', 'run-as', package, 'rm', '-f', 'files/sample.json', 'files/sample.pending')
            at = time.monotonic()
            while time.monotonic()-at < 4:
                state = command('shell', 'dumpsys', '-t', '1', 'media.camera').decode(errors='replace')
                if 'Active Camera Clients:\n[]' in state:
                    break
                time.sleep(.1)
            assert 'Active Camera Clients:\n[]' in state, 'android_camera_not_closed'
            assert not command('exec-out', 'run-as', package, 'ls', '-A', 'files').strip(), 'private_sample_retained'
            result.update(appStopped=True, privateSamplesRemoved=True)
        except Exception:
            result.update(status='failed', appStopped=False)
        grids.clear()
        result['remainingDeviceFds'] = count_device_fds()
        if result['remainingDeviceFds']:
            result['status'] = 'failed'
    print(json.dumps(result), flush=True)
    return result['status'] != 'passed'


if __name__ == '__main__':
    raise SystemExit(main())
