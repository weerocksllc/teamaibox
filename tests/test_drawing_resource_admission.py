"""CPU tests: file/request admission only, not model output quality."""
import base64
from email.message import Message
import importlib.util
import io
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parents[1]

def load(name, source):
    spec=importlib.util.spec_from_file_location(name,ROOT/'services/drawing-worker'/source)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    return module

COMFY=load('drawing_resource_comfy','flux2_comfy_server.py')
PROTECTED=load('drawing_resource_protected','flux2_bf16_protected_server.py')

class DrawingResourceTests(unittest.TestCase):
    def test_protected_reads_more_than_previous_two_mib(self):
        raw=json.dumps({'prompt':'a'*(3*1024*1024)}).encode()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                result=PROTECTED.Handler._body(self)
                self.send_response(200);self.end_headers();self.wfile.write(str(len(result['prompt'])).encode())
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with patch.object(PROTECTED,'buffered_bytes',return_value=4*1024*1024):
                with urlopen(Request('http://127.0.0.1:'+str(server.server_port),data=raw),timeout=5) as response:
                    self.assertEqual(response.read(),str(3*1024*1024).encode())
        finally:server.shutdown();server.server_close();thread.join()

    def test_protected_rejects_current_memory_shortage_before_read(self):
        request=type('Request',(),{})();request.headers=Message();request.headers['content-length']='4096'
        request.rfile=io.BytesIO(b'{}')
        with patch.object(PROTECTED,'buffered_bytes',return_value=2048):
            with self.assertRaises(ValueError):PROTECTED.Handler._body(request)
        self.assertEqual(request.rfile.tell(),0)

    def test_wide_image_is_not_rejected_by_arbitrary_side_length(self):
        from PIL import Image
        output=io.BytesIO();Image.new('RGB',(17000,2),'green').save(output,format='PNG')
        with patch.object(COMFY,'buffered_bytes',return_value=2*1024*1024):
            decoded=COMFY.decode_image(base64.b64encode(output.getvalue()).decode(),'input')
            self.assertEqual(decoded.size,(17000,2))

    def test_decompressed_pixels_are_checked_before_load(self):
        from PIL import Image
        output=io.BytesIO();Image.new('RGB',(100,100),'green').save(output,format='PNG')
        with patch.object(COMFY,'buffered_bytes',return_value=4096):
            with self.assertRaises(COMFY.WorkerError):COMFY.decode_image(base64.b64encode(output.getvalue()).decode(),'input')

    def test_no_repeated_fixed_body_image_or_prompt_caps(self):
        for filename in ('server.py','specialist_server.py','flux2_comfy_server.py','flux2_bf16_protected_server.py'):
            source=(ROOT/'services/drawing-worker'/filename).read_text()
            self.assertNotIn('MAX_BODY_BYTES',source)
            self.assertNotIn('MAX_IMAGE_BYTES',source)
            self.assertNotIn('<= 32000',source)
            self.assertIn('buffered_bytes()',source)

if __name__=='__main__':unittest.main()
