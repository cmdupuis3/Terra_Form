#!/usr/bin/env python3
"""Terra Form launcher. Double-click, or run:  python3 serve.py
Serves THIS folder over http (required -- browsers block reading sibling files from file://)
and opens the app. Ctrl+C to stop."""
import http.server, socketserver, webbrowser, os, threading
os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = 8000
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), http.server.SimpleHTTPRequestHandler) as httpd:
    url = f"http://localhost:{PORT}/"
    print(f"Terra Form serving at {url}   (Ctrl+C to stop)")
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try: httpd.serve_forever()
    except KeyboardInterrupt: print("\nstopped")
