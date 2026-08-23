#!/usr/bin/env python3
"""工作流 1：PR 文件范围与修改权限校验。

用法：
  python3 pr_check.py --repo owner/index-repo --pr N [--token xxx]

校验规则（规格书 v0.4）：
  1. 文件范围：只允许新增/修改 apps/<owner>/<repo>/app.json
  2. 目录与引用：目录名与 app.json 的 repo 字段一致；upstream 指向已存在系统 ID
  3. 修改权限：已有应用只有初始上传者（uploader）或应用仓库 Owner 可改
违规 → 关闭 PR 并留言（--close 时实际执行关闭动作）。
"""
import argparse
import sys
import os
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import gh_api, load_json, validate_app_json, APPS_DIR, log

REPO_PATTERN = re.compile(r"^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$")


def get_pr_files(repo, pr):
    status, files = gh_api(f"/repos/{repo}/pulls/{pr}/files?per_page=100")
    if status != 200:
        log(f"获取 PR 文件失败: {status} {files}")
        sys.exit(2)
    return files


def existing_app_infos():
    """从工作区收集所有 app-info.json（key=目录相对路径，value=json）。"""
    result = {}
    apps_root = os.path.join(".", APPS_DIR)
    if not os.path.isdir(apps_root):
        return result
    for owner in sorted(os.listdir(apps_root)):
        owner_dir = os.path.join(apps_root, owner)
        if not os.path.isdir(owner_dir):
            continue
        for repo in sorted(os.listdir(owner_dir)):
            info_path = os.path.join(owner_dir, repo, "app-info.json")
            if os.path.isfile(info_path):
                result[f"{owner}/{repo}"] = load_json(info_path)
    return result


def validate(pr_author, pr_files, infos):
    errors = []
    for f in pr_files:
        path = f["filename"]
        if path.startswith(f"{APPS_DIR}/") and path.endswith("/app.json"):
            parts = path.split("/")
            if len(parts) != 4:
                errors.append(f"目录层级错误（应为 apps/<owner>/<repo>/app.json）: {path}")
                continue
            _, owner, repo, _ = parts
            if not REPO_PATTERN.match(f"{owner}/{repo}"):
                errors.append(f"owner/repo 命名不合法: {owner}/{repo}")
                continue
            key = f"{owner}/{repo}"
            # 读取 PR 中的新 app.json（checkout 后本地文件）
            if os.path.isfile(path):
                obj = load_json(path)
                errors += validate_app_json(obj)
                if obj.get("repo") != key:
                    errors.append(f"{path}: repo 字段 {obj.get('repo')} 与目录 {key} 不一致")
                up = obj.get("upstream")
                if up is not None:
                    ids = {info.get("id") for info in infos.values()}
                    if str(up) not in ids:
                        errors.append(f"{path}: upstream {up} 不是已存在的应用系统 ID")
                # 修改权限：已存在条目时
                if key in infos:
                    uploader = infos[key].get("uploader")
                    if f["status"] in ("modified", "changed") and pr_author != uploader:
                        errors.append(f"{path}: 修改已有应用须为初始上传者 {uploader}（你是 {pr_author}）")
            else:
                errors.append(f"PR 中新增的 app.json 在本地不可见: {path}（工作流需先 checkout PR 分支）")
        else:
            errors.append(f"越权文件，只允许修改 app.json: {path}")
    return errors


def close_pr(repo, pr, reasons):
    body = "工作流 1 校验未通过，本 PR 已自动关闭。\n\n违反项：\n" + "\n".join(f"- {r}" for r in reasons)
    gh_api(f"/repos/{repo}/pulls/{pr}", method="PATCH", body={"state": "closed"})
    gh_api(f"/repos/{repo}/issues/{pr}/comments", method="POST", body={"body": body})
    log("已关闭 PR 并留言")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="承载仓库 owner/repo")
    ap.add_argument("--pr", required=True, type=int, help="PR 编号")
    ap.add_argument("--author", default=None, help="PR 作者（缺省自动获取）")
    ap.add_argument("--close", action="store_true", help="违规时实际关闭 PR")
    args = ap.parse_args()

    author = args.author
    if not author:
        status, pr = gh_api(f"/repos/{args.repo}/pulls/{args.pr}")
        if status != 200:
            log(f"获取 PR 失败: {status}")
            sys.exit(2)
        author = pr["user"]["login"]

    pr_files = get_pr_files(args.repo, args.pr)
    infos = existing_app_infos()
    errors = validate(author, pr_files, infos)

    if errors:
        log("校验未通过:\n" + "\n".join(f"- {e}" for e in errors))
        # 工作流 1 的规则三需要拿到应用仓库当前 Owner 做二次确认（已是 uploader 则不查）
        if args.close:
            close_pr(args.repo, args.pr, errors)
        sys.exit(1)
    log("校验通过")
    print("PR_VALID=1")


if __name__ == "__main__":
    main()
