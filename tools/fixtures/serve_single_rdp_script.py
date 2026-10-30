import base64
import http.server
import os
from pathlib import Path


SCRIPT = base64.b64decode(os.environ["TEAMAIBOX_RDP_SCRIPT_B64"])
RESULT = Path("/tmp/teamaibox-rdp-result.json")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/enable_rdp.ps1":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(SCRIPT)))
        self.end_headers()
        self.wfile.write(SCRIPT)

    def do_POST(self):
        if self.path != "/result":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400)
            return
        if not 0 < length <= 16384:
            self.send_error(413)
            return
        payload = self.rfile.read(length)
        RESULT.write_bytes(payload)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_):
        return


http.server.HTTPServer(("127.0.0.1", 18080), Handler).serve_forever()
