import importlib.util
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "services" / "realtime-asr-worker" / "media_contract.py"
SPEC = importlib.util.spec_from_file_location("teamaibox_asr_media_contract", MODULE_PATH)
MEDIA = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MEDIA
SPEC.loader.exec_module(MEDIA)


class Container:
    duration = 125_500_000
    streams = (
        SimpleNamespace(type="video", duration=3_765, time_base=1 / 30),
        SimpleNamespace(type="audio", duration=6_023_424, time_base=1 / 48_000),
    )

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class MediaContractTest(unittest.TestCase):
    def test_long_media_is_not_rejected_by_a_product_duration_quota(self):
        value = Container()
        value.duration = 8 * 24 * 3600 * MEDIA.AV_TIME_BASE
        self.assertEqual(MEDIA.probe_media(Path('long.mp4'), opener=lambda _: value).duration_seconds, 8 * 24 * 3600)

    def test_nonfinite_metadata_and_clips_are_rejected(self):
        for number in (float('nan'), float('inf'), -float('inf')):
            for pair in ((number, 30), (0, number)):
                with self.assertRaises(ValueError):
                    MEDIA.validated_clip(*pair, 60)
            value = Container()
            value.duration = number
            value.streams = (SimpleNamespace(type='audio', duration=None, time_base=None),)
            with self.assertRaises(ValueError):
                MEDIA.probe_media(Path('invalid.mp4'), opener=lambda _: value)

    def test_decode_budget_scales_with_full_input(self):
        self.assertEqual(MEDIA.decoded_audio_budget(120), 120 * 16000 * 4 * 8)
        for invalid in (0, -1, float('inf'), float('nan')):
            with self.assertRaises(ValueError):
                MEDIA.decoded_audio_budget(invalid)

    def test_probe_reports_real_container_duration_and_stream_types(self):
        facts = MEDIA.probe_media(Path("ignored.mp4"), opener=lambda _: Container())
        self.assertEqual(facts.duration_seconds, 125.5)
        self.assertEqual(facts.stream_types, ("audio", "video"))

    def test_clip_must_be_complete_and_bounded(self):
        self.assertIsNone(MEDIA.validated_clip(None, None, 125.5))
        self.assertEqual(MEDIA.validated_clip(60, 125.5, 125.5), (60.0, 125.5))
        with self.assertRaisesRegex(ValueError, "required together"):
            MEDIA.validated_clip(60, None, 125.5)
        with self.assertRaisesRegex(ValueError, "outside"):
            MEDIA.validated_clip(60, 126, 125.5)


if __name__ == "__main__":
    unittest.main()
