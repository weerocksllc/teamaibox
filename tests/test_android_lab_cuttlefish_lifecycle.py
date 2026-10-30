import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from android_lab_cuttlefish_lifecycle import owned_android_vm
from validate_android_lab_cuttlefish_lifecycle import validate
from test_android_lab_cuttlefish_functional import inputs as functional_inputs
import copy


class ExactCrashScope(unittest.TestCase):
    def test_only_run_owned_android_vm(self):
        root=Path('/lab/unit-run/artifacts')
        exact=[str(root/'bin/aarch64-linux-musl/crosvm').encode(),b'--extended-status',b'run',
               b'--socket=/tmp/cf_avd_0/cvd-21/internal/crosvm_control.sock']
        self.assertTrue(owned_android_vm(exact,root))
        self.assertFalse(owned_android_vm(exact[:-1]+[b'--socket=/tmp/cf_avd_0/cvd-21/internal/ap_control.sock'],root))
        self.assertFalse(owned_android_vm([b'/other/crosvm',*exact[1:]],root))
        self.assertFalse(owned_android_vm([b'/lab/unit-run/artifacts/bin/process_restarter',*exact],root))
        self.assertFalse(owned_android_vm([],root))


def lifecycle_inputs():
    guard,_,_=functional_inputs();run=guard['runId'];rows=[];browsers=[]
    for n in range(1,11):
        def stats(frames):return {'video':{'width':720,'height':1280},'peers':[{'state':'connected','stats':[{'ssrc':n,'framesDecoded':frames}]}]}
        receipt={'runId':run,'cycle':n,'bootId':'unit-boot-'+str(n),'status':'passed','before':stats(1),'after':stats(31)}
        browsers.append(receipt);rows.append({'index':n,'bootId':receipt['bootId'],'androidId':'unit-phone','browser':copy.deepcopy(receipt),
            'privateSha':'unit-marker','sharedSha':'unit-marker','roundtripSha':'unit-marker','deviceName':'Team-AI-lab-phone',
            'stopExit':0,'appFocus':['mCurrentFocus=com.android.settings'],'bootSeconds':20})
    rows[4]['forcedVmExitPid']=123
    return guard,{'runId':run,'status':'passed','kvmApi':12,'hardwareGraphicsAccepted':False,'finalStopExit':0,
        'cycles':rows,'testApp':{'package':'com.android.settings','thirdPartyInstallAccepted':False},'markerSha256':'unit-marker'},browsers


class LifecycleValidation(unittest.TestCase):
    def test_scope_remains_limited(self):
        r=validate(*lifecycle_inputs());self.assertTrue(r['forcedVmCrashRecovered']);self.assertFalse(r['productAccepted']);self.assertFalse(r['thirdPartyInstallAccepted'])
    def test_reused_boot_rejected(self):
        a,b,c=lifecycle_inputs();b['cycles'][1]['bootId']=b['cycles'][0]['bootId']
        with self.assertRaises(ValueError):validate(a,b,c)
    def test_changed_file_rejected(self):
        a,b,c=lifecycle_inputs();b['cycles'][8]['roundtripSha']='changed'
        with self.assertRaises(ValueError):validate(a,b,c)
    def test_no_crash_rejected(self):
        a,b,c=lifecycle_inputs();del b['cycles'][4]['forcedVmExitPid']
        with self.assertRaises(ValueError):validate(a,b,c)
    def test_missing_browser_receipt_rejected(self):
        a,b,c=lifecycle_inputs();c.pop()
        with self.assertRaises(ValueError):validate(a,b,c)


if __name__=='__main__':unittest.main()
