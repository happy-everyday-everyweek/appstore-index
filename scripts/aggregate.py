#!/usr/bin/env python3
"""工作流 4：应用列表聚合 Release 分发。

用法：
  python3 aggregate.py --repo owner/index-repo [--dry-run] [--token xxx]

每天运行 5 次（约每 4 小时）。变更判定：
- 当天首次运行：任一应用元数据变更 → 全量包发布
- 当天后续运行：新增应用 1 个即触发；变更应用 >= 2 个才触发 → 增量包发布
- 无变更 → 不发布

发布物（Release 三件套）：
  full.zip           全量聚合包（index.json = 全部应用元数据抽取集合）
  incremental.zip    增量包（结构化差异：新增/变更应用条目 + 移除 id）
  patch.json         解析清单（base/target/算法/校验和）
聚合包仅含元数据，绝不含 APK。旧 Release 保留不删。
"""
import argparse
import hashlib
import io
import json
import os
import sys
import time
import urllib.request
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import gh_api, find_app_dirs, load_json, save_json, sha256_file, log

PATCH_ALGO = "structured-json-v1"  # 增量包算法标识（与客户端 SyncEngine 对齐用）


def build_full_index():
    """抽取全部应用的聚合元数据，并把图标/README 作为随包资源收集。

    full.zip 结构：index.json + assets/icons/<id>.<ext> + assets/readmes/<id>.md。
    返回 (index, assets) 其中 assets 为 {包内路径: 字节}。
    """
    index = {}
    assets = {}
    for app_json_path, owner, repo in find_app_dirs("."):
        dir_path = os.path.dirname(app_json_path)
        info_path = os.path.join(dir_path, "app-info.json")
        if not os.path.isfile(info_path):
            log(f"跳过 {owner}/{repo}（缺 app-info.json）")
            continue
        info = load_json(info_path)
        app = load_json(app_json_path)
        aid = str(info["id"])
        # 图标资源：apps/<owner>/<repo>/icon.<ext> → assets/icons/<id>.<ext>
        icon_ref = ""
        import glob
        icon_files = sorted(glob.glob(os.path.join(dir_path, "icon.*")))
        if icon_files:
            icon_path = icon_files[0]
            ext = icon_path.rsplit(".", 1)[-1].lower()
            asset_key = f"assets/icons/{aid}.{ext}"
            with open(icon_path, "rb") as f:
                assets[asset_key] = f.read()
            icon_ref = asset_key
        # README 资源：README.md → assets/readmes/<id>.md
        readme_ref = ""
        readme_path = os.path.join(dir_path, "README.md")
        if os.path.isfile(readme_path):
            with open(readme_path, "rb") as f:
                assets[f"assets/readmes/{aid}.md"] = f.read()
            readme_ref = f"assets/readmes/{aid}.md"
        index[aid] = {
            "id": aid,
            "repo": app["repo"],
            "name": info.get("name", ""),
            "packageName": info.get("packageName", ""),
            "icon": icon_ref,
            "summary": app.get("summary", ""),
            "openSource": bool(app.get("openSource", False)),
            "specialPermissions": app.get("specialPermissions", ["none"]),
            "permissions": info.get("permissions", []),
            "readme": readme_ref,
            "upstream": info.get("upstream"),
            "grade": info.get("grade", "E"),
            "version": info.get("version", {}),
            "source": {
                "repo": info.get("source", {}).get("repo"),
                "license": info.get("source", {}).get("license"),
                "apkUrl": info.get("source", {}).get("apkUrl"),
                "sha256": info.get("source", {}).get("sha256"),
            },
        }
    return index, assets


