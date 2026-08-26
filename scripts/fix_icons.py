#!/usr/bin/env python3
"""WF7 图标批量修复 v5：v4 基础上支持无扩展名/无 type 标注的资源。

Brave/Cromite 系：foreground = mipmap/layered_app_icon，aapt2 dump resources 输出
`(mdpi) (file) res/QtC`（无 type= 段、文件名无扩展名），v4 正则只匹配带 type= 的行
导致 files 映射为空、提取失败；v5 放宽正则 + 按魔数判定扩展名。
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import zipfile
import io

A = '{http://schemas.android.com/apk/res/android}'


def is_image(b: bytes) -> bool:
    return (
        b.startswith(b"\x89PNG\r\n\x1a\n")
        or b.startswith(b"\xff\xd8\xff")
        or (b[:4] == b"RIFF" and b[8:12] == b"WEBP")
    )


def ext_by_magic(b: bytes, fallback: str = "png") -> str:
    """按魔数判定扩展名（无扩展名文件适用）"""
    if b.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if b.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    return fallback


def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd, timeout=300):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return r.stdout, r.stderr, r.returncode


def parse_resources(out: str):
    res_name = {}
    files = {}
    colors = {}
    cur = None
    for line in out.splitlines():
        m = re.match(r"\s*resource (0x[0-9a-f]+) ([\w.]+)/([\w.]+)", line)
        if m:
            cur = m.group(1).lower()
            res_name[cur] = (m.group(2), m.group(3))
            files.setdefault(cur, {})
            continue
        m = re.match(r"\s*\(([^)]*)\) #([0-9a-fA-F]{8})", line)
        if m and cur:
            colors[cur] = '#' + m.group(2)
            continue
        # (dpi) (file) res/xxx[ type=PNG] —— type 段与扩展名均可缺失（混淆/去扩展名）
        m = re.match(r"\s*\(([^)]*)\) \(file\) (res/[\w./-]+)(?:\s+type=(\w+))?", line)
        if m and cur:
            dens = m.group(1) or "default"
            files[cur][dens] = m.group(2)
    return res_name, files, colors


DENSITY_RANK = {
    "xxxhdpi": 5, "xxhdpi": 4, "xhdpi": 3, "hdpi": 2, "mdpi": 1,
    "nodpi": 3, "default": 1, "tvdpi": 1,
}


def best_path(files, res_id):
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


def any_xml_path(files, res_id):
    cands = files.get(res_id, {})
    for p in cands.values():
        if p.endswith('.xml'):
            return p
    return None



def xmltree_refs(aapt2, apk, xmlpath):
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


# ---------- vector/gradient 渲染 ----------

def read_xml_root(apk, xmlpath):
    from androguard.core.axml import AXMLPrinter
    try:
        import xml.etree.ElementTree as ET
        with zipfile.ZipFile(apk) as z:
            data = z.read(xmlpath)
        if data[:4] == b'\x03\x00\x08\x00':
            et = AXMLPrinter(data).get_xml()
            if hasattr(et, 'getroot'):
                return et.getroot()
            return ET.fromstring(et.decode('utf-8', 'replace'))
        return ET.fromstring(data)
    except Exception:
        return None


def svg_color(c):
    c = c.strip()
    if c.startswith('#'):
        h = c[1:]
        if len(h) == 8:
            return '#' + h[2:] + h[0:2]
        return '#' + h
    return c


def render_gradient(apk, xmlpath, cmap, gid):
    g = read_xml_root(apk, xmlpath)
    if g is None or g.tag.split('}')[-1] != 'gradient':
        return '', ''
    ga = g.attrib
    gtype = ga.get(A + 'type', '0')
    stops = []
    for ch in g:
        if ch.tag.split('}')[-1] == 'item':
            col = ch.attrib.get(A + 'color', '#000000')
            if col.startswith('@'):
                v = cmap.get(col[1:].lower())
                col = v if v else '#000000'
            off = ch.attrib.get(A + 'offset', '0')
            try:
                stops.append((float(off), svg_color(col)))
            except Exception:
                pass
    stops.sort()
    if not stops:
        return '', ''
    stop_svg = ''.join('<stop offset="%s" stop-color="%s"/>' % (o, c) for o, c in stops)
    gname = 'g%d' % gid
    if gtype == '0':
        defs = '<linearGradient id="%s" x1="%s" y1="%s" x2="%s" y2="%s">%s</linearGradient>' % (
            gname, ga.get(A + 'startX', '0'), ga.get(A + 'startY', '0'),
            ga.get(A + 'endX', '100'), ga.get(A + 'endY', '100'), stop_svg)
    else:
        defs = '<radialGradient id="%s" cx="%s" cy="%s" r="%s">%s</radialGradient>' % (
            gname, ga.get(A + 'centerX', '0'), ga.get(A + 'centerY', '0'),
            ga.get(A + 'gradientRadius', '100'), stop_svg)
    return defs, 'url(#%s)' % gname


def resolve_fill(apk, val, cmap, gid):
    if val.startswith('@'):
        v = cmap.get(val[1:].lower())
        if v:
            defs, url = render_gradient(apk, v, cmap, gid)
            if url:
                return url, defs, gid + 1
            if v.startswith('#'):
                return svg_color(v), '', gid
    return svg_color(val), '', gid


def build_svg_node(apk, node, cmap, gid):
    parts, defs = [], ''
    for ch in node:
        ctag = ch.tag.split('}')[-1]
        if ctag == 'group':
            ca = ch.attrib
            tf = []
            if A + 'translateX' in ca or A + 'translateY' in ca:
                tf.append('translate(%s,%s)' % (ca.get(A + 'translateX', 0), ca.get(A + 'translateY', 0)))
            if A + 'rotation' in ca:
                px, py = ca.get(A + 'pivotX', 0), ca.get(A + 'pivotY', 0)
                tf.append('rotate(%s,%s,%s)' % (ca[A + 'rotation'], px, py))
            if A + 'scaleX' in ca or A + 'scaleY' in ca:
                sx, sy = ca.get(A + 'scaleX', 1), ca.get(A + 'scaleY', 1)
                px, py = ca.get(A + 'pivotX', 0), ca.get(A + 'pivotY', 0)
                tf.append('translate(%s,%s)' % (px, py))
                tf.append('scale(%s,%s)' % (sx, sy))
                tf.append('translate(%s,%s)' % (-px, -py))
            inner, d2, gid = build_svg_node(apk, ch, cmap, gid)
            defs += d2
            if inner.strip():
                parts.append('<g transform="%s">%s</g>' % (' '.join(tf), inner) if tf else inner)
        elif ctag == 'path':
            ca = ch.attrib
            d = ca.get(A + 'pathData', '').strip()
            if not d:
                continue
            attrs = ['d="%s"' % d]
            fc = ca.get(A + 'fillColor', 'none')
            fill, d2, gid = resolve_fill(apk, fc, cmap, gid)
            defs += d2
            attrs.append('fill="%s"' % fill)
            if A + 'fillAlpha' in ca:
                attrs.append('fill-opacity="%s"' % ca[A + 'fillAlpha'])
            if A + 'strokeColor' in ca:
                scol, d3, gid = resolve_fill(apk, ca[A + 'strokeColor'], cmap, gid)
                defs += d3
                attrs.append('stroke="%s"' % scol)
            if A + 'strokeWidth' in ca:
                attrs.append('stroke-width="%s"' % ca[A + 'strokeWidth'])
            parts.append('<path ' + ' '.join(attrs) + '/>')
    return '\n'.join(parts), defs, gid


def render_vector_png(aapt2, apk, xmlpath, cmap, size=512):
    try:
        root = read_xml_root(apk, xmlpath)
        if root is None:
            return None
        vec = None
        for node in root.iter():
            if node.tag.split('}')[-1] == 'vector':
                vec = node
                break
        if vec is None:
            return None
        a = vec.attrib
        def fnum(v, default):
            try:
                return float(str(v).replace('dp', ''))
            except Exception:
                return default
        w = fnum(a.get(A + 'width', '108'), 108)
        h = fnum(a.get(A + 'height', '108'), 108)
        vw = fnum(a.get(A + 'viewportWidth', '108'), 108)
        vh = fnum(a.get(A + 'viewportHeight', '108'), 108)
        body, defs, _ = build_svg_node(apk, vec, cmap, 0)
        if not body.strip():
            return None
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s"><defs>%s</defs>%s</svg>' % (w, h, vw, vh, defs, body)
        import cairosvg
        png = cairosvg.svg2png(bytestring=svg.encode('utf-8'), output_width=size, output_height=size)
        return png if is_image(png) else None
    except Exception as e:
        log(f"    渲染异常: {e}")
        return None


def composite_png(layers):
    try:
        from PIL import Image
        base = None
        for lb in layers:
            im = Image.open(io.BytesIO(lb)).convert('RGBA')
            if base is None:
                base = im
            else:
                base = Image.alpha_composite(base, im)
        if base is None:
            return None
        buf = io.BytesIO()
        base.save(buf, 'PNG')
        return buf.getvalue()
    except Exception:
        return None


def solid_color_png(color_hex, size=512):
    try:
        from PIL import Image
        im = Image.new('RGBA', (size, size), color_hex)
        buf = io.BytesIO()
        im.save(buf, 'PNG')
        return buf.getvalue()
    except Exception:
        return None


# ---------- 主提取 ----------

def extract_bitmap(aapt2: str, apk: str):
    out, err, rc = run([aapt2, "dump", "badging", apk])
    if rc != 0:
        return None, None, "badging失败: " + (err or out)[:200]
    m = re.search(r"icon='([^']*)'", out)
    icon = m.group(1) if m else ""
    res_name, files, colors = parse_resources(run([aapt2, "dump", "resources", apk])[0])

    with zipfile.ZipFile(apk) as z:
        names = z.namelist()

        def read_if_image(path):
            if path in names:
                data = z.read(path)
                if is_image(data):
                    return data, ext_by_magic(data, path.rsplit(".", 1)[-1].lower() if "." in path else "png")
            return None, None

        # 情况1：icon 直接是位图路径
        if icon and icon.startswith("res/") and not icon.endswith(".xml"):
            data, ext = read_if_image(icon)
            if data:
                return data, ext, icon

        # 情况2：icon 是 @type/name 引用
        if icon and icon.startswith("@"):
            key = icon.lstrip("@")
            for rid, (t, n) in res_name.items():
                if f"{t}/{n}" == key:
                    p = best_path(files, rid)
                    if not p:
                        p = any_xml_path(files, rid)
                    if p:
                        data, ext = read_if_image(p)
                        if data:
                            return data, ext, f"{icon}->{p}"

        # 情况3：adaptive-icon XML（位图优先，渲染兜底）
        if icon and icon.endswith(".xml"):
            fg, bg, mono = xmltree_refs(aapt2, apk, icon)
            # 3a. 先试位图层（含 anydpi 下位图与无扩展名位图）
            for rid, tag in ((fg, "foreground"), (bg, "background"), (mono, "monochrome")):
                if not rid:
                    continue
                p = best_path(files, rid)
                if not p:
                    p = any_xml_path(files, rid)
                if not p:
                    continue
                data, ext = read_if_image(p)
                if data:
                    return data, ext, f"{icon}[{tag}]->{p}"
            # 3b. 渲染合成（bg + fg）
            cmap = {}
            for rid, v in colors.items():
                cmap[rid] = v
            for rid, fn in files.items():
                for d, p in fn.items():
                    cmap.setdefault(rid, p)
            layers = []
            descs = []
            bg_png = None
            if bg:
                p = best_path(files, bg)
                if not p:
                    p = any_xml_path(files, bg)
                if p and p.endswith('.xml'):
                    bg_png = render_vector_png(aapt2, apk, p, cmap)
                    if bg_png:
                        descs.append(f"bg渲染:{p}")
                elif colors.get(bg):
                    bg_png = solid_color_png(colors[bg])
                    descs.append(f"bg纯色:{colors[bg]}")
                elif p:
                    d0, _ = read_if_image(p)
                    if d0:
                        bg_png = d0
                        descs.append(f"bg位图:{p}")
            if bg_png:
                layers.append(bg_png)
            fg_png = None
            if fg:
                p = best_path(files, fg)
                if not p:
                    p = any_xml_path(files, fg)
                if p:
                    d0, _ = read_if_image(p)
                    if d0:
                        fg_png = d0
                        descs.append(f"fg位图:{p}")
                    elif p.endswith('.xml'):
                        fg_png = render_vector_png(aapt2, apk, p, cmap)
                        if fg_png:
                            descs.append(f"fg渲染:{p}")
                elif colors.get(fg):
                    fg_png = solid_color_png(colors[fg])
                    descs.append("fg纯色")
            if fg_png:
                layers.append(fg_png)
            if layers:
                out_png = composite_png(layers) if len(layers) > 1 else layers[0]
                if out_png:
                    return out_png, ext_by_magic(out_png, "png"), f"{icon} 合成({' + '.join(descs)})"

        # 情况4：兜底遍历 mipmap/drawable
        best = None
        for n in names:
            low = n.lower()
            if not (low.startswith("res/mipmap") or low.startswith("res/drawable")):
                continue
            if not (low.endswith(".png") or low.endswith(".webp") or low.endswith(".jpg") or low.endswith(".jpeg")):
                continue
            if ".9." in low or "foreground" in low or "background" in low:
                continue
            mm = re.search(r"(?:mipmap|drawable)-([a-z0-9-]+)", low)
            rk = DENSITY_RANK.get(mm.group(1) if mm else "hdpi", 1)
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
                    best = (rk, data, ext_by_magic(data, "png"), n)
        if best:
            return best[1], best[2], best[3]

    return None, None, f"未能提取图像 (badging icon={icon!r})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aapt2", required=True)
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
            subprocess.run(["git", "commit", "-m", "wf7-v5: 修复无扩展名位图资源提取"], check=True)
            subprocess.run(["git", "push", "origin", "HEAD:main"], check=True)
            log("已推送修复")


if __name__ == "__main__":
    main()
