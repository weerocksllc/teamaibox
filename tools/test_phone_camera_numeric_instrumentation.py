import collections,time,types,unittest
from pathlib import Path
from unittest.mock import Mock

class NumericProbeTests(unittest.TestCase):
    def make(self):
        class Base:
            def _sample(self,sink):return 'forwarded'
        env=dict(BrowserCameraReceiver=Base,time=time)
        exec(compile(Path(__file__).with_name('phone_camera_numeric_instrumentation.py').read_text(),'numeric','exec'),env)
        obj=env['BrowserCameraReceiver'].__new__(env['BrowserCameraReceiver'])
        obj.Gst=types.SimpleNamespace(PadProbeReturn=types.SimpleNamespace(OK='ok'))
        obj._diag_decode=collections.deque();obj._diag_delivery=collections.deque();obj._diag_times=collections.deque()
        obj._diag_age=Mock(return_value=10);obj._diag_caps={};obj._diag_count=29
        return obj
    def test_fraction_uses_typed_getter(self):
        obj=self.make();s=Mock();s.has_field.return_value=True
        s.get_fraction.return_value=(True,1,1)
        def value(key):
            if key=='pixel-aspect-ratio':raise TypeError('unknown type GstFraction')
            return {'width':640,'height':480}[key]
        s.get_value.side_effect=value
        caps=Mock();caps.get_size.return_value=1;caps.get_structure.return_value=s
        pad=Mock();pad.get_current_caps.return_value=caps
        self.assertEqual(obj._diag_decoded(pad,Mock()),'ok')
        self.assertEqual(obj._diag_caps['pixelAspectRatio'],[1,1])
    def test_observer_exception_never_drops_frame(self):
        obj=self.make();obj._diag_age.side_effect=ValueError('observer failed')
        self.assertEqual(obj._diag_decoded(Mock(),Mock()),'ok')
        self.assertTrue(obj._diag_caps['measurementError'])
    def test_output_file_failure_never_breaks_delivery(self):
        obj=self.make();obj._diag_write=Mock(side_effect=OSError('read-only'))
        self.assertEqual(obj._sample(Mock()),'forwarded')

if __name__=='__main__':unittest.main()
