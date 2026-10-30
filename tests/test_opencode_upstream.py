import copy
import json
import pathlib
import tempfile
import unittest
from unittest import mock

from tools import validate_opencode_upstream as upstream


class OpenCodeUpstreamTests(unittest.TestCase):
    def test_committed_upstream_lock_is_non_invasive_and_arm64(self):
        lock = upstream.load_and_validate()
        self.assertEqual(lock["upstream"]["release"]["tag"], "v1.18.16")
        self.assertEqual(lock["runtimeArtifact"]["platform"], "linux/arm64/v8")

    def test_source_or_release_tree_drift_fails_closed(self):
        lock = json.loads(upstream.LOCK.read_text())
        drifted = copy.deepcopy(lock)
        drifted["upstream"]["release"]["tree"] = "0" * 40
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "upstream-lock.v1.json"
            path.write_text(json.dumps(drifted))
            with mock.patch.object(upstream, "LOCK", path):
                with self.assertRaisesRegex(ValueError, "does not match"):
                    upstream.load_and_validate()

    def test_provided_source_matches_the_pinned_release_when_available(self):
        lock = upstream.load_and_validate()
        source = (upstream.ROOT / lock["upstream"]["providedSource"]["relativeWorkspace"]).resolve()
        if not (source / ".git").exists():
            self.skipTest("provided OpenCode source is a development-only compatibility input")
        upstream.verify_provided_source(lock)


if __name__ == "__main__":
    unittest.main()
