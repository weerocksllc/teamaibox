import importlib.util
import os
import pathlib
import sys
import tempfile
import http.client
import hashlib
import json
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("managed_ocr_provider", pathlib.Path(__file__).with_name("managed_server.py"))
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FakeWorker:
    def __init__(self):
        self.calls = []

    def request(self, method, path, value=None, timeout=None):
        self.calls.append((method, path, value, timeout))
        if path == "/health":
            return 200, {"accepting": True, "model": MODULE.MODEL, "loaded": False,
                         "inference_mode": "vllm-dflash"}
        if path.endswith("prepare"):
            return 200, {"status": "ready", "model": MODULE.MODEL, "loaded": True}
        if path.endswith("unload"):
            return 200, {"status": "unloaded", "model": MODULE.MODEL, "loaded": False}
        if path.endswith("cancel"):
            return 200, {"cancelled": True, "job_id": path.split("/")[-2]}
        return 200, {"errorCode": 0, "result": {"layoutParsingResults": []}}


def configuration():
    return MODULE.Configuration(
        bind_host="127.0.0.1", port=19095, certificate_file="unused", private_key_file="unused",
        ca_file="unused", token=b"x" * 32, worker_host="127.0.0.1", worker_port=8000,
        timeout_seconds=30, worker_image_digest="sha256:" + "a" * 64,
        model_revision="01b3ec869d704307645d2d8667f01c5bec6fef6d",
        dflash_digest="sha256:" + "b" * 64,
    )


