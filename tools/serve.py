#!/usr/bin/env python3
# Minimal static file server for local dev. Exists only because stdlib `python3 -m
# http.server` calls os.getcwd() unconditionally while building its argparse parser
# (default=os.getcwd() is evaluated eagerly at add_argument() time, not lazily), which
# fails with PermissionError in some sandboxed environments even when a --directory is
# supplied. This script hardcodes the directory instead, avoiding that call entirely.
#
# Port 8772 is this project's registered port (see Projects/CLAUDE.md 的 Port 註冊表).
# Do not change it without updating that table — 8765/8766/8790/8769/8771 are other
# projects' launchd-resident services.
import http.server
import functools
import os
import sys

directory = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8772

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
with http.server.ThreadingHTTPServer(("", port), handler) as httpd:
    print(f"serving {directory} at http://localhost:{port}")
    httpd.serve_forever()
