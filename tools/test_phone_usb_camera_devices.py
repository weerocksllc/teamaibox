"""Isolated discovery/selection tests, not physical USB or Android evidence."""
from dataclasses import replace
import errno
from pathlib import Path
import struct
import sys
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/android/cuttlefish'))
from phone_usb_camera_devices import (CAP_CAPTURE, CAP_CAPTURE_MPLANE, CAP_DEVICE_CAPS,
    CAP_STREAMING, ENUM_FMT, ENUM_FRAMESIZES, ENUM_FRAMEINTERVALS, QUERYCAP, MAX_FORMATS,
    UsbCameraError, UsbDevice, choose_mode, query_modes,
    device_identifiers, label, permitted_devices, query_capabilities, select_device)

NODE = '30000000-0000-4000-8000-000000000001'
OTHER_NODE = str(uuid.uuid5(uuid.NAMESPACE_DNS, 'other-test-node'))
PHONE = str(uuid.uuid5(uuid.NAMESPACE_DNS, 'test-phone'))
RUN = str(uuid.uuid5(uuid.NAMESPACE_DNS, 'test-run'))
BOOT = str(uuid.uuid5(uuid.NAMESPACE_DNS, 'test-boot'))


def identity(**changes):
    values = dict(node_id=NODE, port='pci/usb1/1-2', vendor='1234', product='5678',
                  serial='synthetic-device', interface='1-2:1.0', index='0',
                  boot_id=BOOT, bus_number='1', device_number='2', inode=100, ctime_ns=200)
    values.update(changes)
    return device_identifiers(**values)


def camera(**changes):
    device_id, attachment = identity()
    return replace(UsbDevice(NODE, device_id, attachment, 'Test USB Camera',
                             '/dev/video0', 81 << 8, 1, ('MJPG', 'YUYV')), **changes)


class FakeIoctl:
    """Explicit V4L2 ABI fixture; it does not simulate actual frame capture."""
    def __init__(self, device_caps=CAP_CAPTURE | CAP_STREAMING,
                 union=CAP_CAPTURE | CAP_STREAMING | CAP_DEVICE_CAPS, formats=('MJPG', 'YUYV')):
        self.device_caps, self.union, self.formats = device_caps, union, formats
        self.calls = []

    def __call__(self, fd, command, raw, mutate):
        self.calls.append(command)
        if command == QUERYCAP:
            raw[:] = struct.pack('=16s32s32s6I', b'uvcvideo', b'Test USB Camera',
                                 b'usb-test', 1, self.union, self.device_caps, 0, 0, 0)
        elif command == ENUM_FMT:
            index, kind = struct.unpack_from('=II', raw)
            if index >= len(self.formats):
                raise OSError(errno.EINVAL, 'end')
            struct.pack_into('=I', raw, 44, int.from_bytes(self.formats[index].encode(), 'little'))
        else:
            raise AssertionError('Discovery must never set formats or stream')


