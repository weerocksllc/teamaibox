from __future__ import annotations

import json
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
ENDPOINT = ROOT / "tools/asr_network_measurement_endpoint.mjs"


class AsrNetworkMeasurementEndpointTests(unittest.TestCase):
    def test_loopback_client_measures_both_directions_and_latency(self):
        server = subprocess.Popen(
            ["node", str(ENDPOINT), "server", "127.0.0.1", "0"],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            assert server.stdout is not None
            ready = json.loads(server.stdout.readline())
            self.assertTrue(ready["ready"])
            completed = subprocess.run(
                ["node", str(ENDPOINT), "client", "127.0.0.1", str(ready["port"]), str(1024 * 1024), "2", "3"],
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=30,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            measured = json.loads(completed.stdout)
            self.assertEqual(measured["sampleBytes"], 1024 * 1024)
            self.assertEqual(measured["throughputSampleCount"], 2)
            self.assertEqual(measured["latencySampleCount"], 3)
            self.assertEqual(len(measured["samples"]["uploadBitsPerSecond"]), 2)
            self.assertEqual(len(measured["samples"]["downloadBitsPerSecond"]), 2)
            self.assertEqual(len(measured["samples"]["roundTripLatencyMilliseconds"]), 3)
            self.assertGreater(measured["uploadBitsPerSecondP25"], 0)
            self.assertGreater(measured["downloadBitsPerSecondP25"], 0)
            self.assertGreaterEqual(measured["roundTripLatencyMillisecondsP95"], 0)
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
            server.communicate(timeout=1)


if __name__ == "__main__":
    unittest.main()
