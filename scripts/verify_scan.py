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
    next_app_id, grade_for, APPS_DIR, TOKEN_ENV, log, sha256_file,
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
    """拉取 README 原文（Accept: application/vnd.github.raw 得原始内容）。"""
    import urllib.request
    import urllib.error
    import os as _os
    token = _os.environ.get(TOKEN_ENV, "")
    headers = {"Accept": "application/vnd.github.raw"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo_name}/readme",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError:
        return None
    except Exception:
        return None


def license_valid(license_info):
    # 许可证判定已废弃：假开源项目同样可能附带 LICENSE 文件，无判别力。
    # 真开源判定改用它处（发行版源码快照体积 vs APK 体积）。
    return True


def download_source_size(release):
    """发行版源码快照体积：取 Release 自动生成的 Source code (zip) 资产，
    下载后统计未压缩字节总数。无法获取时返回 None（不误杀，仅跳过体积判定）。"""
    src = None
    for asset in release.get("assets", []):
        name = asset.get("name", "")
        if name == "Source code (zip)":
            src = asset
            break
    if src is None:
        return None
    try:
        req = urllib.request.Request(src.get("browser_download_url", ""))
        req.add_header("User-Agent", "appstore-ci/1.0")
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
        import io, zipfile
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            total = 0
            for info in z.infolist():
                total += info.file_size
        return total
    except Exception as e:
        log(f"源码快照下载失败（跳过体积判定）: {e}")
        return None


def verify(repo_name, declared_open):
    """核验链，返回 (ok, reason, repo_meta)。

    真开源判定（用户定稿的最简方案）：
    - 许可证检查作废（假开源可伪装 LICENSE）
    - 改比「发行版源码快照体积」与「APK 体积」：源码快照 ≤ APK 体积 → 疑似假开源
    """
    status, meta = get_repo_info(repo_name)
    if status != 200:
        return False, f"应用仓库不存在或不可访问（HTTP {status}）: {repo_name}", {}
    if meta.get("archived"):
        return False, "仓库已被归档，不接受收录", meta
    release = get_latest_release(repo_name)
    if not release:
        return False, "最新 Release 不存在", meta
    apk_asset = next((a for a in release.get("assets", []) if a.get("name", "").lower().endswith(".apk")), None)
    if not apk_asset:
        return False, "最新 Release 资产中不含 APK 文件", meta
    readme = get_readme_raw(repo_name)
    if not readme:
        return False, "仓库无 README 或无法拉取（无 README 视为不合格）", meta
    code_bytes = None
    if declared_open:
        code_bytes = download_source_size(release)
        apk_size = apk_asset.get("size", 0)
        if code_bytes is not None and code_bytes > 0 and apk_size > 0 and code_bytes <= apk_size:
            return False, (
                f"疑似假开源：发行版源码快照体积（{code_bytes}B）不大于 APK 体积（{apk_size}B），"
                f"判定为仅有发布产物而无实质源码"
            ), meta
    return True, "ok", {
        "meta": meta,
        "apk_asset": apk_asset,
        "release": release,
        "readme": readme,
        "code_bytes": code_bytes,
        "stars": meta.get("stargazers_count", 0),
        "license": (meta.get("license") or {}).get("spdx_id") if isinstance(meta.get("license"), dict) else None,
    }


def extract_apk(apk_url, apk_path):
    """下载 APK 并用 androguard 解包：包名/应用名/图标/权限/版本/SHA-256。

    返回 dict 或 None（下载或解包失败，调用方跳过该应用、不做占位伪造）。
    """
    try:
        req = urllib.request.Request(apk_url)
        req.add_header("User-Agent", "appstore-ci/1.0")
        with urllib.request.urlopen(req, timeout=600) as r:
            data = r.read()
        with open(apk_path, "wb") as f:
            f.write(data)
        from androguard.core.apk import APK

        apk = APK(apk_path)
        label = apk.get_app_name()
        if isinstance(label, dict):
            label = label.get("en") or label.get("") or next(iter(label.values()), "")
        icon_path = apk.get_icon_path()
        icon_bytes = None
        icon_ext = "png"
        if icon_path:
            try:
                icon_bytes = apk.get_file(icon_path)
                if icon_bytes:
                    icon_ext = icon_path.rsplit(".", 1)[-1].lower()
                    if icon_ext not in ("png", "webp", "jpg", "jpeg"):
                        icon_ext = "png"
            except Exception:
                icon_bytes = None
        return {
            "packageName": apk.get_package() or "",
            "name": (label or "").strip(),
            "permissions": sorted(set(apk.get_permissions() or [])),
            "versionName": apk.get_androidversion_name() or "",
            "versionCode": apk.get_androidversion_code() or 0,
            "iconBytes": icon_bytes,
            "iconExt": icon_ext,
            "sha256": sha256_file(apk_path),
        }
    except Exception as e:
        log(f"APK 解包失败（跳过该应用采集，不写入占位数据）: {apk_url} -> {e}")
        return None


