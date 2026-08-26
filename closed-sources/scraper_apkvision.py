#!/usr/bin/env python3
"""APKVision 纯 HTTP 采集器（v1）。

参照 ApkMesh assets/sources/apkvision.js 的解析契约，仅用 HTTP + 正则，
不依赖无头浏览器（APKVision 反爬对 headless Chromium 做挑战，curl/urllib 正常）。

接口：
  list_page(tab_url, page) -> (entries, has_more)
  details_page(url) -> {name, packageName, version, iconUrl, summary, downloads:[{label,url,size}]}
  resolve_download(url) -> 直链(https://dl.apkvision.org/...) 或 None
  download_apk(direct_url, dest, headers=None) -> (path, bytes, sha256)
安全：所有请求和下载均受 manifest network 白名单约束（apkvision.org / *.apkvision.org）。
"""
import hashlib
import os
import re
import time
import urllib.error
import urllib.request

ORIGIN = "https://apkvision.org"
ALLOWED_HOSTS = {"apkvision.org", "dl.apkvision.org"}
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 "
      "Safari/537.36")
BASE_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.8",
    "Referer": ORIGIN + "/",
}
ACRONYMS = {"apk", "api", "fps", "gta", "hd", "mcpe", "mod", "nba",
            "pe", "psp", "rpg", "vr", "xapk"}


class DomainError(Exception):
    """域名超出源白名单。"""


def _check_host(url):
    from urllib.parse import urlsplit
    host = urlsplit(url).hostname or ""
    host = host.lower()
    if host in ALLOWED_HOSTS or host.endswith(".apkvision.org"):
        return
    raise DomainError(f"域名不在白名单内: {host}")


def http_get(url, headers=None, timeout=30, retries=2):
    """GET 文本。HTTP 404/410 返回 None；其余异常重试后抛出。"""
    _check_host(url)
    final_headers = dict(BASE_HEADERS)
    if headers:
        final_headers.update(headers)
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=final_headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                m = re.search(r"charset=([^;\s]+)", ctype, re.I)
                enc = m.group(1).strip('"\'') if m else "utf-8"
                try:
                    return raw.decode(enc, errors="replace")
                except LookupError:
                    return raw.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                return None
            last = e
            time.sleep(1.5 * (attempt + 1))
        except Exception as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise last


def _denode(v):
    s = str(v or "")
    return (s.replace("&#8211;", "-")
             .replace("&amp;", "&")
             .replace("&#038;", "&")
             .replace("&#039;", "'").replace("&#8217;", "'")
             .replace(chr(34), chr(34))
             .replace("&lt;", "<").replace("&gt;", ">")
             .replace("&nbsp;", " "))


def _clean(v):
    return re.sub(r"\s+", " ", _denode(v)).strip()


def _attr(tag, name):
    m = re.search(r"\b%s\s*=\s*([\"'])([\s\S]*?)\1" % re.escape(name),
                  tag or "", re.I)
    return _denode(m.group(2)).strip() if m else ""


def _absurl(u):
    v = _clean(u)
    if v.startswith("//"):
        return "https:" + v
    if v.startswith("/"):
        return ORIGIN + v
    return v


def _humanize(value):
    words = [w for w in str(value or "").split("-") if w]
    out = []
    for w in words:
        low = w.lower()
        out.append(low.upper() if low in ACRONYMS else low[0].upper() + low[1:])
    return " ".join(out)


def _strip_apk(title):
    return (_clean(title)
            .replace(ORIGIN, "")
            .replace(" - Download Free for Android", "")
            .strip())


def _extract_version(value):
    m = re.search(r"\bv?\d+(?:\.\d+)+(?:\s+[A-Za-z][\w-]*)?", _clean(value), re.I)
    return m.group(0) if m else ""


def _extract_size(value):
    m = re.match(r"^\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b", _clean(value), re.I)
    return m.group(0) if m else ""


def _image_url(tag):
    for name in ("src", "data-src", "data-lazy-src", "data-original"):
        v = _attr(tag, name)
        if v:
            return _absurl(v)
    return ""


def _has_next(html):
    return bool(re.search(r'\brel\s*=\s*["\']next["\']', html or "", re.I)) or \
           bool(re.search(r'\bclass\s*=\s*["\'][^"\']*\bnextpostslink\b',
                          html or "", re.I))


def parse_cards(html, anchor, title, meta):
    """解析搜索/分类页卡片（与 apkvision.js parseCardResults 同构）。"""
    result = re.compile(
        r"<a\b([^>]*\bclass\s*=\s*[\"'][^\"']*\b%s\b[^\"']*[\"'][^>]*)>([\s\S]*?)</a>"
        % re.escape(anchor), re.I)
    title_re = re.compile(
        r"<div\b[^>]*\bclass\s*=\s*[\"'][^\"']*\b%s\b[^\"']*[\"'][^>]*>([\s\S]*?)</div>"
        % re.escape(title), re.I)
    meta_re = re.compile(
        r"<div\b[^>]*\bclass\s*=\s*[\"'][^\"']*\b%s\b[^\"']*[\"'][^>]*>([\s\S]*?)</div>"
        % re.escape(meta), re.I)
    entries = []
    for m in result.finditer(html or ""):
        opening = "<a%s>" % m.group(1)
        uid = _absurl(_attr(opening, "href"))
        if not re.match(r"^https://(?:[^/]+\.)?apkvision\.org/", uid, re.I):
            continue
        block = m.group(2)
        tm = title_re.search(block)
        metas = [_clean(x.group(1)) for x in meta_re.finditer(block)]
        found_version = next((x for x in metas
                              if re.search(r"\bv?\d+(?:\.\d+)+", x)), "")
        img = re.search(r"<img\b[^>]*>", block, re.I)
        name = _strip_apk(_clean(tm.group(1).replace("\n", " ")) if tm else "")
        # 从 <a> 内文本提取标题兜底
        if not name:
            inner = _clean(re.sub(r"<[^>]+>", " ", m.group(2)))
            name = _strip_apk(inner)
        if not name:
            continue
        entries.append({
            "id": uid,
            "name": name,
            "version": _extract_version(found_version),
            "iconUrl": _image_url(img.group(0)) if img else "",
            "source": "apkvision",
        })
    # 去重
    seen, uniq = set(), []
    for e in entries:
        if e["id"] not in seen:
            seen.add(e["id"])
            uniq.append(e)
    return uniq


