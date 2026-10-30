import hashlib
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / "deploy/compute/speaker-diarization-sortformer-v2-spark.experimental.v1.json"
DOCKERFILE = ROOT / "services/speaker-diarization-worker/Dockerfile"
SUPERVISOR = ROOT / "services/speaker-diarization-worker/supervisor/main.go"


class SpeakerDiarizationWorkerContractTests(unittest.TestCase):
    def test_profile_is_pinned_experimental_and_openai_styled(self) -> None:
        profile = json.loads(PROFILE.read_text(encoding="utf-8"))
        self.assertEqual(profile["certificationState"], "experimental")
        self.assertEqual(profile["source"]["license"], "CC-BY-4.0")
        self.assertRegex(profile["source"]["revision"], r"^[a-f0-9]{40}$")
        self.assertRegex(profile["artifact"]["sha256"], r"^sha256:[a-f0-9]{64}$")
        self.assertEqual(profile["artifact"]["sizeBytes"], 147075776)
        self.assertEqual(profile["api"]["operation"], "POST /v1/audio/diarizations")
        self.assertEqual(profile["speakerInformation"]["mode"], "global-diarization-prepass")
        self.assertEqual(profile["speakerInformation"]["maximumSpeakerCount"], 4)
        self.assertIn("global timestamps", profile["speakerInformation"]["shardedAsrComposition"])
        self.assertTrue(any("not eligible" in item for item in profile["knownLimitations"]))

    def test_image_is_non_root_read_only_compatible_and_digest_pinned(self) -> None:
        source = DOCKERFILE.read_text(encoding="utf-8")
        supervisor = SUPERVISOR.read_text(encoding="utf-8")
        profile = json.loads(PROFILE.read_text(encoding="utf-8"))
        self.assertIn("USER 65532:65532", source)
        self.assertIn('"--no-ui"', supervisor)
        self.assertIn("/v1/audio/diarizations", profile["api"]["operation"])
        self.assertIn(profile["artifact"]["sha256"].removeprefix("sha256:"), source)
        self.assertIn(profile["runtime"]["archiveSha256"].removeprefix("sha256:"), source)
        self.assertIn("HEALTHCHECK", source)
        self.assertIn("speaker-diarization-supervisor", source)
        self.assertNotIn("latest", source.lower())

    def test_worker_loads_on_demand_and_unloads_after_idle(self) -> None:
        source = SUPERVISOR.read_text(encoding="utf-8")
        self.assertIn('POST /v1/models/prepare', source)
        self.assertIn('POST /v1/models/unload', source)
        self.assertIn('POST /v1/audio/diarizations', source)
        self.assertIn("idleLoop", source)
        self.assertIn("maximumUploadBytes", source)

    def test_profile_file_digest_is_stable_shape(self) -> None:
        digest = hashlib.sha256(PROFILE.read_bytes()).hexdigest()
        self.assertRegex(digest, r"^[a-f0-9]{64}$")


if __name__ == "__main__":
    unittest.main()
