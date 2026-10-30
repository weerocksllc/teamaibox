"""Synthetic codec tests inside the camera runtime; not guest acceptance."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import time
import unittest
import uuid

sys.path[:0] = ['/opt/teamaibox', '/opt/teamaibox/camera-python']
from PIL import Image
from phone_camera_decode import decode
from phone_camera_client import request, execute, END, CameraInputError


def encoded(image, fmt='PNG', **kwargs):
    out = io.BytesIO(); image.save(out, format=fmt, **kwargs); return out.getvalue()


class DecodeTests(unittest.TestCase):
    def test_landscape_contains_without_stretch(self):
        raw = decode(io.BytesIO(encoded(Image.new('RGB', (800, 200), 'red'))))
        image = Image.open(io.BytesIO(raw)); self.assertEqual(image.size, (640, 480))
        self.assertEqual(image.getpixel((320, 20)), (0, 0, 0))
        self.assertGreater(image.getpixel((320, 240))[0], 240)
        self.assertEqual(image.getpixel((320, 460)), (0, 0, 0))
        self.assertFalse(image.getexif()); self.assertNotIn('progressive', image.info)

    def test_exif_rotation_is_applied_and_removed(self):
        source = Image.new('RGB', (800, 200), 'green'); exif = Image.Exif(); exif[274] = 6
        raw = decode(io.BytesIO(encoded(source, 'JPEG', exif=exif)))
        image = Image.open(io.BytesIO(raw))
        self.assertEqual(image.getpixel((20, 240)), (0, 0, 0))
        self.assertGreater(image.getpixel((320, 20))[1], 110)
        self.assertFalse(image.getexif())

    def test_transparency_becomes_black(self):
        image = Image.open(io.BytesIO(decode(io.BytesIO(encoded(Image.new('RGBA', (640,480), (255,0,0,0)))))))
        self.assertEqual(image.getpixel((320,240)), (0,0,0))

    def test_webp_png_and_first_animation_frame_but_not_arbitrary_files(self):
        self.assertEqual(Image.open(io.BytesIO(decode(io.BytesIO(encoded(Image.new('RGB',(100,100)),'WEBP'))))).size,(640,480))
        animated=encoded(Image.new('RGB',(16,16),'red'),'PNG',save_all=True,append_images=[Image.new('RGB',(16,16),'blue')],duration=100)
        first=Image.open(io.BytesIO(decode(io.BytesIO(animated))))
        self.assertGreater(first.getpixel((320,240))[0],240)
        for raw in (b'not an image',encoded(Image.new('RGB',(100,100)),'BMP')):
            with self.assertRaises(Exception):decode(io.BytesIO(raw))

    def test_wide_low_memory_image_is_not_rejected_by_dimension_alone(self):
        raw=encoded(Image.new('RGB',(8193,1)))
        self.assertEqual(Image.open(io.BytesIO(decode(io.BytesIO(raw)))).size,(640,480))

    def test_decoder_child_reads_only_memfd(self):
        import phone_camera_client as client
        raw=encoded(Image.new('RGB',(400,400),'blue'));fd=os.memfd_create('synthetic')
        try:
            os.write(fd,raw);os.lseek(fd,0,0)
            output=client.decode(fd,time.monotonic()+5)
            self.assertEqual(Image.open(io.BytesIO(output)).size,(640,480))
        finally:os.close(fd)


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.config={k:str(uuid.uuid4()) for k in ('phoneId','ownerId','runId')}; self.config['generation']=1
        self.grant={**self.config,**{k:str(uuid.uuid4()) for k in ('id','sourceId','sessionId')},'sourceKind':'image'}
        self.raw=encoded(Image.new('RGB',(640,480),'red'))
        self.job=dict(action='image',grant=self.grant,deadline=int(time.time()*1000)+14000,
                      sizeBytes=len(self.raw),sha256=hashlib.sha256(self.raw).hexdigest())
        self.events=[];self.frame=None
    def broker(self,value,frame=None):
        self.events.append(value['action'])
        if value['action']=='frame':self.frame=frame
        if value['action']=='close':self.frame=None
        return dict(state='receiving' if self.frame else 'stopped' if value['action']=='close' else 'waiting',sourceId=self.grant['sourceId'])
    def test_contract_rejects_other_run_unbounded_source_or_private_path(self):
        request(self.job,self.config)
        for patch in ({'path':'/etc/passwd'},{'sizeBytes':2**53},{'deadline':int(time.time()*1000)+16000},
                      {'grant':{**self.grant,'runId':str(uuid.uuid4())}},{'grant':{**self.grant,'sourceKind':'browser'}}):
            with self.assertRaises(CameraInputError):request({**self.job,**patch},self.config)
    def test_actual_decode_and_frame_use_same_grant(self):
        result=execute(self.job,io.BytesIO(self.raw+END),self.broker)
        self.assertEqual(result['state'],'receiving'); self.assertEqual(self.events,['status','frame'])
        self.assertEqual(result['runId'],self.grant['runId']); self.assertEqual(result['resourceScope'],'phone-run')
    def test_transfer_progress_not_short_command_deadline_controls_file_duration(self):
        ticks=[]
        # Authorization is checked before execution; passing the command-start
        # deadline during an active, leased transfer must not reject the file.
        result=execute({**self.job,'deadline':int(time.time()*1000)-1},io.BytesIO(self.raw+END),
            self.broker,progress=lambda:ticks.append(True))
        self.assertEqual(result['state'],'receiving');self.assertGreaterEqual(len(ticks),2)
    def test_changed_truncated_trailing_bytes_rejected_and_source_closed(self):
        for raw in (self.raw[:-1]+END,self.raw+b'x'+END,self.raw+END+b'x'):
            self.events=[]
            with self.assertRaises(CameraInputError):execute(self.job,io.BytesIO(raw),self.broker)
            self.assertNotIn('frame',self.events);self.assertEqual(self.events[-1],'close');self.assertIsNone(self.frame)
    def test_decoder_failure_revokes_source(self):
        def bad(*_):raise CameraInputError('phone_camera_image_unsupported')
        with self.assertRaises(CameraInputError):execute(self.job,io.BytesIO(self.raw+END),self.broker,bad)
        self.assertEqual(self.events,['status','close'])
    def test_stop_requires_no_retained_frame(self):
        job=dict(action='close',grant=self.grant,deadline=int(time.time()*1000)+4000)
        def closed(value,frame=None):return dict(state='stopped',sourceId=self.grant['sourceId'],retainedFrameBytes=0)
        result=execute(job,io.BytesIO(),closed)
        self.assertEqual(result['retainedFrameBytes'],0);self.assertEqual(result['state'],'stopped')
        def retained(value,frame=None):return dict(state='stopped',sourceId=self.grant['sourceId'],retainedFrameBytes=1)
        with self.assertRaises(CameraInputError):execute(job,io.BytesIO(),retained)


if __name__ == '__main__':unittest.main()
