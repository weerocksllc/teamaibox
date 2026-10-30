"""Exercise the actual pure identity guards without camera/Android dependencies."""
import ast
import re
import unittest
import uuid
from pathlib import Path


class ProbeIdentity(unittest.TestCase):
    def guards(self):
        for name in ('probe_phone_stock_camera_successor.py','probe_phone_camera_cadence.py'):
            path=Path(__file__).parent/name
            tree=ast.parse(path.read_text())
            node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='validate_test_identity')
            scope={'re':re,'uuid':uuid}
            exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),scope)
            yield scope['validate_test_identity']

    def config(self,rid):
        return dict(phoneId=str(uuid.uuid5(uuid.NAMESPACE_URL,rid+':phoneId')),
                    runId=str(uuid.uuid5(uuid.NAMESPACE_URL,rid+':run')),instance=21)

    def test_bounded_old_and_lifecycle_runs(self):
        for guard in self.guards():
            for kind in ('video-hal','lifecycle-standard','lifecycle-google'):
                rid='phone-camera-'+kind+'-20260915-a1'
                guard(self.config(rid),rid)

    def test_reject_unowned_guests_and_names(self):
        rid='phone-camera-lifecycle-google-20260915-a1'
        for guard in self.guards():
            for invalid in ('phone-camera-lifecycle-google-20260915-a0',rid+'-extra',
                            'phone-camera-lifecycle-other-20260915-a1','office-worker','../'+rid):
                with self.assertRaises(AssertionError):guard(self.config(invalid),invalid)
            for key,value in (('phoneId',str(uuid.uuid4())),('runId',str(uuid.uuid4())),('instance',1)):
                config=self.config(rid);config[key]=value
                with self.assertRaises(AssertionError):guard(config,rid)


if __name__=='__main__':unittest.main()
