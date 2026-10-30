#!/usr/bin/python3
"""Read-only, node-local USB camera discovery and selection.

Candidate building block, not a member capture endpoint. QUERYCAP/ENUM_FMT do
not start streaming or change a camera's format. An external, trusted caller
must authenticate the phone owner and supply current device permissions.
Device identifiers are not authorization. Opening a stream still requires an
exclusive lease, a fresh attachment check and a bounded capture worker.
"""
import argparse
from dataclasses import dataclass
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import uuid

# Linux generic ioctl ABI, shared by the supported ARM64 and x86_64 builds.
# https://www.kernel.org/doc/html/latest/userspace-api/media/v4l/vidioc-querycap.html
# https://www.kernel.org/doc/html/latest/userspace-api/media/v4l/vidioc-enum-fmt.html
QUERYCAP = 0x80685600
ENUM_FMT = 0xC0405602
ENUM_FRAMESIZES = 0xC02C564A
ENUM_FRAMEINTERVALS = 0xC034564B
CAP_CAPTURE = 0x00000001
CAP_CAPTURE_MPLANE = 0x00001000
CAP_STREAMING = 0x04000000
CAP_DEVICE_CAPS = 0x80000000
MAX_DEVICES = 64
MAX_FORMATS = 64


class UsbCameraError(RuntimeError):
    pass


def fail(code):
    raise UsbCameraError('phone_camera_usb_' + code)


def identifier(value):
    if not isinstance(value, str):
        fail('request_invalid')
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        fail('request_invalid')
    if str(parsed) != value:
        fail('request_invalid')
    return value


def label(raw):
    value = raw.split(b'\0', 1)[0].decode('utf-8', errors='replace')
    return ''.join(c for c in value if c.isprintable()).strip()[:96]


def query_capabilities(fd, ioctl=fcntl.ioctl):
    value = bytearray(104)
    ioctl(fd, QUERYCAP, value, True)
    driver, card, bus, version, union, device_caps, _, _, _ = struct.unpack('=16s32s32s6I', value)
    caps = device_caps if union & CAP_DEVICE_CAPS else union
    # Physical devices often also expose a metadata-only /dev/videoN. The
    # per-node capabilities, not the union, decide whether it is a camera.
    if not caps & CAP_STREAMING or not caps & (CAP_CAPTURE | CAP_CAPTURE_MPLANE):
        return None
    buffer_type = 1 if caps & CAP_CAPTURE else 9
    formats = []
    for index in range(MAX_FORMATS + 1):
        raw = bytearray(64)
        struct.pack_into('=II', raw, 0, index, buffer_type)
        try:
            ioctl(fd, ENUM_FMT, raw, True)
        except OSError as error:
            if error.errno == errno.EINVAL:
                break
            raise
        if index == MAX_FORMATS:
            fail('inventory_limit')
        fourcc = struct.unpack_from('=I', raw, 44)[0].to_bytes(4, 'little')
        if any(c < 32 or c > 126 for c in fourcc):
            fail('device_invalid')
        value = fourcc.decode('ascii')
        if value in formats:
            fail('device_invalid')
        formats.append(value)
    if not formats:
        fail('device_invalid')
    return dict(driver=label(driver), name=label(card), captureType=buffer_type,
                formats=tuple(formats))


def query_modes(fd, formats, ioctl=fcntl.ioctl):
    """Read discrete hardware modes, never assume every format supports VGA.

    Continuous/stepwise mode negotiation remains explicitly unsupported in
    this first adapter. No VIDIOC_S_FMT or stream ownership is taken here.
    """
    result = []
    for fourcc in formats:
        if fourcc not in ('MJPG', 'YUYV'):
            continue
        pixel = int.from_bytes(fourcc.encode(), 'little')
        for index in range(65):
            raw = bytearray(44)
            struct.pack_into('=II', raw, 0, index, pixel)
            try:
                ioctl(fd, ENUM_FRAMESIZES, raw, True)
            except OSError as error:
                if error.errno == errno.EINVAL:
                    break
                raise
            if index == 64:
                fail('inventory_limit')
            _, _, kind, width, height = struct.unpack_from('=5I', raw)
            if kind != 1 or not 1 <= width <= 1920 or not 1 <= height <= 1920 or width*height > 1920*1080:
                continue
            for interval in range(33):
                raw = bytearray(52)
                struct.pack_into('=4I', raw, 0, interval, pixel, width, height)
                try:
                    ioctl(fd, ENUM_FRAMEINTERVALS, raw, True)
                except OSError as error:
                    if error.errno == errno.EINVAL:
                        break
                    raise
                if interval == 32 or len(result) >= 256:
                    fail('inventory_limit')
                _, _, _, _, kind, numerator, denominator = struct.unpack_from('=7I', raw)
                if kind == 1 and numerator > 0 and 15 <= denominator/numerator <= 30:
                    result.append(dict(pixelFormat=fourcc, width=width, height=height,
                                       frameRate=[denominator, numerator]))
    return result


