#!/usr/bin/env python3
"""工作流 4（v2 通道）：清单驱动同步资产生成与发布（AppStore 同步机制 v2 规格 §5.1）。

P0 双轨：与 v1（aggregate.py 全量/增量 zip 发布）并行，本脚本产出 v2 资产：
- dist/index.v2.json      列表层索引（含图标 blurhash 占位，§4.2；重资产移至 bundle）
- dist/manifest.v2.json   对象级 SHA 清单（§4.1）
- Release（tag = dist-<ts>）：manifest.v2.json + index.v2.json +
  仅当期 SHA 变化的 bundles/<id>.bundle.zip（bundle 实体不进仓库，作为 Release 资产，§3.2）

与 v1 的关键差异（§5.1）：
- 删除下载上期 full.zip（~131MB）做 diff：与仓库内 dist/manifest.v2.json（~25KB）对比即知变更
- 增量 = 清单对比结果，不再生成 incremental.zip
- bundle 只上传 SHA 变化的条目；未变化 bundle 复用上期 Release 的资产 URL（历史 URL 永久有效）
- 无任何变化 → 零动作（不提交、不发 Release）

bundle 格式：P0 用 zip（DEFLATE，客户端 BundleLoader 的 ZipInputStream 直接可解，§6.6），
P1 换 zstd（客户端引入 zstd-jni 后本脚本改 .bundle.zst 即可）。

用法：
  python3 scripts/aggregate_v2.py --repo owner/index-repo [--dry-run]
环境变量：GH_TOKEN（发布必需）；GITHUB_ACTIONS=true 且 MAIN_PAT 存在时用于 bot 推送 main
（main 分支保护要求 PR，GITHUB_TOKEN 会被 GH006 拒绝，沿用 merge-settle 的 MAIN_PAT 方案）。
"""
import argparse
import datetime
import glob
import hashlib
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import gh_api, find_app_dirs, load_json, sha256_file, log

# 图标 blurhash（CI 预装 blurhash+pillow+numpy；缺失时优雅降级为空串，客户端容忍空白 iconBlurhash）
try:
    import numpy as _np
    from blurhash import encode as _blurhash_encode
except Exception:
    _np = None
    _blurhash_encode = None

BUNDLE_EXT = ".bundle.zip"  # §6.6：P0 先 zip（DEFLATE 零依赖），P1 换 zstd
BLURHASH_X = 4
BLURHASH_Y = 3


def find_icon(dir_path):
    """apps/<owner>/<repo> 下的图标文件（与 aggregate.py 同规则）。"""
    for pat in ("icon.*", "Icon.*", "app_icon.*", "App_Icon.*", "appicon.*"):
        matches = sorted(glob.glob(os.path.join(dir_path, pat)))
        if matches:
            return matches[0]
    return None


def icon_blurhash(icon_path):
    """图标 blurhash（§4.2 列表页加载占位，客户端 BlurHashDecoder 解码）。失败返回空串。"""
    if _blurhash_encode is None:
        return ""
    try:
        from PIL import Image

        img = Image.open(icon_path).convert("RGB")
        img.thumbnail((128, 128))  # blurhash 只需粗略色块信息，缩放提速
        return _blurhash_encode(_np.array(img), components_x=BLURHASH_X, components_y=BLURHASH_Y)
    except Exception as e:
        log(f"icon blurhash 计算失败 {icon_path}: {e}")
        return ""


