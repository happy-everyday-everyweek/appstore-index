from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class TraceRecorder:
    def __init__(self, limit: int = 12000) -> None:
        self.limit = limit
        self.events: list[dict[str, Any]] = []

    def add(self, event: str, **fields: Any) -> None:
        self.events.append(
            {
                "time": datetime.now(timezone.utc).isoformat(),
                "event": event,
                **{key: self._safe(value) for key, value in fields.items()},
            }
        )

    def body_preview(self, body: bytes | str | None) -> str | None:
        if body is None:
            return None
        if isinstance(body, bytes):
            text = body.decode("utf-8", errors="replace")
        else:
            text = body
        if len(text) <= self.limit:
            return text
        return f"{text[: self.limit]}\n... [body truncated]"

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"events": self.events}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    @staticmethod
    def _safe(value: Any) -> Any:
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        if isinstance(value, Path):
            return str(value)
        if isinstance(value, dict):
            return {str(key): TraceRecorder._safe(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [TraceRecorder._safe(item) for item in value]
        return value
