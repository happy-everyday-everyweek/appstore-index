import importlib.util
from pathlib import Path


_MODULE_PATH = Path(__file__).parents[1] / "examples" / "check_catalog.py"
_SPEC = importlib.util.spec_from_file_location("check_catalog", _MODULE_PATH)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
check_catalog = _MODULE.check_catalog


class FakeRuntime:
    def __init__(self):
        self.calls = []

    def has_method(self, method):
        return method in {"catalog", "catalogPage"}

    def call(self, method, *args):
        self.calls.append((method, *args))
        if method == "catalog":
            return {
                "defaultTabId": "featured",
                "tabs": [
                    {"id": "featured", "name": "Featured", "paged": False},
                    {"id": "genre:action", "name": "Action", "paged": True},
                ],
            }
        if method == "catalogPage":
            assert args[1] == 1
            return {
                "apps": [{"id": "app-1", "name": "Demo"}],
                "hasMore": args[0] == "genre:action",
            }
        raise AssertionError(method)


def test_catalog_check_passes_source_defined_tab_ids():
    runtime = FakeRuntime()

    result = check_catalog(runtime, 0)

    assert result["ok"] is True
    assert result["catalog"] == {"tabs": 2, "default_tab_id": "featured"}
    assert result["checked_tabs"] == [
        {
            "id": "featured",
            "name": "Featured",
            "paged": False,
            "apps": 1,
            "has_more": False,
            "first_app": "Demo",
        },
        {
            "id": "genre:action",
            "name": "Action",
            "paged": True,
            "apps": 1,
            "has_more": True,
            "first_app": "Demo",
        },
    ]
    assert runtime.calls == [
        ("catalog",),
        ("catalogPage", "featured", 1),
        ("catalogPage", "genre:action", 1),
    ]


class LegacyRuntime:
    def __init__(self):
        self.calls = []

    def has_method(self, method):
        return False

    def call(self, method, *args):
        self.calls.append((method, *args))
        if method == "home":
            return {
                "recommended": [{"id": "app-1", "name": "Demo"}],
                "categories": [{"id": "genre:action", "name": "Action"}],
            }
        if method == "category":
            return {"id": args[0], "name": "Action", "apps": []}
        raise AssertionError(method)


def test_catalog_check_supports_legacy_home_and_categories():
    runtime = LegacyRuntime()

    result = check_catalog(runtime, 0)

    assert result["legacy"] is True
    assert len(result["checked_tabs"]) == 2
    assert runtime.calls == [("home",), ("category", "genre:action")]
