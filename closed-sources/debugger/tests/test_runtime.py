from pathlib import Path

from apkmesh_debug.runtime import SourceRuntime
from apkmesh_debug.trace import TraceRecorder


class FakeHost:
    def dispatch(self, name, payload):
        if name == "apkmesh.request":
            return "fixture body"
        if name == "apkmesh.browser.query":
            return {"title": "Fixture", "icon": "icon.png"}
        if name == "apkmesh.browser.queryAll":
            return [{"value": "one"}, {"value": "two"}]
        if name == "apkmesh.browser.open":
            return "tab-1"
        if name == "apkmesh.browser.waitFor":
            return True
        if name == "apkmesh.browser.waitForUrlChange":
            return "https://example.test/file.apk"
        if name == "apkmesh.browser.close":
            return True
        raise AssertionError(name)


def test_runtime_resolves_async_source_and_json_bridge(tmp_path: Path):
    source = tmp_path / "source.js"
    source.write_text(
        """
        globalThis.source = {
          manifest: {
            id: 'test',
            name: 'Test',
            permissions: {network: ['example.test'], browser: true}
          },
          async search(query, page = 1) {
            const body = await apkmesh.request('https://example.test/search');
            const tab = await apkmesh.browser.open('https://example.test/page');
            await tab.waitFor('main');
            const app = await tab.query({title: 'h1@text', icon: 'img@src'});
            const values = await tab.queryAll('li', {value: '@text'});
            const finalUrl = await tab.waitForUrlChange('https://example.test/page');
            await tab.close();
            return {query, page, body, app, values, finalUrl};
          }
        };
        """,
        encoding="utf-8",
    )
    trace = TraceRecorder()
    runtime = SourceRuntime(source, None, trace)
    runtime.attach_host(FakeHost())

    result = runtime.call("search", "demo", 2)
    runtime.close()

    assert result == {
        "query": "demo",
        "page": 2,
        "body": "fixture body",
        "app": {"title": "Fixture", "icon": "icon.png"},
        "values": [{"value": "one"}, {"value": "two"}],
        "finalUrl": "https://example.test/file.apk",
    }
    assert any(event["event"] == "source.completed" for event in trace.events)
