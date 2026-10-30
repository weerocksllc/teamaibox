import copy,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from validate_phone_member_revocation import checks

class RevocationTests(unittest.TestCase):
    def record(self):
        return dict(status='passed',failure=None,cleanupFailures=[],mode='stop',phoneDeleted=True,identityDisabled=True,policyBefore={},policyAfter={},oldServiceIdentityUnchanged=True,foreignStateUnchanged=True,phoneId='fixture',identityId='member',runtimeBefore=dict(running=True,memory=6*1024**3,swapLimit=6*1024**3,labels={'com.teamaibox.phone-id':'fixture','com.teamaibox.owner-identity-id':'member'}),installation=dict(installed=True),sourceBeforeRevocation=dict(audioPlaying=True,audioFramesPlayed=48000,drawnFrames=20),peerObservations=[dict(peersGone=False),dict(peersGone=True)],peerRevokedSeconds=3,browserAccepted=False,hostRebooted=False,servicesRestarted=False)
    def test_needs_real_peer_before_and_after(self):
        checks(self.record())
        for values in ([dict(peersGone=True),dict(peersGone=True)],[dict(peersGone=False),dict(peersGone=False)],[dict(peersGone=False),dict(peersGone=True,error='probe_failed')]):
            r=self.record();r['peerObservations']=values
            with self.assertRaises(RuntimeError):checks(r)
    def test_deadline_cleanup_and_scope(self):
        for key,value in [('peerRevokedSeconds',10.001),('phoneDeleted',False),('foreignStateUnchanged',False),('browserAccepted',True)]:
            r=self.record();r[key]=value
            with self.assertRaises(RuntimeError):checks(r)
    def test_disable_must_be_observed_and_cleanup_scoped(self):
        r=self.record();r.update(mode='disable',revocationResult=dict(status='disabled'),reenabledOnlyForCleanup=True);checks(r)
        r['revocationResult']['status']='active'
        with self.assertRaises(RuntimeError):checks(r)
if __name__=='__main__':unittest.main()
