from pathlib import Path

from apkmesh_debug.models import ResponseData
from apkmesh_debug.replay import RecordingStore, ReplayStore


def test_recording_store_writes_replay_compatible_fixture(tmp_path: Path):
    recorder = RecordingStore(tmp_path)
    recorder.record(
        "GET",
        "https://example.test/page",
        ResponseData(
            status_code=200,
            headers={"content-type": "text/html"},
            body=b"<main>recorded</main>",
            url="https://example.test/page",
        ),
    )
    recorder.save()

    response = ReplayStore(tmp_path).get("GET", "https://example.test/page")
    assert response.status_code == 200
    assert response.body == b"<main>recorded</main>"
