#!/usr/bin/env python3
"""工作流 3：月度推荐票计票。

用法：
  python3 tally_votes.py --repo owner/index-repo [--month 2026-08] [--token xxx]

统计上月携带推荐票标签的 ISSUE：每人每月一票，重复提交作废（按作者去重，保留最早）；
按应用聚合票数，输出前 3 名并 @ 维护者进入人工评级审核。
"""
import argparse
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import gh_api, MAINTAINER_ENV, log

LABEL = "recommendation"
TOP_N = 3


def fetch_issues(repo, month):
    """拉取指定月份全部推荐票 issue（按 created 时间过滤）。"""
    path = f"/repos/{repo}/issues?state=all&labels={LABEL}&per_page=100"
    status, issues = gh_api(path)
    if status != 200:
        log(f"拉取 ISSUE 失败: {status}")
        sys.exit(2)
    prefix = month  # YYYY-MM
    return [i for i in issues if (i.get("created_at") or "").startswith(prefix)]


def tally(issues):
    """按作者去重（保留最早），按应用 slug 聚合。应用标识取 issue 标题或 body 中的 `应用：xxx`。"""
    earliest_by_author = {}
    for i in issues:
        author = i["user"]["login"]
        if author not in earliest_by_author or i["created_at"] < earliest_by_author[author]["created_at"]:
            earliest_by_author[author] = i
    votes = {}
    for i in earliest_by_author.values():
        app = extract_app(i)
        if app:
            votes[app] = votes.get(app, 0) + 1
    ranking = sorted(votes.items(), key=lambda kv: (-kv[1], kv[0]))
    return ranking[:TOP_N]


def extract_app(issue):
    body = (issue.get("body") or "") + "\n" + (issue.get("title") or "")
    for line in body.splitlines():
        line = line.strip().lstrip("-* ")
        if line.startswith("应用：") or line.startswith("应用:"):
            return line.split("：", 1)[-1].split(":", 1)[-1].strip()
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--month", default=None, help="统计月份 YYYY-MM，缺省为上月")
    ap.add_argument("--maintainer", default=None)
    args = ap.parse_args()

    month = args.month
    if not month:
        today = datetime.date.today()
        first = today.replace(day=1)
        month = (first - datetime.timedelta(days=1)).strftime("%Y-%m")

    issues = fetch_issues(args.repo, month)
    top = tally(issues)
    maintainer = args.maintainer or os.environ.get(MAINTAINER_ENV, "")
    log(f"{month} 推荐票统计：有效票 {len(set(i['user']['login'] for i in issues))} 人，"
        f"前 {len(top)} 名：{top}")
    if top:
        mention = f"@{maintainer} " if maintainer else ""
        print(f"{mention}推荐票统计（{month}），前 {TOP_N} 名进入人工评级审核：")
        for i, (app, n) in enumerate(top, 1):
            print(f"{i}. {app} —— {n} 票")


if __name__ == "__main__":
    main()
