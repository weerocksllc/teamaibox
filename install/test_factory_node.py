import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from factory_node import inventory, casting_capacity, CASTING_ELEMENTS
from offline_common import InstallError


class NodeFactoryTests(unittest.TestCase):
    def test_casting_software_slots_require_exact_offline_image_elements(self):
        calls = []
        def runner(args):
            calls.append(args)
            return json.dumps({name: True for name in CASTING_ELEMENTS})
        value = casting_capacity('sha256:' + 'a' * 64, runner)
        self.assertEqual((value['encodeSessions'], value['decodeSessions']), (1, 1))
        self.assertIn('--network', calls[0]); self.assertIn('none', calls[0])
        self.assertIn('--pull', calls[0]); self.assertIn('never', calls[0])
        with self.assertRaisesRegex(InstallError, 'pipeline is incomplete'):
            casting_capacity('sha256:' + 'a' * 64, lambda _: json.dumps({name: name != 'vp8enc' for name in CASTING_ELEMENTS}))

    def fixture(self, root):
        proc, net = root / 'proc', root / 'net'
        proc.mkdir(); net.mkdir()
        (proc / 'meminfo').write_text('MemTotal: 134217728 kB\nMemAvailable: 100663296 kB\n')
        for name, physical, speed in [('enp1s0', True, '10000'), ('docker0', False, '10000'), ('wlan0', True, 'unknown')]:
            device = net / name
            device.mkdir()
            if physical:
                (device / 'device').mkdir()
            (device / 'speed').write_text(speed)
            (device / 'mtu').write_text('1500')
            (device / 'operstate').write_text('up')
        return dict(proc=proc, sys_net=net, cpu_count=20, agent_version='1.0.0',
                    stats=SimpleNamespace(f_bavail=10000, f_frsize=4096, f_fsid=42),
                    runner=lambda args: 'NVIDIA GB10, 12.1\n')

    def test_observed_capacity_and_no_invented_worker_readiness(self):
        with tempfile.TemporaryDirectory() as path:
            value = inventory(Path(path), **self.fixture(Path(path)))
        self.assertEqual(value['resources']['cpu']['totalMillis'], 20000)
        self.assertEqual(value['resources']['unifiedMemory']['totalBytes'], 128 * 1024**3)
        self.assertEqual(value['resources']['network']['availableBitsPerSecond'], 10_000_000_000)
        self.assertEqual([link['linkKey'] for link in value['networkLinks']], ['enp1s0'])
        self.assertEqual(value['schedulerFacts']['workerState'], 'cold')
        self.assertFalse(value['schedulerFacts']['modelArtifactCached'])
        self.assertEqual(value['modelProfiles'], [])
        self.assertEqual(value['capabilities'], [])
        self.assertNotIn('192.168.', json.dumps(value))

    def test_refuses_unknown_or_multiple_gpu_instead_of_copying_host_facts(self):
        with tempfile.TemporaryDirectory() as path:
            args = self.fixture(Path(path))
            for output in ('NVIDIA Other, 9.0', 'NVIDIA GB10, 12.1\nNVIDIA GB10, 12.1'):
                with self.subTest(output=output), self.assertRaises(InstallError):
                    inventory(Path(path), **{**args, 'runner': lambda _: output})

    def test_spark_uppercase_pci_interface_keeps_real_network_capacity(self):
        with tempfile.TemporaryDirectory() as path:
            args = self.fixture(Path(path))
            (args['sys_net'] / 'enp1s0').rename(args['sys_net'] / 'enP7s7')
            value = inventory(Path(path), **args)
        self.assertEqual(value['resources']['network']['availableBitsPerSecond'], 10_000_000_000)
        self.assertEqual(value['networkLinks'][0]['linkKey'], 'enp7s7')


if __name__ == '__main__':
    unittest.main()
