#!/usr/bin/env python3
"""WF7 图标批量修复 v2：把 apps/*/*/ 下非图像（AXML/损坏/采集失败）icon 文件替换为真实位图。

存量判定：icon.* 文件 < 2000 字节或魔数非 PNG/JPEG/WebP 即视为坏。
修复路径（v2 重写）：app-info.json 的 apkUrl 直连下载 APK → aapt2 dump badging 取图标资源
→ 若指向 XML（混淆 APK 的 adaptive-icon 定义如 res/BW.xml），用 aapt2 dump xmltree 解析
foreground/background/monochrome 引用 ID → 用 aapt2 dump resources 建立 资源ID→密度→文件路径
映射，选最高密度真实位图字节（魔数校验）→ 落盘覆盖旧 icon.* → git commit/push。

v1 教训：混淆 APK 的位图全在 res/ 根下（res/-B.png 乱名），原 fallback 只遍历
res/mipmap|res/drawable 子目录导致 88/100 失败；v2 通过 resources.arsc 的资源 ID 映射
精确找到图标位图，无需依赖目录命名。
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import zipfile


def is_image(b: bytes) -> bool:
    return (
        b.startswith(b"\x89PNG\r\n\x1a\n")
        or b.startswith(b"\xff\xd8\xff")
        or (b[:4] == b"RIFF" and b[8:12] == b"WEBP")
    )


def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd, timeout=300):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return r.stdout, r.stderr, r.returncode


def parse_resources(out: str):
    """解析 aapt2 dump resources：返回 (资源名映射, 文件路径映射)。
    资源行：  resource 0x7f0f0014 mipmap/ic_launcher_foreground
    文件行：  (xxxhdpi) (file) res/as.png type=PNG
    """
    res_name = {}   # res_id(lower) -> (type, name)
    files = {}      # res_id(lower) -> {density: path}
    cur = None
    for line in out.splitlines():
        m = re.match(r"\s*resource (0x[0-9a-f]+) ([\w.]+)/([\w.]+)", line)
        if m:
            cur = m.group(1).lower()
            res_name[cur] = (m.group(2), m.group(3))
            files.setdefault(cur, {})
            continue
        m = re.match(r"\s*\(([^)]*)\) \(file\) (res/[\w./-]+) type=(\w+)", line)
        if m and cur:
            dens = m.group(1) or "default"
            files[cur][dens] = m.group(2)
    return res_name, files


DENSITY_RANK = {
    "xxxhdpi": 5, "xxhdpi": 4, "xhdpi": 3, "hdpi": 2, "mdpi": 1,
    "nodpi": 3, "default": 1, "tvdpi": 1,
}


def best_path(files, res_id):
    """资源 ID 对应的最高密度位图路径（跳过 XML 类目录 anydpi）"""
    cands = files.get(res_id, {})
    if not cands:
        return None
    best, brank = None, -1
    for d, p in cands.items():
        if "anydpi" in d:
            continue
        r = DENSITY_RANK.get(d, 0)
        if r > brank:
            best, brank = p, r
    return best


def xmltree_refs(aapt2, apk, xmlpath):
    """解析 adaptive-icon XML，返回 (foreground_id, background_id, monochrome_id) 均不带 @"""
    out, err, rc = run([aapt2, "dump", "xmltree", "--file", xmlpath, apk])
    fg = bg = mono = None
    section = None
    for line in out.splitlines():
        if "E: adaptive-icon" in line:
            section = "adaptive"
            continue
        if "E: background" in line:
            section = "bg"
            continue
        if "E: foreground" in line:
            section = "fg"
            continue
        if "E: monochrome" in line:
            section = "mono"
            continue
        m = re.search(r"drawable\(0x01010199\)=@(0x[0-9a-f]+)", line)
        if m:
            rid = m.group(1).lower()
            if section == "fg":
                fg = rid
            elif section == "bg":
                bg = rid
            elif section == "mono":
                mono = rid
    return fg, bg, mono


def extract_bitmap(aapt2: str, apk: str):
    """从 APK 提取应用图标位图。返回 (bytes, ext, 来源描述) 或 (None, None, 原因)。"""
    out, err, rc = run([aapt2, "dump", "badging", apk])
    if rc != 0:
        return None, None, "badging失败: " + (err or out)[:200]
    m = re.search(r"icon='([^']*)'", out)
    icon = m.group(1) if m else ""
    res_name, files = parse_resources(run([aapt2, "dump", "resources", apk])[0])

    with zipfile.ZipFile(apk) as z:
        names = z.namelist()

        def read_if_image(path):
            if path in names:
                data = z.read(path)
                if is_image(data):
                    ext = path.rsplit(".", 1)[-1].lower()
                    if ext not in ("png", "webp", "jpg", "jpeg"):
                        ext = "png"
                    return data, ext
            return None, None

        # 情况1：icon 直接是位图文件路径 res/xxx.png
        if icon and icon.startswith("res/") and not icon.endswith(".xml"):
            data, ext = read_if_image(icon)
            if data:
                return data, ext, icon

        # 情况2：icon 是 @type/name 资源引用
        if icon and icon.startswith("@"):
            key = icon.lstrip("@")
            for rid, (t, n) in res_name.items():
                if f"{t}/{n}" == key:
                    p = best_path(files, rid)
                    if p:
                        data, ext = read_if_image(p)
                        if data:
                            return data, ext, f"{icon}->{p}"

        # 情况3：icon 指向 adaptive-icon XML（混淆 APK 常见）
        if icon and icon.endswith(".xml"):
            fg, bg, mono = xmltree_refs(aapt2, apk, icon)
            for rid, tag in ((fg, "foreground"), (bg, "background"), (mono, "monochrome")):
                if not rid:
                    continue
                p = best_path(files, rid)
                if not p:
                    continue
                data, ext = read_if_image(p)
                if data:
                    return data, ext, f"{icon}[{tag}]->{p}"

        # 情况4：兜底遍历 mipmap/drawable 找最大位图（老式未混淆 APK）
        best = None  # (score, data, ext, src)
        for n in names:
            low = n.lower()
            if not (low.startswith("res/mipmap") or low.startswith("res/drawable")):
                continue
            if not (low.endswith(".png") or low.endswith(".webp") or low.endswith(".jpg")):
                continue
            if ".9." in low or "foreground" in low or "background" in low:
                continue
            m = re.search(r"(?:mipmap|drawable)-([a-z0-9-]+)", low)
            rk = DENSITY_RANK.get(m.group(1) if m else "hdpi", 1)
            if "round" in low:
                rk -= 1
            if "ic_launcher" in low:
                rk += 10
            try:
                data = z.read(n)
            except Exception:
                continue
            if is_image(data) and 2_000 <= len(data) <= 800_000:
                if best is None or rk > best[0]:
                    best = (rk, data, n.rsplit(".", 1)[-1].lower() if n.rsplit(".", 1)[-1].lower() in ("png", "webp", "jpg", "jpeg") else "png", n)
        if best:
            return best[1], best[2], best[3]

    return None, None, f"未能提取图像 (badging icon={icon!r})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aapt2", required=True, help="aapt2 可执行文件路径")
    ap.add_argument("--workdir", default="/tmp/wf7")
    args = ap.parse_args()
    os.makedirs(args.workdir, exist_ok=True)

    dirs = set()
    for icon_path in glob.glob("apps/*/*/icon.*"):
        try:
            sz = os.path.getsize(icon_path)
            with open(icon_path, "rb") as f:
                head = f.read(16)
            if sz < 2000 or not is_image(head):
                dirs.add(os.path.dirname(icon_path))
        except OSError:
            dirs.add(os.path.dirname(icon_path))
    log(f"待修复目录: {len(dirs)}")

    ok, fail = [], []
    apk = os.path.join(args.workdir, "cur.apk")
    for d in sorted(dirs):
        info_path = os.path.join(d, "app-info.json")
        if not os.path.isfile(info_path):
            fail.append((d, "缺 app-info.json"))
            continue
        info = json.load(open(info_path, encoding="utf-8"))
        apkurl = (info.get("source") or {}).get("apkUrl", "")
        if not apkurl:
            fail.append((d, "无 apkUrl"))
            continue
        log(f"[{d}] 下载 {apkurl}")
        r = subprocess.run(["curl", "-sL", "--retry", "3", "-o", apk, apkurl], timeout=900)
        if r.returncode != 0 or not os.path.isfile(apk) or os.path.getsize(apk) < 10000:
            fail.append((d, "APK 下载失败"))
            continue
        try:
            data, ext, desc = extract_bitmap(args.aapt2, apk)
        except Exception as e:
            fail.append((d, f"提取异常: {e}"))
            os.remove(apk)
            continue
        if data is None:
            fail.append((d, desc))
            os.remove(apk)
            continue
        for old in glob.glob(os.path.join(d, "icon.*")):
            os.remove(old)
        new = os.path.join(d, f"icon.{ext}")
        with open(new, "wb") as f:
            f.write(data)
        log(f"  OK -> {new} ({len(data)}B，来源 {desc})")
        ok.append(d)
        os.remove(apk)

    log(f"\n成功 {len(ok)}，失败 {len(fail)}")
    for d, why in fail:
        log(f"  FAIL {d}: {why}")

    if ok:
        changed = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True).stdout.strip()
        if changed:
            subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
            subprocess.run(["git", "config", "user.email", "actions@users.noreply.github.com"], check=True)
            subprocess.run(["git", "add", "-A"], check=True)
            subprocess.run(["git", "commit", "-m", "wf7-v2: 批量修复历史坏图标（AXML→位图，资源ID映射）"], check=True)
            subprocess.run(["git", "push", "origin", "HEAD:main"], check=True)
            log("已推送修复")


if __name__ == "__main__":
    main()