def list_page(tab_url, page=1):
    """目录/分类分页：返回 (entries, has_more)。404 视为结束。

    与官方 apkvision.js 一致：main-news 卡片优先，mainb-item 兜底。
    """
    num = max(1, int(page or 1))
    base = _absurl(tab_url).rstrip("/")
    url = "%s/page/%d/" % (base, num) if num > 1 else base + "/"
    html = http_get(url)
    if html is None:
        return [], False
    cards = parse_cards(html, "main-news", "main-news-title", "main-news-cat")
    if not cards:
        cards = parse_cards(html, "mainb-item", "mainb-title", "mainb-cat")
    return cards, _has_next(html)


def _row_field(rows, label):
    want = _clean(label).lower()
    for r in rows:
        if _clean(r[0]).lower() == want:
            return _clean(r[1])
    return ""


def details_page(url):
    """详情解析（纯 HTTP）：名称/包名/版本/图标/描述/下载候选→直链。"""
    uid = _absurl(url)
    _check_host(uid)
    html = http_get(uid)
    if html is None:
        return None

    name = ""
    m = re.search(r'<h1[^>]*>([\s\S]*?)</h1>', html, re.I)
    if m:
        name = _strip_apk(_clean(m.group(1)))
    if not name:
        m = re.search(r"<title[^>]*>([\s\S]*?)</title>", html, re.I)
        if m:
            name = _strip_apk(_clean(m.group(1).split("|")[0]))

    rows = []
    for m in re.finditer(
            r"<th[^>]*>([\s\S]*?)</th>\s*<td[^>]*>([\s\S]*?)</td>", html, re.I):
        rows.append((m.group(1), _clean(m.group(2))))
    package_name = _row_field(rows, "Package name")
    updated = _row_field(rows, "Updated")
    genre = _row_field(rows, "Genre")

    version = ""
    v = re.search(r'class="ver-top-version"[^>]*>([\s\S]*?)<', html, re.I)
    if v:
        version = _clean(v.group(1))

    icon_url = ""
    block = re.search(r'class="ver-top-l"[^>]*>[\s\S]{0,1200}?</div>', html, re.I)
    if block:
        img = re.search(r"<img\b[^>]*>", block.group(0), re.I)
        if img:
            icon_url = _image_url(img.group(0))

    summary = ""
    dm = re.search(r'<meta\s+name="description"\s+content="([^"]*)"',
                   html, re.I)
    if dm:
        summary = _clean(dm.group(1))

    # 下载候选：仅 apkvision.org 内 /download/ 路径
    candidates = []
    for tag in re.findall(r'<a\b([^>]*\bhref\s*=\s*["\'][^"\']*["\'][^>]*)>',
                          html, re.I):
        href = _absurl(_attr(tag, "href"))
        if re.match(r"^https://apkvision\.org/[^?#]+/download/", href, re.I):
            label = _clean(re.sub(r"<[^>]+>", " ", _attr(tag, "title")))
            if not label:
                label = _humanize(href.rsplit("/", 2)[-2] or "") or "APK"
            candidates.append({"label": label[:60], "url": href})

    downloads = []
    seen = set()
    for cand in candidates[:12]:
        direct = resolve_download(cand["url"])
        if direct and direct not in seen:
            seen.add(direct)
            downloads.append({"label": cand["label"], "url": direct,
                              "size": ""})
    return {
        "id": uid,
        "name": name,
        "packageName": package_name,
        "version": version or _extract_version(updated),
        "iconUrl": icon_url,
        "summary": summary,
        "category": genre,
        "updatedAt": updated,
        "downloads": downloads,
    }


def resolve_download(url):
    """详情页 → 下载中转页 → dl.apkvision.org 直链。"""
    _check_host(url)
    html = http_get(url)
    if html is None:
        return None
    m = re.search(r'<a\b[^>]*\bid\s*=\s*["\']durl["\'][^>]*>', html)
    if not m:
        return None
    direct = _absurl(_attr(m.group(0), "href"))
    if re.match(r"^https://dl\.apkvision\.org/", direct, re.I):
        return direct
    return None


def download_apk(direct_url, dest, headers=None, timeout=120):
    """流式下载 APK 到 dest，返回 (bytes, sha256)。域名必须 dl.apkvision.org。"""
    _check_host(direct_url)
    h = dict(BASE_HEADERS)
    if headers:
        h.update(headers)
    sha = hashlib.sha256()
    total = 0
    req = urllib.request.Request(direct_url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
                sha.update(chunk)
                total += len(chunk)
    return total, sha.hexdigest()


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--list":
        tab = sys.argv[2] if len(sys.argv) > 2 else ORIGIN + "/app/"
        page = int(sys.argv[3]) if len(sys.argv) > 3 else 1
        entries, more = list_page(tab, page)
        print("entries:", len(entries), "has_more:", more)
        for e in entries[:5]:
            print(e)
    elif len(sys.argv) > 1 and sys.argv[1] == "--details":
        d = details_page(sys.argv[2])
        import json
        print(json.dumps(d, ensure_ascii=False, indent=1)[:2000])
    else:
        print(__doc__)