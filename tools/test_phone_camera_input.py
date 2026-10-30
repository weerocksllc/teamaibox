import importlib.util
from pathlib import Path
import unittest
import uuid
import threading

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('phone_camera_input',ROOT/'deploy/android/cuttlefish/phone_camera_input.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class CameraInputTests(unittest.TestCase):
    def setUp(self):
        self.now=100.
        self.frame=(ROOT/'tools/fixtures/phone-camera-checker-v1.jpg').read_bytes()
        self.other=self.frame[:2]+b'\xff\xfe\x00\x06test'+self.frame[2:]
        self.config={k:str(uuid.uuid4()) for k in ('phoneId','ownerId','runId')};self.config['generation']=1
        self.grant={**self.config,**{k:str(uuid.uuid4()) for k in ('id','sourceId','sessionId')},'sourceKind':'image'}
        self.state=module.CameraInput(self.config,self.frame,lambda:self.now,lambda:self.now)
    def req(self,action,grant=None,**extra):
        value=dict(action=action,grant=grant or self.grant,**extra)
        if action in ('open','renew'):value['leaseExpiresAt']=(self.now+5)*1000
        return value
    def activate(self,grant=None):
        self.state.apply(self.req('open',grant));self.state.apply(self.req('frame',grant,sequence=1),self.other)
    def test_no_source_by_default(self):
        self.assertIsNone(self.state.active);self.assertEqual(self.state.current(),self.frame)
    def test_frame_is_input_only_under_matching_lease(self):
        with self.assertRaises(module.CameraInputError):self.state.apply(self.req('frame',sequence=1),self.other)
        self.activate();self.assertEqual(self.state.current(),self.other)
    def test_revoke_discards_private_frame_and_cannot_renew(self):
        self.activate();self.state.apply(self.req('close'))
        self.assertEqual(self.state.current(),self.frame);self.assertIsNone(self.state.active)
        for action in ('open','renew'):
            with self.assertRaisesRegex(module.CameraInputError,'revoked'):self.state.apply(self.req(action))
    def test_expiry_uses_monotonic_time_and_returns_neutral(self):
        self.activate();self.now+=5;self.assertEqual(self.state.current(),self.frame)
        self.assertIsNone(self.state.active)
    def test_idle_frame_is_reclaimed_without_any_client_request(self):
        self.activate();stopped=threading.Event();thread=threading.Thread(target=self.state.watch,args=(stopped,));thread.start()
        try:
            self.now+=6
            # Waiting releases the GIL; no current()/status() request triggers expiry.
            threading.Event().wait(.25)
            self.assertIsNone(self.state.active)
        finally:stopped.set();thread.join(timeout=1)
    def test_live_sources_go_neutral_on_missing_frames(self):
        for kind in ('browser','usb','video','udp'):
            grant={**self.grant,'id':str(uuid.uuid4()),'sourceId':str(uuid.uuid4()),'sourceKind':kind}
            self.activate(grant);self.now+=1.1
            self.assertEqual(self.state.current(),self.frame);self.assertIsNone(self.state.active['frame'])
    def test_image_can_continue_with_explicit_renewal(self):
        self.activate();self.now+=4;self.state.apply(self.req('renew'));self.now+=4
        self.assertEqual(self.state.current(),self.other)
    def test_switch_drops_old_frame_and_old_source_cannot_push(self):
        self.activate();new={**self.grant,'id':str(uuid.uuid4()),'sourceId':str(uuid.uuid4())}
        self.state.apply(self.req('open',new));self.assertEqual(self.state.current(),self.frame)
        with self.assertRaisesRegex(module.CameraInputError,'revoked'):self.state.apply(self.req('frame',sequence=2),self.other)
    def test_owner_phone_and_old_run_are_rejected(self):
        for key in ('ownerId','phoneId','runId','generation'):
            bad={**self.grant,key:2 if key=='generation' else str(uuid.uuid4())}
            with self.assertRaisesRegex(module.CameraInputError,'stale_run'):self.state.apply(self.req('open',bad))
    def test_same_token_cannot_change_binding(self):
        self.activate();bad={**self.grant,'sourceId':str(uuid.uuid4())}
        for action in ('open','close','renew'):
            with self.assertRaises(module.CameraInputError):self.state.apply(self.req(action,bad))
        self.assertEqual(self.state.current(),self.other)
    def test_bounds_and_stale_sequence(self):
        self.activate()
        for frame in (b'no',b'\xff\xd8'+bytes(module.MAX_JPEG)+b'\xff\xd9',self.other[:-2],bytearray(self.other)):
            with self.assertRaises(module.CameraInputError):self.state.apply(self.req('frame',sequence=2),frame)
        with self.assertRaisesRegex(module.CameraInputError,'sequence_stale'):self.state.apply(self.req('frame',sequence=1),self.other)
    def test_expiry_and_request_shape_are_closed(self):
        for expiry in (True,float('inf'),float('nan'),100000,106000):
            request=self.req('open');request['leaseExpiresAt']=expiry
            with self.assertRaises(module.CameraInputError):self.state.apply(request)
        for extra in ({'path':'/etc/passwd'},{'microphone':True}):
            with self.assertRaises(module.CameraInputError):self.state.apply(self.req('open',**extra))
    def test_only_fixed_baseline_jpeg_dimensions(self):
        bad=self.frame.replace(b'\x01\xe0\x02\x80',b'\x02\xd0\x05\x00',1)
        self.assertNotEqual(bad,self.frame)
        with self.assertRaises(module.CameraInputError):module.jpeg_frame(bad)


if __name__=='__main__':unittest.main()
