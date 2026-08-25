#!/usr/bin/env python3
"""WF7 图标批量修复：把 apps/*/*/ 下非图像（AXML/损坏/采集失败）icon 文件替换为真实位图。

存量判定：icon.* 文件 < 2000 字节或魔数非 PNG/JPEG/WebP 即视为坏。
修复路径：app-info.json 的 apkUrl 直连下载 APK → aapt2 dump badging 取图标资源路径
→ 解包读字节并魔数校验 → 落盘（覆盖旧 icon.*）→ git commit/push。
badging 指向自适应图标 XML 时读取结果为 AXML（非图像），自动回退到遍历位图选图。
"""
import argparse
import glob
import json
import os
import re
import subprocess
import zipfile


def is_image(b: bytes) -> bool:
    return (
        b.startswith(b"\x89PNG\r\n\x1a\n")
        or b.startswith(b"\xff\xd8\xff")
        or (b[:4] == b"RIFF" and b[8:12] == b"WEBP")
    )


def log(msg: str) -> None:
    print(msg, flush=True)


def aapt_icon(aapt2: str, apk: str):
    """返回 (badging 中的 icon 资源路径, 错误信息)"""
    r = subprocess.run([aapt2, "dump", "badging", apk], capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return "", (r.stderr or r.stdout)[:200]
    m = re.search(r"icon='([^']*)'", r.stdout)
    return (m.group(1) if m else ""), ""


def extract_bitmap(apk: str, icon_rel: str):
    """从 APK 读取指定资源路径，仅接受真实图像字节。返回 (bytes, ext) 或 (None, None)"""
    if not icon_rel:
        return None, None
    try:
        with zipfile.ZipFile(apk) as z:
            if icon_rel in z.namelist():
                data = z.read(icon_rel)
                if is_image(data):
                    ext = icon_rel.rsplit(".", 1)[-1].lower()
                    if ext not in ("png", "webp", "jpg", "jpeg"):
                        ext = "png"
                    return data, ext
    except Exception as e:
        log(f"  解包异常: {e}")
    return None, None


def fallback_bitmap(apk: str):
    """遍历 mipmap/drawable 位图，按密度优先 + ic_launcher 加分选最佳图。"""
    rank = {"xxxhdpi": 5, "xxhdpi": 4, "xhdpi": 3, "hdpi": 2, "mdpi": 1, "nodpi": 3, "anydpi": 3}
    best = None  # (score, bytes, ext)
    try:
        with zipfile.ZipFile(apk) as z:
            for n in z.namelist():
                low = n.lower()
                if not (low.startswith("res/mipmap") or low.startswith("res/drawable")):
                    continue
                if not (low.endswith(".png") or low.endswith(".webp") or low.endswith(".jpg")):
                    continue
                if ".9." in low or "foreground" in low or "background" in low:
                    continue
                m = re.search(r"(?:mipmap|drawable)-([a-z0-9-]+)", low)
                rk = rank.get(m.group(1) if m else "hdpi", 1)
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
                        ext = n.rsplit(".", 1)[-1].lower()
                        best = (rk, data, ext if ext in ("png", "webp", "jpg", "jpeg") else "png")
    except Exception as e:
        log(f"  fallback 异常: {e}")
    if best:
        return best[1], best[2]
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aapt2", required=True, help="aapt2 可执行文件路径（ANDROID_HOME/build-tools/<v>/aapt2）")
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
        icon_rel, err = aapt_icon(args.aapt2, apk)
        data, ext = extract_bitmap(apk, icon_rel)
        if data is None:
            log(f"  badging icon={icon_rel!r} 非图像或缺失{('；'+err) if err else ''}，回退遍历")
            data, ext = fallback_bitmap(apk)
        if data is None:
            fail.append((d, f"未能提取图像 (badging={icon_rel!r})"))
            os.remove(apk)
            continue
        for old in glob.glob(os.path.join(d, "icon.*")):
            os.remove(old)
        new = os.path.join(d, f"icon.{ext}")
        with open(new, "wb") as f:
            f.write(data)
        log(f"  OK -> {new} ({len(data)}B，来源 {icon_rel or 'fallback'})")
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
            subprocess.run(["git", "commit", "-m", "wf7: 批量修复历史坏图标（AXML→真实位图）"], check=True)
            subprocess.run(["git", "push", "origin", "HEAD:main"], check=True)
            log("已推送修复")


if __name__ == "__main__":
    main()
