"""Network-source lifetime tests; no external UDP listener or camera content."""
from pathlib import Path
import socket
import sys
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish'))
from phone_camera_input import CameraInput, CameraInputError
from phone_udp_camera_session import UdpCameraSession, validate_start
from phone_udp_ingress import UdpIngressError


class UdpSessionTests(unittest.TestCase):
    def setUp(self):
        self.now=100.;self.alive=True;self.sources=[]
        self.sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);self.sock.bind(('127.0.0.1',0))
        self.addCleanup(self.sock.close)
        self.config={k:str(uuid.uuid4()) for k in ('phoneId','ownerId','runId')};self.config['generation']=1
        self.grant={**self.config,**{k:str(uuid.uuid4()) for k in ('id','sourceId','sessionId')},'sourceKind':'udp'}
        self.value=dict(grant=self.grant,policy=dict(listenAddress='127.0.0.1',listenPort=self.sock.getsockname()[1],allowedSources=['127.0.0.1/32']))
        self.frame=(Path(__file__).parent/'fixtures/phone-camera-checker-v1.jpg').read_bytes()
        self.input=CameraInput(self.config,self.frame,lambda:self.now,lambda:self.now)
        outer=self
        class Source:
            def __init__(self,incoming,policy,**options):
                self.socket=incoming.dup();self.options=options;self.closed=False;outer.sources.append(self)
            def close(self):self.closed=True;self.socket.close()
        self.factory=Source

    def start(self):
        self.input.apply(dict(action='open',grant=self.grant,leaseExpiresAt=104000))
        s=UdpCameraSession(self.value,self.config,self.sock.fileno(),broker=self.input.apply,parent_alive=lambda:self.alive,factory=self.factory)
        self.addCleanup(s.close);return s

    def test_waiting_then_delivery_and_stop(self):
        s=self.start();self.assertFalse(s.ready.is_set());self.assertEqual(s.state()['state'],'waiting')
        self.sources[0].options['deliver'](self.frame,1,100,200)
        self.assertTrue(s.ready.is_set());self.assertEqual(s.state()['state'],'receiving')
        s.close();self.assertIsNone(self.input.active);self.assertTrue(self.sources[0].closed)
        self.assertGreater(self.sock.fileno(),0)

    def test_lease_expires_even_without_a_sender(self):
        s=self.start();self.now=105
        self.assertTrue(s.done.wait(1));self.assertIsNone(self.input.active);self.assertTrue(self.sources[0].closed)

    def test_parent_loss_clears_waiting_receiver(self):
        s=self.start();self.alive=False
        self.assertTrue(s.done.wait(1));self.assertIsNone(self.input.active);self.assertTrue(self.sources[0].closed)

    def test_stall_clears_last_frame_and_socket(self):
        s=self.start();self.sources[0].options['deliver'](self.frame,1,100,200)
        self.sources[0].options['on_end']('phone_camera_udp_input_stalled')
        self.assertTrue(s.done.wait(1));self.assertIsNone(self.input.active);self.assertTrue(self.sources[0].closed)

    def test_old_cleanup_cannot_clear_new_input(self):
        s=self.start();s.close()
        new={**self.grant,'id':str(uuid.uuid4()),'sourceId':str(uuid.uuid4()),'sourceKind':'image'}
        self.input.apply(dict(action='open',grant=new,leaseExpiresAt=104000))
        self.input.apply(dict(action='frame',grant=new,sequence=1),self.frame)
        s.close();self.assertEqual(self.input.active['grant'],new)

    def test_binding_and_policy_rejected_before_socket_use(self):
        for change in ({'phoneId':str(uuid.uuid4())},{'ownerId':str(uuid.uuid4())},{'generation':2},{'sourceKind':'image'}):
            with self.assertRaises(CameraInputError):validate_start({**self.value,'grant':{**self.grant,**change}},self.config)
        with self.assertRaises(CameraInputError):validate_start({**self.value,'url':'udp://anything'},self.config)
        with self.assertRaises(UdpIngressError):validate_start({**self.value,'policy':{**self.value['policy'],'listenAddress':'0.0.0.0'}},self.config)


if __name__=='__main__':unittest.main()