def build_bundle(aid, dir_path, info):
    """打包详情包（§4.3）：detail.json + README.md（readme-assets/ → <aid>_files/ 前缀改写）+ <aid>_files/**。

    返回 bundle 字节；无 README 也产出含 detail.json 的最小包（详情页所需元数据）。
    """
    files = {}
    readme_path = os.path.join(dir_path, "README.md")
    if os.path.isfile(readme_path):
        with open(readme_path, "rb") as f:
            md = f.read()
        dep_dir = os.path.join(dir_path, "readme-assets")
        if os.path.isdir(dep_dir):
            md = md.replace(b"readme-assets/", f"{aid}_files/".encode())
            for root, _dirs, names in os.walk(dep_dir):
                for name in names:
                    rel = os.path.relpath(os.path.join(root, name), dep_dir)
                    with open(os.path.join(root, name), "rb") as f:
                        files[f"{aid}_files/{rel}"] = f.read()
        files["README.md"] = md
    src = info.get("source", {}) or {}
    detail = {
        "upstream": info.get("upstream"),
        "permissions": info.get("permissions", []),
        "readme": "README.md",
        "source": {
            "license": src.get("license"),
            "apkUrl": src.get("apkUrl", ""),
            "sha256": src.get("sha256", ""),
            "openSourceVerified": bool(src.get("openSourceVerified", False)),
        },
    }
    files["detail.json"] = json.dumps(detail, ensure_ascii=False, indent=2).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in sorted(files.items()):
            # 固定条目时间戳（zipfile 默认写当前时间）→ bundle 字节确定性：
            # §3.3 内容稳定、§8 无变更期两版 manifest 的 bundle SHA 完全一致
            zi = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, data)
    return buf.getvalue()


def build_v2_assets():
    """扫描 apps/**，构建 v2 三件套素材。

    返回 (index_v2, icons, bundles, bundle_blobs)：
    - index_v2: {aid: 列表层元数据}（§4.2，重资产字段已移至 bundle）
    - icons: [ManifestObjectRef]（§4.1，path 为仓库内相对路径）
    - bundles: [ManifestObjectRef]（§4.1，url 稍后按 tag/上期复用解析）
    - bundle_blobs: {aid: bytes}
    """
    index_v2 = {}
    icons = []
    bundles = []
    bundle_blobs = {}
    for app_json_path, owner, repo in find_app_dirs("."):
        dir_path = os.path.dirname(app_json_path)
        info_path = os.path.join(dir_path, "app-info.json")
        if not os.path.isfile(info_path):
            log(f"跳过 {owner}/{repo}（缺 app-info.json）")
            continue
        try:
            info = load_json(info_path)
            app = load_json(app_json_path)
            aid = str(info["id"])
        except (KeyError, ValueError) as e:
            log(f"跳过 {owner}/{repo}（元数据异常：{e}）")
            continue
        icon_path = find_icon(dir_path)
        if icon_path:
            icon_rel = os.path.relpath(icon_path, ".").replace(os.sep, "/")  # apps/.../icon.png
            icons.append({"id": aid, "path": icon_rel, "sha256": sha256_file(icon_path), "size": os.path.getsize(icon_path)})
        index_v2[aid] = {
            "id": aid,
            "repo": app["repo"],
            "name": info.get("name", ""),
            "packageName": info.get("packageName", ""),
            "summary": app.get("summary", ""),
            "openSource": bool(app.get("openSource", False)),
            "grade": info.get("grade", "E"),
            "specialPermissions": app.get("specialPermissions", ["none"]),
            "version": info.get("version", {}),
            # §4.2：icon 存 manifest.icons[].id（客户端解析为 assets/icons/<id>.png）；
            # 无图标应用置空串，与 v1 语义一致（manifest.icons 仅收录存在的图标）
            "icon": aid if icon_path else "",
            "iconBlurhash": icon_blurhash(icon_path) if icon_path else "",
        }
        bundle_bytes = build_bundle(aid, dir_path, info)
        bundle_blobs[aid] = bundle_bytes
        bundles.append({"id": aid, "url": "", "sha256": hashlib.sha256(bundle_bytes).hexdigest(), "size": len(bundle_bytes)})
    return index_v2, icons, bundles, bundle_blobs