def pack_zip(files):
    """files: {name: bytes} → zip 字节。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in sorted(files.items()):
            z.writestr(name, data)
    return buf.getvalue()


def diff_full(prev_index, cur_index):
    """结构化差异：新增/变更条目的完整元数据 + 移除的 id。"""
    added_changed = {}
    removed = []
    for aid, entry in cur_index.items():
        if aid not in prev_index or prev_index[aid] != entry:
            added_changed[aid] = entry
    for aid in prev_index:
        if aid not in cur_index:
            removed.append(aid)
    return added_changed, removed


def create_release(repo, tag, name, assets, token):
    """assets: {filename: bytes} """
    status, rel = gh_api(f"/repos/{repo}/releases", method="POST", body={
        "tag_name": tag,
        "name": name,
        "body": "聚合包自动发布",
        "draft": False,
        "prerelease": False,
    })
    if status not in (200, 201):
        log(f"创建 Release 失败: {status} {rel}")
        sys.exit(2)
    release_id = rel["id"]
    upload_url = f"https://uploads.github.com/repos/{repo}/releases/{release_id}/assets"
    for fname, data in assets.items():
        url = f"{upload_url}?name={fname}"
        req = __import__("urllib.request", fromlist=["Request"]).Request(
            url, data=data, method="POST")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/octet-stream")
        req.add_header("Accept", "application/vnd.github+json")
        import urllib.request
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                log(f"上传 {fname}: HTTP {resp.status}")
        except Exception as e:
            log(f"上传 {fname} 失败: {e}")
            sys.exit(2)


def latest_release_tag(repo):
    status, rel = gh_api(f"/repos/{repo}/releases/latest")
    if status == 200:
        return rel.get("tag_name")
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--run-index", type=int, default=0, help="当天第几次运行（1-5），用于变更判定")
    ap.add_argument("--dry-run", action="store_true", help="只判定与打包，不创建 Release")
    args = ap.parse_args()
    token = os.environ.get("GH_TOKEN", "")

    cur, assets = build_full_index()
    if not cur:
        log("聚合包为空（无任何已收录应用），不发布")
        sys.exit(0)

    # 取上一期全量包（最近一次聚合 Release 内的 full.zip，browser_download_url 直下；带重试）
    prev = {}
    status, releases = gh_api(f"/repos/{args.repo}/releases?per_page=10")
    if status == 200:
        for rel in releases:
            full_asset = next((a for a in rel.get("assets", []) if a["name"] == "full.zip"), None)
            if full_asset:
                for attempt in range(3):
                    try:
                        with urllib.request.urlopen(full_asset["browser_download_url"], timeout=120) as resp:
                            raw = resp.read()
                            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                                prev = json.loads(z.read("index.json"))
                        break
                    except Exception:
                        if attempt == 2:
                            raise
                        time.sleep(3)
                break

    is_first_run = args.run_index <= 1
    added_changed, removed = diff_full(prev, cur) if prev else (cur, [])
    changes = len(added_changed) + len(removed)

    if prev == cur:
        log("无变更，不发布")
        sys.exit(0)
    if not is_first_run and changes < 1:
        log("非首次运行且变更量不达标（增量需新增 1 或变更 2+），不发布")
        sys.exit(0)
    if not is_first_run:
        # 增量判定：新增 1 即触发；变更（含移除）>= 2 才触发
        new_count = len([k for k in added_changed if k not in prev])
        if new_count >= 1 or changes >= 2:
            pass
        else:
            log(f"变更量不达标（新增 {new_count}，总变更 {changes}），不发布")
            sys.exit(0)

    full_payload = {"index.json": json.dumps(cur, ensure_ascii=False, indent=2).encode()}
    full_payload.update(assets)  # 图标/README 随包资源
    full_zip = pack_zip(full_payload)
    inc_data = {"addedOrChanged": added_changed, "removed": removed}
    inc_zip = pack_zip({"incremental.json": json.dumps(inc_data, ensure_ascii=False, indent=2).encode()})
    patch = {
        "base": latest_release_tag(args.repo) or "none",
        "target": None,
        "algorithm": PATCH_ALGO,
        "incrementalSha256": hashlib.sha256(inc_zip).hexdigest(),
        "fullSha256": hashlib.sha256(full_zip).hexdigest(),
        "fullSize": len(full_zip),
    }
    log(f"变更 {changes} 项（新增/变更 {len(added_changed)}，移除 {len(removed)}）→ 生成发布物")

    if args.dry_run:
        os.makedirs("dist", exist_ok=True)
        for name, data in [("full.zip", full_zip), ("incremental.zip", inc_zip)]:
            with open(os.path.join("dist", name), "wb") as f:
                f.write(data)
        save_json("dist/patch.json", patch)
        log("dry-run：发布物已写入 dist/")
        return

    import datetime
    ts = datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S")
    tag = f"aggregate-{ts}"
    patch["target"] = tag
    create_release(args.repo, tag, f"聚合包 {ts}", {
        "full.zip": full_zip,
        "incremental.zip": inc_zip,
        "patch.json": json.dumps(patch, ensure_ascii=False, indent=2).encode(),
    }, token)
    log(f"已发布 Release {tag}")


if __name__ == "__main__":
    main()