class ManagedProviderTests(unittest.TestCase):
    def test_real_http_relays_over_64_mib_with_bounded_reads_and_no_json_buffer(self):
        digest=hashlib.sha256();chunk=b'x'*65536;count=1120
        for _ in range(count):digest.update(chunk)
        expected=digest.hexdigest()
        class Engine(BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_POST(self):
                left=int(self.headers['Content-Length']);h=hashlib.sha256()
                while left:
                    data=self.rfile.read(min(left,65536));h.update(data);left-=len(data)
                raw=json.dumps({'digest':h.hexdigest()}).encode()
                self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        upstream=ThreadingHTTPServer(('127.0.0.1',0),Engine)
        class StreamingHandler(MODULE.Handler):
            def read_json(self):raise AssertionError('OCR files must not be buffered in the provider')
        provider=ThreadingHTTPServer(('127.0.0.1',0),StreamingHandler)
        provider.application=MODULE.Application(replace(configuration(),worker_port=upstream.server_port),None)
        threads=[threading.Thread(target=s.serve_forever,daemon=True) for s in (upstream,provider)]
        for t in threads:t.start()
        client=http.client.HTTPConnection('127.0.0.1',provider.server_port,timeout=10)
        try:
            with mock.patch.object(MODULE,'request_budget',return_value=16):
                client.putrequest('POST','/v1/ocr');client.putheader('Authorization','Bearer '+'x'*32)
                client.putheader('Content-Type','application/json');client.putheader('Content-Length',str(len(chunk)*count));client.endheaders()
                for _ in range(count):client.send(chunk)
                response=client.getresponse();self.assertEqual(response.status,200);self.assertEqual(json.loads(response.read())['digest'],expected)
        finally:
            client.close()
            for s in (provider,upstream):s.shutdown();s.server_close()
            for t in threads:t.join(timeout=2)

    def test_disclosure_is_managed_dflash_and_truthful_about_geometry(self):
        app = MODULE.Application(configuration(), FakeWorker())
        model = app.models()["data"][0]
        self.assertEqual(model["x_teamaibox"]["execution_kind"], "managed_node")
        self.assertEqual(model["x_teamaibox"]["inference_mode"], "vllm-dflash")
        self.assertFalse(model["x_teamaibox"]["geometry_supported"])

    def test_status_and_control_preserve_exact_model(self):
        worker = FakeWorker()
        app = MODULE.Application(configuration(), worker)
        self.assertEqual(app.status()[0], 200)
        self.assertTrue(app.control("prepare", {"model": MODULE.MODEL})[1]["loaded"])
        self.assertFalse(app.control("unload", {"model": MODULE.MODEL})[1]["loaded"])

    def test_invalid_model_is_rejected_before_worker_dispatch(self):
        worker = FakeWorker()
        app = MODULE.Application(configuration(), worker)
        with self.assertRaises(MODULE.ProviderError):
            app.recognize({"model": "not-the-profile"})
        self.assertEqual(worker.calls, [])


class ManagedProviderConfigurationTests(unittest.TestCase):
    MANAGED_HOST = "teamaibox-worker-b3ea0138-4acf-5840-ad1d-5b698cc89cf5"

    def environment(self, token_file, worker_url="http://127.0.0.1:8000", allowed_host=None):
        value = {
            "OCR_MANAGED_PROVIDER_TOKEN_FILE": token_file,
            "OCR_MANAGED_PROVIDER_WORKER_URL": worker_url,
            "OCR_MANAGED_PROVIDER_WORKER_IMAGE_DIGEST": "sha256:" + "a" * 64,
            "OCR_MANAGED_PROVIDER_MODEL_REVISION": "01b3ec869d704307645d2d8667f01c5bec6fef6d",
            "OCR_MANAGED_PROVIDER_DFLASH_DIGEST": "sha256:" + "b" * 64,
            "OCR_MANAGED_PROVIDER_TLS_CERT_FILE": "/run/secrets/server.crt",
            "OCR_MANAGED_PROVIDER_TLS_KEY_FILE": "/run/secrets/server.key",
            "OCR_MANAGED_PROVIDER_CA_FILE": "/run/secrets/ca.crt",
        }
        if allowed_host is not None:
            value["OCR_MANAGED_PROVIDER_ALLOWED_WORKER_HOST"] = allowed_host
        return value

    def configured(self, worker_url="http://127.0.0.1:8000", allowed_host=None):
        with tempfile.NamedTemporaryFile() as token:
            token.write(b"x" * 32)
            token.flush()
            with mock.patch.dict(
                os.environ,
                self.environment(token.name, worker_url=worker_url, allowed_host=allowed_host),
                clear=True,
            ):
                return MODULE.configuration()

    def test_loopback_workers_remain_allowed_without_an_explicit_allowlist(self):
        expected_endpoints = {
            "http://127.0.0.1:8000": ("127.0.0.1", 8000),
            "http://localhost:8000": ("localhost", 8000),
            "http://[::1]:8000": ("::1", 8000),
        }
        for worker_url, expected in expected_endpoints.items():
            with self.subTest(worker_url=worker_url):
                value = self.configured(worker_url=worker_url)
                self.assertEqual((value.worker_host, value.worker_port), expected)

    def test_exact_managed_worker_host_requires_and_accepts_explicit_allowlist(self):
        worker_url = f"http://{self.MANAGED_HOST}:8000"
        with self.assertRaisesRegex(ValueError, "managed OCR Worker URL is invalid"):
            self.configured(worker_url=worker_url)
        value = self.configured(worker_url=worker_url, allowed_host=self.MANAGED_HOST)
        self.assertEqual((value.worker_host, value.worker_port), (self.MANAGED_HOST, 8000))

    def test_worker_url_rejects_credentials_query_fragment_path_and_other_ports(self):
        invalid_urls = (
            "http://user@127.0.0.1:8000",
            "http://user:password@127.0.0.1:8000",
            "http://127.0.0.1:8000?mode=dflash",
            "http://127.0.0.1:8000#worker",
            "http://127.0.0.1:8000/",
            "http://127.0.0.1:8000/health",
            "http://127.0.0.1:8001",
            "http://127.0.0.1",
            "https://127.0.0.1:8000",
        )
        for worker_url in invalid_urls:
            with self.subTest(worker_url=worker_url):
                with self.assertRaisesRegex(ValueError, "managed OCR Worker URL is invalid"):
                    self.configured(worker_url=worker_url)

    def test_worker_url_rejects_unlisted_or_different_managed_hosts(self):
        other_host = "teamaibox-worker-4ac86c89-ef71-5fe5-8a6a-0e8979fff66d"
        invalid_urls = (
            "http://worker:8000",
            "http://10.64.0.20:8000",
            f"http://{other_host}:8000",
        )
        for worker_url in invalid_urls:
            with self.subTest(worker_url=worker_url):
                with self.assertRaisesRegex(ValueError, "managed OCR Worker URL is invalid"):
                    self.configured(worker_url=worker_url, allowed_host=self.MANAGED_HOST)

    def test_managed_worker_host_allowlist_must_be_one_canonical_container_name(self):
        invalid_hosts = (
            "",
            "worker",
            "teamaibox-worker-*",
            "TEAMAIBOX-WORKER-b3ea0138-4acf-5840-ad1d-5b698cc89cf5",
            "teamaibox-worker-b3ea0138-4acf-5840-ad1d-5b698cc89cf5.example",
            "teamaibox-worker-b3ea0138-4acf-5840-ad1d-5b698cc89cf5,localhost",
        )
        for allowed_host in invalid_hosts:
            with self.subTest(allowed_host=allowed_host):
                with self.assertRaisesRegex(ValueError, "managed OCR Worker host allowlist is invalid"):
                    self.configured(allowed_host=allowed_host)


if __name__ == "__main__":
    unittest.main()
