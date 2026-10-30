"""Greeter-only host boundary tests; not physical HDMI acceptance."""
import importlib.util
from pathlib import Path
import tempfile
import json
import struct
import time
import unittest
from unittest.mock import MagicMock, patch
from types import SimpleNamespace
from services.trusted_media_service.display_lease_client import request_display, ManagedKmsDevice
from services.trusted_media_service.hdmi_media_output import KmsDevice, HdmiOutputError

spec=importlib.util.spec_from_file_location('display_lease',Path(__file__).resolve().parents[1]/'tools/casting_display_lease_host.py')
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)

class DisplayLeaseTest(unittest.TestCase):
    def test_request_bounds_and_no_caller_command(self):
        self.assertTrue(host.valid_request({'operation':'status'}))
        request={'operation':'acquire','sessionId':'10000000-0000-4000-8000-000000000001','expiresAt':time.time()+60}
        self.assertTrue(host.valid_request(request))
        for change in ({'command':'reboot'},{'expiresAt':True},{'expiresAt':float('inf')},{'expiresAt':time.time()+14410},{'sessionId':'../x'},{'operation':'stop'}):
            self.assertFalse(host.valid_request({**request,**change}))

    def test_local_user_desktop_is_never_stopped(self):
        def answer(*args):
            if args[:3]==('systemctl','show','display-manager'):return 'gdm.service'
            if args[:3]==('systemctl','show','gdm.service'):return 'active'
            if args[1]=='list-seats':return 'seat0'
            if args[1]=='show-seat':return 'c1'
            if args[1]=='show-session':return 'Class=user\nRemote=no'
            raise AssertionError(args)
        with patch.object(host,'run',side_effect=answer) as run:
            self.assertFalse(host.eligible())
            self.assertFalse(any('stop' in c.args for c in run.call_args_list))

    def test_only_owned_greeter_restore_marker_triggers_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/'restore-needed'
            with patch.object(host,'MARKER',marker),patch.object(host,'run') as run:
                host.restore();run.assert_not_called()
                marker.touch();host.restore();run.assert_called_once_with('systemctl','start','gdm.service')
                self.assertFalse(marker.exists())

    def test_refresh_fixed_connector_without_desktop_or_mode_command(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(host,'CONNECTOR',Path(folder)), \
             patch.object(host,'DETECTION_VALID',False),patch.object(host,'OWNER',None), \
             patch.object(host,'eligible',return_value=True),patch.object(host,'run') as run:
            self.assertTrue(host.refresh_connector_status())
            self.assertEqual((Path(folder)/'status').read_text(),'detect\n')
            self.assertTrue(host.DETECTION_VALID);run.assert_not_called()

    def test_refresh_never_touches_active_user_desktop(self):
        with patch.object(host,'OWNER',None),patch.object(host,'eligible',return_value=False), \
             patch.object(host,'CONNECTOR') as connector,patch.object(host,'DETECTION_VALID',True):
            self.assertFalse(host.refresh_connector_status());self.assertFalse(host.DETECTION_VALID)
            connector.__truediv__.assert_not_called()

    def test_failed_refresh_invalidates_stale_cache(self):
        with patch.object(host,'OWNER',object()),patch.object(host,'CONNECTOR') as connector,patch.object(host,'DETECTION_VALID',True):
            connector.__truediv__.return_value.write_text.side_effect=PermissionError()
            self.assertFalse(host.refresh_connector_status());self.assertFalse(host.connected())

    def test_status_is_read_only_and_requires_supported_mode(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(host,'CONNECTOR',Path(folder)), \
             patch.object(host,'DETECTION_VALID',True),patch.object(host,'refresh_connector_status') as refresh:
            (Path(folder)/'status').write_text('connected\n');(Path(folder)/'modes').write_text('3840x2160\n1920x1080\n')
            for _ in range(10):self.assertTrue(host.connected())
            (Path(folder)/'modes').write_text('3840x2160\n');self.assertFalse(host.connected())
            refresh.assert_not_called()

    def test_hotplug_only_kernel_fixed_card_drm_event(self):
        path='/devices/example/drm/card1'
        event=f'change@{path}\0ACTION=change\0SUBSYSTEM=drm\0HOTPLUG=1\0DEVPATH={path}\0'.encode()
        self.assertTrue(host.kernel_hotplug(event,(0,1),path))
        for data,peer in ((event,(100,1)),(event.replace(b'drm\0',b'usb\0'),(0,1)),
                          (event.replace(b'HOTPLUG=1',b'HOTPLUG=0'),(0,1)),
                          (event.replace(b'card1',b'card2'),(0,1)),(b'x'*4097,(0,1)),(b'\xff',(0,1))):
            self.assertFalse(host.kernel_hotplug(data,peer,path))

    def test_hotplug_burst_coalesces_and_idle_never_reprobes(self):
        path='/devices/example/drm/card1'
        event=f'ACTION=change\0SUBSYSTEM=drm\0HOTPLUG=1\0DEVPATH={path}\0'.encode()
        monitor=host.HotplugMonitor.__new__(host.HotplugMonitor)
        monitor.card_path=path;monitor.channel=MagicMock();monitor.pending=None
        monitor.audio=MagicMock();monitor.audio.changed.return_value=False
        monitor.channel.recvfrom.side_effect=[(event,(0,1)),(event,(0,1)),BlockingIOError(),BlockingIOError(),BlockingIOError()]
        with patch.object(host.time,'monotonic',side_effect=[1.,1.3,4.]),patch.object(host,'refresh_connector_status') as refresh:
            monitor.poll();refresh.assert_not_called()
            monitor.poll();refresh.assert_called_once()
            monitor.poll();refresh.assert_called_once()

    def test_hdmi_audio_notification_refreshes_without_drm_uevent(self):
        monitor=host.HotplugMonitor.__new__(host.HotplugMonitor)
        monitor.channel=MagicMock();monitor.channel.recvfrom.side_effect=BlockingIOError()
        monitor.audio=MagicMock();monitor.audio.changed.side_effect=[True,False,False]
        monitor.pending=None
        with patch.object(host.time,'monotonic',side_effect=[1.,1.3,9.]),patch.object(host,'refresh_connector_status') as refresh:
            monitor.poll();refresh.assert_not_called()
            monitor.poll();refresh.assert_called_once()
            monitor.poll();refresh.assert_called_once()
        monitor.close();monitor.audio.close.assert_called_once();monitor.channel.close.assert_called_once()

    def test_audio_monitor_ignores_mixer_and_other_connector_events(self):
        m=host.EldHotplugMonitor.__new__(host.EldHotplugMonitor)
        m.lib=MagicMock();m.handle=object();m.event=object()
        for name,device,wanted in ((b'ELD',3,True),(b'ELD',7,False),(b'HDMI/DP,pcm=3 Jack',0,True),(b'Volume',3,False)):
            m.lib.snd_ctl_read.side_effect=[1,-host.errno.EAGAIN]
            m.lib.snd_ctl_event_get_type.return_value=0
            m.lib.snd_ctl_event_elem_get_name.return_value=name
            m.lib.snd_ctl_event_elem_get_device.return_value=device
            self.assertEqual(m.changed(),wanted)
        m.lib.snd_ctl_elem_write.assert_not_called();m.lib.snd_pcm_open.assert_not_called()

    def test_audio_monitor_bounded_drain_and_error(self):
        m=host.EldHotplugMonitor.__new__(host.EldHotplugMonitor)
        m.lib=MagicMock();m.handle=object();m.event=object()
        m.lib.snd_ctl_read.return_value=1;m.lib.snd_ctl_event_get_type.return_value=0
        m.lib.snd_ctl_event_elem_get_name.return_value=b'ELD';m.lib.snd_ctl_event_elem_get_device.return_value=3
        self.assertTrue(m.changed());self.assertEqual(m.lib.snd_ctl_read.call_count,32)
        m.lib.snd_ctl_read.return_value=-19
        with self.assertRaisesRegex(RuntimeError,'eld_monitor_unavailable'):m.changed()

    def test_audio_monitor_opens_readonly_nonblocking_and_closes_once(self):
        lib=MagicMock()
        def allocate(pointer,*_):pointer._obj.value=123;return 0
        lib.snd_ctl_open.side_effect=allocate;lib.snd_ctl_event_malloc.side_effect=allocate
        lib.snd_ctl_subscribe_events.return_value=0
        with patch.object(host.ctypes,'CDLL',return_value=lib):m=host.EldHotplugMonitor()
        self.assertEqual(lib.snd_ctl_open.call_args.args[1:],(b'hw:0',5))
        m.close();m.close();lib.snd_ctl_event_free.assert_called_once();lib.snd_ctl_close.assert_called_once()

    def test_audio_subscription_failure_releases_allocations(self):
        lib=MagicMock()
        def allocate(pointer,*_):pointer._obj.value=123;return 0
        lib.snd_ctl_open.side_effect=allocate;lib.snd_ctl_event_malloc.side_effect=allocate
        lib.snd_ctl_subscribe_events.return_value=-1
        with patch.object(host.ctypes,'CDLL',return_value=lib),self.assertRaises(RuntimeError):host.EldHotplugMonitor()
        lib.snd_ctl_event_free.assert_called_once();lib.snd_ctl_close.assert_called_once()

    def handle(self, operation='status', eligible=True, connected=True):
        value={'operation':operation}
        if operation=='acquire':value.update(sessionId='10000000-0000-4000-8000-000000000001',expiresAt=time.time()+15)
        request=MagicMock();request.getsockopt.return_value=struct.pack('3i',1,65532,65532)
        request.recv.side_effect=[bytes([x]) for x in json.dumps(value).encode()+b'\n']
        handler=host.Handler.__new__(host.Handler);handler.request=request
        with tempfile.TemporaryDirectory() as folder,patch.object(host,'MARKER',Path(folder)/'restore-needed'), \
             patch.object(host.socket,'SO_PEERCRED',17,create=True), \
             patch.object(host,'OWNER',None),patch.object(host,'eligible',return_value=eligible), \
             patch.object(host,'connected',return_value=connected) as query, \
             patch.object(host,'run',return_value='active') as command, \
             patch.object(host.select,'select',return_value=([request],[],[])):
            handler.handle()
            return json.loads(request.sendall.call_args.args[0]),command.call_args_list,query.call_count

    def test_unavailable_desktop_is_not_queried_or_stopped(self):
        value,calls,queries=self.handle(eligible=False)
        self.assertEqual(value,{'available':False,'reasonCode':'cast_hdmi_display_busy'})
        self.assertEqual((calls,queries),([],0))

    def test_disconnected_fails_before_handoff(self):
        value,calls,_=self.handle('acquire',connected=False)
        self.assertEqual(value,{'available':False,'reasonCode':'cast_hdmi_disconnected_or_unsupported'})
        self.assertEqual(calls,[])

    def test_connected_status_never_stops_greeter(self):
        value,calls,_=self.handle()
        self.assertEqual(value,{'available':True,'reasonCode':None});self.assertEqual(calls,[])

    def test_acquire_then_eof_restores_owned_greeter(self):
        value,calls,_=self.handle('acquire')
        self.assertEqual(value,{'available':True,'reasonCode':None})
        self.assertEqual([c.args for c in calls],[
            ('systemctl','show','gdm.service','-p','ActiveState','--value'),
            ('systemctl','stop','gdm.service'),('systemctl','start','gdm.service')])

    def test_client_accepts_only_typed_fixed_status_and_closes_denials(self):
        for response in ({'available':True,'reasonCode':None},
                         {'available':False,'reasonCode':'cast_hdmi_disconnected_or_unsupported'},
                         {'available':True,'reasonCode':None,'command':'x'},
                         {'available':1,'reasonCode':None}):
            channel=MagicMock();channel.recv.side_effect=[bytes([x]) for x in json.dumps(response).encode()+b'\n']
            with patch('services.trusted_media_service.display_lease_client.socket.socket',return_value=channel):
                if response=={'available':True,'reasonCode':None} and type(response['available']) is bool:
                    self.assertIs(request_display('status'),channel);channel.close.assert_not_called()
                else:
                    with self.assertRaises(HdmiOutputError):request_display('status')
                    channel.close.assert_called_once()

    def test_managed_acquire_refreshes_only_after_lease_and_closes_on_failure(self):
        device=ManagedKmsDevice(card=1,connector='HDMI-A-1');device.bind_lease('10000000-0000-4000-8000-000000000001',time.time()+30)
        channel=MagicMock()
        def acquire(*,refresh_connector):
            self.assertTrue(refresh_connector);self.assertIs(device._display_channel,channel)
            raise HdmiOutputError('cast_hdmi_disconnected_or_unsupported')
        with patch('services.trusted_media_service.display_lease_client.request_display',return_value=channel),patch.object(KmsDevice,'acquire',side_effect=acquire):
            with self.assertRaises(HdmiOutputError):device.acquire()
        channel.close.assert_called_once();self.assertIsNone(device._display_channel)

if __name__=='__main__':unittest.main()
