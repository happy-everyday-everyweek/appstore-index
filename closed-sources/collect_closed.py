#!/usr/bin/env python3
"""WF8 闭源应用持续采集主控（v1）。

链路：APKVision 目录分页全量巡扫 → 详情（纯 HTTP）→ 下载 APK →
机器人账号自动建镜像仓库（mirror-<包名>）→ README + 图标 + Release(APK) →
app.json 批量 PR 进承载仓库（复用 WF1/WF2/merge-settle/WF4 全链路）→ 状态回写。

对环境变量的约定：
  GH_TOKEN      承载仓库 Actions token（推分支 / 开 PR / 查索引；本地可用主账号 PAT）
  MIRROR_TOKEN  机器人账号 PAT（建镜像仓库 + 上传 Release）
  MIRROR_OWNER  机器人账号 login（镜像仓库统一归属，不进主账号）

用法：
  python3 closed-sources/collect_closed.py \
    --repo happy-everyday-everyweek/appstore-index \
    [--dry-run] [--limit 10] [--tab https://apkvision.org/app/] [--max-mb 200]

状态文件：closed-sources/state.json（已处理 id 集合 + 每个 tab 的游标），
非 dry-run 时每轮结束提交回 main（不影响 apps/** 的 WF1/merge-settle 流程）。
"""
import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
import scraper_apkvision as apv  # noqa: E402
from common import gh_api, log  # noqa: E402

TOKEN_ENV = "GH_TOKEN"
MTOKEN_ENV = "MIRROR_TOKEN"
MOWNER_ENV = "MIRROR_OWNER"
STATE_TOKEN_ENV = "MAIN_PAT"  # 主账号 PAT：main 受保护后直推状态文件用
STATE_PATH = os.path.join(HERE, "state.json")
TMP_DIR = os.path.join(HERE, ".tmp")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"

DEFAULT_TABS = [
    "https://apkvision.org/app/",
    "https://apkvision.org/games/",
    "https://apkvision.org/updated/",
    "https://apkvision.org/best-new-releases/",
]


