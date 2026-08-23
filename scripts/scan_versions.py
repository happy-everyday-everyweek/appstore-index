#!/usr/bin/env python3
"""工作流 5：版本扫描自动更新。

用法：
  python3 scan_versions.py --repo owner/index-repo [--dry-run] [--token xxx]

扫描全部收录应用：解析 app.json 指向仓库的最新 Release tag 与资产，
与 app-info.json 记录对比；发现新版本（新 tag 或新 APK 资产）→ 更新
app-info.json（版本信息、APK 固化链接、SHA-256，必要时重采图标/名称/权限）。
评级不随版本扫描变动。更新结果进入工作流 4 的变更判定。
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import gh_api, find_app_dirs, load_json, save_json, log


def latest_release(repo_name):
    status, data = gh_api(f"/repos/{repo_name}/releases/latest")
    return data if status == 200 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="承载仓库 owner/repo（用于提交用，暂未用）")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    args = ap.parse_args()

    updated = 0
    for app_json_path, owner, repo in find_app_dirs("."):
        app = load_json(app_json_path)
        dir_path = os.path.dirname(app_json_path)
        info_path = os.path.join(dir_path, "app-info.json")
        if not os.path.isfile(info_path):
            log(f"跳过 {owner}/{repo}（无 app-info.json）")
            continue
        info = load_json(info_path)

        release = latest_release(app["repo"])
        if not release:
            log(f"{owner}/{repo}: 无法获取最新 Release，跳过")
            continue
        tag = release.get("tag_name")
        apk_asset = next((a for a in release.get("assets", []) if a.get("name", "").lower().endswith(".apk")), None)
        recorded_tag = info.get("version", {}).get("releaseTag")
        recorded_url = info.get("source", {}).get("apkUrl")
        new_url = apk_asset.get("browser_download_url") if apk_asset else None

        if tag == recorded_tag and new_url == recorded_url:
            log(f"{owner}/{repo}: 无新版本（{tag}）")
            continue

        log(f"{owner}/{repo}: 发现新版本 {recorded_tag} → {tag}（APK: {new_url}）")
        updated += 1
        if args.dry_run:
            continue
        info["version"] = {
            "versionName": tag,
            "versionCode": 0,  # 需 APK 解包后回填
            "releaseTag": tag,
        }
        info["source"]["apkUrl"] = new_url or info["source"].get("apkUrl")
        info["source"]["sha256"] = "待重采"
        info["generatedAt"] = release.get("published_at") or info.get("generatedAt")
        info["generatedBy"] = "workflow-5"
        save_json(info_path, info)

    log(f"扫描完成，{updated} 个应用发现新版本" + ("（dry-run，未写盘）" if args.dry_run else "，已更新 app-info.json"))
    if updated == 0:
        sys.exit(0)


if __name__ == "__main__":
    main()
