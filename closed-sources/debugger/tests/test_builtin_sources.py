import json
from pathlib import Path

import pytest

from apkmesh_debug.runtime import SourceRuntime
from apkmesh_debug.trace import TraceRecorder


REPOSITORY = Path(__file__).resolve().parents[3]
SOURCES = REPOSITORY / "assets" / "sources"


class NoOpHost:
    def dispatch(self, name, payload):
        raise AssertionError(name)


def source_runtime(source_name: str) -> SourceRuntime:
    runtime = SourceRuntime(SOURCES / source_name, None, TraceRecorder())
    runtime.attach_host(NoOpHost())
    return runtime


def test_all_builtin_source_sidecars_match_runtime_contract():
    source_names = sorted(path.name for path in SOURCES.glob("*.js"))

    assert source_names
    for source_name in source_names:
        runtime = source_runtime(source_name)
        sidecar = json.loads((SOURCES / f"{source_name}.manifest.json").read_text())
        manifest = runtime.manifest.raw
        try:
            assert runtime.has_method("search"), source_name
            assert runtime.has_method("details"), source_name
            for field in (
                "id",
                "name",
                "version",
                "homepage",
                "description",
                "permissions",
                "debugProjects",
            ):
                assert sidecar.get(field) == manifest.get(field), (
                    source_name,
                    field,
                )

            has_catalog = runtime.has_method("catalog")
            assert has_catalog == runtime.has_method("catalogPage"), source_name
            has_detail_progress = runtime.has_method("detailsMetadata")
            assert has_detail_progress == runtime.has_method(
                "resolveDownloads"
            ), source_name
            has_package_lookup = runtime.has_method("packageLookupUrl")
            assert has_package_lookup == bool(manifest.get("packageLookup")), source_name

            capabilities = sidecar.get("capabilities")
            assert capabilities == {
                "catalog": has_catalog,
                "detailProgress": has_detail_progress,
                "packageLookup": has_package_lookup,
            }, source_name
        finally:
            runtime.close()


@pytest.mark.parametrize(
    "source_name", ["apktodo.js", "aptoide.js", "downloadit.js"]
)
def test_changed_source_sidecars_match_catalog_capability(source_name: str):
    runtime = source_runtime(source_name)
    sidecar = json.loads((SOURCES / f"{source_name}.manifest.json").read_text())
    try:
        catalog = runtime.call("catalog")
        assert catalog["tabs"]
        assert catalog["defaultTabId"] == catalog["tabs"][0]["id"]
        assert sidecar["version"] == runtime.manifest.raw["version"]
        assert sidecar["capabilities"]["catalog"] is True
        assert runtime.has_method("catalogPage") is True
    finally:
        runtime.close()


def test_aptoide_catalog_parses_structured_page_data():
    runtime = source_runtime("aptoide.js")
    payload = {
        "props": {
            "pageProps": {
                "gridApps": {
                    "list": [
                        {
                            "name": "Example App",
                            "uname": "example-app",
                            "package": "com.example.app",
                            "size": "12 MB",
                            "icon": "https://cdn.aptoide.com/example.png",
                            "file": {"vername": "2.1.0"},
                        }
                    ],
                    "next": 50,
                }
            }
        }
    }
    html = (
        '<script id="__NEXT_DATA__" type="application/json">'
        f"{json.dumps(payload)}"
        "</script>"
    )
    runtime.context.eval(
        f"""
        globalThis.__requestedUrl = null;
        globalThis.apkmesh.request = async (url) => {{
          globalThis.__requestedUrl = url;
          return {json.dumps(html)};
        }};
        """
    )
    try:
        page = runtime.call("catalogPage", "apps-trending", 2)
        assert runtime.context.eval("globalThis.__requestedUrl") == (
            "https://en.aptoide.com/apps/trending?page=2"
        )
        assert page["hasMore"] is True
        assert page["apps"] == [
            {
                "id": "https://example-app.en.aptoide.com/app",
                "name": "Example App",
                "packageName": "com.example.app",
                "version": "2.1.0",
                "size": "12 MB",
                "updatedAt": "",
                "category": "应用",
                "iconUrl": "https://cdn.aptoide.com/example.png",
            }
        ]
    finally:
        runtime.close()


