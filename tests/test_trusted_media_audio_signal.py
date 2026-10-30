"""Synthetic signal-presence checks; no physical/sender acceptance claim."""
from array import array
import sys
import os
import unittest
from services.trusted_media_service.audio_signal_meter import AudioSignalMeter


class SignalMeterTest(unittest.TestCase):
    def test_counts_silence_and_signal_without_retaining_bytes(self):
        meter = AudioSignalMeter()
        meter.observe_s16le(bytes(1920))
        data = array('h', [100, -100]*480)
        if sys.byteorder != 'little':data.byteswap()
        meter.observe_s16le(data.tobytes())
        self.assertEqual(meter.snapshot(), {'signalBuffers': 1, 'silentBuffers': 1, 'invalidBuffers': 0})
        self.assertEqual(set(vars(meter)), {'_lock', '_signal', '_silent', '_invalid'})

    def test_rejects_unbounded_or_unaligned_input(self):
        meter = AudioSignalMeter()
        for value in (b'', b'12', bytes(192004)):
            meter.observe_s16le(value)
        self.assertEqual(meter.snapshot(), {'signalBuffers': 0, 'silentBuffers': 0, 'invalidBuffers': 3})

    def test_real_converter_measures_the_actual_sink_input(self):
        from services.trusted_media_service.gdp_media_ingress import _gstreamer
        from services.trusted_media_service.hdmi_media_output import HdmiMediaOutput, KmsDevice
        import time
        try:
            Gst = _gstreamer()
        except ModuleNotFoundError as error:
            if error.name != 'gi' or os.environ.get('TEAMAIBOX_REQUIRE_MEDIA_INTEGRATION') == '1':
                raise
            self.skipTest('Audio conversion integration requires the Linux GStreamer test container')
        for volume, wanted in ((0, 'silentBuffers'), (.1, 'signalBuffers')):
            output=HdmiMediaOutput(session_id='10000000-0000-4000-8000-000000000001',
                                  expires_at=time.time()+30,device=KmsDevice(card=1,connector='HDMI-A-1'))
            output._Gst=Gst
            pipeline=Gst.parse_launch(f'audiotestsrc num-buffers=10 volume={volume} ! '
                'audio/x-raw,format=F32LE,rate=44100,channels=2 ! audioconvert ! audioresample ! '
                'audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved ! fakesink name=output')
            pipeline.get_by_name('output').get_static_pad('sink').add_probe(Gst.PadProbeType.BUFFER,output._measure_audio)
            try:
                pipeline.set_state(Gst.State.PLAYING)
                message=pipeline.get_bus().timed_pop_filtered(2*Gst.SECOND,Gst.MessageType.ERROR|Gst.MessageType.EOS)
                self.assertIsNotNone(message)
                self.assertEqual(message.type,Gst.MessageType.EOS)
                state=output._signal_meter.snapshot()
                self.assertGreaterEqual(state[wanted],10)
                self.assertEqual(state['invalidBuffers'],0)
            finally:
                pipeline.set_state(Gst.State.NULL)
                pipeline.get_state(Gst.SECOND)

if __name__=='__main__':unittest.main()
