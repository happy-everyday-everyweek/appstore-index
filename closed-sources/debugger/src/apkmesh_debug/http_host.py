from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx

from .models import HostRequestError, ReplayMiss, ResponseData
from .policy import SourcePolicy
from .replay import RecordingStore, ReplayStore
from .trace import TraceRecorder


class HttpHost:
    def __init__(
        self,
        policy: SourcePolicy,
        trace: TraceRecorder,
        *,
        mode: str = "live",
        replay: ReplayStore | None = None,
        recording: RecordingStore | None = None,
        timeout: float = 15.0,
        download_dir: Path | None = None,
    ) -> None:
        self.policy = policy
        self.trace = trace
        self.mode = mode
        self.replay = replay
        self.recording = recording
        self.timeout = timeout
        self.download_dir = download_dir or Path("downloads")
        self.client = httpx.Client(follow_redirects=False, timeout=timeout)

    def request(self, url: str, headers: dict[str, str] | None = None) -> str:
        response = self.fetch(url, headers=headers)
        if response.status_code >= 400:
            raise HostRequestError(
                f"HTTP {response.status_code} for {url}", response=response
            )
        return self._decode(response)

    def fetch(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        capability: str = "network",
    ) -> ResponseData:
        current_url = url
        request_headers = headers or {}
        for redirect_count in range(7):
            self.policy.check(current_url, capability)
            self.trace.add(
                "http.request",
                method="GET",
                url=current_url,
                headers=request_headers,
                redirect=redirect_count,
                mode=self.mode,
            )
            response = self._get_once(current_url, request_headers)
            location = response.header("location")
            self.trace.add(
                "http.response",
                method="GET",
                url=current_url,
                final_url=response.url,
                status=response.status_code,
                headers=response.headers,
                body=self.trace.body_preview(response.body),
                redirect=redirect_count,
            )
            if not 300 <= response.status_code < 400:
                return response
            if not location:
                raise HostRequestError(
                    f"redirect from {current_url} has no Location", response=response
                )
            current_url = urljoin(current_url, location)
        raise HostRequestError(f"too many redirects for {url}")

    def download(
        self,
        url: str,
        *,
        file_name: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> str:
        response = self.fetch(url, headers=headers, capability="download")
        if not 200 <= response.status_code < 300:
            raise HostRequestError(
                f"download returned HTTP {response.status_code} for {url}",
                response=response,
            )
        requested_name = file_name or Path(urlsplit(url).path).name or "download.apk"
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", requested_name)
        destination = self.download_dir / (safe_name or "download.apk")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(response.body)
        self.trace.add(
            "download.completed",
            url=url,
            path=destination,
            bytes=len(response.body),
        )
        return str(destination)

    def close(self) -> None:
        self.client.close()

    def _get_once(self, url: str, headers: dict[str, str]) -> ResponseData:
        if self.mode == "replay":
            if self.replay is None:
                raise RuntimeError("replay mode requires a ReplayStore")
            try:
                return self.replay.get("GET", url)
            except ReplayMiss as error:
                self.trace.add("replay.miss", method="GET", url=url)
                raise

        response = self.client.get(url, headers=headers, follow_redirects=False)
        data = ResponseData(
            status_code=response.status_code,
            headers=dict(response.headers),
            body=response.content,
            url=str(response.url),
        )
        if self.recording is not None:
            self.recording.record("GET", url, data)
        return data

    @staticmethod
    def _decode(response: ResponseData) -> str:
        content_type = response.header("content-type") or ""
        match = re.search(r"charset=([^;\s]+)", content_type, re.IGNORECASE)
        encoding = match.group(1).strip('"\'') if match else "utf-8"
        try:
            return response.body.decode(encoding, errors="replace")
        except LookupError:
            return response.body.decode("utf-8", errors="replace")
