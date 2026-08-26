from pathlib import Path

import pytest

from apkmesh_debug.runtime import SourceRuntime
from apkmesh_debug.trace import TraceRecorder


class NoOpHost:
    def dispatch(self, name, payload):
        raise AssertionError(name)


@pytest.mark.parametrize(
    "source_name",
    ["apkvision.js", "apkmirror.js", "apktodo.js"],
)
def test_search_treats_http_404_as_an_empty_page(source_name: str):
    repository = Path(__file__).resolve().parents[3]
    source_path = repository / "assets" / "sources" / source_name
    runtime = SourceRuntime(source_path, None, TraceRecorder())
    runtime.attach_host(NoOpHost())
    runtime.context.eval(
        "globalThis.apkmesh.request = async () => { throw new Error('HTTP 404'); };"
    )
    try:
        assert runtime.call("search", "demo", 2) == []
    finally:
        runtime.close()
