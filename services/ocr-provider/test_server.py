import base64
import importlib.util
import json
import pathlib
import sys
import threading
import unittest


SPEC = importlib.util.spec_from_file_location("ocr_provider_server", pathlib.Path(__file__).with_name("server.py"))
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
JOB = "11111111-1111-4111-8111-111111111111"
INPUT = "22222222-2222-4222-8222-222222222222"
TASK = "33333333-3333-4333-8333-333333333333"
OUTPUT = "44444444-4444-4444-8444-444444444444"


def configuration():
    return MODULE.Configuration(
        bind_host="127.0.0.1", port=19094, certificate_file="unused", private_key_file="unused", ca_file="unused",
        token=b"x" * 32, docfarm_url="http://127.0.0.1:9200/docfarm/api/v1", request_timeout_seconds=30,
        poll_interval_seconds=0.1, model_revision="01b3ec869d704307645d2d8667f01c5bec6fef6d",
        worker_image_digest=f"sha256:{'a' * 64}",
    )


class FakeDocFarm:
    def __init__(self):
        self.calls = []
        self.upload_digest = None

    def ready(self):
        return True

    def upload(self, content, media_type, extension, job_id):
        self.calls.append(("upload", media_type, extension, job_id))
        self.upload_digest = __import__("hashlib").sha256(content).hexdigest()
        return INPUT

    def create_task(self, input_file_id, job_id):
        self.calls.append(("create", input_file_id, job_id))
        return TASK

    def await_task(self, task_id, deadline):
        self.calls.append(("await", task_id, deadline > 0))
        return {"id": task_id, "status": "completed", "output_file_id": OUTPUT}

    def download_file(self, file_id):
        self.calls.append(("download", file_id))
        return json.dumps({
            "modelName": "tencent/HunyuanOCR", "inferenceMode": "vllm-dflash", "backendVersion": "test",
            "durationMs": 638, "source": "/private/path/must-not-escape", "markdown": "# 团队 AI 盒子\n\n真实识别",
        }).encode()

    def cancel_task(self, task_id):
        self.calls.append(("cancel", task_id))
        return True

    def delete_file(self, file_id):
        self.calls.append(("delete_file", file_id))
        return True

    def delete_task(self, task_id):
        self.calls.append(("delete_task", task_id))
        return True


class OCRProviderTests(unittest.TestCase):
    def test_real_adapter_shape_is_markdown_only_and_cleans_every_owned_identity(self):
        docfarm = FakeDocFarm()
        application = MODULE.ProviderApplication(configuration(), docfarm)
        result = application.recognize({
            "model": MODULE.MODEL_NAME, "job_id": JOB, "file": base64.b64encode(PNG).decode(), "fileType": 1,
            "useLayoutDetection": True, "formatBlockContent": True, "layoutShapeMode": "rect",
            "returnMarkdownImages": False, "visualize": False, "language_hints": ["zh-CN"],
        })
        self.assertEqual(result["errorCode"], 0)
        page = result["result"]["layoutParsingResults"][0]["prunedResult"]
        self.assertFalse(page["geometry_supported"])
        self.assertIsNone(page["width"])
        self.assertIsNone(page["parsing_res_list"][0]["block_bbox"])
        self.assertEqual(result["x_teamaibox"]["model_revision"], configuration().model_revision)
        self.assertNotIn("source", json.dumps(result))
        self.assertEqual(docfarm.upload_digest, __import__("hashlib").sha256(PNG).hexdigest())
        self.assertEqual(docfarm.calls[-3:], [
            ("delete_task", TASK), ("delete_file", OUTPUT), ("delete_file", INPUT),
        ])

    def test_invalid_media_is_rejected_before_any_upstream_call(self):
        docfarm = FakeDocFarm()
        application = MODULE.ProviderApplication(configuration(), docfarm)
        with self.assertRaisesRegex(MODULE.ProviderError, "does not match") as caught:
            application.recognize({"model": MODULE.MODEL_NAME, "job_id": JOB,
                                   "file": base64.b64encode(b"not-an-image").decode(), "fileType": 1})
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(docfarm.calls, [])

    def test_cancel_maps_only_the_exact_active_job(self):
        docfarm = FakeDocFarm()
        application = MODULE.ProviderApplication(configuration(), docfarm)
        application._active[JOB] = TASK
        self.assertEqual(application.cancel(JOB), {"job_id": JOB, "cancellation_requested": True, "active": True})
        self.assertEqual(docfarm.calls, [("cancel", TASK)])
        self.assertEqual(application.cancel("55555555-5555-4555-8555-555555555555")["active"], False)

    def test_single_capacity_lane_fails_closed_without_upstream_dispatch(self):
        docfarm = FakeDocFarm()
        application = MODULE.ProviderApplication(configuration(), docfarm)
        self.assertTrue(application._capacity.acquire(blocking=False))
        try:
            with self.assertRaises(MODULE.ProviderError) as caught:
                application.recognize({"model": MODULE.MODEL_NAME, "job_id": JOB,
                                       "file": base64.b64encode(PNG).decode(), "fileType": 1})
            self.assertEqual(caught.exception.status, 429)
            self.assertEqual(docfarm.calls, [])
        finally:
            application._capacity.release()


if __name__ == "__main__":
    unittest.main()
