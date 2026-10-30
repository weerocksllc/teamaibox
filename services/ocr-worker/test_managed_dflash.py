import base64
import importlib.util
import pathlib
import signal
import subprocess
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ENGINE = load("managed_hunyuan_dflash_engine", "managed_dflash_engine.py")
WORKER = load("managed_hunyuan_dflash_worker", "managed_dflash_server.py")
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")


class ManagedDFlashTests(unittest.TestCase):
    def test_normalization_preserves_markdown_without_fabricating_layout(self):
        value = ENGINE.normalize_page("# 标题\n\n<table><tr><td>A</td></tr></table>\n\n$x^2$")
        pruned = value["prunedResult"]
        self.assertFalse(pruned["geometry_supported"])
        self.assertIsNone(pruned["width"])
        self.assertIsNone(pruned["height"])
        self.assertIsNone(pruned["parsing_res_list"][0]["block_bbox"])
        self.assertEqual(pruned["parsing_res_list"][0]["block_format"], "markdown")
        self.assertIn("<table>", value["markdown"]["text"])
        self.assertIn("$x^2$", value["markdown"]["text"])

    def test_media_validation_is_magic_bound_and_fails_closed(self):
        self.assertEqual(ENGINE.media_type(PNG, 1), ("image/png", ".png"))
        with self.assertRaises(ENGINE.RequestError):
            ENGINE.media_type(PNG, 0)
        with self.assertRaises(ENGINE.RequestError):
            ENGINE.media_type(b"not-an-image", 1)

    def test_worker_refuses_non_dflash_startup(self):
        with mock.patch.dict(WORKER.os.environ, {"INFERENCE_MODE": "vllm-ar"}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "refuses non-DFlash"):
                WORKER.main()

    def test_cancel_terminates_only_the_exact_active_job(self):
        supervisor = WORKER.EngineSupervisor()
        supervisor.active_job = "11111111-1111-4111-8111-111111111111"
        with mock.patch.object(supervisor, "_stop_locked") as stopped:
            self.assertFalse(supervisor.cancel("22222222-2222-4222-8222-222222222222"))
            self.assertTrue(supervisor.cancel("11111111-1111-4111-8111-111111111111"))
            stopped.assert_called_once()

    def test_unload_terminates_the_exact_engine_process_group(self):
        supervisor = WORKER.EngineSupervisor()
        process = mock.Mock(pid=4242)
        process.wait.return_value = 0
        supervisor.process = process
        supervisor.process_group_id = 4242
        with mock.patch.object(WORKER.os, "killpg", side_effect=[None, ProcessLookupError]) as killpg:
            supervisor.unload(force=True)
        killpg.assert_has_calls([
            mock.call(4242, signal.SIGTERM),
            mock.call(4242, 0),
        ])
        self.assertIsNone(supervisor.process)
        self.assertIsNone(supervisor.process_group_id)

    def test_unload_force_kills_a_process_group_that_ignores_sigterm(self):
        supervisor = WORKER.EngineSupervisor()
        process = mock.Mock(pid=4243)
        process.wait.side_effect = [subprocess.TimeoutExpired("engine", 10), 0]
        supervisor.process = process
        supervisor.process_group_id = 4243
        with mock.patch.object(WORKER.time, "monotonic", side_effect=[0, 21]), \
                mock.patch.object(WORKER.os, "killpg") as killpg:
            supervisor.unload(force=True)
        self.assertIn(mock.call(4243, signal.SIGKILL), killpg.call_args_list)


if __name__ == "__main__":
    unittest.main()