def choose_mode(modes, pixel_format):
    candidates = [m for m in modes if m['pixelFormat'] == pixel_format]
    if not candidates:
        fail('format_unsupported')
    # Prefer the output aspect, avoid upscaling, then choose the smallest
    # adequate hardware mode. Do not decode 1080p to produce VGA by default.
    return min(candidates, key=lambda m: (abs(m['width']/m['height'] - 4/3),
        m['width'] < 640 or m['height'] < 480, abs(m['width']*m['height'] - 640*480),
        -m['frameRate'][0]/m['frameRate'][1]))


@dataclass(frozen=True)
class UsbDevice:
    node_id: str
    device_id: str
    attachment_id: str
    name: str
    device_path: str
    rdev: int
    capture_type: int
    formats: tuple

    def public(self):
        # Never give a browser a host pathname, serial number or a claimed
        # "free" status: read-only capability discovery cannot prove vacancy.
        return dict(deviceId=self.device_id, attachmentId=self.attachment_id,
                    name=self.name, formats=list(self.formats))


def device_identifiers(node_id, *, port, vendor, product, serial, interface,
                       index, boot_id, bus_number, device_number, inode, ctime_ns):
    identifier(node_id)
    identifier(boot_id)
    identity = json.dumps([port, vendor, product, serial, interface, index], separators=(',', ':'))
    device_id = str(uuid.uuid5(uuid.UUID(node_id), identity))
    # A removed/reinserted device must be explicitly selected again, even if
    # Linux reuses /dev/video0 or its USB address. Do not persist raw serials.
    attachment = json.dumps([boot_id, bus_number, device_number, inode, ctime_ns], separators=(',', ':'))
    attachment_id = hashlib.sha256((device_id + attachment).encode()).hexdigest()
    return device_id, attachment_id


def _text(path):
    with path.open('rb') as source:
        raw = source.read(513)
    if len(raw) > 512:
        fail('device_invalid')
    return raw.decode('utf-8').strip()


