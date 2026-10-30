"""Decode actual generated files through the recording analyzer (not real media acceptance)."""
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import casting_browser_av_probe as probe


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'existing ffmpeg/ffprobe required')
class EncodedRecordingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix='teamaibox-av-fixture-')
        cls.source = Path(cls.scratch.name) / 'source.mp4'
        cls.recording = Path(cls.scratch.name) / 'recording.mp4'
        probe.generate(cls.source)
        # Synthetic camera: same source on left; browser +200 ms on right;
        # sound +230 ms. 60 fps sampling keeps optical bracket width <50 ms.
        graph = ('[0:v]split[s][b];[s]scale=640:360,fps=60[ss];'
                 '[b]scale=640:360,tpad=start_duration=0.2:start_mode=clone,fps=60[bb];'
                 '[ss][bb]hstack=shortest=1[v];[0:a]adelay=230|230[a]')
        probe.base.command(['ffmpeg', '-v', 'error', '-n', '-threads', '2',
                            '-i', str(cls.source), '-filter_complex_threads', '1',
                            '-filter_complex', graph, '-map', '[v]', '-map', '[a]',
                            '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast',
                            '-crf', '18', '-bf', '0', '-c:a', 'aac', '-b:a', '192k',
                            '-t', '32', str(cls.recording)])

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def test_decoded_source_timeline(self):
        result = probe.self_test(self.source)
        self.assertEqual(result['decodedFrames'], 960)
        self.assertFalse(result['actualAppleSourceAccepted'])
        self.assertFalse(result['browserAvSyncAccepted'])

    def test_end_to_end_known_offset_and_no_false_product_acceptance(self):
        result = probe.analyze(self.recording, [96, 90, 448, 180], [736, 90, 448, 180])
        self.assertAlmostEqual(result['sourceToBrowser']['medianMs'], 200, delta=1)
        # Optical onset is bracketed between camera frames, so use the full
        # measured interval rather than asserting an invented point precision.
        for pulse in result['observedSoundMinusBrowser']['perPulse']:
            self.assertLessEqual(pulse['lowerMs'], 30 + 2)
            self.assertGreaterEqual(pulse['upperMs'], 30 - 2)
        self.assertTrue(result['glassBudgetPassed'])
        self.assertFalse(result['browserAvBudgetPassed'])
        self.assertFalse(result['browserAvSyncAccepted'])

    def test_missing_actual_encoded_beep_is_not_accepted(self):
        missing = Path(self.scratch.name) / 'missing-beep.mp4'
        probe.base.command(['ffmpeg', '-v', 'error', '-n', '-threads', '2',
                            '-i', str(self.recording), '-c:v', 'copy',
                            '-af', "volume=0:enable='between(t,7.1,7.4)'", '-c:a', 'aac', str(missing)])
        with self.assertRaisesRegex(ValueError, 'complete_ten_pulse_sequence_required'):
            probe.analyze(missing, [96, 90, 448, 180], [736, 90, 448, 180])


if __name__ == '__main__':
    unittest.main()
