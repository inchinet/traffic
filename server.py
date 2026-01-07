import http.server
import socketserver
import urllib.request
import urllib.parse
import json
import sys

PORT = 8000

class ProxyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # Check if this is a proxy request
        if self.path.startswith('/api/proxy'):
            self.handle_proxy()
        else:
            # Serve static files as usual
            super().do_GET()

    def handle_proxy(self):
        try:
            # Parse URL parameters
            query = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(query)
            target_url = params.get('url', [None])[0]

            if not target_url:
                self.send_error(400, "Missing 'url' parameter")
                return

            print(f"Proxying request to: {target_url}")

            # Create request with a generic user agent to avoid blocking
            req = urllib.request.Request(
                target_url, 
                headers={'User-Agent': 'Mozilla/5.0'}
            )

            # Fetch data from external API
            with urllib.request.urlopen(req, timeout=30) as response:
                content_type = response.headers.get('Content-Type', 'application/json')
                data = response.read()

                # Send response back to frontend
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)

        except Exception as e:
            print(f"Proxy Error: {e}")
            self.send_error(500, str(e))

if __name__ == "__main__":
    # Allow address reuse to avoid "Address already in use" errors during restarts
    socketserver.TCPServer.allow_reuse_address = True
    
    try:
        with socketserver.TCPServer(("", PORT), ProxyHTTPRequestHandler) as httpd:
            print(f"Serving HTTP on 0.0.0.0 port {PORT}...")
            print(f"Proxy Endpoint ready at http://localhost:{PORT}/api/proxy?url=...")
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
