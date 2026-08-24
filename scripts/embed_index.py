#!/usr/bin/env python3
"""生成全市场应用向量数据（为向量搜索铺路）。

模型：sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
- 开源（Apache-2.0），中等规模（~118M 参数，12 层），384 维
- 多语言（含中文），适合应用名/简介/README 混排检索
产物：Release（tag: embed-<时间戳>）携带 embeddings.json
结构：{"model","dim","generatedAt","apps": {<id>: [float,...]}}
"""
import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request

TOKEN_ENV = "GH_TOKEN"
MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def log(msg):
    print(f"[embed] {msg}", flush=True)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def iter_app_dirs(root="."):
    apps_root = os.path.join(root, "apps")
    if not os.path.isdir(apps_root):
        return
    for owner in sorted(os.listdir(apps_root)):
        owner_dir = os.path.join(apps_root, owner)
        if not os.path.isdir(owner_dir):
            continue
        for repo in sorted(os.listdir(owner_dir)):
            dir_path = os.path.join(owner_dir, repo)
            info_path = os.path.join(dir_path, "app-info.json")
            if not os.path.isfile(info_path):
                continue
            yield owner, repo, dir_path


def build_texts():
    """应用 → 索引文本（名称 + 仓库 + 简介 + README 摘要）"""
    texts = {}
    for owner, repo, dir_path in iter_app_dirs():
        info = load_json(os.path.join(dir_path, "app-info.json"))
        app_json = {}
        try:
            app_json = load_json(os.path.join(dir_path, "app.json"))
        except Exception:
            pass
        readme = ""
        readme_path = os.path.join(dir_path, "README.md")
        if os.path.isfile(readme_path):
            readme = open(readme_path, encoding="utf-8", errors="replace").read()
        readme = readme[:1000]
        parts = [
            (info.get("name") or "").strip(),
            (info.get("source") or {}).get("repo") or (owner + "/" + repo),
            (app_json.get("summary") or "").strip(),
            "开源" if app_json.get("openSource") else "闭源",
            readme,
        ]
        texts[str(info["id"])] = "\n".join(p for p in parts if p)
    return texts


def run_embedding(texts):
    import numpy as np  # noqa
    from sentence_transformers import SentenceTransformer

    log(f"加载模型 {MODEL_NAME} …")
    model = SentenceTransformer(MODEL_NAME)
    log("编码全部应用文本 …")
    ids = list(texts.keys())
    embs = model.encode(list(texts.values()), batch_size=32, show_progress_bar=False)
    return ids, embs.tolist(), model.get_sentence_embedding_dimension()


def gh_api(path, method="GET", body=None, token=None, retries=5):
    token = token or os.environ.get(TOKEN_ENV, "")
    url = f"https://api.github.com{path}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, method=method)
            if token:
                req.add_header("Authorization", "Bearer " + token)
            req.add_header("Accept", "application/vnd.github+json")
            data = None
            if body is not None:
                data = json.dumps(body).encode()
                req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, data=data, timeout=120) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode())
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(3)
    return 500, {"message": "unreachable"}


def upload_release(repo, tag, embeddings, token):
    status, rel = gh_api(f"/repos/{repo}/releases", "POST",
                         {"tag_name": tag, "name": f"向量数据 {tag}",
                          "body": f"模型 {MODEL_NAME}，维度 {embeddings['dim']}",
                          "draft": False, "prerelease": False}, token=token)
    if status not in (200, 201):
        raise RuntimeError(f"创建 Release 失败: {status} {rel}")
    release_id = rel["id"]
    url = f"https://uploads.github.com/repos/{repo}/releases/{release_id}/assets?name=embeddings.json"
    req = urllib.request.Request(url, data=json.dumps(embeddings, ensure_ascii=False).encode(),
                                 method="POST")
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            log(f"embeddings.json 上传 → HTTP {r.status}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"上传失败: {e.code} {e.read().decode()[:200]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    token = os.environ.get(TOKEN_ENV, "")
    texts = build_texts()
    if not texts:
        log("无待编码应用（缺 app-info.json），退出")
        sys.exit(0)
    log(f"待编码应用: {len(texts)}")
    ids, vectors, dim = run_embedding(texts)
    embeddings = {
        "model": MODEL_NAME,
        "dim": dim,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "apps": dict(zip(ids, vectors)),
    }
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "embeddings.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(embeddings, f, ensure_ascii=False)
    log(f"embeddings.json 已生成（{os.path.getsize(out)} B, {len(ids)} 个应用）")
    if args.dry_run:
        return
    tag = "embed-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S")
    upload_release(args.repo, tag, embeddings, token)
    log(f"已发布 Release {tag}")


if __name__ == "__main__":
    main()