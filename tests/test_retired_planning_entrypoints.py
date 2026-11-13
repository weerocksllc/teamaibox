"""Retired planning tools cannot execute checks, even through Python imports."""

from contextlib import ExitStack
import hashlib
import importlib
import json
from pathlib import Path
import runpy
import sys
import tempfile
from types import ModuleType
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
CURRENT = (
    "current_supported_environment_v2_qualification",
    "current_supported_records_v3_qualification",
    "current_supported_records_v4_qualification",
)
RUNNERS = (*CURRENT, "airplay_compatible_source_readiness", "release_candidate_gate")
RETIRED = "Retired OpenSpec qualification runner"


class RetiredPlanningEntrypointTests(unittest.TestCase):
    def setUp(self):
        # These private historical helper modules are intentionally absent from
        # public source. Inert import stubs let us exercise the entry guards;
        # using a stubbed helper is itself a failure, not a qualification pass.
        baseline = ModuleType("tools.run_spark_model_baseline")
        baseline.canonical_digest = mock.Mock(side_effect=AssertionError("retired helper executed"))
        baseline.utc_now = mock.Mock(side_effect=AssertionError("retired helper executed"))
        spark = ModuleType("tools.spark_validation")
        spark.ROOT = ROOT
        previous = set(sys.modules)
        patcher = mock.patch.dict(sys.modules, {
            baseline.__name__: baseline, spark.__name__: spark,
        })
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(lambda: [sys.modules.pop(name, None) for name in set(sys.modules) - previous
                                 if name.startswith(("tools.run_current_supported_", "tools.validate_current_supported_"))])

    def no_execution(self):
        stack = ExitStack()
        for target in ("subprocess.run", "subprocess.Popen", "pathlib.Path.write_text",
                       "pathlib.Path.write_bytes", "pathlib.Path.mkdir"):
            stack.enter_context(mock.patch(target, side_effect=AssertionError("unexpected execution or write")))
        return stack

    def test_runner_cli_stops_before_checks_or_report_writes(self):
        for name in RUNNERS:
            with self.subTest(runner=name), self.no_execution():
                with self.assertRaisesRegex(SystemExit, RETIRED):
                    runpy.run_path(str(ROOT / "tools" / f"run_{name}.py"), run_name="__main__")

    def test_imported_run_functions_cannot_bypass_retirement(self):
        for name in RUNNERS:
            module = importlib.import_module(f"tools.run_{name}")
            calls = [("main", ())]
            if name in CURRENT:
                calls.append(("command", (("openspec", "validate"),)))
            elif name == "release_candidate_gate":
                calls.append(("run_command", (("openspec", "validate"), 10)))
            else:
                calls.extend((("strict_openspec", ()), ("readiness_checks", ()),
                              ("run", ("unused", Path("unused-report.json")))))
            for function, args in calls:
                with self.subTest(runner=name, function=function), self.no_execution():
                    with self.assertRaisesRegex(RuntimeError, RETIRED):
                        getattr(module, function)(*args)

    def test_validator_live_modes_refuse_before_reading_or_running(self):
        for name in (*CURRENT, "airplay_compatible_source_readiness"):
            module = importlib.import_module(f"tools.validate_{name}")
            flag = "live_commands" if name in CURRENT else "revalidate"
            with self.subTest(validator=name), self.no_execution():
                for options in ({}, {flag: True}):
                    with self.assertRaisesRegex(RuntimeError, RETIRED):
                        module.validate(Path("no-record-required.json"), **options)
                # The explicit historical reader is still available. An invalid
                # input remains rejected by its existing validation, not passed.
                with self.assertRaises((ValueError, RuntimeError)) as failure:
                    module.validate(Path("no-record-required.json"), **{flag: False})
                self.assertNotIn(RETIRED, str(failure.exception))
                with mock.patch.object(sys, "argv", ["validator", "--evidence", "unused.json"]):
                    with self.assertRaisesRegex(RuntimeError, RETIRED):
                        module.main()

    def test_pure_history_readers_and_digest_helpers_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix="retired-planning-unit-") as directory:
            source = Path(directory) / "record.json"
            value = {"matrixId": "synthetic", "runId": "synthetic", "value": 1}
            raw = json.dumps(value).encode()
            source.write_bytes(raw)
            expected = "sha256:" + hashlib.sha256(raw).hexdigest()
            with self.no_execution():
                for name in CURRENT:
                    module = importlib.import_module(f"tools.run_{name}")
                    with mock.patch.object(module, "ROOT", Path(directory)):
                        record, binding = module.artifact(source, "matrixId", "synthetic")
                    self.assertEqual(record, value)
                    self.assertEqual(binding["fileSha256"], expected)
                release = importlib.import_module("tools.run_release_candidate_gate")
                airplay = importlib.import_module("tools.run_airplay_compatible_source_readiness")
                self.assertEqual(release.digest_bytes(raw), expected)
                self.assertEqual(airplay.file_digest(source), expected)


if __name__ == "__main__":
    unittest.main()
