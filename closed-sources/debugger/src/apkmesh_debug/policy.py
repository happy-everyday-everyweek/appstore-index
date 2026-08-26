from __future__ import annotations

from urllib.parse import urlsplit

from .models import PolicyError, SourceManifest


class SourcePolicy:
    def __init__(self, manifest: SourceManifest) -> None:
        self.manifest = manifest
        self.allowed_hosts = {item.lower() for item in manifest.allowed_hosts}
        self.allow_browser = manifest.allow_browser
        self.allow_download = manifest.allow_download
        self.allow_install = manifest.allow_install

    def permits(self, url: str) -> bool:
        try:
            parsed = urlsplit(url)
            host = (parsed.hostname or "").lower()
        except ValueError:
            return False
        if parsed.scheme not in {"http", "https"} or not host:
            return False
        return any(self._host_matches(host, rule) for rule in self.allowed_hosts)

    @staticmethod
    def _host_matches(host: str, rule: str) -> bool:
        normalized = rule.lower().strip()
        if normalized == "*":
            return True
        if normalized.startswith("*."):
            suffix = normalized[1:]
            return host.endswith(suffix) and len(host) > len(suffix)
        return host == normalized

    def require_capability(self, capability: str) -> None:
        allowed = {
            "network": True,
            "browser": self.allow_browser,
            "download": self.allow_download,
            "install": self.allow_install,
        }.get(capability)
        if allowed is False:
            raise PolicyError(f"source did not declare the {capability} capability")
        if allowed is None:
            raise PolicyError(f"unknown host capability: {capability}")

    def check(self, url: str, capability: str = "network") -> None:
        self.require_capability(capability)
        if not self.permits(url):
            host = urlsplit(url).hostname or "<invalid>"
            raise PolicyError(f"source policy rejected {url} ({host})")
