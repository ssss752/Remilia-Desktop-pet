import http.server
import socketserver
import os
import datetime

SEED_DIR = os.path.join(os.path.dirname(__file__), "seed")
LOG_PATH = os.path.join(os.path.dirname(__file__), "server.log")
PORT = 8123
HOST = "127.0.0.1"


class Handler(http.server.BaseHTTPRequestHandler):
    def _log(self, msg):
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now().isoformat()} {msg}\n")

    def do_GET(self):
        path = self.path.split("?")[0]
        # strip a leading mirror prefix like /electron-builder-binaries/
        parts = [p for p in path.split("/") if p]
        # the actual filename is the last path segment
        fname = parts[-1] if parts else ""
        self._log(f"GET {self.path} -> basename={fname}")
        fpath = os.path.join(SEED_DIR, fname)
        if fname and os.path.isfile(fpath):
            with open(fpath, "rb") as fb:
                data = fb.read()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            self.wfile.write(data)
            self._log(f"  200 served {len(data)} bytes")
        else:
            self.send_response(404)
            self.end_headers()
            self._log(f"  404 NOT FOUND (seed has: {sorted(os.listdir(SEED_DIR))})")

    def log_message(self, *args):
        pass


with open(LOG_PATH, "a", encoding="utf-8") as f:
    f.write(f"\n=== server start {datetime.datetime.now().isoformat()} on {HOST}:{PORT} seed={SEED_DIR} ===\n")

with socketserver.TCPServer((HOST, PORT), Handler) as httpd:
    httpd.serve_forever()