def inventory(node_id, *, sys_root=Path('/sys'), dev_root=Path('/dev'),
              boot_path=Path('/proc/sys/kernel/random/boot_id')):
    """Read metadata only. Caller runs with its existing device permissions."""
    identifier(node_id)
    if sys.platform != 'linux':
        fail('platform_unsupported')
    boot_id = identifier(_text(boot_path))
    root = sys_root.resolve(strict=True)
    folder = root / 'class/video4linux'
    if not folder.exists():
        return [], []
    entries = sorted(p for p in folder.iterdir() if re.fullmatch(r'video[0-9]+', p.name))
    if len(entries) > MAX_DEVICES:
        fail('inventory_limit')
    devices, issues = [], []
    for entry in entries:
        fd = None
        try:
            real = entry.resolve(strict=True)
            real.relative_to(root / 'devices')
            usb = next((p for p in real.parents if p != root and
                        (p / 'idVendor').is_file() and (p / 'idProduct').is_file()), None)
            if usb is None:
                continue  # Excludes virtual/platform devices, not just by label.
            if (usb / 'subsystem').resolve(strict=True) != root / 'bus/usb':
                continue
            vendor, product = _text(usb / 'idVendor'), _text(usb / 'idProduct')
            if not all(re.fullmatch(r'[0-9a-fA-F]{4}', v) for v in (vendor, product)):
                fail('device_invalid')
            interface = str(real.relative_to(usb)).split('/')[0]
            index = _text(real / 'index')
            serial = _text(usb / 'serial') if (usb / 'serial').exists() else ''
            info = usb.stat()
            device_id, attachment = device_identifiers(node_id,
                port=str(usb.relative_to(root / 'devices')), vendor=vendor, product=product,
                serial=serial, interface=interface, index=index, boot_id=boot_id,
                bus_number=_text(usb / 'busnum'), device_number=_text(usb / 'devnum'),
                inode=info.st_ino, ctime_ns=info.st_ctime_ns)
            path = dev_root / entry.name
            before = path.lstat()
            expected_rdev = tuple(map(int, _text(real / 'dev').split(':')))
            if not stat.S_ISCHR(before.st_mode) or (os.major(before.st_rdev), os.minor(before.st_rdev)) != expected_rdev:
                fail('device_invalid')
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW)
            opened = os.fstat(fd)
            if not stat.S_ISCHR(opened.st_mode) or (opened.st_ino, opened.st_rdev) != (before.st_ino, before.st_rdev):
                fail('device_changed')
            caps = query_capabilities(fd)
            after = usb.stat()
            if (after.st_ino, after.st_ctime_ns) != (info.st_ino, info.st_ctime_ns) or entry.resolve(strict=True) != real:
                fail('device_changed')
            if caps is not None:
                devices.append(UsbDevice(node_id, device_id, attachment,
                    caps['name'] or 'USB Camera', str(path), opened.st_rdev,
                    caps['captureType'], caps['formats']))
        except (OSError, ValueError, UsbCameraError) as error:
            code = str(error) if isinstance(error, UsbCameraError) else (
                'phone_camera_usb_permission_required' if isinstance(error, PermissionError)
                else 'phone_camera_usb_device_unavailable')
            issues.append(dict(deviceNode=entry.name, errorCode=code))
        finally:
            if fd is not None:
                os.close(fd)
    if len({d.device_id for d in devices}) != len(devices):
        fail('device_invalid')
    return devices, issues


def _local_run(local_node_id, phone_run):
    identifier(local_node_id)
    if not isinstance(phone_run, dict) or phone_run.get('nodeId') != local_node_id:
        fail('wrong_node')
    if (phone_run.get('state') != 'running' or type(phone_run.get('generation')) is not int
            or phone_run['generation'] < 1):
        fail('phone_not_running')
    identifier(phone_run.get('phoneId'))
    identifier(phone_run.get('runId'))


def permitted_devices(devices, *, local_node_id, phone_run, permitted_device_ids):
    """Permissions come from current server-side admin + member authorization."""
    _local_run(local_node_id, phone_run)
    if not isinstance(permitted_device_ids, (set, frozenset)):
        fail('permission_required')
    for value in permitted_device_ids:
        identifier(value)
    current = [d for d in devices if d.node_id == local_node_id and d.device_id in permitted_device_ids]
    if len({d.device_id for d in current}) != len(current):
        fail('device_invalid')
    return current


def select_device(devices, *, local_node_id, phone_run, permitted_device_ids, request):
    # Explicit selection only. No arbitrary path/node and no "first camera"
    # fallback when the selected device is removed or access is revoked.
    current = permitted_devices(devices, local_node_id=local_node_id,
                                phone_run=phone_run, permitted_device_ids=permitted_device_ids)
    if not isinstance(request, dict) or set(request) != {'deviceId', 'attachmentId', 'expectedGeneration'}:
        fail('request_invalid')
    identifier(request['deviceId'])
    if not isinstance(request['attachmentId'], str) or not re.fullmatch('[0-9a-f]{64}', request['attachmentId']):
        fail('request_invalid')
    if type(request['expectedGeneration']) is not int or request['expectedGeneration'] != phone_run['generation']:
        fail('stale_run')
    matches = [d for d in current if d.device_id == request['deviceId']]
    if len(matches) != 1:
        fail('device_unavailable')
    if matches[0].attachment_id != request['attachmentId']:
        fail('device_changed')
    return matches[0]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Read USB camera metadata; never capture frames')
    parser.add_argument('--node-id', required=True)
    args = parser.parse_args()
    try:
        cameras, issues = inventory(args.node_id)
        print(json.dumps(dict(nodeId=args.node_id, devices=[d.public() for d in cameras],
                              issues=issues, capturedFrames=0)))
    except (OSError, ValueError, UsbCameraError) as error:
        print(json.dumps(dict(errorCode=str(error) if isinstance(error, UsbCameraError)
                              else 'phone_camera_usb_inventory_unavailable')))
        raise SystemExit(1)
