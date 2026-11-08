"""Public-only direct connections for the isolated download worker.

Resolve once, validate every address, then connect to that numeric sockaddr.
HTTP Host and TLS SNI remain the original hostname in the urllib caller.
"""
from __future__ import annotations

import ipaddress
import socket
from contextlib import contextmanager
from urllib.parse import urlsplit


class UnsafeDestination(OSError):
    pass


def check_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        raise UnsafeDestination("Only public HTTP(S) URLs without credentials are supported")


def public_addresses(host, port):
    addresses = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    if not addresses:
        raise UnsafeDestination("No destination addresses")
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0].split("%", 1)[0])
        # Treat mapped IPv4 addresses exactly as IPv4; reject multicast as well
        # as non-global, private, loopback, link-local and synthetic TUN ranges.
        effective = getattr(ip, "ipv4_mapped", None) or ip
        if not effective.is_global or effective.is_multicast:
            raise UnsafeDestination("Non-public video destination blocked")
    return addresses


def public_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    addresses = public_addresses(*address)
    last_error = None
    for family, socktype, proto, _, sockaddr in addresses:
        if source_address and family != (socket.AF_INET6 if ":" in source_address[0] else socket.AF_INET):
            continue
        sock = socket.socket(family, socktype, proto)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            # Numeric sockaddr from the checked lookup: no second DNS lookup.
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            sock.close()
            last_error = exc
    raise last_error or OSError("No usable public destination addresses")


@contextmanager
def secure_downloader(options):
    """Keep this process on one guarded HTTP transport, including redirects."""
    import yt_dlp
    from yt_dlp.networking import _urllib

    original_connection = _urllib.create_connection
    original_redirect = _urllib.RedirectHandler

    class PublicRedirect(original_redirect):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            check_url(newurl)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    class PublicHTTPRH(_urllib.UrllibRH):
        RH_KEY = "Urllib"
        _SUPPORTED_URL_SCHEMES = ("http", "https")

        def _get_proxies(self, request):
            # A proxy can resolve a public hostname to a private destination.
            # Never inherit system/env proxies or extractor-provided proxies.
            return {}

        def _send(self, request):
            check_url(request.url)
            return super()._send(request)

    class PublicDownloader(yt_dlp.YoutubeDL):
        def build_request_director(self, handlers, preferences=None):
            return super().build_request_director([PublicHTTPRH])

    _urllib.create_connection = public_connection
    _urllib.RedirectHandler = PublicRedirect
    try:
        with PublicDownloader({**options, "proxy": "", "geo_verification_proxy": None,
                               "enable_file_urls": False, "js_runtimes": {},
                               "remote_components": [], "external_downloader": {"default": "native"}}) as downloader:
            yield downloader
    finally:
        _urllib.create_connection = original_connection
        _urllib.RedirectHandler = original_redirect
