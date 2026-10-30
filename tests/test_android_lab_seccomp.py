import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tools'))
from android_lab_guard import create_args
from build_android_lab_seccomp import extend, VSOCK_RULE


class SeccompTests(unittest.TestCase):
    def test_modified_parent_rejected(self):
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            extend(b'{"defaultAction":"SCMP_ACT_ALLOW"}')

    def test_unknown_allow_all_profile_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory)/'profile.json'
            profile.write_text('{"defaultAction":"SCMP_ACT_ALLOW"}')
            with self.assertRaisesRegex(ValueError, 'unapproved seccomp'):
                create_args('android-lab-test-20260911-a1', 'sha256:'+'a'*64, 1,
                            'sh', [], vsock_seccomp=str(profile))

    def test_only_vsock_rule(self):
        self.assertEqual(VSOCK_RULE, {'names':['socket'], 'action':'SCMP_ACT_ALLOW',
            'args':[{'index':0, 'value':40, 'op':'SCMP_CMP_EQ'}]})


if __name__ == '__main__':
    unittest.main()
