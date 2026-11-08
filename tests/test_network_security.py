import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock

import pytest
from plugin.plugins.video_reader import network_security as security


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1",
                                     "::ffff:127.0.0.1", "198.18.0.1", "224.0.0.1"])
def test_connection_rejects_non_public_addresses_before_socket_creation(monkeypatch, address):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", (address, 80))])
    factory = Mock()
    monkeypatch.setattr(socket, "socket", factory)
    with pytest.raises(security.UnsafeDestination):
        security.public_connection(("example.com", 80))
    factory.assert_not_called()


def test_connection_pins_checked_address_without_second_lookup(monkeypatch):
    lookup = Mock(side_effect=[[(2, 1, 6, "", ("93.184.216.34", 80))],
                               [(2, 1, 6, "", ("127.0.0.1", 80))]])
    monkeypatch.setattr(socket, "getaddrinfo", lookup)
    sock = Mock()
    monkeypatch.setattr(socket, "socket", Mock(return_value=sock))
    assert security.public_connection(("example.com", 80)) is sock
    lookup.assert_called_once()
    sock.connect.assert_called_once_with(("93.184.216.34", 80))
    with pytest.raises(security.UnsafeDestination):
        security.public_connection(("example.com", 80))


def test_mixed_public_private_dns_fails_closed(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [
        (2, 1, 6, "", ("93.184.216.34", 80)), (2, 1, 6, "", ("10.0.0.1", 80))])
    with pytest.raises(security.UnsafeDestination):
        security.public_addresses("example.com", 80)


@pytest.mark.parametrize("url", ["file:///secret.mp4", "ftp://example.com/video", "http://user:pass@example.com/"])
def test_unsafe_url_shapes(url):
    with pytest.raises(security.UnsafeDestination):
        security.check_url(url)


@pytest.mark.parametrize("mode", ["redirect", "extracted"])
def test_real_http_transport_blocks_private_redirect_and_media(monkeypatch, mode):
    hits = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            target = f"http://127.0.0.1:{self.server.server_port}/private.mp4"
            if mode == "redirect":
                self.send_response(302)
                self.send_header("Location", target)
                self.end_headers()
            else:
                body = f'<html><title>test</title><video src="{target}"></video></html>'.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    guarded_connection = security.public_connection
    direct_connection = socket.create_connection

    def connect(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
        # Only the initial public test origin is mapped to our controlled server.
        # All media/redirect destinations go through the production guard.
        if address[0] == "public.example":
            return direct_connection(("127.0.0.1", server.server_port), timeout, source_address)
        return guarded_connection(address, timeout, source_address)

    monkeypatch.setattr(security, "public_connection", connect)
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    try:
        with security.secure_downloader({"quiet": True, "no_warnings": True, "retries": 0}) as downloader:
            assert list(downloader._request_director.handlers) == ["Urllib"]
            with pytest.raises(Exception, match="Non-public"):
                if mode == "redirect":
                    downloader.urlopen("http://public.example/start").read()
                else:
                    info = downloader.extract_info("http://public.example/start", download=False)
                    downloader.urlopen(info["url"]).read()
        assert hits and all(path == "/start" for path in hits)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
