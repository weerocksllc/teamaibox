import copy,hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from tools import validate_current_casting_expiry_browser as gate

class CastingExpiryValidation(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();(self.root/'tools').mkdir()
        source=b'bounded timer test'
        (self.root/'tools/test_current_casting_expiry_browser_v2.mjs').write_bytes(source)
        self.path=self.root/'evidence/validation/browser/casting-expiry-browser-20260916-a9.json';self.path.parent.mkdir(parents=True)
        self.value=dict(runId=self.path.stem,status='passed',checks={k:True for k in gate.CHECKS},identities=['member'],cleanup=dict(disabled=['member'],sessionStopped=True),systemTrustUsed=True,appleSenderAccepted=False,mediaSaved=False,clockModified=False,createdAt='2026-09-16T12:00:00Z',expiresAt='2026-09-16T12:01:00Z',expiryObservedAt='2026-09-16T12:01:02Z',sessionId='first',successorSessionId='next',expiredJoinStatus=403,sourceSha256=hashlib.sha256(source).hexdigest())
    def validate(self,value):
        self.path.write_text(json.dumps(value))
        with patch.object(gate,'ROOT',self.root):return gate.validate(self.path)
    def test_complete_control_scope(self):self.assertTrue(self.validate(self.value)['valid'])
    def test_failed_run(self):
        self.value['status']='failed'
        with self.assertRaisesRegex(RuntimeError,'run_failed'):self.validate(self.value)
    def test_missing_check(self):
        self.value['checks'].pop(next(iter(self.value['checks'])))
        with self.assertRaisesRegex(RuntimeError,'coverage_missing'):self.validate(self.value)
    def test_fake_clock_or_media_claim(self):
        for key in ('clockModified','appleSenderAccepted','mediaSaved'):
            v=copy.deepcopy(self.value);v[key]=True
            with self.assertRaisesRegex(RuntimeError,'scope_invalid'):self.validate(v)
    def test_bad_duration_or_late_cleanup(self):
        for key,value in (('expiresAt','2026-09-16T12:00:30Z'),('expiryObservedAt','2026-09-16T12:01:15Z'),('expiryObservedAt','2026-09-16T12:00:59Z')):
            v=copy.deepcopy(self.value);v[key]=value
            with self.assertRaisesRegex(RuntimeError,'timer_not_measured'):self.validate(v)
    def test_missing_cleanup(self):
        self.value['cleanup']['sessionStopped']=False
        with self.assertRaisesRegex(RuntimeError,'cleanup_failed'):self.validate(self.value)
    def test_stale_join_or_source(self):
        v=copy.deepcopy(self.value);v['expiredJoinStatus']=200
        with self.assertRaisesRegex(RuntimeError,'expiry_failed'):self.validate(v)
        self.value['sourceSha256']='0'*64
        with self.assertRaisesRegex(RuntimeError,'source_changed'):self.validate(self.value)
if __name__=='__main__':unittest.main()
