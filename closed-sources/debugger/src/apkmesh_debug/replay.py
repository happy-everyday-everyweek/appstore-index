from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .models import ReplayMiss, ResponseData


class ReplayStore:
    """Exact URL response replay for deterministic, no-network runs."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.spec_path = root / "replay.json"
        if not self.spec_path.is_file():
            raise FileNotFoundError(f"replay manifest not found: {self.spec_path}")
        value = json.loads(self.spec_path.read_text(encoding="utf-8"))
        responses = value.get("responses") if isinstance(value, dict) else None
        if not isinstance(responses, dict):
            raise ValueError("replay.json must contain an object named 'responses'")
        self.responses = responses

    def get(self, method: str, url: str) -> ResponseData:
        key = f"{method.upper()} {url}"
        record = self.responses.get(key)
        if record is None:
            record = self.responses.get(url)
        if not isinstance(record, dict):
            raise ReplayMiss(f"no replay response for {key}")

        body_file = record.get("body_file")
        if body_file is not None:
            body = (self.root / str(body_file)).read_bytes()
        else:
            body_value = record.get("body", "")
            if not isinstance(body_value, str):
                raise ValueError(f"replay body must be a string for {key}")
            body = body_value.encode("utf-8")
        headers = record.get("headers", {})
        if not isinstance(headers, dict):
            raise ValueError(f"replay headers must be an object for {key}")
        return ResponseData(
            status_code=int(record.get("status", 200)),
            headers={str(k): str(v) for k, v in headers.items()},
            body=body,
            url=url,
        )


class RecordingStore:
    """Persist live responses in the exact format consumed by ReplayStore."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.responses: dict[str, dict[str, Any]] = {}

    def record(self, method: str, url: str, response: ResponseData) -> None:
        key = f"{method.upper()} {url}"
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:20]
        body_path = self.root / f"response-{digest}.body"
        body_path.write_bytes(response.body)
        self.responses[key] = {
            "status": response.status_code,
            "headers": response.headers,
            "body_file": body_path.name,
        }

    def save(self) -> None:
        (self.root / "replay.json").write_text(
            json.dumps({"responses": self.responses}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
