"""Linux-only private fd handoff, controller lifecycle and input framing."""
import array
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import stat
import struct
import sys
import threading
import time
import unittest
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish'))
from phone_camera_input import CameraInput, CameraInputError
from phone_camera_client import request, execute, END
from phone_video_camera_control import VideoCameraControl, read_handoff


def sealed(data=b'\x00\x00\x00\x18ftypisom' + bytes(12)):
    fd=os.memfd_create('synthetic-video',os.MFD_ALLOW_SEALING)
    os.write(fd,data);fcntl.fcntl(fd,fcntl.F_ADD_SEALS,15);return fd


class VideoControlTests(unittest.TestCase):
    def setUp(self):
        self.now=100.
        self.config={k:str(uuid.uuid4()) for k in ('phoneId','ownerId','runId')};self.config['generation']=1
        self.grant={**self.config,**{k:str(uuid.uuid4()) for k in ('id','sourceId','sessionId')},'sourceKind':'video'}
        self.frame=(Path(__file__).parent/'fixtures/phone-camera-checker-v1.jpg').read_bytes()
        self.input=CameraInput(self.config,self.frame,lambda:self.now,lambda:self.now)
        self.workers=[];self.fd=sealed()
        outer=self
        class Worker:
            def __init__(self,value,fd):
                self.value=value;self.fd=os.dup(fd);self.running=True;self.block=None
                outer.workers.append(self)
            def answer(self):
                if self.block:self.block.wait(2)
                outer.input.apply({'action':'frame','grant':self.value['grant'],'sequence':1},outer.frame)
                return {'sourceId':self.value['grant']['sourceId'],'state':'receiving'}
            def alive(self):return self.running
            def close(self):
                if self.running:os.close(self.fd)
                self.running=False
                if self.block:self.block.set()
        self.control=VideoCameraControl(self.config,self.input.apply,Worker)
        self.value={'grant':self.grant,'loop':False}
    def tearDown(self):self.control.close();os.close(self.fd)
    def open(self,grant=None):self.input.apply({'action':'open','grant':grant or self.grant,'leaseExpiresAt':104000})
    def test_no_worker_before_grant_or_for_foreign_run(self):
        with self.assertRaises(CameraInputError):self.control.start(self.value,self.fd)
        self.open()
        with self.assertRaises(CameraInputError):self.control.start({**self.value,'grant':{**self.grant,'runId':str(uuid.uuid4())}},self.fd)
        self.assertFalse(self.workers)
    def test_start_one_stop_clears_frame_and_closes_inherited_fd(self):
        self.open();result=self.control.start(self.value,self.fd);self.assertEqual(result['state'],'receiving')
        with self.assertRaises(CameraInputError):self.control.start(self.value,self.fd)
        worker=self.workers[0];self.assertEqual(self.control.stop(self.grant)['retainedFrameBytes'],0)
        self.assertIsNone(self.input.active);self.assertFalse(worker.alive())
        with self.assertRaises(OSError):os.fstat(worker.fd)
        os.fstat(self.fd)  # Caller descriptor is not the worker's descriptor.
    def test_expiry_reaps_worker_without_web_request(self):
        self.open();self.control.start(self.value,self.fd);self.now=105;self.control.check()
        self.assertIsNone(self.control.active);self.assertFalse(self.workers[0].alive());self.assertIsNone(self.input.active)
    def test_worker_exit_clears_input_and_old_stop_keeps_replacement(self):
        self.open();self.control.start(self.value,self.fd);self.workers[0].close();self.control.check()
        new={**self.grant,'sourceId':str(uuid.uuid4()),'id':str(uuid.uuid4()),'sourceKind':'image'}
        self.open(new);self.input.apply({'action':'frame','grant':new,'sequence':1},self.frame)
        self.control.stop(self.grant);self.assertEqual(self.input.active['grant'],new)
    def test_close_interrupts_pending_start_without_locking_lease_watch(self):
        self.open();factory=self.control.factory;entered=threading.Event();release=threading.Event();errors=[]
        def make(value,fd):
            worker=factory(value,fd);worker.block=release;entered.set();return worker
        self.control.factory=make
        def start():
            try:self.control.start(self.value,self.fd)
            except Exception as error:errors.append(type(error).__name__)
        thread=threading.Thread(target=start);thread.start();self.assertTrue(entered.wait(1))
        self.control.stop(self.grant);thread.join(2)
        self.assertFalse(thread.is_alive());self.assertTrue(errors);self.assertIsNone(self.input.active)
    def test_real_scm_rights_fd_is_sealed_and_close_on_exec(self):
        a,b=socket.socketpair()
        with a,b:
            value={'action':'start',**self.value};raw=json.dumps(value).encode()
            a.sendmsg([b'V'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[self.fd]))]);a.sendall(struct.pack('!I',len(raw))+raw)
            received,fd=read_handoff(b)
            try:
                self.assertEqual(received,value);self.assertEqual(fcntl.fcntl(fd,fcntl.F_GET_SEALS),15)
                self.assertTrue(fcntl.fcntl(fd,fcntl.F_GETFD)&fcntl.FD_CLOEXEC)
                self.assertEqual(os.pread(fd,8,0)[4:],b'ftyp')
            finally:os.close(fd)
    def test_unexpected_descriptors_are_closed_even_on_invalid_request(self):
        for action,count in [('start',0),('start',2),('close',1)]:
            a,b=socket.socketpair()
            with a,b:
                before=len(os.listdir('/proc/self/fd'));raw=json.dumps({'action':action,**self.value}).encode()
                a.sendmsg([b'V'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[self.fd]*count))] if count else [])
                a.sendall(struct.pack('!I',len(raw))+raw)
                with self.assertRaises(CameraInputError):read_handoff(b)
                self.assertEqual(len(os.listdir('/proc/self/fd')),before)
    def test_video_command_has_exact_bool_and_closed_framing(self):
        raw=b'\x00\x00\x00\x18ftypisom'+bytes(12)
        job={'action':'video','grant':self.grant,'deadline':int(time.time()*1000)+14000,'sizeBytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'loop':True}
        request(job,self.config)
        for patch in ({'loop':1},{'sizeBytes':2**53},{'url':'file:///secret'},{'grant':{**self.grant,'sourceKind':'image'}}):
            with self.assertRaises(CameraInputError):request({**job,**patch},self.config)
        self.open();seen=[]
        def worker(value,fd=None):
            seen.append(value['action'])
            if value['action']=='start':
                info=os.fstat(fd)
                self.assertTrue(stat.S_ISREG(info.st_mode));self.assertEqual(info.st_nlink,0)
                self.assertEqual(info.st_uid,os.getuid())
                self.assertEqual(fcntl.fcntl(fd,fcntl.F_GETFL)&os.O_ACCMODE,os.O_RDONLY)
                self.assertEqual(os.pread(fd,len(raw),0),raw)
                self.input.apply({'action':'frame','grant':self.grant,'sequence':1},self.frame)
                return {'sourceId':self.grant['sourceId'],'state':'receiving'}
        result=execute(job,io.BytesIO(raw+END),broker=self.input.apply,video_broker=worker)
        self.assertEqual(result['state'],'receiving');self.assertEqual(seen,['start'])
        with self.assertRaises(CameraInputError):execute(job,io.BytesIO(raw+END+b'x'),broker=self.input.apply,video_broker=worker)
        self.assertIsNone(self.input.active)


if __name__=='__main__':unittest.main()
