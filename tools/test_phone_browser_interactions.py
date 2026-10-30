"""Negative controls only; immutable real observations are never modified."""
import copy,json,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from validate_phone_browser_interactions import E,checks,validate

class BrowserInteractions(unittest.TestCase):
    def setUp(self):
        self.path=E/'phone-browser-interactions-20260912-a1.json'
        self.r=json.loads(self.path.read_bytes())
        self.parent=json.loads((E/'phone-member-media-20260912-a3.json').read_bytes())
        self.observer=json.loads((E/'phone-peer-observation-20260912-a6.json').read_bytes())
    def test_real_scoped_observations(self):
        self.assertEqual(validate(self.path)['peerRevokedSeconds'],2.913)
    def test_missing_frames_and_audio(self):
        for mutate in (lambda r:r['reloads'].pop(),lambda r:r['reloads'][0].update(ready=0),lambda r:r['audioAfterExplicitEnable'].update(paused=True)):
            r=copy.deepcopy(self.r);mutate(r)
            with self.assertRaises(RuntimeError):checks(r,self.parent,self.observer)
    def test_wss_close_is_not_actual_media_close(self):
        o=copy.deepcopy(self.observer)
        for s in o['samples']:s['peersGone']=False
        with self.assertRaisesRegex(RuntimeError,'actual_peer_revoke_timeout'):checks(self.r,self.parent,o)
    def test_wrong_guest_or_guest_restart(self):
        for field,value in (('android',[999999]),('streamer',{'pid':999999,'startTicks':1})):
            o=copy.deepcopy(self.observer);o['samples'][-1][field]=value
            with self.assertRaises(RuntimeError):checks(self.r,self.parent,o)
    def test_no_overclaim(self):
        for field in ('tenMinuteContinuousPlaybackAccepted','fullBrowserAccepted','releaseAccepted'):
            r=copy.deepcopy(self.r);r[field]=True
            with self.assertRaises(RuntimeError):checks(r,self.parent,self.observer)
    def test_bounded_revoke_observation(self):
        r=copy.deepcopy(self.r);r['browserAfterLogout']['at']='2026-09-12T12:58:10Z'
        with self.assertRaises(RuntimeError):checks(r,self.parent,self.observer)

if __name__=='__main__':unittest.main()
