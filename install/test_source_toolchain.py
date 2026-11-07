"""Exercise the build boundary without installing tools on the test host."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from offline_common import read_json
from source_toolchain import prepare


class ToolchainTests(unittest.TestCase):
    def test_prepare_runs_android_sdk_in_a_pinned_build_container(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve()
            repo=root/'source'
            (repo/'install/images').mkdir(parents=True)
            cache=root/'cache'
            cache.mkdir()
            output=root/'output'
            image='sha256:'+'a'*64
            calls=[]
            observed=json.dumps([{'Id':image,'Architecture':'arm64','Os':'linux'}])
            with patch('source_toolchain.subprocess.check_output',side_effect=[observed,'fixture-container']):
                prepare(output,cache,calls.append,repo,'fixture:android')
            self.assertTrue(all(call[0]=='docker' for call in calls))
            self.assertEqual(read_json(output/'tools.json')['androidImage'],image)
            self.assertEqual(calls[-1][-7:],[image,'python3','/src/install/source_toolchain.py',
                '--sdk-output','/out','--cache','/cache'])
            self.assertIn('--read-only',calls[-1])
            self.assertIn('type=bind,src='+str(cache/'android-sdk-downloads')+',dst=/cache',calls[-1])
