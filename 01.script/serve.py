"""Serve the project root over HTTP so the dashboard's relative fetch()
paths (../../02.input/processed/...) resolve correctly.

Run with: uv run python serve.py [port]
Then open: http://localhost:<port>/01.script/dashboard/index.html
"""

import http.server
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(PROJECT_ROOT), **kw)
    with http.server.ThreadingHTTPServer(("localhost", port), handler) as httpd:
        print(f"Serving {PROJECT_ROOT} at http://localhost:{port}")
        print(f"Open: http://localhost:{port}/01.script/dashboard/index.html")
        httpd.serve_forever()