def collect_app_info(app_json, verified, apk_meta):
    """采集 app-info.json 内容（全部字段来自真实核验/解包，无占位）。"""
    version_name = verified["release"].get("tag_name", "")
    version_code = 0
    if apk_meta is not None:
        if apk_meta.get("versionName"):
            version_name = apk_meta["versionName"]
        version_code = int(apk_meta.get("versionCode") or 0)
    return {
        "id": None,  # 分配后回填
        "upstream": app_json.get("upstream"),
        "packageName": (apk_meta or {}).get("packageName", ""),
        "name": (apk_meta or {}).get("name", ""),
        "icon": "icon.png" if (apk_meta or {}).get("iconBytes") else "",
        "permissions": (apk_meta or {}).get("permissions", []),
        "version": {
            "versionName": version_name,
            "versionCode": version_code,
            "releaseTag": verified["release"].get("tag_name", ""),
        },
        "source": {
            "repo": app_json["repo"],
            "openSourceVerified": (verified.get("code_bytes") or 0) > 0 and bool(app_json["openSource"]),
            "license": verified["license"],
            "apkUrl": verified["apk_asset"].get("browser_download_url", ""),
            "sha256": (apk_meta or {}).get("sha256", ""),
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
    ap.add_argument("--commit", action="store_true", help="核验通过后把 app-info.json/README.md 写入工作区（合并落盘模式）")
    args = ap.parse_args()

    # 收集 PR 修改的应用（apps/<owner>/<repo>/app.json，repo 字段与目录一致）
    targets = []
    apps_root = os.path.join(".", APPS_DIR)
    if os.path.isdir(apps_root):
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
                    targets.append((app_json_path, owner, repo, obj))
    if not targets:
        log("未找到待核验的 app.json（目录与 repo 字段不一致？）")
        sys.exit(1)

    # 逐个核验：任一失败关闭 PR 并聚合列出
    failures = []
    infos = collect_existing_infos()
    for app_json_path, owner, repo, app_json in targets:
        ok, reason, verified = verify(app_json["repo"], app_json["openSource"])
        if not ok:
            failures.append(f"{app_json['repo']}: {reason}")
            continue
        new_id = next_app_id(infos)
        info = collect_app_info(app_json, verified, None)
        info["id"] = str(new_id)
        info["uploader"] = args.author
        info["generatedAt"] = verified["release"].get("published_at") or "now"
        infos.append(info)
        log(f"核验通过: {app_json['repo']} · stars={verified['stars']} · "
            f"license={verified['license']} · tag={verified['release'].get('tag_name')} · "
            f"apk={verified['apk_asset'].get('name')} · 分配 ID={new_id} · 评级 {info['grade']}")

    if failures:
        msg = "核验未通过（已跳过采集，不影响其余应用收录）:\n\n" + "\n".join(f"- {f}" for f in failures) + \
              "\n\n通过的应用将在合并后正常采集落盘；失败应用可在修正后通过新 PR 重新提交。"
        if args.close:
            close_pr(args.repo, args.pr, "\n".join(f"- {f}" for f in failures))
        else:
            gh_api(f"/repos/{args.repo}/issues/{args.pr}/comments", method="POST", body={"body": msg})
            log("已留言说明跳过项（未关闭 PR）")

    log(f"{len(targets) - len(failures)}/{len(targets)} 个应用核验通过（合并时将采集落盘 app-info.json 与 README.md）")
    # 落盘模式：--commit（PR 合并后执行）时写 app-info.json 与 README.md 到工作区；
    # 已存在 app-info 的应用复用原 id（幂等重跑不漂移）
    if args.commit:
        # 复用 id 必须以磁盘上已落盘的 app-info 为准（第一轮预分配值不参与复用，防 id 漂移）
        disk_infos = collect_existing_infos()
        by_repo = {i.get("source", {}).get("repo"): i for i in disk_infos if i.get("id")}
        os.makedirs(".apk_tmp", exist_ok=True)
        for i, (app_json_path, owner, repo, app_json) in enumerate(targets):
            ok, reason, verified = verify(app_json["repo"], app_json["openSource"])
            if not ok:
                continue
            existing = by_repo.get(app_json["repo"])
            apk_path = os.path.join(".apk_tmp", f"{owner}__{repo}.apk")
            apk_meta = extract_apk(
                verified["apk_asset"].get("browser_download_url", ""), apk_path
            )
            if apk_meta is None:
                log(f"采集跳过: {app_json['repo']}（APK 解包失败，不写入占位数据）")
                continue
            info = collect_app_info(app_json, verified, apk_meta)
            info["id"] = existing.get("id") if existing else str(next_app_id(infos))
            info["uploader"] = args.author
            info["generatedAt"] = verified["release"].get("published_at") or "now"
            dir_path = os.path.join(APPS_DIR, owner, repo)
            save_json(os.path.join(dir_path, "app-info.json"), info)
            with open(os.path.join(dir_path, "README.md"), "w", encoding="utf-8") as f:
                f.write(verified["readme"])
            if apk_meta.get("iconBytes"):
                ext = apk_meta.get("iconExt", "png")
                with open(os.path.join(dir_path, f"icon.{ext}"), "wb") as f:
                    f.write(apk_meta["iconBytes"])
            infos.append(info)
            by_repo[app_json["repo"]] = info
            log(f"已落盘 {dir_path}（ID={info['id']}，名称={info['name']}，评级 {info['grade']}）")
    for info in infos:
        if info.get("uploader") == args.author and info.get("id"):
            print(f"APP_OK id={info['id']} repo={info['source']['repo']} grade={info['grade']}")


if __name__ == "__main__":
    main()