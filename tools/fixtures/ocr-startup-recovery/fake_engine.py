"""Synthetic CPU-only transport fixture. NEVER a production OCR engine."""
import json
import os
from pathlib import Path
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

root = Path(os.environ['TEAMAIBOX_STARTUP_FIXTURE_ROOT'])
with (root / 'starts').open('a') as stream:
    stream.write(str(os.getpid()) + '\n')
if (root / 'fail').exists():
    # Exercise pipe draining and redaction, not genuine CUDA/model execution.
    print('x' * 100000 + 'CUDA out of memory /private/synthetic-document.png', flush=True)
    raise SystemExit(7)
time.sleep(2)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        raw = json.dumps(dict(loaded=True, model='hunyuanocr-1.5-bf16-dflash', inference_mode='vllm-dflash')).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


HTTPServer(('127.0.0.1', 8001), Handler).serve_forever()
