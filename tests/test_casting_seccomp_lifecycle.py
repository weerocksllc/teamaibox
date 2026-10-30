"""Guard the actual ARM64 discovery directory lifecycle, not only HTTP health."""
import json
from pathlib import Path
import unittest


class CastingSeccompLifecycleTests(unittest.TestCase):
    def test_private_discovery_filesystem_operations_remain_available(self):
        root = Path(__file__).resolve().parents[1]
        profile = json.loads((root / 'deploy/casting/trusted-media-seccomp.v1.json').read_text())
        allowed = {name for rule in profile['syscalls'] if rule['action'] == 'SCMP_ACT_ALLOW'
                   for name in rule['names']}
        # AArch64 Path.mkdir/rmdir and config-file creation/removal use these.
        self.assertTrue({'mkdirat', 'unlinkat', 'openat', 'write', 'close', 'setsid'} <= allowed)
        self.assertEqual(profile['defaultAction'], 'SCMP_ACT_ERRNO')
        self.assertEqual(profile['architectures'], ['SCMP_ARCH_AARCH64'])
        self.assertFalse({'mount', 'ptrace', 'bpf', 'kexec_load', 'reboot'} & allowed)


if __name__ == '__main__':
    unittest.main()
