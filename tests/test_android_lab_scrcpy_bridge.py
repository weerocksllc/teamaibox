import struct
import unittest
from tools.android_lab_scrcpy_bridge import control_message,media_header

class ProtocolTests(unittest.TestCase):
    def test_touch(self):
        raw=control_message(dict(type='touch',action=0,x=100,y=200,width=720,height=1280))
        self.assertEqual(len(raw),32);self.assertEqual(raw[:2],b'\x02\x00')
        self.assertEqual(struct.unpack('>ii',raw[10:18]),(100,200))
    def test_reject_bounds(self):
        with self.assertRaises(ValueError):control_message(dict(type='touch',action=0,x=720,y=0,width=720,height=1280))
    def test_text(self):self.assertEqual(control_message(dict(type='text',text='TEST')),b'\x01\x00\x00\x00\x04TEST')
    def test_key(self):self.assertEqual(len(control_message(dict(type='key',keycode=4,action=1))),14)
    def test_session(self):self.assertEqual(media_header(struct.pack('>III',0x80000000,720,1280)),dict(session=True,width=720,height=1280))
    def test_frame(self):
        h=media_header(struct.pack('>QI',(1<<61)|123,555))
        self.assertEqual(h['pts'],123);self.assertTrue(h['key']);self.assertEqual(h['length'],555)
    def test_limit(self):
        with self.assertRaises(ValueError):media_header(struct.pack('>QI',0,20*1024*1024))
