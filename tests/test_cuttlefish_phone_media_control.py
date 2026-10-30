import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid
import tempfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('phone_media_control',ROOT/'deploy/android/cuttlefish/phone_media_control.py')
media=importlib.util.module_from_spec(spec);spec.loader.exec_module(media)
wrapper_spec=importlib.util.spec_from_file_location('phone_streamer',ROOT/'deploy/android/cuttlefish/phone_streamer.py')
wrapper=importlib.util.module_from_spec(wrapper_spec);wrapper_spec.loader.exec_module(wrapper)


class ProcessDouble:
    def __init__(self): self.value={'pid':40,'startTicks':100};self.closed=[];self.allow=True
    def current(self): return dict(self.value)
    def close(self,value):
        self.closed.append(value)
        if not self.allow: raise media.MediaError('phone_media_close_unconfirmed')
        self.value={'pid':self.value['pid']+1,'startTicks':self.value['startTicks']+100}
        return True


class MediaTests(unittest.TestCase):
    def test_unreadable_unrelated_process_does_not_hide_exact_streamer(self):
        proc=Path('/synthetic-proc')
        streamer=media.Streamer(proc=proc)
        fields=['S','40']+['0']*17+['123']
        def link(path):
            if path==proc/'1/exe':raise PermissionError('synthetic non-dumpable process')
            return str(streamer.base/('bin/process_restarter' if path==proc/'40/exe' else 'bin/webRTC.elf'))
        with patch.object(Path,'iterdir',return_value=iter([proc/'1',proc/'41'])),patch.object(media.os,'readlink',side_effect=link),patch.object(Path,'read_text',return_value='41 (streamer) '+' '.join(fields)):
            self.assertEqual(streamer.current(),{'pid':41,'startTicks':123})
    def test_unreadable_streamer_is_never_accepted_or_signalled(self):
        streamer=media.Streamer(proc=Path('/synthetic-proc'))
        with patch.object(Path,'iterdir',return_value=iter([streamer.proc/'41'])),patch.object(media.os,'readlink',side_effect=PermissionError):
            with self.assertRaisesRegex(media.MediaError,'process_unavailable'):streamer.current()
    def setUp(self):
        self.clock=100.0;self.wall=1000.0;self.process=ProcessDouble()
        self.grant={k:str(uuid.uuid4()) for k in ('id','phoneId','ownerId','runId','sessionId')}
        self.grant.update(generation=1,kind='control')
        self.leases=media.MediaLeases({k:self.grant[k] for k in ('phoneId','ownerId','runId','generation')},
            streamer=self.process,clock=lambda:self.clock,wall=lambda:self.wall)
    def request(self,action,grant=None,**changes):
        value={'action':action,'grant':grant or self.grant}
        if action!='close':value['leaseExpiresAt']=int(self.wall*1000+4000)
        return self.leases.apply(value|changes)
    def test_open_renew_close_and_late_renew(self):
        self.assertTrue(self.request('open')['peerOpen'])
        self.clock+=2;self.wall+=2
        self.assertTrue(self.request('renew')['peerOpen'])
        self.clock+=3;self.leases.expire();self.assertFalse(self.process.closed)
        self.assertTrue(self.request('close')['peerClosed']);self.assertEqual(len(self.process.closed),1)
        self.assertTrue(self.request('close')['peerClosed']);self.assertEqual(len(self.process.closed),1)
        for action in ('open','renew'):
            with self.assertRaisesRegex(media.MediaError,'revoked'):self.request(action)
    def test_expiry_closes_process_not_just_signalling(self):
        self.request('open');self.clock+=4.1;self.wall-=20
        self.leases.expire()
        self.assertEqual(self.process.closed,[{'pid':40,'startTicks':100}]);self.assertIsNone(self.leases.active)
        with self.assertRaisesRegex(media.MediaError,'revoked'):self.request('open')
    def test_close_before_delayed_open_is_fenced(self):
        self.request('close')
        with self.assertRaisesRegex(media.MediaError,'revoked'):self.request('open')
        self.assertFalse(self.process.closed)
    def test_failed_closure_retains_peer_and_retries(self):
        self.request('open');self.process.allow=False
        with self.assertRaisesRegex(media.MediaError,'unconfirmed'):self.request('close')
        self.assertIsNotNone(self.leases.active)
        with self.assertRaisesRegex(media.MediaError,'revoked'):self.request('renew')
        self.process.allow=True;self.leases.expire();self.assertIsNone(self.leases.active)
    def test_foreign_run_identity_unknown_options_and_unbounded_lease_are_rejected(self):
        for key in ('phoneId','ownerId','runId','generation'):
            value=2 if key=='generation' else str(uuid.uuid4())
            with self.assertRaises(media.MediaError):self.request('open',self.grant|{key:value})
        for extra in ({'url':'http://127.0.0.1/'},{'leaseExpiresAt':1006000},{'leaseExpiresAt':1000000},{'leaseExpiresAt':True}):
            with self.assertRaises(media.MediaError):self.request('open',**extra)
        for kind in ('adb','shell'):
            with self.assertRaises(media.MediaError):self.request('open',self.grant|{'kind':kind})
        self.assertFalse(self.process.closed)
    def test_second_controller_and_process_replacement(self):
        self.request('open')
        with self.assertRaisesRegex(media.MediaError,'busy'):self.request('open',self.grant|{'id':str(uuid.uuid4())})
        self.process.value={'pid':50,'startTicks':200}
        with self.assertRaisesRegex(media.MediaError,'lost'):self.request('renew')
        self.assertIn(self.grant['id'],self.leases.revoked)
    def test_same_grant_cannot_change_login_and_tombstones_are_bounded(self):
        self.request('open')
        with self.assertRaises(media.MediaError):self.request('close',self.grant|{'sessionId':str(uuid.uuid4())})
        self.request('close')
        self.leases.revoked.update({str(uuid.uuid4()):self.grant for _ in range(4096)})
        with self.assertRaisesRegex(media.MediaError,'limit'):self.request('open',self.grant|{'id':str(uuid.uuid4())})
        self.assertFalse(self.leases.active)

    def test_wrapper_removes_only_streamer_debug_target_without_mutating_guest_config(self):
        original={'instances':{'21':{'adb_ip_and_port':'127.0.0.1:6540','adb_host_port':6540,'other':'retained'}},'base':'fixed'}
        changed=wrapper.media_configuration(original,21)
        self.assertEqual(changed['instances']['21'],{'adb_ip_and_port':'','adb_host_port':0,'other':'retained'})
        self.assertEqual(original['instances']['21']['adb_host_port'],6540)
        for value in ({},{'instances':[]},{'instances':{'21':{},'22':{}}},{'instances':{'21':{}}}):
            with self.assertRaises(ValueError):wrapper.media_configuration(value,21)


class StreamerSocketTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.proc=Path(self.temp.name);(self.proc/'41/fd').mkdir(parents=True);(self.proc/'net').mkdir()
        self.streamer=media.Streamer(proc=self.proc,instance=21)
        self.expected={'pid':41,'startTicks':123}
        self.identity=patch.object(self.streamer,'identity',return_value=self.expected);self.identity.start();self.addCleanup(self.identity.stop)
        for protocol in ('udp','udp6','tcp','tcp6'):self.table(protocol)
    def table(self,protocol,*rows):
        (self.proc/'net'/protocol).write_text('header\n'+'\n'.join(rows))
    def row(self,port,remote='0100007F',state='01',inode='20',local='00000000'):
        return f'0: {local}:{port:04X} {remote}:C001 {state} 0:0 0:0 0 0 0 {inode}'
    def own(self,inode):
        (self.proc/'41/fd'/inode).symlink_to('socket:['+inode+']')
    def test_only_loopback_device_connection_is_not_a_browser_peer(self):
        self.table('tcp',self.row(8463),self.row(8463,'00000000',state='0A'))
        self.table('tcp6',self.row(8463,'00000000000000000000000001000000'))
        self.assertTrue(self.streamer.peers_gone(self.expected))
    def test_established_or_closing_browser_connection_blocks_confirmation(self):
        for protocol,address in [('tcp','020013AC'),('tcp6','0000000000000000FFFF0000020013AC')]:
            for state in ('01','08','04'):
                self.table(protocol,self.row(8463,address,state))
                self.assertFalse(self.streamer.peers_gone(self.expected))
            self.table(protocol)
    def test_retired_tcp_timer_does_not_break_display_on_reload(self):
        self.table('tcp',self.row(8463,'020013AC',state='06',inode='0'))
        self.assertTrue(self.streamer.peers_gone(self.expected))
        self.table('tcp',self.row(8463,'020013AC',state='06',inode='20'))
        self.assertFalse(self.streamer.peers_gone(self.expected))
    def test_only_exact_streamer_owned_media_sockets_block_confirmation(self):
        self.table('udp',self.row(20000,state='07',inode='20'));self.assertTrue(self.streamer.peers_gone(self.expected))
        self.own('20');self.assertFalse(self.streamer.peers_gone(self.expected))
        self.table('udp');self.table('tcp6',self.row(20100,state='0A',inode='20'))
        self.assertFalse(self.streamer.peers_gone(self.expected))
    def test_private_streamer_http_ports_are_not_lingering_media_peers(self):
        self.own('20')
        # Cuttlefish's private HTTP listener and operator client use ephemeral
        # loopback ports. Their numbers can overlap another phone's media slot.
        for port in (33121, 36205, 20021):
            self.table('tcp',self.row(port,'00000000','0A',local='0100007F'),
                       self.row(port,local='0100007F'))
            self.assertTrue(self.streamer.peers_gone(self.expected))
            with patch.object(media.os,'pidfd_open',create=True) as pidfd,patch.object(media.time,'sleep'):
                self.assertTrue(self.streamer.close(self.expected))
                pidfd.assert_not_called()
        # The same owned port on a browser-reachable address must still block.
        self.table('tcp',self.row(33121,state='0A',local='020013AC'))
        self.assertFalse(self.streamer.peers_gone(self.expected))
    def test_ipv6_loopback_internal_tcp_is_not_a_media_peer(self):
        self.own('20')
        for local in ('00000000000000000000000001000000',
                      '0000000000000000FFFF00000100007F'):
            self.table('tcp6',self.row(36205,state='0A',local=local))
            self.assertTrue(self.streamer.peers_gone(self.expected))
        self.table('tcp6',self.row(36205,state='0A',local='0000000000000000FFFF0000020013AC'))
        self.assertFalse(self.streamer.peers_gone(self.expected))
    def test_loopback_exception_never_hides_owned_udp_media(self):
        self.own('20')
        self.table('udp',self.row(20021,state='07',local='0100007F'))
        self.assertFalse(self.streamer.peers_gone(self.expected))
    def test_unreadable_malformed_or_replaced_observations_are_not_empty(self):
        self.table('tcp','broken');self.assertFalse(self.streamer.peers_gone(self.expected))
        (self.proc/'net/tcp').unlink();self.assertFalse(self.streamer.peers_gone(self.expected))
        self.table('tcp')
        with patch.object(self.streamer,'identity',side_effect=[self.expected,None]):
            self.assertFalse(self.streamer.peers_gone(self.expected))
        self.streamer.instance=None;self.assertFalse(self.streamer.peers_gone(self.expected))
    def test_normal_disconnect_does_not_signal_shared_wayland_audio_process(self):
        with patch.object(media.os,'pidfd_open',create=True) as pidfd,patch.object(media.time,'sleep'):
            self.assertTrue(self.streamer.close(self.expected));pidfd.assert_not_called()
    def test_unconfirmed_peer_uses_exact_pidfd_fallback_not_false_success(self):
        with patch.object(media.time,'monotonic',side_effect=[0,2]),patch.object(media.os,'pidfd_open',return_value=7,create=True) as pidfd,patch.object(media.signal,'pidfd_send_signal',create=True) as send,patch.object(media.select,'select',return_value=([7],[],[])),patch.object(media.os,'close'):
            self.assertTrue(self.streamer.close(self.expected))
            pidfd.assert_called_once_with(41,0);send.assert_called_once_with(7,media.signal.SIGKILL,None,0)


if __name__=='__main__':unittest.main()
