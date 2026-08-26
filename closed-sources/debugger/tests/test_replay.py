import json
from pathlib import Path

from apkmesh_debug.replay import ReplayStore


def test_replay_reads_inline_and_file_bodies(tmp_path: Path):
    (tmp_path / "page.html").write_text("<main>fixture</main>", encoding="utf-8")
    (tmp_path / "replay.json").write_text(
        json.dumps(
            {
                "responses": {
                    "GET https://example.test/inline": {
                        "status": 201,
                        "headers": {"content-type": "text/plain"},
                        "body": "hello",
                    },
                    "GET https://example.test/page": {
                        "status": 200,
                        "body_file": "page.html",
                    },
                }
            }
        ),
        encoding="utf-8",
    )

    store = ReplayStore(tmp_path)
    inline = store.get("GET", "https://example.test/inline")
    page = store.get("GET", "https://example.test/page")

    assert inline.status_code == 201
    assert inline.body == b"hello"
    assert page.body == b"<main>fixture</main>"
