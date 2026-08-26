from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from apkmesh_debug.host import SourceHost
from apkmesh_debug.runtime import SourceRuntime
from apkmesh_debug.trace import TraceRecorder


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run generic home and category checks through the Python source host."
    )
    parser.add_argument(
        "source",
        type=Path,
        help="source JavaScript path",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="check only the first N categories; 0 checks every category",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="per source call timeout in seconds (default: 30)",
    )
    parser.add_argument("--trace", type=Path, help="write the execution trace to this path")
    return parser


def check_catalog(runtime: SourceRuntime, limit: int) -> dict[str, Any]:
    if runtime.has_method("catalog") and runtime.has_method("catalogPage"):
        return _check_tab_catalog(runtime, limit)
    return _check_legacy_catalog(runtime, limit)


def _check_tab_catalog(runtime: SourceRuntime, limit: int) -> dict[str, Any]:
    catalog = runtime.call("catalog")
    if not isinstance(catalog, dict):
        raise RuntimeError("catalog() did not return an object")

    tabs = catalog.get("tabs")
    if not isinstance(tabs, list):
        raise RuntimeError("catalog().tabs must be an array")
    default_tab_id = catalog.get("defaultTabId")
    if default_tab_id is not None and (
        not isinstance(default_tab_id, str)
        or default_tab_id not in {tab.get("id") for tab in tabs if isinstance(tab, dict)}
    ):
        raise RuntimeError("catalog().defaultTabId must reference a returned tab")

    selected = tabs if limit == 0 else tabs[:limit]
    checked_tabs = []
    for index, tab in enumerate(selected):
        if not isinstance(tab, dict):
            raise RuntimeError(f"catalog().tabs[{index}] must be an object")
        tab_id = tab.get("id")
        tab_name = tab.get("name")
        paged = tab.get("paged")
        if not isinstance(tab_id, str) or not tab_id.strip():
            raise RuntimeError(f"catalog().tabs[{index}].id must be a non-empty string")
        if not isinstance(tab_name, str) or not tab_name.strip():
            raise RuntimeError(f"catalog().tabs[{index}].name must be a non-empty string")
        if not isinstance(paged, bool):
            raise RuntimeError(f"catalog().tabs[{index}].paged must be a boolean")

        result = runtime.call("catalogPage", tab_id, 1)
        if not isinstance(result, dict):
            raise RuntimeError(f"catalogPage() did not return an object: {tab_id}")
        apps = result.get("apps")
        has_more = result.get("hasMore")
        _require_app_list(apps, f"catalogPage({tab_id!r}, 1).apps")
        if not isinstance(has_more, bool):
            raise RuntimeError(f"catalogPage({tab_id!r}, 1).hasMore must be a boolean")
        if not paged and has_more:
            raise RuntimeError(f"non-paged catalog tab returned hasMore=true: {tab_id}")
        checked_tabs.append(
            {
                "id": tab_id,
                "name": tab_name,
                "paged": paged,
                "apps": len(apps),
                "has_more": has_more,
                "first_app": apps[0].get("name", "") if apps else "",
            }
        )

    return {
        "ok": True,
        "catalog": {"tabs": len(tabs), "default_tab_id": default_tab_id},
        "checked_tabs": checked_tabs,
    }


def _check_legacy_catalog(runtime: SourceRuntime, limit: int) -> dict[str, Any]:
    home = runtime.call("home")
    if not isinstance(home, dict):
        raise RuntimeError("home() did not return an object")

    recommended = home.get("recommended")
    categories = home.get("categories")
    _require_app_list(recommended, "home().recommended")
    if not isinstance(categories, list):
        raise RuntimeError("home().categories must be an array")

    selected = categories if limit == 0 else categories[:limit]
    checked_tabs = []
    if recommended:
        checked_tabs.append(
            {
                "id": "__legacy_recommended__",
                "name": "Recommended",
                "paged": False,
                "apps": len(recommended),
                "has_more": False,
                "first_app": recommended[0].get("name", ""),
            }
        )
    for index, category in enumerate(selected):
        if not isinstance(category, dict):
            raise RuntimeError(f"home().categories[{index}] must be an object")

        category_id = category.get("id")
        category_name = category.get("name")
        if not isinstance(category_id, str) or not category_id.strip():
            raise RuntimeError(f"home().categories[{index}].id must be a non-empty string")
        if not isinstance(category_name, str) or not category_name.strip():
            raise RuntimeError(f"home().categories[{index}].name must be a non-empty string")

        result = runtime.call("category", category_id)
        if not isinstance(result, dict):
            raise RuntimeError(f"category() did not return an object: {category_id}")
        result_id = result.get("id")
        result_name = result.get("name")
        if not isinstance(result_id, str) or not result_id.strip():
            raise RuntimeError(f"category() returned an invalid id: {category_id}")
        if not isinstance(result_name, str) or not result_name.strip():
            raise RuntimeError(f"category() returned an invalid name: {category_id}")

        apps = result.get("apps")
        _require_app_list(apps, f"category({category_id!r}).apps")
        checked_tabs.append(
            {
                "id": result_id,
                "name": result_name,
                "paged": False,
                "apps": len(apps),
                "has_more": False,
                "first_app": apps[0].get("name", "") if apps else "",
            }
        )

    return {
        "ok": True,
        "legacy": True,
        "catalog": {"tabs": len(checked_tabs), "default_tab_id": checked_tabs[0]["id"] if checked_tabs else None},
        "checked_tabs": checked_tabs,
    }


def _require_app_list(value: Any, label: str) -> None:
    if not isinstance(value, list):
        raise RuntimeError(f"{label} must be an array")
    for index, app in enumerate(value):
        if not isinstance(app, dict):
            raise RuntimeError(f"{label}[{index}] must be an application object")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    source = args.source.expanduser().resolve()
    if not source.is_file():
        print(f"source file not found: {source}", file=sys.stderr)
        return 2
    if args.limit < 0 or args.timeout <= 0:
        print("--limit must be non-negative and --timeout must be greater than zero", file=sys.stderr)
        return 2

    trace = TraceRecorder()
    runtime: SourceRuntime | None = None
    host: SourceHost | None = None
    try:
        runtime = SourceRuntime(source, None, trace, timeout=args.timeout)
        host = SourceHost(runtime.manifest, trace, mode="live", timeout=args.timeout)
        runtime.attach_host(host)
        print(json.dumps(check_catalog(runtime, args.limit), ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        trace.add("catalog_check.error", error=str(error), error_type=type(error).__name__)
        print(f"catalog check failed: {error}", file=sys.stderr)
        return 1
    finally:
        if host is not None:
            host.close()
        if runtime is not None:
            runtime.close()
        if args.trace is not None:
            trace.save(args.trace.expanduser().resolve())


if __name__ == "__main__":
    raise SystemExit(main())
