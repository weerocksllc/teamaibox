"""No GStreamer/network: exercise the actual startup-silence timestamp path."""
import unittest
from types import SimpleNamespace
from services.trusted_media_service.webrtc_media_output import WebRtcMediaOutput


class Buffer:
    def __init__(self,size):self.size=size;self.flags=set()
    @classmethod
    def new_allocate(cls,allocator,size,params):return cls(size)
    def get_size(self):return self.size
    def memset(self,*args):pass
    def set_flags(self,value):self.flags.add(value)


class Source:
    def __init__(self):self.buffers=[]
    def set_property(self,*args):pass
    def emit(self,method,buffer):self.buffers.append(buffer);return 'ok'


def output():
    value=WebRtcMediaOutput.__new__(WebRtcMediaOutput)
    value._pushed={'audio':0};value._last_silence=None
    clock=SimpleNamespace(now=0);clock.get_time=lambda:clock.now
    value._pipeline=SimpleNamespace(get_clock=lambda:clock,get_base_time=lambda:0)
    value._Gst=SimpleNamespace(MSECOND=1000000,Buffer=Buffer,
        BufferFlags=SimpleNamespace(GAP='gap',DISCONT='discont'),FlowReturn=SimpleNamespace(OK='ok'),
        Caps=SimpleNamespace(from_string=lambda s:s))
    source=Source();value._sources={'audio':source}
    return value,clock,source


class StartupSilenceTimelineTests(unittest.TestCase):
    def test_video_tick_must_not_make_holes_in_the_audio_timeline(self):
        value,clock,source=output()
        for frame in range(61):
            clock.now=frame*1000000000//30
            value._prime_silent_audio()
        buffers=source.buffers
        for previous,current in zip(buffers,buffers[1:]):
            self.assertEqual(current.pts,previous.pts+previous.duration)
        self.assertGreaterEqual(buffers[-1].pts+buffers[-1].duration,2*1000000000)
        self.assertEqual(value._pushed['audio'],0,'synthetic silence is not received user audio')

    def test_stop_priming_when_real_audio_has_arrived(self):
        value,clock,source=output();value._pushed['audio']=1
        value._prime_silent_audio();self.assertEqual(source.buffers,[])

    def test_no_unbounded_catchup_after_stall(self):
        value,clock,source=output();value._prime_silent_audio()
        before=len(source.buffers);clock.now=10*1000000000
        value._prime_silent_audio()
        self.assertLessEqual(len(source.buffers)-before,8)
        self.assertGreaterEqual(source.buffers[-1].pts,clock.now-160000000)
        self.assertIn('discont',source.buffers[-1].flags)

    def test_fast_video_ticks_do_not_duplicate_silence(self):
        value,clock,source=output()
        for millisecond in range(101):
            clock.now=millisecond*1000000;value._prime_silent_audio()
        self.assertEqual([b.pts for b in source.buffers],list(range(0,100000001,20000000)))

    def test_short_video_stall_preserves_timeline(self):
        value,clock,source=output();value._prime_silent_audio();clock.now=159000000
        value._prime_silent_audio()
        self.assertEqual([b.pts for b in source.buffers],list(range(0,159000001,20000000)))
        self.assertTrue(all('discont' not in b.flags for b in source.buffers))

    def test_failed_push_does_not_advance_timeline(self):
        from services.trusted_media_service.webrtc_media_output import MediaOutputError
        value,clock,source=output();source.emit=lambda *args:'failed'
        with self.assertRaises(MediaOutputError):value._prime_silent_audio()
        self.assertIsNone(value._last_silence)


if __name__=='__main__':unittest.main()
