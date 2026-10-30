import unittest
import os
from threading import Thread
from types import SimpleNamespace
from services.trusted_media_service.native_failure import assertion_code, native_assertion_code
from services.trusted_media_service.native_receiver_process import NativeReceiverProcess


class NativeFailureTest(unittest.TestCase):
    def test_gstreamer_relative_path_keeps_only_compiler_location(self):
        for line, expected in (
            (b'ERROR:../gst/videorate/gstvideorate.c:705:gst_video_rate_push_buffer: assertion failed: (private expression)\n', 'native_assert_gstvideorate_705'),
            (b'ERROR:../gst-libs/gst/video/video-converter.c:275:converter: assertion failed: (private expression)\n', 'native_assert_video_converter_275'),
            (b'ERROR:gstbuffer.c:123:buffer: assertion failed: (private expression)\n', 'native_assert_gstbuffer_123'),
        ):
            self.assertEqual(assertion_code(line), expected)
            self.assertTrue(native_assertion_code(expected))

    def test_non_source_and_arbitrary_relative_names_remain_rejected(self):
        for line in (b'ERROR:../../private-label.c:100:assertion failed: (secret)',
                     b'ERROR:../gst/videorate/gstvideorate.c:0: assertion failed: (secret)',
                     b'ERROR:../gst/videorate/gstvideorate.c:705:sender says private text',
                     b'ERROR:/tmp/gstvideorate.c/secret:705: assertion failed: (secret)'):
            self.assertIsNone(assertion_code(line))

    def test_only_allowlisted_source_location_is_returned(self):
        self.assertEqual(assertion_code(b"uxplay: /build/src/lib/crypto.c:93: aes_encrypt: Assertion `private expression' failed.\n"), "native_assert_crypto_93")
        self.assertEqual(assertion_code(b"ERROR:/build/src/renderers/video_renderer.c:390:renderer: assertion failed: (private)\n"), "native_assert_video_renderer_390")

    def test_labels_keys_payload_and_unbounded_text_are_discarded(self):
        for line in (b"a device named uxplay: /build/src/crypto.c:12: Assertion 'x' failed", b"private key value",
                     b"uxplay: /tmp/private.c:12: Assertion 'x' failed", b"x"*3000):
            self.assertIsNone(assertion_code(line))
        for code in ("native_assert_private_42", "native_assert_crypto_0", "native_assert_crypto_1/secret", None):
            self.assertFalse(native_assertion_code(code))
        self.assertTrue(native_assertion_code("native_assert_crypto_93"))

    def test_fragmented_and_oversized_native_output_keeps_only_code_location(self):
        read, write = os.pipe()
        stream = os.fdopen(read, 'rb', buffering=0)
        receiver = SimpleNamespace(_process=SimpleNamespace(stderr=stream), _assertion_code=None)
        def emit():
            try:
                for part in (b'private sender label\n', b'x'*8192, b'\n', b'uxplay: /build/src/lib/cry',
                             b'pto.c:93: aes_encrypt: Assertion `private expression' + b"' failed.\n"):
                    os.write(write, part)
            finally:
                os.close(write)
        writer = Thread(target=emit)
        writer.start()
        try:
            NativeReceiverProcess._read_assertion(receiver)
            self.assertEqual(receiver._assertion_code, 'native_assert_crypto_93')
        finally:
            stream.close()
            writer.join(3)
        self.assertFalse(writer.is_alive())
