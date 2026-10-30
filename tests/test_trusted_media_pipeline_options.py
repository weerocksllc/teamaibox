"""Regression for UxPlay's effective CLI graph, not just the -vc fragment."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from services.trusted_media_service.native_receiver_process import NativeReceiverProcess, NativeReceiverProcessError


class PipelineOptionsTest(unittest.TestCase):
    def argv(self):
        callback = SimpleNamespace(pair_source=lambda **kw: {'paired': True, 'blocked': False})
        receiver = NativeReceiverProcess(callback_client=callback)
        with patch('services.trusted_media_service.native_receiver_process.spawn_service_child',
                   side_effect=OSError('synthetic spawn interception')) as spawn:
            with self.assertRaises(NativeReceiverProcessError):
                receiver.start(session_id='6cb7a018-aad1-4ea6-a8c2-039ea0291573',
                    receiver_name='Team-AI-0123456789', pin='9876', lifetime_seconds=30)
            return spawn.call_args.args[0]

    def test_real_spawn_arguments_disable_implicit_pipeline_rewrite(self):
        argv = self.argv()
        self.assertEqual(argv[argv.index('-srgb') + 1], 'no')
        self.assertEqual(argv[argv.index('-vd') + 1], 'avdec_h264')
        self.assertEqual(argv[argv.index('-vs') + 1], 'gdppay ! fdsink fd=4 sync=false')
        self.assertNotIn('9876', argv)

    @unittest.skipUnless(importlib.util.find_spec('gi'), 'container GStreamer required')
    def test_effective_upstream_expansion_is_parsable_only_with_explicit_no(self):
        from services.trusted_media_service.gdp_media_ingress import _gstreamer
        G = _gstreamer()
        from gi.repository import GLib
        argv = self.argv()
        converter = argv[argv.index('-vc') + 1]
        # Exact UxPlay 1.73.6 FULL_RANGE_RGB_FIX expansion, before our fix.
        expanded = converter + ' ! video/x-raw,colorimetry=sRGB,format=RGB ! ' + converter
        with self.assertRaises(GLib.Error):
            G.parse_launch('videotestsrc ! ' + expanded + ' ! fakesink')
        effective = converter if argv[argv.index('-srgb') + 1] == 'no' else expanded
        pipe = G.parse_launch('videotestsrc num-buffers=3 ! video/x-raw,format=Y444,framerate=30/1 ! '
                              + effective + ' ! fakesink sync=false')
        try:
            self.assertNotEqual(pipe.set_state(G.State.PLAYING), G.StateChangeReturn.FAILURE)
            msg = pipe.get_bus().timed_pop_filtered(3 * G.SECOND, G.MessageType.ERROR | G.MessageType.EOS)
            self.assertIsNotNone(msg)
            self.assertEqual(msg.type, G.MessageType.EOS)
        finally:
            pipe.set_state(G.State.NULL)
