import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from validate_android_lab_cuttlefish_functional import validate


def inputs():
    run='unit-test-only';identity={'Id':'unit','Image':'test-image','Name':'/'+run,
        'Config.Labels':{'com.teamaibox.android-lab.run':run},'HostConfig.Memory':8*1024**3,
        'HostConfig.MemorySwap':8*1024**3,'HostConfig.NanoCpus':4_000_000_000,'State.ExitCode':0,'State.OOMKilled':False}
    guard={'runId':run,'status':'passed','containerRemoved':True,'existingServicesUnchanged':True,
        'containersBefore':[],'containersAfter':[],'containerFinal':identity,'containerId':'unit','image':'test-image',
        'samples':[{'availableBytes':17*1024**3} for _ in range(31)]}
    android={'runId':run,'status':'passed','androidBooted':True,'containerKvmApi':12,'containerEmptyVmCreated':True,
        'requestedRenderer':'guest_swiftshader','hardwareGraphicsAccepted':False,'stopExitCode':0}
    def media(time,frames):return {'at':time,'peers':[{'state':'connected','stats':[{'type':'inbound-rtp','kind':'video',
        'framesDecoded':frames,'framesDropped':0,'packetsLost':0}]}]}
    tone={'paused':False,'samples':[{'rms':.01,'peakHz':1000}]}
    browser={'run':run,'status':'passed','keyboard':{'text':'TEST-123'},
        'measurements':[{'done':True,'elapsedMs':150,'start':10,'end':160} for _ in range(5)],
        'loads':[{'audio':copy.deepcopy(tone),'before':media(0,0),'after':media(21000,1260),
                  'guest':{'intervals':[1000/30]*630}} for _ in range(3)],
        'reconnects':[{'n':n,'text':'TEST-123','media':media(0,0)} for n in range(1,11)],'audioAfterReconnect':tone}
    return guard,android,browser


class FunctionalValidation(unittest.TestCase):
    def continuous_inputs(self):
        a,b,c=inputs()
        def media(n):
            return {'at':n*10000,'peers':[{'state':'connected','stats':[{'type':'inbound-rtp','kind':'video',
                'ssrc':42,'framesDecoded':n*300,'framesDropped':0,'packetsLost':0}]}]}
        c['continuous']={'targetSeconds':600,'seconds':600,'before':media(0),'after':media(60),
            'windows':[{'index':n,'before':media(n-1),'after':media(n),'audio':copy.deepcopy(c['audioAfterReconnect'])} for n in range(1,61)]}
        return a,b,c
    def test_full_playback_has_sixty_connected_audio_video_windows(self):
        result=validate(*self.continuous_inputs(),require_continuous=True)
        self.assertEqual(result['continuousPlaybackSeconds'],600)
    def test_long_container_lifetime_does_not_replace_playback(self):
        with self.assertRaises(ValueError):validate(*inputs(),require_continuous=True)
    def test_timeline_gap_rejected(self):
        a,b,c=self.continuous_inputs();c['continuous']['windows'][7]['before']['at']+=1
        with self.assertRaises(ValueError):validate(a,b,c,require_continuous=True)
    def test_frozen_continuous_window_rejected(self):
        a,b,c=self.continuous_inputs();c['continuous']['windows'][7]['after']['peers'][0]['stats'][0]['framesDecoded']=0
        with self.assertRaises(ValueError):validate(a,b,c,require_continuous=True)
    def test_short_duration_rejected(self):
        a,b,c=self.continuous_inputs();c['continuous']['seconds']=599
        with self.assertRaises(ValueError):validate(a,b,c,require_continuous=True)
    def test_unverified_app_bytes_rejected(self):
        a,b,c=inputs();b['testApp']={'package':'org.fossify.math','bytes':1,'sha256':'wrong'}
        with self.assertRaises(ValueError):validate(a,b,c)
    def test_actual_scope_is_not_product_or_lifecycle_acceptance(self):
        result=validate(*inputs());self.assertFalse(result['productAccepted']);self.assertFalse(result['androidLifecycleVerified'])
        self.assertAlmostEqual(result['repetitions'][0]['browserDecodedFps'],60)
        self.assertAlmostEqual(result['repetitions'][0]['androidFrameMeanMs'],1000/30)
    def test_old_service_drift_rejected(self):
        a,b,c=inputs();a['containersAfter']=[{'changed':True}]
        with self.assertRaises(ValueError):validate(a,b,c)
    def test_oom_rejected(self):
        a,b,c=inputs();a['containerFinal']['State.OOMKilled']=True
        with self.assertRaises(ValueError):validate(a,b,c)
    def test_received_but_paused_audio_rejected(self):
        a,b,c=inputs();c['audioAfterReconnect']['paused']=True
        with self.assertRaises(ValueError):validate(a,b,c)
    def test_wrong_tone_rejected(self):
        a,b,c=inputs();c['loads'][1]['audio']['samples'][0]['peakHz']=800
        with self.assertRaises(ValueError):validate(a,b,c)
    def test_missing_reconnect_rejected(self):
        a,b,c=inputs();c['reconnects'].pop()
        with self.assertRaises(ValueError):validate(a,b,c)
    def test_cross_run_rejected(self):
        a,b,c=inputs();c['run']='other'
        with self.assertRaises(ValueError):validate(a,b,c)
    def test_frozen_video_rejected(self):
        a,b,c=inputs();c['loads'][0]['after']['peers'][0]['stats'][0]['framesDecoded']=0
        with self.assertRaises(ValueError):validate(a,b,c)


if __name__=='__main__':unittest.main()
