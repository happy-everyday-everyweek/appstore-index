from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .host import SourceHost
from .models import SourceManifest
from .replay import RecordingStore, ReplayStore
from .runtime import SourceRuntime
from .trace import TraceRecorder


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="apkmesh-debug",
        description="Run an APK Mesh JavaScript source without Android.",
    )
    parser.add_argument(
        "source",
        type=Path,
        help="path to the source JavaScript file",
    )
    parser.add_argument(
        "--mode",
        choices=("live", "record", "replay"),
        default="live",
        help="live network access, live recording, or exact fixture replay (default: live)",
    )
    parser.add_argument(
        "--fixture-dir",
        type=Path,
        help="directory containing replay.json when --mode replay is used",
    )
    parser.add_argument(
        "--trace",
        type=Path,
        help="write a JSON execution trace to this path",
    )
    parser.add_argument(
        "--record-dir",
        type=Path,
        help="directory where live responses are saved in record mode",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="per-source-call and browser timeout in seconds (default: 30)",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="show Chromium when a browser operation is used",
    )
    parser.add_argument(
        "--download-dir",
        type=Path,
        default=Path("downloads"),
        help="directory for source downloads (default: ./downloads)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print only JSON result data",
    )

    commands = parser.add_subparsers(dest="operation", required=True)
    commands.add_parser("inspect", help="show source manifest and capabilities")

    search = commands.add_parser("search", help="call source.search(query, page)")
    search.add_argument("query")
    search.add_argument("--page", type=int, default=1)

    package_search = commands.add_parser(
        "package-search", help="call source.packageLookupUrl(packageName) and source.details()"
    )
    package_search.add_argument("package_name")

    details = commands.add_parser("details", help="call source.details(idOrUrl)")
    details.add_argument("id_or_url")

    debug = commands.add_parser("debug", help="call source.debug(projectId, input)")
    debug.add_argument("project_id")
    debug.add_argument("input")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    source_path = args.source.expanduser().resolve()
    if not source_path.is_file():
        parser.error(f"source file not found: {source_path}")
    if args.timeout <= 0:
        parser.error("--timeout must be greater than zero")
    if args.mode == "replay" and args.fixture_dir is None:
        parser.error("--fixture-dir is required in replay mode")
    if args.mode == "record" and args.record_dir is None:
        parser.error("--record-dir is required in record mode")

    trace = TraceRecorder()
    runtime: SourceRuntime | None = None
    host: SourceHost | None = None
    recording: RecordingStore | None = None
    result: Any = None
    exit_code = 0
    try:
        replay = ReplayStore(args.fixture_dir.resolve()) if args.mode == "replay" else None
        recording = RecordingStore(args.record_dir.resolve()) if args.mode == "record" else None
        runtime = SourceRuntime(source_path, None, trace, timeout=args.timeout)
        host = SourceHost(
            runtime.manifest,
            trace,
            mode=args.mode,
            replay=replay,
            recording=recording,
            timeout=args.timeout,
            headed=args.headed,
            download_dir=args.download_dir,
        )
        runtime.attach_host(host)
        result = _run_operation(runtime, args)
    except Exception as error:
        exit_code = 1
        trace.add("run.error", error=str(error), error_type=type(error).__name__)
        if args.json:
            print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        else:
            print(f"error: {error}", file=sys.stderr)
    finally:
        if host is not None:
            host.close()
        if runtime is not None:
            runtime.close()
        if recording is not None:
            recording.save()
        if args.trace is not None:
            trace.save(args.trace.expanduser().resolve())

    if exit_code == 0:
        _print_result(result, json_only=args.json)
    return exit_code


def _run_operation(runtime: SourceRuntime, args: argparse.Namespace) -> Any:
    manifest: SourceManifest = runtime.manifest
    if args.operation == "inspect":
        return {
            "manifest": manifest.raw,
            "capabilities": {
                "network": sorted(manifest.allowed_hosts),
                "browser": manifest.allow_browser,
                "download": manifest.allow_download,
                "install": manifest.allow_install,
                "packageLookup": manifest.package_lookup,
            },
        }
    if args.operation == "search":
        return runtime.call("search", args.query, args.page)
    if args.operation == "package-search":
        if not manifest.package_lookup:
            raise ValueError("source does not declare packageLookup")
        lookup_url = runtime.call("packageLookupUrl", args.package_name)
        if not isinstance(lookup_url, str) or not lookup_url.strip():
            return []
        detail = runtime.call("details", lookup_url)
        if not isinstance(detail, dict):
            return []
        actual = str(detail.get("packageName", "")).strip()
        return [detail] if actual.casefold() == args.package_name.strip().casefold() else []
    if args.operation == "details":
        return runtime.call("details", args.id_or_url)
    if args.operation == "debug":
        return runtime.call("debug", args.project_id, args.input)
    raise ValueError(f"unknown operation: {args.operation}")


def _print_result(value: Any, *, json_only: bool) -> None:
    text = json.dumps(value, ensure_ascii=False, indent=None if json_only else 2)
    print(text)


if __name__ == "__main__":
    raise SystemExit(main())
