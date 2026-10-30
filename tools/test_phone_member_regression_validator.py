"""In-memory negative controls; never modify immutable deployment receipts."""
import json,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from tools.validate_phone_member_regression import ROOT,validate_record,sha

E=ROOT/'evidence/validation/virtual-phones'

class MemberEvidenceTests(unittest.TestCase):
    def record(self,name):
        path=E/(name+'.json')
        return json.loads(path.read_bytes()),path

    def rejected(self,name,change):
        record,path=self.record(name)
        if name=='phone-member-ui-observations-20260912-a4':
            # In-memory schema fixture only. The real old UI receipt must remain
            # rejected after the product UI changes; never rewrite that receipt.
            record['sources']={f:sha((ROOT/f).read_bytes()) for f in record['sources']}
        validate_record(record,path)
        change(record)
        with self.assertRaises((RuntimeError,KeyError,ValueError)):
            validate_record(record,path)

    def test_current_real_records(self):
        for name in ('phone-member-transfers-20260912-a2','phone-member-adb-20260912-a2',
                     'phone-member-denials-20260912-a1','phone-member-browser-20260912-a4',
                     'phone-peer-observation-20260912-a3',
                     'phone-member-lifecycle-20260912-a1'):
            with self.subTest(name=name):
                r,p=self.record(name);self.assertEqual(validate_record(r,p),name)

    def test_old_ui_is_not_current_product_acceptance(self):
        r,p=self.record('phone-member-ui-observations-20260912-a4')
        with self.assertRaisesRegex(RuntimeError,'bound_file_changed:apps/virtual-phones-plugin/src/public/app.js'):
            validate_record(r,p)

    def test_lifecycle_requires_a_node_deployment_parent(self):
        name='phone-member-lifecycle-20260912-a1'
        self.rejected(name,lambda r:r.update(parents={f:d for f,d in r['parents'].items() if 'phone-peer-node-' not in f}))

    def test_empty_bindings_and_changed_source(self):
        name='phone-member-transfers-20260912-a2'
        self.rejected(name,lambda r:r.update(sources={}))
        self.rejected(name,lambda r:r.update(parents={}))
        self.rejected(name,lambda r:r['sources'].update({'tools/qualify_phone_member_transfers.py':'0'*64}))

    def test_new_lifecycle_requires_foreign_phone_preservation(self):
        # Schema negative control only, not a replacement for the new live run.
        r,p=self.record('phone-member-lifecycle-20260912-a1')
        name='tools/qualify_phone_member_lifecycle_v2.py'
        r['sources'][name]=sha((ROOT/name).read_bytes())
        with self.assertRaisesRegex(RuntimeError,'other_user_phone_changed'):
            validate_record(r,p)
        r['foreignBefore']=[{'id':'synthetic-other-phone','state':'stopped'}]
        r['foreignAfter']=[dict(r['foreignBefore'][0])]
        validate_record(r,p)
        r['foreignAfter'][0]['state']='running'
        with self.assertRaisesRegex(RuntimeError,'other_user_phone_changed'):
            validate_record(r,p)

    def test_failed_or_expanded_claim(self):
        name='phone-member-lifecycle-20260912-a1'
        for change in (lambda r:r.update(status='failed'),lambda r:r.update(cleanupFailures=['failed']),
                       lambda r:r.update(releaseAccepted=True),lambda r:r.update(hostRebooted=True)):
            self.rejected(name,change)

    def test_cycle_count_generation_and_data(self):
        name='phone-member-lifecycle-20260912-a1'
        for change in (lambda r:r['cycles'].pop(),lambda r:r['cycles'][3].update(generation=3),
                       lambda r:r['cycles'][3].update(appDataVerified=False),
                       lambda r:r['cycles'][3]['run'].update(cleanShutdown=False),
                       lambda r:r.update(phoneDeleted=False)):
            self.rejected(name,change)

    def test_cannot_infer_adb_revocation_from_wss_alone(self):
        name='phone-member-adb-20260912-a2'
        self.rejected(name,lambda r:r['checks'][0].update(actualAdbRejectedAfterClose=False))
        self.rejected(name,lambda r:r['checks'][0].update(closeSeconds=11))

    def test_browser_cannot_claim_unmeasured_playback(self):
        name='phone-member-ui-observations-20260912-a4'
        self.rejected(name,lambda r:r.update(tenMinuteContinuousPlaybackAccepted=True))
        self.rejected(name,lambda r:r['reloads'][0].update(ready=0))

    def test_exact_path_required(self):
        r,p=self.record('phone-member-lifecycle-20260912-a1')
        with self.assertRaises(RuntimeError):validate_record(r,p.with_name('different.json'))

if __name__=='__main__':unittest.main()
