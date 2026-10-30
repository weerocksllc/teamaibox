import copy,hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from tools import validate_current_casting_boundaries as gate

class CastingBoundaryValidation(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();(self.root/'tools').mkdir()
        source=b'bounded test runner'
        (self.root/'tools/test_current_casting_boundaries_v2.mjs').write_bytes(source)
        self.path=self.root/'evidence/validation/browser/casting-control-boundaries-20260916-a7.json';self.path.parent.mkdir(parents=True)
        self.value=dict(runId=self.path.stem,status='passed',checks={k:True for k in gate.CHECKS},identities=['test-member'],cleanup=dict(disabled=['test-member'],sessionStopped=True),systemTrustUsed=True,appleSenderAccepted=False,mediaSaved=False,busyCode='cast_session_busy',sourceSha256=hashlib.sha256(source).hexdigest(),rejectedOutputs=[dict(value=v,status=400,code='cast_output_invalid') for v in ([],['hdmi'],['browser','hdmi'],['unknown'],None)])
    def validate(self,value):
        self.path.write_text(json.dumps(value))
        with patch.object(gate,'ROOT',self.root):return gate.validate(self.path)
    def test_complete_control_only(self):
        self.assertTrue(self.validate(self.value)['valid'])
    def test_failed_run_never_passes(self):
        self.value['status']='failed'
        with self.assertRaisesRegex(RuntimeError,'run_failed'):self.validate(self.value)
    def test_missing_or_false_checks_rejected(self):
        for mode in ('missing','false'):
            v=copy.deepcopy(self.value);key=next(iter(v['checks']))
            if mode=='missing':del v['checks'][key]
            else:v['checks'][key]=False
            with self.assertRaisesRegex(RuntimeError,'checks_missing'):self.validate(v)
    def test_media_claim_cannot_be_added(self):
        self.value['appleSenderAccepted']=True
        with self.assertRaisesRegex(RuntimeError,'scope_invalid'):self.validate(self.value)
    def test_incomplete_cleanup_rejected(self):
        self.value['cleanup']['sessionStopped']=False
        with self.assertRaisesRegex(RuntimeError,'cleanup_failed'):self.validate(self.value)
    def test_wrong_rejection_and_changed_source_rejected(self):
        v=copy.deepcopy(self.value);v['rejectedOutputs'][0]['status']=200
        with self.assertRaisesRegex(RuntimeError,'output_rejection_missing'):self.validate(v)
        self.value['sourceSha256']='0'*64
        with self.assertRaisesRegex(RuntimeError,'source_changed'):self.validate(self.value)

if __name__=='__main__':unittest.main()
