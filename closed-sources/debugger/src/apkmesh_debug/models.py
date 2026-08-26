from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ResponseData:
    status_code: int
    headers: dict[str, str]
    body: bytes
    url: str

    def header(self, name: str) -> str | None:
        wanted = name.lower()
        for key, value in self.headers.items():
            if key.lower() == wanted:
                return value
        return None


@dataclass(frozen=True)
class BrowserTab:
    id: str
    url: str
    state: str
    started_at: str


@dataclass(frozen=True)
class SourceManifest:
    raw: dict[str, Any]
    source_id: str
    name: str
    permissions: dict[str, Any]
    debug_projects: list[dict[str, Any]]
    package_lookup: bool

    @classmethod
    def from_raw(cls, value: Any) -> "SourceManifest":
        if not isinstance(value, dict):
            raise ValueError("source.manifest must be an object")
        source_id = str(value.get("id", "")).strip()
        name = str(value.get("name", "")).strip()
        if not source_id:
            raise ValueError("source.manifest.id is required")
        if not name:
            raise ValueError("source.manifest.name is required")
        permissions = value.get("permissions", {})
        if not isinstance(permissions, dict):
            raise ValueError("source.manifest.permissions must be an object")
        hosts = permissions.get("network", [])
        if not isinstance(hosts, list) or not all(isinstance(item, str) for item in hosts):
            raise ValueError("source.manifest.permissions.network must be a string array")
        projects = value.get("debugProjects", [])
        if not isinstance(projects, list):
            raise ValueError("source.manifest.debugProjects must be an array")
        return cls(
            raw=value,
            source_id=source_id,
            name=name,
            permissions=permissions,
            debug_projects=[item for item in projects if isinstance(item, dict)],
            package_lookup=value.get("packageLookup") is True,
        )

    @property
    def allowed_hosts(self) -> set[str]:
        return {str(item) for item in self.permissions.get("network", [])}

    @property
    def allow_browser(self) -> bool:
        return self.permissions.get("browser") is True

    @property
    def allow_download(self) -> bool:
        return self.permissions.get("download") is True

    @property
    def allow_install(self) -> bool:
        return self.permissions.get("install") is True


class SourceHostError(RuntimeError):
    """Base error for host-side failures."""


class PolicyError(SourceHostError):
    """Raised when a source accesses a URL outside its manifest."""


class ReplayMiss(SourceHostError):
    """Raised when replay mode has no response for a requested URL."""


class HostRequestError(SourceHostError):
    def __init__(self, message: str, response: ResponseData | None = None) -> None:
        super().__init__(message)
        self.response = response


class UnsupportedHostOperation(SourceHostError):
    """Raised for Android-only operations such as package installation."""


PathLike = str | Path
