import copy,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from validate_phone_revocation_browser import checks
from validate_phone_revocation_browser_v2 import checks as current_checks

class BrowserRevocationTests(unittest.TestCase):
    def record(self):
        first=dict(at='2026-01-01T00:00:00Z',audioMuted=False,audioPaused=False,audioReady=4,audioTime=1,videoPaused=False,videoReady=4,videoTime=1,status='已连接',inputState='open',inputSent=4,audioEnergy=.01,decodedFrames=60)
        before={**first,'at':'2026-01-01T00:00:05Z','audioTime':6,'videoTime':6,'audioEnergy':.02,'decodedFrames':360}
        after=dict(at='2026-01-01T00:00:07Z',audioPaused=True,audioReady=0,audioTime=0,videoPaused=True,videoReady=0,videoTime=0,status='连接已断开',inputStatsCleared=True,workspaceHidden=False)
        r=dict(status='passed',observationMethod='actual-system-trusted-browser',phoneId='fixture',memberLogin='test',mode='stop',first=first,lastPlaying=before,firstCleared=after,sampleCount=28,maximumSampleGapMs=300,fullBrowserAccepted=False,releaseAccepted=False)
        p=dict(phoneId='fixture',runId='test',mode='stop',revocationAt='2026-01-01T00:00:06Z')
        return r,p
    def test_observed_teardown(self):
        r,p=self.record();self.assertEqual(checks(r,p),1)
    def test_rejects_late_or_wrong_action(self):
        for at in ('2026-01-01T00:00:04Z','2026-01-01T00:00:17Z'):
            r,p=self.record();r['firstCleared']['at']=at
            with self.assertRaises(RuntimeError):checks(r,p)
    def test_requires_actual_media_input_and_clear(self):
        for group,key,value in [('first','audioEnergy',0),('lastPlaying','inputState','closed'),('firstCleared','videoReady',4),('firstCleared','inputStatsCleared',False)]:
            r,p=self.record();r[group][key]=value
            with self.assertRaises(RuntimeError):checks(r,p)
    def test_disable_requires_closed_workspace(self):
        r,p=self.record();r['mode']=p['mode']='disable';r['firstCleared'].update(status='暂时无法连接手机，请重试。',workspaceHidden=True);checks(r,p)
        r['firstCleared']['workspaceHidden']=False
        with self.assertRaises(RuntimeError):checks(r,p)
    def test_media_deadline_is_separate_from_list_refresh(self):
        r,p=self.record();r['mode']=p['mode']='disable'
        r['firstCleared'].update(status='暂时无法连接手机，请重试。',workspaceHidden=False)
        r['settled']={**r['firstCleared'],'at':'2026-01-01T00:00:12Z','workspaceHidden':True}
        self.assertEqual(current_checks(r,p),1)
        r['firstCleared']['at']='2026-01-01T00:00:17Z'
        with self.assertRaises(RuntimeError):current_checks(r,p)
    def test_delayed_list_refresh_cannot_replace_missing_media_teardown(self):
        r,p=self.record();r['mode']=p['mode']='disable'
        r['firstCleared'].update(status='暂时无法连接手机，请重试。',workspaceHidden=False)
        r['settled']={**r['firstCleared'],'at':'2026-01-01T00:00:37Z','workspaceHidden':True}
        with self.assertRaises(RuntimeError):current_checks(r,p)
if __name__=='__main__':unittest.main()
