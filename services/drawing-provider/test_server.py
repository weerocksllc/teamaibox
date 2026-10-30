import importlib.util
import pathlib
import sys
import unittest
import io
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("drawing_provider", pathlib.Path(__file__).with_name("server.py"))
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FakeWorker:
    def __init__(self):
        self.calls = []

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        if path == "/health":
            return 200, {"accepting": True, "loaded": False, "model": MODULE.MODEL}
        if path == "/v1/models/prepare":
            return 200, {"status": "ready", "loaded": True, "model": MODULE.MODEL}
        if path == "/v1/models/unload":
            return 200, {"status": "unloaded", "loaded": False, "model": MODULE.MODEL}
        return 200, {"created": 1, "data": [{"b64_json": "aW1hZ2U="}], "x_teamaibox": {
            "seed": body["x_teamaibox"]["seed"], "steps": body["x_teamaibox"]["steps"],
            "guidance_scale": body["x_teamaibox"]["guidance_scale"], "width": 512, "height": 512,
            "output_format": "png", "preset_key": body["x_teamaibox"]["preset_key"],
        }}


def config():
    return MODULE.Configuration("0.0.0.0", 19095, "cert", "key", "ca", b"x" * 32,
                                "127.0.0.1", 19096, 1800, "sha256:" + "a" * 64, "revision")


class DrawingProviderTest(unittest.TestCase):
    def test_long_prompt_is_not_cut_off_by_adapter(self):
        worker = FakeWorker()
        prompt = 'x' * 32001
        MODULE.Application(config(), worker).execute('/images/generations', {'model': MODULE.MODEL, 'prompt': prompt})
        self.assertEqual(worker.calls[-1][2]['prompt'], prompt)

    def test_request_uses_available_memory_not_fixed_file_limit(self):
        handler = object.__new__(MODULE.Handler)
        handler.headers = {'Content-Length': str(97 * 1024**2)}
        class VirtualBody:
            def read(self, amount):
                self.amount = amount
                # Avoid an unnecessary 97 MiB test allocation; a JSON error
                # proves admission reached the reader, rather than size denial.
                raise LookupError('admitted')
        handler.rfile = VirtualBody()
        with patch.object(MODULE, 'buffered_bytes', return_value=128 * 1024**2):
            with self.assertRaisesRegex(LookupError, 'admitted'):
                handler.read_json()
        self.assertEqual(handler.rfile.amount, 97 * 1024**2)
        with patch.object(MODULE, 'buffered_bytes', return_value=10):
            with self.assertRaisesRegex(MODULE.ProviderError, 'available memory'):
                handler.read_json()

    def test_small_valid_request_and_framing(self):
        handler = object.__new__(MODULE.Handler)
        handler.headers = {'Content-Length': '2'}
        handler.rfile = io.BytesIO(b'{}')
        with patch.object(MODULE, 'buffered_bytes', return_value=100):
            self.assertEqual(handler.read_json(), {})
            handler.rfile = io.BytesIO(b'{')
            with self.assertRaisesRegex(MODULE.ProviderError, 'incomplete'):
                handler.read_json()

    def test_served_model_has_a_safe_default(self):
        self.assertEqual(MODULE.MODEL, "sdxl-base-1.0-fp16")
        self.assertEqual(MODULE.OPERATIONS, ("images.generations", "images.edits"))

    def test_contract_probe_is_normalized(self):
        worker = FakeWorker()
        status, value = MODULE.Application(config(), worker).execute("/images/generations", {
            "model": MODULE.MODEL, "prompt": "A solid blue square", "n": 1, "size": "256x256",
        })
        self.assertEqual(status, 200)
        request = worker.calls[0][2]
        self.assertEqual(request["size"], "512x512")
        self.assertEqual(request["response_format"], "b64_json")
        self.assertRegex(request["x_teamaibox"]["job_id"], MODULE.UUID_RE)
        self.assertEqual(value["x_teamaibox"]["width"], 512)

    def test_invalid_model_and_prompt_fail_before_worker(self):
        worker = FakeWorker()
        application = MODULE.Application(config(), worker)
        with self.assertRaises(MODULE.ProviderError):
            application.execute("/images/generations", {"model": "wrong", "prompt": "x"})
        with self.assertRaises(MODULE.ProviderError):
            application.execute("/images/generations", {"model": MODULE.MODEL, "prompt": ""})
        self.assertEqual(worker.calls, [])

    def test_capacity_fails_closed(self):
        worker = FakeWorker()
        application = MODULE.Application(config(), worker)
        application.capacity.acquire()
        with self.assertRaisesRegex(MODULE.ProviderError, "busy"):
            application.execute("/images/generations", {"model": MODULE.MODEL, "prompt": "x"})

    def test_generation_only_profile_rejects_edit_before_worker(self):
        worker = FakeWorker()
        previous = MODULE.OPERATIONS
        MODULE.OPERATIONS = ("images.generations",)
        try:
            application = MODULE.Application(config(), worker)
            self.assertEqual(application.models()["data"][0]["x_teamaibox"]["operations"],
                             ["images.generations"])
            with self.assertRaisesRegex(MODULE.ProviderError, "unsupported"):
                application.execute("/images/edits", {"model": MODULE.MODEL, "prompt": "x"})
            self.assertEqual(worker.calls, [])
        finally:
            MODULE.OPERATIONS = previous

    def test_profile_specific_defaults_are_forwarded(self):
        worker = FakeWorker()
        previous_steps = MODULE.DEFAULT_STEPS
        previous_guidance = MODULE.DEFAULT_GUIDANCE_SCALE
        MODULE.DEFAULT_STEPS = 50
        MODULE.DEFAULT_GUIDANCE_SCALE = 4.0
        try:
            status, _ = MODULE.Application(config(), worker).execute("/images/generations", {
                "model": MODULE.MODEL, "prompt": "bounded defaults",
            })
            self.assertEqual(status, 200)
            request = worker.calls[-1][2]
            self.assertEqual(request["x_teamaibox"]["steps"], 50)
            self.assertEqual(request["x_teamaibox"]["guidance_scale"], 4.0)
        finally:
            MODULE.DEFAULT_STEPS = previous_steps
            MODULE.DEFAULT_GUIDANCE_SCALE = previous_guidance

    def test_authenticated_model_control_contract_preserves_residency_facts(self):
        worker = FakeWorker()
        application = MODULE.Application(config(), worker)
        status, observed = application.model_status()
        self.assertEqual((status, observed["loaded"]), (200, False))
        status, prepared = application.control_model("prepare", {"model": MODULE.MODEL})
        self.assertEqual((status, prepared["status"], prepared["loaded"]), (200, "ready", True))
        status, unloaded = application.control_model("unload", {"model": MODULE.MODEL})
        self.assertEqual((status, unloaded["status"], unloaded["loaded"]), (200, "unloaded", False))
        self.assertEqual([call[1] for call in worker.calls], ["/health", "/v1/models/prepare", "/v1/models/unload"])

    def test_model_control_rejects_wrong_model_before_worker(self):
        worker = FakeWorker()
        application = MODULE.Application(config(), worker)
        with self.assertRaises(MODULE.ProviderError):
            application.control_model("prepare", {"model": "wrong"})
        self.assertEqual(worker.calls, [])


if __name__ == "__main__":
    unittest.main()
