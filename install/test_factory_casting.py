import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from bootstrap_casting_service import runtime_identity


class FactoryCastingTests(unittest.TestCase):
    def test_generated_identity_has_no_resource_budget(self):
        config = runtime_identity(dict(nodeId='12345678-1234-4234-8234-123456789abc',
            nodeGeneration=1, protectedSetId='factory-office-test'))
        self.assertEqual(set(config), {'schemaVersion','nodeId','nodeGeneration'})
        script = """
import {normalizeCastingRuntimeIdentity} from './apps/platform-api/server/casting-session-runtime.mjs';
let raw='';for await(const c of process.stdin)raw+=c;
normalizeCastingRuntimeIdentity(JSON.parse(raw));
"""
        result = subprocess.run(['node','--input-type=module','-e',script], cwd=ROOT,
                                input=json.dumps(config), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