def test_downloadit_catalog_is_non_paged_and_uses_fixed_queries():
    runtime = source_runtime("downloadit.js")
    runtime.context.eval(
        """
        globalThis.__catalogSearches = [];
        source.search = async (query, page) => {
          globalThis.__catalogSearches.push([query, page]);
          return [{id: 'https://example.en.download.it/android', name: query}];
        };
        """
    )
    try:
        first = runtime.call("catalogPage", "tools", 1)
        second = runtime.call("catalogPage", "tools", 2)
        searches = json.loads(
            runtime.context.eval("JSON.stringify(globalThis.__catalogSearches)")
        )
        assert first["apps"][0]["name"] == "tools"
        assert first["hasMore"] is False
        assert second == {"apps": [], "hasMore": False}
        assert searches == [["tools", 1]]
    finally:
        runtime.close()


def call_apktodo_download(candidate: dict, responses: dict[str, str]):
    runtime = source_runtime("apktodo.js")
    runtime.context.eval(
        f"""
        globalThis.__responses = {json.dumps(responses)};
        globalThis.apkmesh.request = async (url) => {{
          if (!Object.prototype.hasOwnProperty.call(globalThis.__responses, url)) {{
            throw new Error('HTTP 404: ' + url);
          }}
          return globalThis.__responses[url];
        }};
        """
    )
    try:
        return runtime.call("resolveDownloads", [candidate], None)
    finally:
        runtime.close()


def test_apktodo_falls_back_to_name_slug_and_accepts_download_without_apk_label():
    candidate = {
        "label": "Minecraft",
        "url": "https://minecraft-free.apktodo.io/prepare",
        "size": "805 MB",
    }
    responses = {
        candidate["url"]: (
            '<div id="download-container">'
            '<a href="https://minecraft-free.apktodo.io/download">Continue</a>'
            "</div>"
        ),
        "https://minecraft-free.apktodo.io/download": "<main>No links yet</main>",
        "https://apktodo.net/minecraft/": (
            '<div class="btn_download">'
            '<a href="https://apktodo.net/download/minecraft-33928">Download</a>'
            "</div>"
        ),
        "https://apktodo.net/download/minecraft-33928": (
            '<div class="item item-apk">'
            '<a href="https://apktodo.net/download/mod/minecraft-33928-888">'
            "<span>Download Minecraft [805 MB]</span>"
            "</a></div>"
        ),
    }

    downloads = call_apktodo_download(candidate, responses)

    assert len(downloads) == 1
    assert downloads[0]["url"] == (
        "https://apktodo.net/download/mod/minecraft-33928-888"
    )
    assert downloads[0]["size"] == "805 MB"
    assert downloads[0]["headers"]["Referer"] == (
        "https://apktodo.net/download/minecraft-33928"
    )


def test_apktodo_rejects_explicit_pc_download_pages():
    candidate = {
        "label": "Example Mod",
        "url": "https://example-mod.apktodo.io/prepare",
        "size": "20 MB",
    }
    responses = {
        candidate["url"]: (
            '<div id="download-container">'
            '<a href="https://example-mod.apktodo.io/download">Continue</a>'
            "</div>"
        ),
        "https://example-mod.apktodo.io/download": "<main>No links yet</main>",
        "https://apktodo.net/example-mod/": (
            '<div class="btn_download">'
            '<a href="https://apktodo.net/download/example-mod-1">Download</a>'
            "</div>"
        ),
        "https://apktodo.net/download/example-mod-1": (
            "<h2>Example Mod for PC</h2>"
            '<div class="item item-apk">'
            '<a href="https://apktodo.net/download/mod/example-mod-1-2">'
            "<span>Download Example Mod [20 MB]</span>"
            "</a></div>"
        ),
    }

    assert call_apktodo_download(candidate, responses) == []
