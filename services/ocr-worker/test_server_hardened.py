import asyncio
import base64
import json
import unittest
from unittest import mock

import server_hardened as hardened


class FakeImage:
    width = 100_000
    height = 100_000

    def load(self):
        raise AssertionError("oversized image must be rejected before decode")


class FakeRect:
    width = 100_000
    height = 100_000


class FakePage:
    rect = FakeRect()

    def get_pixmap(self, **kwargs):
        raise AssertionError("oversized PDF must be rejected before render")


class FakeDocument:
    page_count = 1

    def __iter__(self):
        return iter([FakePage()])

    def close(self):
        pass


class FakeRequest:
    def __init__(self, value, content_type="application/json"):
        self.value = value
        self.headers = {"content-type": content_type,
                        "content-length": str(len(value))}

    async def body(self):
        return self.value


class HardenedOcrBoundaryTest(unittest.TestCase):
    def test_image_dimensions_are_checked_before_decode(self):
        with mock.patch.object(hardened.base.Image, "open", return_value=FakeImage()):
            with self.assertRaisesRegex(ValueError, "image input"):
                hardened.hardened_input_pages(b"image", 1)

    def test_pdf_dimensions_are_checked_before_render(self):
        with mock.patch.object(hardened.base.fitz, "open", return_value=FakeDocument()):
            with self.assertRaisesRegex(ValueError, "too large"):
                hardened.hardened_input_pages(b"pdf", 0)

    def test_non_object_json_fails_closed(self):
        request = FakeRequest(b"[]")
        response = asyncio.run(hardened.layout_parsing(request))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(json.loads(response.body)["errorCode"], 400)

    def test_unknown_fields_fail_closed(self):
        body = json.dumps({"file": base64.b64encode(b"x").decode(), "fileType": 1,
                           "url": "http://169.254.169.254/"}).encode()
        response = asyncio.run(hardened.layout_parsing(FakeRequest(body)))
        self.assertEqual(response.status_code, 400)
        self.assertIn("schema", json.loads(response.body)["errorMsg"])


if __name__ == "__main__":
    unittest.main()
