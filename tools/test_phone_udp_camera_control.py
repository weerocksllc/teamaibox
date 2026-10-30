import os
from pathlib import Path
import socket
import sys
import unittest
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish'))
from phone_camera_input import CameraInput,CameraInputError
from phone_udp_camera_control import UdpCameraControl,own_socket

class ControlTests(unittest.TestCase):
    def setUp(self):
        self.sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);self.sock.bind(('127.0.0.1',0));self.addCleanup(self.sock.close)
        self.config={k:str(uuid.uuid4()) for k in ('phoneId','ownerId','runId')};self.config['generation']=1
        self.grant={**self.config,**{k:str(uuid.uuid4()) for k in ('id','sourceId','sessionId')},'sourceKind':'udp'}
        self.value=dict(grant=self.grant,policy=dict(listenAddress='127.0.0.1',listenPort=self.sock.getsockname()[1],allowedSources=['127.0.0.1/32']))
        self.broker=CameraInput(self.config,(Path(__file__).parent/'fixtures/phone-camera-checker-v1.jpg').read_bytes(),lambda:100.,lambda:100.)
        self.broker.apply(dict(action='open',grant=self.grant,leaseExpiresAt=104000))
        self.processes=[];outer=self
        class Process:
            def __init__(self,value,fd):self.fd=os.dup(fd);self.closed=False;outer.processes.append(self)
            def answer(self):return dict(sourceId=outer.grant['sourceId'],state='waiting')
            def alive(self):return not self.closed
            def close(self):
                if not self.closed:os.close(self.fd);self.closed=True
        self.manager=UdpCameraControl(self.config,broker=self.broker.apply,factory=Process);self.addCleanup(self.manager.close)

    def test_start_waits_without_lying_about_receiving(self):
        self.assertEqual(self.manager.start(self.value,self.sock.fileno()),dict(sourceId=self.grant['sourceId'],state='waiting'))
        self.assertEqual(self.broker.apply(dict(action='status',grant=self.grant))['state'],'waiting')
        self.manager.stop(self.grant);self.assertTrue(self.processes[0].closed)
        self.assertGreater(self.sock.fileno(),0);self.assertIsNone(self.broker.active)

    def test_rejects_other_bound_port_before_process(self):
        value={**self.value,'policy':{**self.value['policy'],'listenPort':self.value['policy']['listenPort']+1}}
        with self.assertRaises(CameraInputError):self.manager.start(value,self.sock.fileno())
        self.assertFalse(self.processes)

    def test_rejects_wildcard_reuse_and_non_datagram(self):
        for kind,address,reuse in [(socket.SOCK_DGRAM,'0.0.0.0',0),(socket.SOCK_DGRAM,'127.0.0.1',1),(socket.SOCK_STREAM,'127.0.0.1',0)]:
            with socket.socket(socket.AF_INET,kind) as s:
                s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,reuse);s.bind((address,0))
                with self.assertRaises(CameraInputError):own_socket(s.fileno())

    def test_refuses_second_process_for_same_source(self):
        self.manager.start(self.value,self.sock.fileno())
        with self.assertRaises(CameraInputError):self.manager.start(self.value,self.sock.fileno())
        self.assertEqual(len(self.processes),1)

if __name__=='__main__':unittest.main()
