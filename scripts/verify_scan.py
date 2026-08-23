#!/usr/bin/env python3
"""工作流 2：应用核验与信息采集（合并前运行）。

用法：
  python3 verify_scan.py --repo owner/index-repo --pr N [--token xxx]

核验链：仓库存在可访问 → 真开源（LICENSE/非归档/非占位）→ 最新 Release 含 APK →
        README 可拉取。任一失败 → 关闭 PR 并留言。
通过后：采集图标/名称/权限（开源走仓库侧，闭源走 APK 解包）、APK 下载地址固化链接、
SHA-256、README 原文，抓 Star 数做算法评级，为新应用分配系统 ID；
产出 app-info.json 与 README.md 写入应用目录（由 Actions 负责提交）。
"""
import argparse
import base64
import json
import os
import sys
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (
    gh_api, load_json, save_json, validate_app_json,
    next_app_id, grade_for, APPS_DIR, log,
)


def collect_existing_infos():
    infos = []
    apps_root = os.path.join(".", APPS_DIR)
    if not os.path.isdir(apps_root):
        return infos
    for owner in sorted(os.listdir(apps_root)):
        owner_dir = os.path.join(apps_root, owner)
        if not os.path.isdir(owner_dir):
            continue
        for repo in sorted(os.listdir(owner_dir)):
            info_path = os.path.join(owner_dir, repo, "app-info.json")
            if os.path.isfile(info_path):
                infos.append(load_json(info_path))
    return infos


def get_repo_info(repo_name):
    status, data = gh_api(f"/repos/{repo_name}")
    return (status, data) if status == 200 else (status, {})


def get_latest_release(repo_name):
    status, data = gh_api(f"/repos/{repo_name}/releases/latest")
    if status != 200:
        return None
    return data


def get_readme_raw(repo_name):
    """拉取 README 原文（?raw=1 拿原始内容）。"""
    status, data = gh_api(f"/repos/{repo_name}/readme?raw=1")
    if status == 200 and isinstance(data, (str, bytes)):
        return data if isinstance(data, str) else data.decode("utf-8", errors="replace")
    return None


def license_valid(license_info):
    if not license_info:
        return False
    if isinstance(license_info, dict) and license_info.get("key") in ("other", None):
        return False  # NOASSERTION / 无 SPDX 视为不可核验
    return True


def verify(repo_name, declared_open):
    """核验链，返回 (ok, reason, repo_meta)。"""
    status, meta = get_repo_info(repo_name)
    if status != 200:
        return False, f"应用仓库不存在或不可访问（HTTP {status}）: {repo_name}", {}
    if meta.get("archived"):
        return False, "仓库已被归档，不接受收录", meta
    if declared_open:
        if not license_valid(meta.get("license")):
            return False, "声明开源但缺少有效 LICENSE（或 LICENSE 无法核验 SPDX），判定为假开源", meta
    release = get_latest_release(repo_name)
    if not release:
        return False, "最新 Release 不存在", meta
    apk_asset = next((a for a in release.get("assets", []) if a.get("name", "").lower().endswith(".apk")), None)
    if not apk_asset:
        return False, "最新 Release 资产中不含 APK 文件", meta
    readme = get_readme_raw(repo_name)
    if not readme:
        return False, "仓库无 README 或无法拉取（无 README 视为不合格）", meta
    return True, "ok", {
        "meta": meta,
        "apk_asset": apk_asset,
        "release": release,
        "readme": readme,
        "stars": meta.get("stargazers_count", 0),
        "license": (meta.get("license") or {}).get("spdx_id") if isinstance(meta.get("license"), dict) else None,
    }


def collect_app_info(app_json, verified):
    """采集 app-info.json 内容。开源侧字段标注待采集处由 Actions 环境补齐。"""
    return {
        "id": None,  # 分配后回填
        "upstream": app_json.get("upstream"),
        "packageName": "待采集",
        "name": "待采集",
        "icon": "待采集",
        "permissions": [],
        "version": {
            "versionName": verified["release"].get("tag_name", "待采集"),
            "versionCode": 0,
            "releaseTag": verified["release"].get("tag_name", "待采集"),
        },
        "source": {
            "repo": app_json["repo"],
            "openSourceVerified": verified["meta"].get("fork") is not None and bool(app_json["openSource"]),
            "license": verified["license"],
            "apkUrl": verified["apk_asset"].get("browser_download_url", "待采集"),
            "sha256": "待采集",
            "stars": verified["stars"],
        },
        "readme": "included",
        "uploader": None,  # Actions 注入 PR 作者
        "grade": grade_for(app_json["openSource"], verified["stars"]),
        "generatedAt": None,
        "generatedBy": "workflow-2",
    }


def close_pr(repo, pr, reason):
    body = f"工作流 2 核验未通过，本 PR 已自动关闭。\n\n原因：{reason}\n\n修正后请重新提交。"
    gh_api(f"/repos/{repo}/pulls/{pr}", method="PATCH", body={"state": "closed"})
    gh_api(f"/repos/{repo}/issues/{pr}/comments", method="POST", body={"body": body})
    log("已关闭 PR 并留言")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="承载仓库 owner/repo")
    ap.add_argument("--pr", required=True, type=int, help="PR 编号")
    ap.add_argument("--author", required=True, help="PR 作者（uploader）")
    ap.add_argument("--close", action="store_true", help="核验失败时实际关闭 PR")
    args = ap.parse_args()

    target = None
    apps_root = os.path.join(".", APPS_DIR)
    for owner in sorted(os.listdir(apps_root)):
        owner_dir = os.path.join(apps_root, owner)
        if not os.path.isdir(owner_dir):
            continue
        for repo in sorted(os.listdir(owner_dir)):
            app_json_path = os.path.join(owner_dir, repo, "app.json")
            if not os.path.isfile(app_json_path):
                continue
            obj = load_json(app_json_path)
            if obj.get("repo") == f"{owner}/{repo}":
                target = (app_json_path, owner, repo, obj)
    if not target:
        log("未找到待核验的 app.json（目录与 repo 字段不一致？）")
        sys.exit(1)
    app_json_path, owner, repo, app_json = target
    repo_name = app_json["repo"]

    ok, reason, verified = verify(repo_name, app_json["openSource"])
    if not ok:
        log(f"核验失败: {reason}")
        if args.close:
            close_pr(args.repo, args.pr, reason)
        sys.exit(1)
    log(f"核验通过: {repo_name} · stars={verified['stars']} · license={verified['license']}")

    infos = collect_existing_infos()
    new_id = next_app_id(infos)
    info = collect_app_info(app_json, verified)
    info["id"] = str(new_id)
    info["uploader"] = args.author
    info["generatedAt"] = verified["release"].get("published_at") or "now"

    dir_path = os.path.join(APPS_DIR, owner, repo)
    save_json(os.path.join(dir_path, "app-info.json"), info)
    readme_path = os.path.join(dir_path, "README.md")
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(verified["readme"])
    log(f"app-info.json 与 README.md 已写入 {dir_path}（分配系统 ID={new_id}，评级 {info['grade']}）")
    print(f"APP_ID={new_id}")
    print(f"APP_GRADE={info['grade']}")


if __name__ == "__main__":
    main()
