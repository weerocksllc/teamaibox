import unittest
import inspect
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

from tools import run_spark_model_coexistence as runner


class RunSparkModelCoexistenceTests(unittest.TestCase):
    def test_runner_remains_compatible_with_the_workstation_python(self):
        self.assertNotIn("strict=True", inspect.getsource(runner.prepare_remote))

    def test_remote_source_material_covers_the_probe_worker_and_core_objective(self):
        material = runner.remote_source_material()
        self.assertIn("tools/model_coexistence_probe.mjs", material)
        self.assertIn("tools/model_coexistence_worker.mjs", material)
        self.assertIn("deploy/compose/core-service-objective.mjs", material)
        self.assertIn("apps/platform-api/src/identity/repository-error.mjs", material)
        self.assertIn("services/object-service/src/buffered-media-budget.mjs", material)
        self.assertGreater(len(material), 20)

    def test_remote_source_material_is_closed_over_relative_imports(self):
        omitted = tuple(
            source for source in runner.REMOTE_TREE_SOURCES
            if source.name != "repository-error.mjs"
        )
        with patch.object(runner, "REMOTE_TREE_SOURCES", omitted):
            with self.assertRaisesRegex(runner.CoexistenceRunError, "remote source closure is missing"):
                runner.remote_source_material()

    def test_runner_fails_closed_before_constructing_spark(self):
        source = Path(runner.__file__).read_text(encoding="utf-8")
        main = source[source.index("def main()") :]
        self.assertLess(main.index("strict_prerequisites()"), main.index("spark = Spark()"))
        self.assertIn("validate as validate_soak", source)

    def test_names_are_run_scoped_and_not_host_wide(self):
        run_id = "coexist-20260812-a1"
        self.assertIn(run_id, runner.network_name(run_id))
        self.assertIn(run_id, runner.runtime_volume(run_id))
        self.assertIn(run_id, runner.container_name(run_id, "worker-ocr"))
        self.assertTrue(runner.REMOTE_PREFIX.startswith("/tmp/teamaibox-model-coexistence-"))

    def test_evidence_path_is_run_scoped_and_immutable(self):
        run_id = "coexist-20990101-a1"
        expected = runner.EVIDENCE_ROOT / f"{run_id}.json"
        self.assertEqual(runner.evidence_path_for_run(run_id), expected.resolve())
        with self.assertRaisesRegex(runner.CoexistenceRunError, "match its run identity"):
            runner.evidence_path_for_run(run_id, runner.EVIDENCE_ROOT / "different.json")
        with patch.object(Path, "exists", return_value=True):
            with self.assertRaisesRegex(runner.CoexistenceRunError, "will not be overwritten"):
                runner.evidence_path_for_run(run_id)

    def test_evidence_writer_never_overwrites_or_leaves_a_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "coexist-run.json"
            runner.write_local(path, {"status": "passed"})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"status": "passed"})
            with self.assertRaisesRegex(runner.CoexistenceRunError, "will not be overwritten"):
                runner.write_local(path, {"status": "changed"})
            self.assertFalse(path.with_suffix(".json.tmp").exists())

    def test_scheduler_contracts_cover_exclusive_realtime_memory_and_reserve(self):
        result = runner.scheduler_contract_evidence()
        self.assertTrue(result["passed"])
        self.assertEqual(len(result["testFiles"]), 4)

    def test_core_inspection_binds_run_scoped_runtime_identity(self):
        run_id = "coexist-20260812-a1"
        suffixes = (
            "core-platform", "core-web", "core-object", "core-messaging",
            "core-scheduler", "core-postgres", "core-queue",
        )
        names = [runner.container_name(run_id, suffix) for suffix in suffixes]

        class Spark:
            def run(self, command, timeout):
                name = command[2]
                suffix = name.removeprefix(f"{runner.NAME_PREFIX}{run_id}-")
                ordinal = suffixes.index(suffix) + 1
                document = [{
                    "Id": f"{ordinal:064x}",
                    "State": {"Running": True, "OOMKilled": False, "Restarting": False},
                    "Config": {"Labels": {
                        "io.teamaibox.role": suffix,
                        "io.teamaibox.owner": runner.OWNER,
                        "io.teamaibox.run-id": run_id,
                    }},
                    "HostConfig": {
                        "NetworkMode": runner.network_name(run_id),
                        "RestartPolicy": {"Name": "no"},
                    },
                }]
                return SimpleNamespace(returncode=0, stdout=json.dumps(document), stderr="")

        boundaries = runner.inspect_core_containers(Spark(), run_id, names)
        self.assertEqual([item["container"] for item in boundaries], names)
        self.assertEqual(len({item["containerId"] for item in boundaries}), len(names))


if __name__ == "__main__":
    unittest.main()