def serialize_json(obj, pretty=False):
    """固定序列化（内容稳定 → 镜像缓存可命中，§3.3）。返回字节。"""
    if pretty:
        return (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode()
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()


def read_prev_manifest():
    """读取上期已发布 manifest（§5.1 step 4：仓库内 dist/manifest.v2.json 即可，~25KB）。"""
    path = "dist/manifest.v2.json"
    if not os.path.isfile(path):
        return None
    try:
        return json.loads(open(path, encoding="utf-8").read())
    except Exception as e:
        log(f"上期 manifest 解析失败（视为无上期）：{e}")
        return None


def manifest_unchanged(index_v2, icons, bundles, prev):
    """内容相关部分对比（§5.1 step 4 / §8 验收：无变更期两版 manifest 完全一致）。

    忽略 generatedAt/commit/releaseTag 等元字段（每次生成都不同，不代表内容变化）。
    """
    index_bytes = serialize_json(index_v2)
    if prev.get("index", {}).get("sha256") != hashlib.sha256(index_bytes).hexdigest():
        return False
    cur_icons = {(i["id"], i["sha256"]) for i in icons}
    prev_icons = {(i.get("id"), i.get("sha256")) for i in prev.get("icons", [])}
    if cur_icons != prev_icons:
        return False
    cur_bundles = {(b["id"], b["sha256"]) for b in bundles}
    prev_bundles = {(b.get("id"), b.get("sha256")) for b in prev.get("bundles", [])}
    return cur_bundles == prev_bundles


def git_head_sha():
    r = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def git_commit_and_push(repo, tag):
    """bot commit dist/ 到 main（§5.1 step 5）。

    main 分支保护要求 PR + 状态检查（GITHUB_TOKEN 推送会被 GH006 拒绝），沿用
    merge-settle 的 MAIN_PAT（仓库管理员，enforce_admins=false 可绕过）直接推送；
    无 MAIN_PAT 时退回 GITHUB_TOKEN。
    """
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    subprocess.run(["git", "config", "user.name", "appstore-ci"])
    subprocess.run(["git", "config", "user.email", "appstore-ci@users.noreply.github.com"])
    # §3.2：bundle 实体不进仓库（Release 资产），仓库 dist/ 仅落 manifest + index 两个文本文件
    subprocess.run(["git", "add", "dist/manifest.v2.json", "dist/index.v2.json"])
    r = subprocess.run(["git", "commit", "-m", f"chore(v2): 清单驱动资产生成（{tag}）"])
    if r.returncode != 0:
        log("dist 无变更，跳过 bot 提交")
        return
    pat = os.environ.get("MAIN_PAT") or os.environ.get("GH_TOKEN", "")
    subprocess.run(["git", "remote", "set-url", "origin", f"https://x-access-token:{pat}@github.com/{repo}.git"])
    # actions/checkout 的 extraheader（GITHUB_TOKEN）优先级高于 URL 内嵌凭据 → 必须 unset
    subprocess.run(["git", "config", "--unset-all", "http.https://github.com/.extraheader"])
    pushed = False
    for _ in range(5):
        if subprocess.run(["git", "push", "origin", "HEAD:main"]).returncode == 0:
            pushed = True
            break
        subprocess.run(["git", "pull", "--rebase", "origin", "main"])
        time.sleep(4)
    if not pushed:
        log("::error::dist 推送失败（GH006 或网络错误，需人工介入）")
        sys.exit(2)


def create_release(repo, tag, name, assets, token):
    """assets: {filename: bytes}（§5.1 step 6：manifest + index + 仅当期变化的 bundle）。"""
    status, rel = gh_api(f"/repos/{repo}/releases", method="POST", body={
        "tag_name": tag,
        "name": name,
        "body": "v2 清单驱动同步资产生成",
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
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/octet-stream")
        req.add_header("Accept", "application/vnd.github+json")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                log(f"上传 {fname}: HTTP {resp.status}")
        except Exception as e:
            log(f"上传 {fname} 失败: {e}")
            sys.exit(2)


def cleanup_releases(repo, token, keep_days=7, referenced_tags=frozenset()):
    """§5.2 Release 治理：删除 7 天前的 dist-* Release；被当前 manifest 引用的 tag 永不删除。

    清理规则：被最新 manifest 引用的 bundle 全部集中在最新 1~2 个 tag 中，删除是安全的。
    """
    status, releases = gh_api(f"/repos/{repo}/releases?per_page=100")
    if status != 200:
        return
    now = time.time()
    for rel in releases:
        tag = rel.get("tag_name", "")
        if not tag.startswith("dist-") or tag in referenced_tags:
            continue
        try:
            created = datetime.datetime.strptime(rel.get("created_at", ""), "%Y-%m-%dT%H:%M:%SZ").timestamp()
        except ValueError:
            continue
        if now - created > keep_days * 86400:
            gh_api(f"/repos/{repo}/releases/{rel['id']}", method="DELETE")
            log(f"清理旧 Release {tag}")


def main():
    ap = argparse.ArgumentParser(description="v2 清单驱动同步资产生成与发布（§5.1）")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--dry-run", action="store_true", help="只构建与写入 dist/，不提交、不发版")
    args = ap.parse_args()
    token = os.environ.get("GH_TOKEN", "")

    # 1. 扫描 apps/** 构建 v2 素材
    index_v2, icons, bundles, bundle_blobs = build_v2_assets()
    if not icons:
        log("无任何已收录应用，不发布")
        sys.exit(0)

    # 2. 读取上期已发布 manifest
    prev = read_prev_manifest()

    # 3. 无任何变化 → 结束（不提交、不发 Release，§5.1 step 4）
    if prev is not None and manifest_unchanged(index_v2, icons, bundles, prev):
        log("无变更（index/icons/bundles 与上期一致），不提交、不发 Release")
        sys.exit(0)

    # 4. 有变化：决定 tag 并解析 bundle URL（未变化复用上期 tag URL，§5.1）
    ts = datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S")
    tag = f"dist-{ts}"
    prev_bundle_sha = {b.get("id"): b.get("sha256") for b in (prev or {}).get("bundles", [])}
    prev_bundle_url = {b.get("id"): b.get("url") for b in (prev or {}).get("bundles", [])}
    changed_ids = []
    for b in bundles:
        if b["id"] in prev_bundle_sha and prev_bundle_sha[b["id"]] == b["sha256"] and b["id"] in prev_bundle_url:
            b["url"] = prev_bundle_url[b["id"]]  # 未变化：复用上期 URL（历史 URL 永久有效）
        else:
            b["url"] = f"{tag}/bundles/{b['id']}{BUNDLE_EXT}"
            changed_ids.append(b["id"])

    # 5. 生成 manifest.v2.json + index.v2.json（SHA 以实际写入字节为准）
    index_bytes = serialize_json(index_v2)
    manifest = {
        "version": 2,
        "channel": "app-index",
        "generatedAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "commit": git_head_sha(),
        "releaseTag": tag,
        "index": {"sha256": hashlib.sha256(index_bytes).hexdigest(), "size": len(index_bytes), "count": len(index_v2)},
        "icons": icons,
        "bundles": bundles,
    }
    manifest_bytes = serialize_json(manifest, pretty=True)

    # 6. 写入 dist/
    os.makedirs("dist", exist_ok=True)
    with open("dist/index.v2.json", "wb") as f:
        f.write(index_bytes)
    with open("dist/manifest.v2.json", "wb") as f:
        f.write(manifest_bytes)
    log(f"index.v2.json {len(index_bytes)}B（{len(index_v2)} 应用）/ manifest.v2.json {len(manifest_bytes)}B / "
        f"bundles 变化 {len(changed_ids)} 个（共 {len(bundles)}）")

    if args.dry_run:
        os.makedirs("dist/bundles", exist_ok=True)
        for aid in changed_ids:
            with open(os.path.join("dist/bundles", f"{aid}{BUNDLE_EXT}"), "wb") as f:
                f.write(bundle_blobs[aid])
        log("dry-run：dist/ 已写入，未提交、未发版")
        return

    # 7. bot commit dist/ 到 main
    git_commit_and_push(args.repo, tag)

    # 8. 创建 Release：manifest + index + 仅当期 SHA 变化的 bundle（§5.1 step 6）
    assets = {"manifest.v2.json": manifest_bytes, "index.v2.json": index_bytes}
    for aid in changed_ids:
        assets[f"bundles/{aid}{BUNDLE_EXT}"] = bundle_blobs[aid]
    create_release(args.repo, tag, f"v2 清单驱动同步 {ts}", assets, token)
    log(f"已发布 Release {tag}（bundle 变化 {len(changed_ids)} 个）")

    # 9. Release 治理（§5.2）：被当前 manifest 引用的 tag 永不删除
    referenced = {b["url"].split("/", 1)[0] for b in bundles if b["url"].startswith("dist-")}
    cleanup_releases(args.repo, token, referenced_tags=referenced)


if __name__ == "__main__":
    main()