def now_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def http_json(method, url, token=None, body=None, raw=False,
              timeout=90, binary=False, headers=None):
    """通用 HTTP（GitHub API / 上传 / 下载）。binary=True 时返回字节。"""
    req = urllib.request.Request(url, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        if not isinstance(body, bytes) and not headers:
            req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            raw_body = r.read()
            if binary:
                return r.status, raw_body
            ctype = r.headers.get("Content-Type", "")
            if "json" in ctype:
                return r.status, json.loads(raw_body)
            return r.status, raw_body.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raw_body = e.read()
        try:
            return e.code, json.loads(raw_body)
        except Exception:
            return e.code, raw_body.decode("utf-8", errors="replace")


def load_state():
    if os.path.isfile(STATE_PATH):
        try:
            with open(STATE_PATH, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"version": 1, "cursors": {}, "processed": [], "failed": {}}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.write("\n")


def indexed_packages():
    """承载仓库已收录应用的 packageName 集合（app-info.json）。"""
    pkgs = set()
    root = os.path.join(os.path.dirname(HERE), "apps")
    if not os.path.isdir(root):
        return pkgs
    for owner in os.listdir(root):
        owner_dir = os.path.join(root, owner)
        if not os.path.isdir(owner_dir):
            continue
        for repo in os.listdir(owner_dir):
            p = os.path.join(owner_dir, repo, "app-info.json")
            if os.path.isfile(p):
                try:
                    with open(p, encoding="utf-8") as f:
                        info = json.load(f)
                    if info.get("packageName"):
                        pkgs.add(info["packageName"])
                except Exception:
                    continue
    return pkgs


def slug_for(package_name, name):
    if package_name:
        return "mirror-" + re.sub(r"[^A-Za-z0-9_.-]", "-",
                                  package_name.strip().lower())
    base = re.sub(r"[^A-Za-z0-9-]+", "-",
                  (name or "app").strip().lower()).strip("-")
    return ("mirror-" + base) if base else "mirror-app"


def tag_for(version):
    v = re.sub(r"[^A-Za-z0-9.+-]", "-", (version or "").strip())
    v = re.sub(r"\.\.+", ".", v)      # git ref 不允许连续点
    v = re.sub(r"^[-.]+", "", v)      # 不允许以 -/. 开头
    if v and re.match(r"^[A-Za-z0-9]", v):
        return "v" + v if not v.startswith("v") else v
    return "v1.0.0"


def fetch_binary(url, max_bytes, referer=None):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    if referer:
        req.add_header("Referer", referer)
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise RuntimeError("binary exceeds max_bytes")
    return data


def mirror_exists(owner, slug, token):
    st, _ = http_json("GET", f"https://api.github.com/repos/{owner}/{slug}",
                      token=token)
    return st == 200


def create_mirror_repo(owner, slug, desc, token):
    st, body = http_json(
        "POST", "https://api.github.com/user/repos", token=token,
        body={"name": slug, "description": (desc or "")[:100],
              "auto_init": True, "private": False})
    if st not in (200, 201):
        raise RuntimeError("create repo failed: %s %s" % (st, body))
    return body


def upload_content(owner, slug, path, content, message, token, branch="main"):
    """PUT 文件（幂等）：先取现有 sha，存在则更新，不存在则新建。"""
    b64 = base64.b64encode(content).decode()
    st, cur = http_json(
        "GET", "https://api.github.com/repos/%s/%s/contents/%s?ref=%s"
        % (owner, slug, path, branch), token=token)
    sha = cur.get("sha") if st == 200 else None
    st, body = http_json(
        "PUT",
        "https://api.github.com/repos/%s/%s/contents/%s" % (owner, slug, path),
        token=token,
        body={"message": message, "content": b64, "branch": branch,
              "sha": sha})
    if st not in (200, 201):
        raise RuntimeError("upload content failed: %s %s %s" % (st, path, body))


def create_release(owner, slug, tag, name, body, token):
    """创建 Release；tag 已存在时改为更新同名 Release（幂等）。"""
    st, rel = http_json(
        "POST", "https://api.github.com/repos/%s/%s/releases"
        % (owner, slug), token=token,
        body={"tag_name": tag, "name": name[:80], "body": body})
    if st in (200, 201):
        return rel
    if st == 422:
        tq = urllib.parse.quote(tag, safe="")
        st2, existing = http_json(
            "GET", "https://api.github.com/repos/%s/%s/releases/tags/%s"
            % (owner, slug, tq), token=token)
        if st2 == 200:
            st3, _ = http_json(
                "PATCH", "https://api.github.com/repos/%s/%s/releases/%s"
                % (owner, slug, existing["id"]), token=token,
                body={"name": name[:80], "body": body})
            if st3 in (200, 201):
                return existing
    raise RuntimeError("create release failed: %s %s" % (st, rel))


def upload_asset(owner, slug, release_id, asset_name, data, token):
    """上传 Release 资产；同名资产先删后传（幂等）。"""
    url = ("https://uploads.github.com/repos/%s/%s/releases/%s/assets?name=%s"
           % (owner, slug, release_id, urllib.parse.quote(asset_name)))
    st, body = http_json(
        "POST", url, token=token, body=data, timeout=900,
        headers={"Content-Type": "application/octet-stream"})
    if st in (200, 201):
        return body
    if st == 422 and "already_exists" in str(body):
        st2, assets = http_json(
            "GET", "https://api.github.com/repos/%s/%s/releases/%s/assets"
            % (owner, slug, release_id), token=token)
        for a in (assets or []):
            if a.get("name") == asset_name:
                http_json("DELETE",
                          "https://api.github.com/repos/%s/%s/releases/assets/%s"
                          % (owner, slug, a["id"]), token=token)
        st, body = http_json(
            "POST", url, token=token, body=data, timeout=900,
            headers={"Content-Type": "application/octet-stream"})
        if st in (200, 201):
            return body
    raise RuntimeError("upload asset failed: %s %s" % (st, body))


def mirror_ready(owner, slug, token):
    """镜像是否就绪：最新 Release 含 APK 即为可用（WF2 同标准）。"""
    st, rel = http_json(
        "GET", "https://api.github.com/repos/%s/%s/releases/latest"
        % (owner, slug), token=token)
    if st == 200:
        for a in rel.get("assets", []):
            if a.get("name", "").lower().endswith(".apk"):
                return True
    return False


def make_readme(meta):
    lines = [
        "# " + meta["name"],
        "",
        "- **包名**: `%s`" % meta.get("packageName", ""),
        "- **版本**: %s" % meta.get("version", ""),
        "- **更新日期**: %s" % meta.get("updatedAt", ""),
        "- **来源**: [APKVision](https://apkvision.org/)",
        "- **收录时间**: %s" % now_utc(),
        "",
        "此为 AppStore 闭源采集管道自动生成的镜像仓库，APK 存放于 Releases。",
        "",
    ]
    if meta.get("summary"):
        lines.append(meta["summary"])
        lines.append("")
    return "\n".join(lines)


def make_app_json(meta, owner, slug):
    summary = meta.get("summary") or ""
    summary = summary.replace("\n", " ").strip()
    if len(summary) < 4:
        summary = "源自 APKVision 的闭源应用：" + meta.get("name", "")
    return {
        "repo": "%s/%s" % (owner, slug),
        "openSource": False,
        "name": meta.get("name", ""),
        "packageName": meta.get("packageName", ""),
        "icon": "https://raw.githubusercontent.com/%s/%s/main/icon.png"
                % (owner, slug),
        "version": meta.get("version", ""),
        "homepage": "https://apkvision.org/",
        "specialPermissions": ["none"],
        "summary": summary[:120],
    }


def direct_apk_url(detail):
    """从详情下载列表选源站 .apk 直链（xapk/站外链接跳过）。"""
    for d in detail.get("downloads") or []:
        u = (d.get("url") or "").strip()
        if not u.lower().endswith(".apk"):
            continue
        try:
            host = urllib.parse.urlsplit(u).netloc.lower()
        except Exception:
            continue
        if host == "dl.apkvision.org" or host.endswith(".apkvision.org"):
            return u
    return None


def app_slug(name, entry_id):
    """应用 slug：名称清洗后拼上详情 URL 尾部数字 id（天然唯一且可读）。"""
    base = re.sub(r"[^A-Za-z0-9-]+", "-", (name or "app").strip().lower()).strip("-")
    base = re.sub(r"-{2,}", "-", base)
    m = re.search(r"[-/](\d+)/?$", (entry_id or "").strip().rstrip("/"))
    suffix = ("-" + m.group(1)) if m else ""
    return (base + suffix) or "app"


def process_candidate(entry, detail, state, args, indexed):
    """直链模式：解析源站 APK 直链，生成标准 app.json（不下载、不建镜像仓）。
    返回 app.json dict 或 None（失败时由调用方记入 state.failed）。"""
    meta = dict(detail)
    pkg = meta.get("packageName") or ""
    if pkg and (pkg in indexed or pkg in state.get("processed_pkgs", [])):
        return None  # 已收录，跳过（静默）
    apk_url = direct_apk_url(meta)
    if not apk_url:
        raise RuntimeError("无可用源站 .apk 直链（xapk/站外链接已被过滤）")
    slug = app_slug(meta.get("name") or pkg, entry.get("id", ""))
    summary = (meta.get("summary") or "").replace("\n", " ").strip()
    if len(summary) < 4:
        summary = "源自 APKVision 的闭源应用：" + meta.get("name", "")
    return {
        "repo": "apkvision/%s" % slug,
        "openSource": False,
        "name": meta.get("name", ""),
        "packageName": pkg,
        "version": meta.get("version", ""),
        "apkUrl": apk_url,
        "homepage": "https://apkvision.org/",
        "specialPermissions": ["none"],
        "summary": summary[:120],
    }


def collect_candidates(state, args):
    """巡扫：按源 tabs 顺序推进分页，收集新候选 entry 列表。
    截至本轮 limit 或全部 tab 翻完。返回 (entries, advanced)。"""
    advanced = False
    entries = []
    gh_token = os.environ.get(TOKEN_ENV, "")
    processed = set(state.get("processed", []))
    failed = set(state.get("failed", {}).keys())
    cursors = state.setdefault("cursors", {})
    key = "apkvision"
    cur = cursors.setdefault(key, {"tabs": list(DEFAULT_TABS), "tabIdx": 0,
                                   "page": 1})
    if args.tab:
        cur["tabs"] = [args.tab]
        cur["tabIdx"] = 0
        cur["page"] = int(args.page or 1)

    while len(entries) < args.limit:
        tabs = cur.get("tabs") or DEFAULT_TABS
        idx = int(cur.get("tabIdx", 0))
        if idx >= len(tabs):
            break
        tab = tabs[idx]
        page = int(cur.get("page", 1))
        try:
            page_entries, has_more = apv.list_page(tab, page)
        except Exception as e:
            log("列表页失败 %s p%d: %s" % (tab, page, e))
            break
        fresh = [e for e in page_entries
                 if e["id"] not in processed and e["id"] not in failed]
        entries.extend(fresh)
        log("tab %s p%d：%d 条（新候选累计 %d）"
            % (tab, page, len(page_entries), len(entries)))
        if has_more and len(fresh) == 0:
            # 本页没有新候选但还有下一页：继续翻
            cur["page"] = page + 1
            advanced = True
            continue
        if has_more and len(entries) < args.limit:
            cur["page"] = page + 1
            advanced = True
            continue
        if not has_more:
            cur["tabIdx"] = idx + 1
            cur["page"] = 1
            advanced = True
    if len(entries) >= args.limit:
        cur["page"] = cur.get("page", 1) + 0  # 保持游标，下一轮继续
    return entries, advanced


def get_pr_files_branch(branch):
    tmp = os.path.join(TMP_DIR, "pr_files")
    os.makedirs(tmp, exist_ok=True)
    files = []
    for fn in sorted(os.listdir(tmp)):
        with open(os.path.join(tmp, fn), encoding="utf-8") as f:
            files.append((fn, f.read()))
        os.remove(os.path.join(tmp, fn))
    return files


def run_git(args):
    import subprocess
    token = os.environ.get(TOKEN_ENV, "")
    return subprocess.run(args, capture_output=True, text=True,
                          timeout=180, env=dict(os.environ,
                                                GIT_ASKPASS="echo"))


def api_create_ref(index_repo, ref, sha, token):
    st, body = http_json(
        "POST",
        "https://api.github.com/repos/%s/git/refs" % index_repo,
        token=token, body={"ref": ref, "sha": sha})
    return st, body


def api_put_file(index_repo, path, content, message, token, branch):
    b64 = base64.b64encode(content.encode("utf-8")).decode()
    st, body = http_json(
        "PUT",
        "https://api.github.com/repos/%s/contents/%s" % (index_repo, path),
        token=token,
        body={"message": message, "content": b64, "branch": branch})
    if st not in (200, 201):
        raise RuntimeError("写入 %s 失败: %s %s" % (path, st, body))


def api_create_pr(index_repo, branch, files, title, body):
    """全 API 开 PR：取 main sha → 建分支 → PUT app.json → POST pulls。"""
    token = os.environ.get(TOKEN_ENV, "")
    st, ref = http_json(
        "GET", "https://api.github.com/repos/%s/git/ref/heads/main"
        % index_repo, token=token)
    if st != 200:
        raise RuntimeError("读取 main sha 失败: %s %s" % (st, ref))
    sha = ref["object"]["sha"]
    st, body_r = api_create_ref(
        index_repo, "refs/heads/%s" % branch, sha, token)
    if st not in (200, 201):
        raise RuntimeError("创建分支失败: %s %s" % (st, body_r))
    for path, content in files:
        api_put_file(index_repo, path, content,
                     "chore: 闭源收录 %s" % path, token, branch)
    st, pr = http_json(
        "POST",
        "https://api.github.com/repos/%s/pulls" % index_repo,
        token=token,
        body={"title": title[:120], "head": branch, "base": "main",
              "body": body})
    if st not in (200, 201):
        raise RuntimeError("create PR failed: %s %s" % (st, pr))
    log("PR 已创建: #%s %s" % (pr.get("number"), pr.get("html_url")))


def state_token():
    """main 受保护后，状态文件直推需要主账号 PAT（MAIN_PAT）；本地回退 GH_TOKEN。"""
    return (os.environ.get(STATE_TOKEN_ENV, "")
            or os.environ.get(TOKEN_ENV, ""))


def api_put_state(index_repo):
    """把本地 state.json 提交回 main（Contents API，用 MAIN_PAT 豁免保护）。"""
    token = state_token()
    path = "closed-sources/state.json"
    with open(STATE_PATH, "rb") as f:
        data = f.read()
    st, cur = http_json(
        "GET", "https://api.github.com/repos/%s/contents/%s"
        % (index_repo, path), token=token, headers={
            "Accept": "application/vnd.github+json"})
    st, body = http_json(
        "PUT",
        "https://api.github.com/repos/%s/contents/%s" % (index_repo, path),
        token=token,
        body={"message": "chore: 闭源采集状态推进", "branch": "main",
              "content": base64.b64encode(data).decode(),
              "sha": cur.get("sha") if st == 200 else None})
    if st not in (200, 201):
        raise RuntimeError("state 提交失败: %s %s" % (st, body))


def put_app_json_main(index_repo, app_json):
    """直链条目直推 main（不走 PR）：幂等 PUT apps/<owner>/<repo>/app.json。
    触发 merge-settle 落盘 app-info/README（Trigger: push apps/**/app.json）。"""
    token = state_token()
    path = "apps/%s/%s/app.json" % (app_json["repo"].split("/")[0],
                                    app_json["repo"].split("/")[1])
    b64 = base64.b64encode(
        json.dumps(app_json, ensure_ascii=False, indent=2).encode()).decode()
    st, cur = http_json(
        "GET", "https://api.github.com/repos/%s/contents/%s?ref=main"
        % (index_repo, path), token=token)
    st, body = http_json(
        "PUT",
        "https://api.github.com/repos/%s/contents/%s" % (index_repo, path),
        token=token,
        body={"message": "chore: 闭源直链收录 %s" % path,
              "branch": "main", "content": b64,
              "sha": cur.get("sha") if st == 200 else None})
    if st not in (200, 201):
        raise RuntimeError("直推 %s 失败: %s %s" % (path, st, body))
    return "apps/%s/%s" % (app_json["repo"].split("/")[0],
                           app_json["repo"].split("/")[1])


# ---------- 自续链与保活 ----------
# 调度约定：
#   - 本轮未翻完全库：collect_closed.py 结尾自动 dispatch 下一轮 WF8（自续链）
#   - 翻完全库：写完成标记 closed-sources/.wf8_done，停止自续
#   - WF9 保活工作流每天检查：无完成标记且 WF8 不在运行 → 补触发一轮
DONE_MARKER = ".wf8_done"
SELF_LIMIT = 30  # 自续/保活触发的每轮上限


def scanned_to_end(state):
    """游标是否已翻完全部 tab（翻完 = tabIdx 超出 tabs 数量）。"""
    cur = state.get("cursors", {}).get("apkvision", {})
    tabs = cur.get("tabs") or DEFAULT_TABS
    return int(cur.get("tabIdx", 0)) >= len(tabs)


def put_done_marker(repo):
    """写入完成标记（幂等：已存在则跳过）。"""
    token = state_token()
    path = "closed-sources/%s" % DONE_MARKER
    st, cur = http_json(
        "GET", "https://api.github.com/repos/%s/contents/%s" % (repo, path),
        token=token)
    if st == 200:
        log("完成标记已存在，跳过写入")
        return
    body = {"message": "chore: 闭源全库扫描完成", "branch": "main",
            "content": base64.b64encode(
                json.dumps({"doneAt": now_utc()}, ensure_ascii=False)
                .encode()).decode()}
    st, resp = http_json(
        "PUT", "https://api.github.com/repos/%s/contents/%s" % (repo, path),
        token=token, body=body)
    log("完成标记写入: HTTP %s" % st)


def remove_done_marker(repo):
    """删除完成标记（重新全库扫描时使用；不存在则忽略）。"""
    token = state_token()
    path = "closed-sources/%s" % DONE_MARKER
    st, cur = http_json(
        "GET", "https://api.github.com/repos/%s/contents/%s" % (repo, path),
        token=token)
    if st == 200:
        http_json("DELETE",
                  "https://api.github.com/repos/%s/contents/%s" % (repo, path),
                  token=token,
                  body={"message": "chore: 重新开始闭源扫描",
                        "sha": cur.get("sha")})


def maybe_self_dispatch(repo):
    """未翻完全库时触发下一轮 WF8；已有其他运行/排队中的 run 则跳过（防重）。
    注意排除自身（GITHUB_RUN_ID），否则总会以为自己还在运行。"""
    token = os.environ.get(TOKEN_ENV, "")
    wf = "wf8-collect-closed.yml"
    self_run = os.environ.get("GITHUB_RUN_ID", "")
    st, runs = http_json(
        "GET",
        "https://api.github.com/repos/%s/actions/workflows/%s/runs?per_page=5"
        % (repo, wf), token=token)
    active = False
    for r in (runs or {}).get("workflow_runs", []):
        if (r.get("status") in ("in_progress", "queued")
                and str(r.get("id")) != str(self_run)):
            active = True
            break
    if active:
        log("检测到其他 WF8 运行，跳过自续触发")
        return
    st, body = http_json(
        "POST",
        "https://api.github.com/repos/%s/actions/workflows/%s/dispatches"
        % (repo, wf), token=token,
        body={"ref": "main",
              "inputs": {"dry_run": "false", "limit": str(SELF_LIMIT)}})
    log("自续触发下一轮 WF8: HTTP %s %s"
        % (st, "OK" if st in (200, 201, 204) else body))


def finish_round(args, state):
    """收盘逻辑：全库翻完写完成标记并停止；否则删标记并自续下一轮。"""
    if args.dry_run:
        log("DRY-RUN：不写标记、不自续")
        return
    if scanned_to_end(state):
        put_done_marker(args.repo)
        log("全库扫描完成，本轮结束，不再自续")
        return
    remove_done_marker(args.repo)
    maybe_self_dispatch(args.repo)


def maybe_open_pr(args, state):
    """把待收录队列（state.pending_pr）开成 PR；失败不致命，保留下轮重试。
    这样即使 Actions 暂无开 PR 权限，自续链也不会中断，镜像仓照常积累。"""
    if args.dry_run:
        return
    pending = state.get("pending_pr") or []
    if not pending:
        return
    branch = "closed-batch-%s" % int(time.time())
    pr_files = [(p["path"], p["content"]) for p in pending]
    names = []
    for p in pending[:10]:
        try:
            names.append(json.loads(p["content"]).get("name", ""))
        except Exception:
            pass
    body = ("闭源采集管道自动收录 %d 个应用：%s\n\n"
            "均为 APKVision 源站闭源应用，镜像仓库由机器人账号统一持有，"
            "APK 已上传对应 Releases。" % (len(pr_files), "、".join(names)))
    title = "闭源收录：%s 等 %d 个应用" % (names[0] if names else "新应用", len(pr_files))
    try:
        api_create_pr(args.repo, branch, pr_files, title, body)
        state["pending_pr"] = []
        log("PR 已创建并清空待收录队列（%d 条）" % len(pr_files))
    except Exception as e:
        log("开 PR 失败（待收录 %d 条保留，下轮重试）: %s" % (len(pending), e))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="承载仓库 owner/repo")
    ap.add_argument("--dry-run", action="store_true",
                    help="只巡扫+详情，不下载、不建仓、不开 PR、不自续")
    ap.add_argument("--limit", type=int, default=30, help="本轮新应用上限（默认 30）")
    ap.add_argument("--tab", default=None, help="指定起始目录页（覆盖默认 tabs）")
    ap.add_argument("--page", type=int, default=1, help="与 --tab 配套的起始页")
    ap.add_argument("--max-mb", type=float, default=200,
                    help="单个 APK 大小上限（MB）")
    ap.add_argument("--rescan", action="store_true",
                    help="重置游标并删除完成标记，重新全库扫描")
    args = ap.parse_args()

    state = load_state()
    if args.rescan:
        state = {"version": 1, "cursors": {}, "processed": [], "failed": {}}
        save_state(state)
        if not args.dry_run:
            remove_done_marker(args.repo)
        log("已重置游标，重新全库扫描")
    indexed = indexed_packages()
    log("已收录包名 %d 个，历史处理 %d 条，失败 %d 条"
        % (len(indexed), len(state.get("processed", [])),
           len(state.get("failed", {}))))

    entries, advanced = collect_candidates(state, args)
    log("本轮新候选 %d 个" % len(entries))
    if not entries:
        if scanned_to_end(state):
            log("全库已翻完，本轮无新候选")
            finish_round(args, state)
        else:
            log("无新候选且未翻完全库（疑似源站异常），本轮停止，等待保活工作流")
        return

    processed_now = []
    direct_apps = []
    for i, entry in enumerate(entries[:args.limit], 1):
        log("[%d/%d] 详情: %s" % (i, len(entries), entry["id"]))
        try:
            detail = apv.details_page(entry["id"])
            if not detail:
                state["failed"][entry["id"]] = "详情 404 或不可解析"
                continue
            if args.dry_run:
                print("CANDIDATE " + json.dumps(
                    {"entry": entry, "detail": {k: detail[k] for k in
                     ("name", "packageName", "version", "summary",
                      "downloads")}}, ensure_ascii=False))
                processed_now.append(entry)
                continue
            app_json = process_candidate(entry, detail, state, args, indexed)
            if app_json:
                direct_apps.append(app_json)
                processed_now.append(entry)
        except Exception as e:
            state["failed"][entry["id"]] = str(e)[:300]
            log("候选处理失败: %s" % e)

    state["processed"].extend(e["id"] for e in processed_now)
    state["processed"] = sorted(set(state["processed"]))
    state["failed"] = {k: v for k, v in list(state["failed"].items())[-500:]}
    if args.dry_run:
        log("DRY-RUN 结束：候选 %d 个，失败 %d 条"
            % (len(processed_now), len(state.get("failed", {}))))
        return

    # 直推 main（不走 PR）：merge-settle 会自动落盘 app-info/README
    pushed = 0
    for app_json in direct_apps:
        try:
            put_app_json_main(args.repo, app_json)
            pushed += 1
        except Exception as e:
            log("直推失败: %s -> %s" % (app_json["repo"], e))
            state["failed"][app_json["repo"]] = str(e)[:300]
    log("本轮直推 %d/%d 条 app.json 到 main" % (pushed, len(direct_apps)))
    save_state(state)
    api_put_state(args.repo)
    log("本轮完成：候选 %d，直推应用 %d" % (len(entries), pushed))
    finish_round(args, state)


if __name__ == "__main__":
    main()