import json
import os
import socket
import subprocess
import time
import unittest
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ModelCoexistenceWorkerTests(unittest.TestCase):
    def test_worker_touches_memory_and_returns_only_deterministic_metadata(self):
        port = free_port()
        source = (ROOT / "tools/model_coexistence_worker.mjs").read_text(encoding="utf-8")
        source = source.replace('server.listen(8080, "0.0.0.0"', f'server.listen({port}, "127.0.0.1"')
        process = subprocess.Popen(
            ["node", "--input-type=module", "--eval", source],
            cwd=ROOT,
            env={**os.environ, "CAPABILITY": "ocr", "MEMORY_TOUCH_BYTES": str(16 * 1024**2), "CPU_STRESS_WORKERS": "0"},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health/ready", timeout=1) as response:
                        health = json.load(response)
                    break
                except OSError:
                    if process.poll() is not None:
                        self.fail(process.stderr.read())
                    time.sleep(0.05)
            else:
                self.fail("coexistence worker did not become ready")
            self.assertTrue(health["ready"])
            self.assertEqual(health["memoryTouchBytes"], 16 * 1024**2)
            request = urllib.request.Request(f"http://127.0.0.1:{port}/work", method="POST", data=b"")
            with urllib.request.urlopen(request, timeout=2) as response:
                result = json.load(response)
            self.assertEqual(result["capability"], "ocr")
            self.assertEqual(result["sequence"], 1)
            self.assertRegex(result["resultDigest"], r"^sha256:[0-9a-f]{64}$")
            self.assertNotIn("prompt", result)
            self.assertNotIn("output", result)
        finally:
            process.terminate()
            process.communicate(timeout=10)


if __name__ == "__main__":
    unittest.main()
