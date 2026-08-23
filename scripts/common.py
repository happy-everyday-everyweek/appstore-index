"""AppStore 承载仓库 CLI 共享工具。

约定：
- 应用目录：apps/<owner>/<repo>/
- ID：系统自动分配的数字串，起点 1001，递增
- 评级：开源 >= ID_STAR_C_THRESHOLD 为 C，否则 D；闭源为 E
"""
import json
import os
import hashlib
import sys
import time
import urllib.request
import urllib.error

ID_START = 1001
ID_STAR_C_THRESHOLD = 10000
APPS_DIR = "apps"
TOKEN_ENV = "GH_TOKEN"           # GitHub Actions 注入的 token
MAINTAINER_ENV = "MAINTAINER"    # 维护者账号（推荐票 @ 用）


def gh_api(path, method="GET", body=None, token=None):
    """GitHub REST API 薄封装，返回 (status, json_or_bytes)。网络瞬时故障自动重试 3 次。"""
    token = token or os.environ.get(TOKEN_ENV)
    last_err = None
    for attempt in range(3):
        try:
            url = f"https://api.github.com{path}"
            req = urllib.request.Request(url, method=method)
            req.add_header("Accept", "application/vnd.github+json")
            if token:
                req.add_header("Authorization", f"Bearer {token}")
            data = json.dumps(body).encode() if body is not None else None
            if data:
                req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, data=data, timeout=60) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                return resp.status, (json.loads(raw) if "json" in ctype else raw)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, raw.decode(errors="replace")
        except Exception as e:
            last_err = e
            time.sleep(2 * (attempt + 1))
    raise last_err


def find_app_dirs(root="."):
    """返回 [(app_json_path, owner, repo)]，目录结构 apps/<owner>/<repo>/app.json。"""
    found = []
    apps_root = os.path.join(root, APPS_DIR)
    if not os.path.isdir(apps_root):
        return found
    for owner in sorted(os.listdir(apps_root)):
        owner_dir = os.path.join(apps_root, owner)
        if not os.path.isdir(owner_dir):
            continue
        for repo in sorted(os.listdir(owner_dir)):
            app_json = os.path.join(owner_dir, repo, "app.json")
            if os.path.isfile(app_json):
                found.append((app_json, owner, repo))
    return found


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def validate_app_json(obj):
    """结构校验：返回错误列表，空列表表示通过。"""
    errors = []
    if not isinstance(obj, dict):
        return ["app.json 必须是 JSON 对象"]
    if not isinstance(obj.get("repo"), str) or "/" not in obj["repo"]:
        errors.append("repo 必填，格式 owner/repo")
    if not isinstance(obj.get("openSource"), bool):
        errors.append("openSource 必填，布尔值")
    if not isinstance(obj.get("summary"), str) or len(obj["summary"].strip()) < 4:
        errors.append("summary 必填且不少于 4 个字符")
    perms = obj.get("specialPermissions", ["none"])
    if not isinstance(perms, list) or not all(p in ("none", "adb", "root") for p in perms):
        errors.append("specialPermissions 取值须为 none/adb/root 数组")
    if "upstream" in obj and not isinstance(obj.get("upstream"), int):
        errors.append("upstream 必须是整数（上游应用系统 ID）")
    return errors


def next_app_id(app_infos):
    """基于现有 app-info.json 的 id 计算下一个 ID（起点 ID_START，递增）。"""
    max_id = ID_START - 1
    for info in app_infos:
        try:
            max_id = max(max_id, int(info.get("id", 0)))
        except (TypeError, ValueError):
            continue
    return max_id + 1


def grade_for(open_source_verified, stars):
    """算法初评：开源按 Star 阈值（C/D），闭源一律 E。"""
    if not open_source_verified:
        return "E"
    return "C" if int(stars or 0) >= ID_STAR_C_THRESHOLD else "D"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def log(msg):
    print(f"[appstore] {msg}", flush=True)