class UsbCameraDeviceTests(unittest.TestCase):
    def setUp(self):
        self.device = camera()
        self.run = dict(nodeId=NODE, phoneId=PHONE, runId=RUN, generation=3, state='running')
        self.args = dict(local_node_id=NODE, phone_run=self.run,
                         permitted_device_ids={self.device.device_id})
        self.request = dict(deviceId=self.device.device_id,
                            attachmentId=self.device.attachment_id, expectedGeneration=3)

    def test_select_only_current_node(self):
        foreign = camera(node_id=OTHER_NODE, device_id=identity(node_id=OTHER_NODE)[0])
        self.args['permitted_device_ids'].add(foreign.device_id)
        devices = [foreign, self.device]
        self.assertEqual(permitted_devices(devices, **self.args), [self.device])
        self.assertEqual(select_device(devices, request=self.request, **self.args), self.device)
        with self.assertRaisesRegex(UsbCameraError, 'device_unavailable'):
            select_device(devices, request={**self.request, 'deviceId': foreign.device_id}, **self.args)

    def test_wrong_node_never_follows_phone_to_remote_host(self):
        for value in [None, {}, {**self.run, 'nodeId': OTHER_NODE}]:
            with self.subTest(value=value), self.assertRaisesRegex(UsbCameraError, 'wrong_node'):
                select_device([self.device], request=self.request, **{**self.args, 'phone_run': value})

    def test_stopped_starting_or_invalid_generation_cannot_capture(self):
        for changes in [dict(state='stopped'), dict(state='starting'), dict(generation=0), dict(generation=True)]:
            with self.subTest(changes=changes), self.assertRaisesRegex(UsbCameraError, 'phone_not_running'):
                select_device([self.device], request=self.request,
                              **{**self.args, 'phone_run': {**self.run, **changes}})

    def test_stale_run_and_boolean_generation_rejected(self):
        for generation in [2, 4, True, '3']:
            with self.subTest(generation=generation), self.assertRaisesRegex(UsbCameraError, 'stale_run'):
                select_device([self.device], request={**self.request, 'expectedGeneration': generation}, **self.args)

    def test_request_cannot_supply_node_path_url_or_permission(self):
        for key, value in [('nodeId', OTHER_NODE), ('path', '/dev/video0'),
                           ('url', 'https://example.test'), ('permitted', True), ('ownerId', PHONE)]:
            with self.subTest(key=key), self.assertRaisesRegex(UsbCameraError, 'request_invalid'):
                select_device([self.device], request={**self.request, key: value}, **self.args)

    def test_empty_or_revoked_permissions_never_default_to_first_camera(self):
        with self.assertRaisesRegex(UsbCameraError, 'device_unavailable'):
            select_device([self.device], request=self.request,
                          **{**self.args, 'permitted_device_ids': set()})
        with self.assertRaisesRegex(UsbCameraError, 'permission_required'):
            select_device([self.device], request=self.request,
                          **{**self.args, 'permitted_device_ids': None})

    def test_replug_requires_new_attachment_selection(self):
        for changes in [dict(device_number='3'), dict(inode=101), dict(ctime_ns=201),
                        dict(boot_id=str(uuid.uuid5(uuid.NAMESPACE_DNS, 'new-boot')))]:
            device_id, attachment = identity(**changes)
            self.assertEqual(device_id, self.device.device_id)
            self.assertNotEqual(attachment, self.device.attachment_id)
            with self.subTest(changes=changes), self.assertRaisesRegex(UsbCameraError, 'device_changed'):
                select_device([replace(self.device, attachment_id=attachment)], request=self.request, **self.args)

    def test_distinct_node_port_interface_and_serial_have_distinct_ids(self):
        for changes in [dict(node_id=OTHER_NODE), dict(port='pci/usb1/1-3'),
                        dict(serial='second-camera'), dict(interface='1-2:1.1'), dict(index='1')]:
            self.assertNotEqual(identity(**changes)[0], self.device.device_id)

    def test_removed_selected_device_never_falls_back(self):
        second = camera(device_id=identity(serial='second-camera')[0])
        self.args['permitted_device_ids'].add(second.device_id)
        with self.assertRaisesRegex(UsbCameraError, 'device_unavailable'):
            select_device([second], request=self.request, **self.args)
        with self.assertRaisesRegex(UsbCameraError, 'device_invalid'):
            select_device([self.device, self.device], request=self.request, **self.args)

    def test_public_metadata_excludes_paths_serial_and_false_availability(self):
        public = self.device.public()
        self.assertEqual(set(public), {'deviceId', 'attachmentId', 'name', 'formats'})
        self.assertNotIn('/dev/', str(public))
        self.assertNotIn('synthetic-device', str(public))
        self.assertEqual(label(b'Camera\n\x1b[31m\0secret'), 'Camera[31m')

    def test_queries_only_node_capabilities_and_formats(self):
        ioctl = FakeIoctl()
        caps = query_capabilities(5, ioctl)
        self.assertEqual(caps, dict(driver='uvcvideo', name='Test USB Camera', captureType=1,
                                   formats=('MJPG', 'YUYV')))
        self.assertEqual(ioctl.calls, [QUERYCAP, ENUM_FMT, ENUM_FMT, ENUM_FMT])

    def test_metadata_node_is_not_mistaken_for_sibling_camera(self):
        ioctl = FakeIoctl(device_caps=0x00800000 | CAP_STREAMING)
        self.assertIsNone(query_capabilities(5, ioctl))
        self.assertEqual(ioctl.calls, [QUERYCAP])

    def test_legacy_capabilities_and_multiplane_are_reported_truthfully(self):
        result = query_capabilities(5, FakeIoctl(union=CAP_CAPTURE_MPLANE | CAP_STREAMING, device_caps=0))
        self.assertEqual(result['captureType'], 9)
        self.assertIsNone(query_capabilities(5, FakeIoctl(device_caps=CAP_CAPTURE)))

    def test_enumeration_is_bounded_and_unexpected_errors_propagate(self):
        formats = tuple(f'{index:04}' for index in range(MAX_FORMATS + 1))
        with self.assertRaisesRegex(UsbCameraError, 'inventory_limit'):
            query_capabilities(5, FakeIoctl(formats=formats))
        with self.assertRaisesRegex(UsbCameraError, 'device_invalid'):
            query_capabilities(5, FakeIoctl(formats=('MJPG', 'MJPG')))
        def denied(*args):
            raise PermissionError(errno.EACCES, 'fixture')
        with self.assertRaises(PermissionError):
            query_capabilities(5, denied)

    def test_modes_do_not_invent_missing_mjpeg_vga(self):
        def ioctl(fd, command, raw, mutate):
            index = struct.unpack_from('=I', raw)[0]
            if command == ENUM_FRAMESIZES:
                if index > 2:
                    raise OSError(errno.EINVAL, 'end')
                width, height = [(1920,1080),(320,240),(800,600)][index]
                struct.pack_into('=3I', raw, 8, 1, width, height)
            elif command == ENUM_FRAMEINTERVALS:
                if index:
                    raise OSError(errno.EINVAL, 'end')
                struct.pack_into('=3I', raw, 16, 1, 1, 30)
            else:
                raise AssertionError('unexpected ioctl')
        modes = query_modes(5, ['MJPG'], ioctl)
        self.assertEqual(len(modes), 3)
        self.assertEqual(choose_mode(modes, 'MJPG'),
                         dict(pixelFormat='MJPG',width=800,height=600,frameRate=[30,1]))
        self.assertNotIn([640,480], [[m['width'],m['height']] for m in modes])
        with self.assertRaisesRegex(UsbCameraError, 'format_unsupported'):
            choose_mode(modes, 'YUYV')


if __name__ == '__main__':
    unittest.main()
