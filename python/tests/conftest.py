from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest


class _Capture(BaseHTTPRequestHandler):
    captured: list[dict] = []

    def do_GET(self):  # noqa: N802
        _Capture.captured.append(dict(self.headers))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):  # noqa: N802 - ChatOpenAI POSTs /v1/chat/completions
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        _Capture.captured.append(dict(self.headers))
        self.send_response(500)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a):  # silence
        pass


@pytest.fixture()
def capture_server():
    _Capture.captured = []
    srv = HTTPServer(("127.0.0.1", 0), _Capture)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"127.0.0.1:{srv.server_port}", _Capture.captured
    srv.shutdown()
