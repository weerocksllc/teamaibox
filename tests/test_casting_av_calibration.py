import unittest
import numpy as np
from tools.casting_av_calibration import rising_events,match_events

class CalibrationTest(unittest.TestCase):
    def events(self,offset=0,step=1/60):
        times=np.arange(0,12,step)
        values=np.full(len(times),20.)
        for start in (2,4,6,8,10):values[(times>=start+offset)&(times<start+offset+.1)]=230
        return rising_events(times,values)

    def test_known_150_ms_video_delay_within_frame_bounds(self):
        v=match_events(self.events(),self.events(.15))
        self.assertAlmostEqual(v['medianMs'],150)
        self.assertTrue(all(p['lowerMs']<=150<=p['upperMs'] for p in v['perPulse']))

    def test_sound_before_picture_keeps_negative_sign(self):
        v=match_events(self.events(.1),self.events(.05))
        self.assertAlmostEqual(v['medianMs'],-50)

    def test_dropped_pulse_is_not_silently_ignored(self):
        with self.assertRaises(ValueError):match_events(self.events(),self.events()[:-1])

    def test_wrong_pulse_alignment_fails(self):
        shifted=[{k:v+2 for k,v in event.items()} for event in self.events()]
        with self.assertRaises(ValueError):match_events(self.events(),shifted)

    def test_no_flash_contrast_fails(self):
        with self.assertRaises(ValueError):rising_events(np.arange(100)/60,np.ones(100)*20)

    def test_variable_frame_times_are_used_not_assumed_fps(self):
        t=np.cumsum(np.tile([.01,.02,.015,.022],200));v=np.where(np.floor(t)%2==0,20,230)
        events=rising_events(t,v)
        for e in events:self.assertGreater(e['hi'],e['lo'])

if __name__=='__main__':unittest.main()
