"""Isolated grant/lifetime tests; real WebRTC/Android are separate runs."""
import copy
from pathlib import Path
import sys
import threading
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'deploy/android/cuttlefish'))
from phone_browser_camera_control import BrowserCameraControl
from phone_camera_input import CameraInput, CameraInputError
from test_phone_browser_camera import offer


class Worker:
    def __init__(self, value):
        self.value, self.running, self.closes = value, True, 0
        self.entered, self.release = threading.Event(), threading.Event()
        self.block = False
    def answer(self):
        self.entered.set()
        if self.block:
            self.release.wait(2)
        return {'sourceId':self.value['grant']['sourceId'],'answerSdp':'v=0\r\n','bindAddress':'172.18.0.2'}
    def alive(self):
        return self.running
    def close(self):
        self.running = False
        self.closes += 1
        self.release.set()


class BrowserControlTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.config = {k:str(uuid.uuid4()) for k in ('phoneId','ownerId','runId')}
        self.config.update(generation=1)
        self.grant = {**self.config,**{k:str(uuid.uuid4()) for k in ('id','sourceId','sessionId')},'sourceKind':'browser'}
        self.frame = (ROOT/'tools/fixtures/phone-camera-checker-v1.jpg').read_bytes()
        self.private = self.frame[:2]+b'\xff\xfe\x00\x06test'+self.frame[2:]
        self.input = CameraInput(self.config,self.frame,lambda:self.now,lambda:self.now)
        self.workers = []
        def factory(value):
            worker = Worker(value)
            self.workers.append(worker)
            return worker
        self.control = BrowserCameraControl(self.config,self.input.apply,factory)
        self.start = {'grant':self.grant,'allowedAddresses':['10.64.0.8'],'offerSdp':offer()}
    def tearDown(self):
        self.control.close()
    def open(self, grant=None):
        self.input.apply({'action':'open','grant':grant or self.grant,'leaseExpiresAt':(self.now+4)*1000})
    def send(self):
        self.input.apply({'action':'frame','grant':self.grant,'sequence':1},self.private)
    def test_no_decoder_before_an_authorized_grant(self):
        self.assertEqual(self.workers,[])
        with self.assertRaisesRegex(CameraInputError,'stopped'):
            self.control.offer(self.start)
        self.assertEqual(self.workers,[])
    def test_one_decoder_and_no_duplicate_negotiation(self):
        self.open();self.control.offer(self.start)
        with self.assertRaisesRegex(CameraInputError,'already_started'):
            self.control.offer(self.start)
        self.assertEqual(len(self.workers),1)
    def test_stop_discards_private_frame_and_reaps_exact_process(self):
        self.open();self.control.offer(self.start);self.send()
        self.assertEqual(self.input.current(),self.private)
        self.assertEqual(self.control.stop(self.grant)['retainedFrameBytes'],0)
        self.assertEqual(self.input.current(),self.frame)
        self.assertFalse(self.workers[0].alive())
        self.assertEqual(self.workers[0].closes,1)
        with self.assertRaises(CameraInputError):
            self.open()
    def test_expired_grant_stops_decoder_without_page_notification(self):
        self.open();self.control.offer(self.start);self.send()
        self.now += 4.1;self.control.check()
        self.assertIsNone(self.control.active)
        self.assertFalse(self.workers[0].alive())
        self.assertEqual(self.input.current(),self.frame)
    def test_native_decoder_failure_revokes_input(self):
        self.open();self.control.offer(self.start);self.send()
        self.workers[0].running = False
        self.control.check()
        self.assertIsNone(self.input.active)
        self.assertIsNone(self.control.active)
    def test_stale_close_and_old_frames_cannot_affect_replacement(self):
        self.open();self.control.offer(self.start);self.control.stop(self.grant)
        newer = {**self.grant,'id':str(uuid.uuid4()),'sourceId':str(uuid.uuid4())}
        self.open(newer);self.control.offer({**self.start,'grant':newer})
        # Status refuses to disclose a different source, while the old close
        # cannot signal or clear the new worker/input.
        with self.assertRaises(CameraInputError):
            self.control.stop(self.grant)
        self.assertTrue(self.workers[1].alive())
        self.assertEqual(self.input.active['grant'],newer)
        with self.assertRaises(CameraInputError):
            self.send()
    def test_foreign_phone_owner_run_and_generation_rejected_before_spawn(self):
        self.open()
        for field in ('phoneId','ownerId','runId','generation'):
            bad = copy.deepcopy(self.start)
            bad['grant'][field] = 2 if field == 'generation' else str(uuid.uuid4())
            with self.assertRaisesRegex(CameraInputError,'stale_run'):
                self.control.offer(bad)
        self.assertEqual(self.workers,[])
    def test_stop_interrupts_negotiation_without_waiting_on_its_lock(self):
        self.open()
        entered = threading.Event()
        def factory(value):
            worker=Worker(value);worker.block=True;worker.entered=entered
            self.workers.append(worker);return worker
        self.control.factory=factory
        errors=[]
        def negotiate():
            try:self.control.offer(self.start)
            except Exception as e:errors.append(str(e))
        thread=threading.Thread(target=negotiate);thread.start()
        self.assertTrue(entered.wait(1))
        self.control.stop(self.grant);thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors,['phone_camera_source_stopped'])
        self.assertEqual(self.workers[0].closes,1)
    def test_only_fixed_worker_request_no_arbitrary_path_or_microphone(self):
        self.open()
        for extra in ({'path':'/dev/video0'},{'microphone':True},{'command':'sh'}):
            with self.assertRaises(CameraInputError):
                self.control.offer({**self.start,**extra})
        self.assertEqual(self.workers,[])


if __name__ == '__main__':
    unittest.main()
