import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import model_fault_probe as probe  # noqa: E402


class FakeModelHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        pass

    def _send(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == "/health":
            self._send(200, b"ok", "text/plain")
            return
        if self.path == "/metrics":
            self._send(200, b"vllm:num_requests_running 0\nvllm:num_requests_waiting 0\n", "text/plain")
            return
        self._send(404, b"{}")

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        try:
            document = json.loads(raw)
        except json.JSONDecodeError:
            self._send(400, b'{"error":{"message":"invalid"}}')
            return
        if not isinstance(document.get("messages"), list):
            self._send(400, b'{"error":{"message":"invalid"}}')
            return
        prompt = document["messages"][-1].get("content", "")
        if document.get("stream"):
            if prompt.startswith("Write a long"):
                time.sleep(0.05)
            body = b'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n'
            self._send(200, body, "text/event-stream")
            return
        content = probe.INTEGRITY_MARKER if prompt.startswith("Return only") else "OK"
        prompt_tokens = 20_001 if prompt.startswith("Independent request") else 8
        body = json.dumps({
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": 1},
        }, separators=(",", ":")).encode()
        self._send(200, body)


class ModelFaultProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeModelHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_integrity_and_openai_error_shape(self):
        value = probe.integrity(self.base_url, "model-a")
        self.assertTrue(value["passed"])
        self.assertRegex(value["contentDigest"], r"^sha256:[a-f0-9]{64}$")
        malformed = probe.malformed_inputs(self.base_url, "model-a")
        self.assertEqual([case["status"] for case in malformed["cases"]], [400, 400])

    def test_timeout_and_cancel_drain_without_worker_failure(self):
        self.assertEqual(probe.timeout_request(self.base_url, "model-a")["classification"], "client_timeout")
        self.assertTrue(probe.cancel_stream(self.base_url, "model-a")["passed"])

    def test_bounded_concurrent_cache_pressure(self):
        value = probe.cache_pressure(self.base_url, "model-a")
        self.assertEqual(value["concurrency"], 2)
        self.assertEqual(value["minimumPromptTokens"], 20_001)

    def test_missing_drain_metrics_fail_closed(self):
        original = probe.urllib.request.urlopen
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def read(self, _size): return b"unrelated_metric 0\n"
        probe.urllib.request.urlopen = lambda *_args, **_kwargs: Response()
        try:
            with self.assertRaisesRegex(probe.FaultProbeError, "aggregate metric"):
                probe.metrics(self.base_url)
        finally:
            probe.urllib.request.urlopen = original

    def test_host_memory_sampler_reports_only_aggregate_available_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "meminfo").write_text("MemTotal: 1024 kB\nMemAvailable: 768 kB\n", encoding="utf-8")
            with probe.HostMemorySampler(root, interval_seconds=0.01) as sampler:
                time.sleep(0.02)
            self.assertEqual(sampler.summary()["minimumHostAvailableMemoryBytes"], 768 * 1024)


if __name__ == "__main__":
    unittest.main()
