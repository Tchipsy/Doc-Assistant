"""纯文本函数：token 估算、页块/窗口切分、标题编号、目录、图片路径重写。

无 IO、无全局状态，除 token 估算读取比率常量外不依赖配置——方便离线单测。
"""
import os
import re
from pathlib import Path

TOKEN_CJK_RATIO = 0.8
TOKEN_OTHER_RATIO = 3.5

FENCE_RE = re.compile(r"^\s*(```|~~~)")
PAGE_RE = re.compile(r"^<!--\s*page:\s*(\d+)\s*-->\s*$")
PAGE_TAIL_RE = re.compile(r"<!--\s*page:\s*\d+\s*-->\s*$")
CJK_RE = re.compile("[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]")
NUM_PREFIX_RE = re.compile(r"^(\d+(?:\.\d+)*)\s+(.*)$")
H_RE = {2: re.compile(r"^##(?!#)\s+(.+?)\s*$"),
        3: re.compile(r"^###(?!#)\s+(.+?)\s*$"),
        4: re.compile(r"^####(?!#)\s+(.+?)\s*$")}


def estimate_tokens(text: str) -> int:
    cjk = len(CJK_RE.findall(text))
    other = len(text) - cjk
    return int(cjk * TOKEN_CJK_RATIO + other / TOKEN_OTHER_RATIO)


def tail_by_tokens(text: str, max_tokens: int) -> str:
    if estimate_tokens(text) <= max_tokens:
        return text
    step, best, k = 1000, 0, step
    while k < len(text):
        if estimate_tokens(text[-k:]) <= max_tokens:
            best = k
            k += step
        else:
            break
    if best == 0:
        best = step
    t = text[-best:]
    nl = t.find("\n")
    if 0 < nl < 200:
        t = t[nl + 1:]
    return t


def fence_scan(lines) -> list[bool]:
    """返回每行是否在围栏代码块内（标题识别时忽略代码块中的 # 行）。"""
    inside = [False] * len(lines)
    cur = False
    for i, line in enumerate(lines):
        inside[i] = cur
        if FENCE_RE.match(line):
            cur = not cur
    return inside


# ============================================================
# 页块 / 窗口
# ============================================================


def page_blocks(text: str) -> list[tuple[int | None, str]]:
    """按 <!-- page:N --> 切块。返回 [(page_no|None, text)]（前言 page_no=None）。"""
    lines = text.split("\n")
    idx = [i for i, l in enumerate(lines) if PAGE_RE.match(l)]
    blocks: list[tuple[int | None, str]] = []
    if not idx:
        return [(None, text)] if text.strip() else []
    if idx[0] > 0:
        pre = "\n".join(lines[: idx[0]])
        if pre.strip():
            blocks.append((None, pre))
    bounds = idx + [len(lines)]
    for a, b in zip(idx, bounds[1:]):
        n = int(PAGE_RE.match(lines[a]).group(1))
        blocks.append((n, "\n".join(lines[a:b])))
    return blocks


def make_page_windows(blocks, max_tokens: int) -> list[list]:
    """页块累积切窗（不拆页，页是整理与恢复的最小对齐单位）。"""
    windows, cur, tok = [], [], 0
    for b in blocks:
        t = estimate_tokens(b[1])
        if cur and tok + t > max_tokens:
            windows.append(cur)
            cur, tok = [], 0
        cur.append(b)
        tok += t
    if cur:
        windows.append(cur)
    return windows


def make_item_windows(items, max_tokens: int) -> list[list]:
    """节项累积成窗（不拆 item；item 为 {num, content, key}）。"""
    windows, cur, tok = [], [], 0
    for it in items:
        t = estimate_tokens(it["content"])
        if cur and tok + t > max_tokens:
            windows.append(cur)
            cur, tok = [], 0
        cur.append(it)
        tok += t
    if cur:
        windows.append(cur)
    return windows


def strip_page_markers(text: str) -> tuple[str, int]:
    """剥离页标记：整行标记删行、行尾标记剥标记留内容（围栏内不动），
    随后压缩围栏外连续空行。返回 (新文本, 剥离数)。"""
    lines = text.split("\n")
    fence = fence_scan(lines)
    out: list[str] = []
    n = 0
    for i, l in enumerate(lines):
        if fence[i]:
            out.append(l)
            continue
        if PAGE_RE.match(l.strip()):
            n += 1
            continue
        m = PAGE_TAIL_RE.search(l)
        if m:
            l = l[: m.start()].rstrip()
            n += 1
        out.append(l)
    fence2 = fence_scan(out)
    collapsed: list[str] = []
    prev_blank = False
    for i, l in enumerate(out):
        if not fence2[i] and not l.strip():
            if prev_blank:
                continue
            prev_blank = True
        else:
            prev_blank = False
        collapsed.append(l)
    return "\n".join(collapsed), n


# ============================================================
# 标题编号 / 目录 / 定位
# ============================================================


def number_headings(text: str) -> tuple[str, list[dict]]:
    """给 ##/###/#### 标题统一编号（## 2 / ### 2.1 / #### 2.1.3）。

    幂等：已有编号的标题先剥离旧编号再统一重编。
    返回 (新文本, [ {level, num, title} ])。
    """
    lines = text.split("\n")
    fence = fence_scan(lines)
    c2 = c3 = c4 = 0
    headings: list[dict] = []
    for i, l in enumerate(lines):
        if fence[i]:
            continue
        lvl, m = None, None
        for k in (2, 3, 4):
            m = H_RE[k].match(l)
            if m:
                lvl = k
                break
        if lvl is None:
            continue
        title = NUM_PREFIX_RE.sub(r"\2", m.group(1))
        if lvl == 2:
            c2 += 1
            c3 = c4 = 0
            num = f"{c2}"
        elif lvl == 3:
            c3 += 1
            c4 = 0
            num = f"{c2}.{c3}"
        else:
            c4 += 1
            num = f"{c2}.{c3}.{c4}"
        lines[i] = f"{'#' * lvl} {num} {title}"
        headings.append({"level": lvl, "num": num, "title": title})
    return "\n".join(lines), headings


def num_of(title: str) -> str | None:
    m = NUM_PREFIX_RE.match(title)
    return m.group(1) if m else None


def heading_lines(lines) -> list[tuple[int, int, str]]:
    """[(行号, 级别, 标题)]，跳过围栏代码块内。"""
    fence = fence_scan(lines)
    out = []
    for i, l in enumerate(lines):
        if fence[i]:
            continue
        for k in (2, 3, 4):
            m = H_RE[k].match(l)
            if m:
                out.append((i, k, m.group(1)))
                break
    return out


def section_span(lines, num: str) -> tuple[int, int] | None:
    """编号 -> (起始行, 内容末行)（含标题行；末行=下一同级或更高级标题前一行）。"""
    hl = heading_lines(lines)
    idx = next((j for j, (i, k, t) in enumerate(hl) if num_of(t) == num), None)
    if idx is None:
        return None
    i, k, _ = hl[idx]
    end = len(lines) - 1
    for j in range(idx + 1, len(hl)):
        ni, nk, _ = hl[j]
        if nk <= k:
            end = ni - 1
            break
    return i, end


def build_toc(headings) -> str:
    """纯文本缩进目录（层级 ##/###/#### -> 缩进 0/1/2）。"""
    out = []
    for h in headings:
        indent = "  " * (h["level"] - 2)
        out.append(f"{indent}- {h['num']} {h['title']}")
    return "\n".join(out)


def recent_headings(text: str, n: int = 3) -> str:
    """提取文本中最后 n 个标题（供 Pass 1 层级状态上下文）。"""
    lines = text.split("\n")
    fence = fence_scan(lines)
    found = []
    for i, l in enumerate(lines):
        if fence[i]:
            continue
        for k in (2, 3, 4):
            m = H_RE[k].match(l)
            if m:
                found.append("#" * k + " " + m.group(1))
                break
    return "\n".join(found[-n:])


# ============================================================
# Pass 2 章节切分
# ============================================================


def split_h2_sections(text: str) -> list[dict]:
    """按 ## 标题切分。返回 [ {num, content} ]（## 前前言 num=None）。"""
    lines = text.split("\n")
    fence = fence_scan(lines)
    idx = [i for i, l in enumerate(lines) if not fence[i] and H_RE[2].match(l)]
    secs: list[dict] = []
    if not idx:
        return [{"num": None, "content": text}]
    if idx[0] > 0:
        pre = "\n".join(lines[: idx[0]])
        if pre.strip():
            secs.append({"num": None, "content": pre})
    bounds = idx + [len(lines)]
    for a, b in zip(idx, bounds[1:]):
        title = H_RE[2].match(lines[a]).group(1)
        secs.append({"num": num_of(title), "content": "\n".join(lines[a:b])})
    return secs


def split_h3(section_text: str) -> list[tuple[str | None, str]]:
    """## 节内按 ### 细分。返回 [ (num|None, text) ]（节首前言=父 ## 编号）。"""
    lines = section_text.split("\n")
    fence = fence_scan(lines)
    idx = [i for i, l in enumerate(lines) if not fence[i] and H_RE[3].match(l)]
    if not idx:
        return []
    out: list[tuple[str | None, str]] = []
    if idx[0] > 0:
        pre = "\n".join(lines[: idx[0]])
        if pre.strip():
            m = H_RE[2].match(lines[0])
            out.append((num_of(m.group(1)) if m else None, pre))
    bounds = idx + [len(lines)]
    for a, b in zip(idx, bounds[1:]):
        t = H_RE[3].match(lines[a]).group(1)
        out.append((num_of(t), "\n".join(lines[a:b])))
    return out


def para_windows(text: str, target_chars: int) -> list[str]:
    """段落窗口兜底。"""
    paras = re.split(r"\n\s*\n", text)
    groups, buf = [], ""
    for p in paras:
        if not p.strip():
            continue
        if buf and len(buf) + len(p) > target_chars:
            groups.append(buf)
            buf = p
        else:
            buf = f"{buf}\n\n{p}" if buf else p
    if buf.strip():
        groups.append(buf)
    return groups


def build_pass2_items(numbered_text: str, max_tokens: int) -> list[dict]:
    """## 节序列 -> 讲解 item 列表（单节超窗按 ###/段落细分）。

    返回 [ {num, content, key} ]，顺序与文档一致；item 顺序即断点续传的 key。
    """
    items: list[dict] = []
    chars = max(1000, int(max_tokens * 1.2))
    for sec in split_h2_sections(numbered_text):
        if estimate_tokens(sec["content"]) <= max_tokens:
            items.append({"num": sec["num"], "content": sec["content"]})
            continue
        subs = split_h3(sec["content"])
        if len(subs) > 1:
            for num, txt in subs:
                if estimate_tokens(txt) <= max_tokens:
                    items.append({"num": num, "content": txt})
                else:
                    for w in para_windows(txt, chars):
                        items.append({"num": num, "content": w})
        else:
            for w in para_windows(sec["content"], chars):
                items.append({"num": sec["num"], "content": w})
    for i, it in enumerate(items):
        it["key"] = i
    return items


def leaf_section_nums(headings: list[dict]) -> list[str]:
    """最小编号节编号列表（其下不含更深层编号小节的节）。"""
    levels = {h["num"]: h["level"] for h in headings}
    leaves = []
    for h in headings:
        prefix = h["num"] + "."
        if not any(n.startswith(prefix) for n in levels):
            leaves.append(h["num"])
    return leaves


# ============================================================
# 图片路径重写
# ============================================================


def _fuzzy_resolve(cand: Path) -> Path | None:
    """精确路径不存在时，按文件名相似度（>=0.85）在同目录找近似文件。

    修复 OCR 云端输出中正文引用与图片清单不一致的情况（如 image_box/chart_box
    措辞差异、坐标微小出入）；仅作回退，精确命中优先。
    """
    import difflib
    if not cand.parent.is_dir():
        return None
    names = [p.name for p in cand.parent.iterdir() if p.is_file()]
    match = difflib.get_close_matches(cand.name, names, n=1, cutoff=0.85)
    return cand.parent / match[0] if match else None


def rewrite_image_paths(text: str, source_md, target_file) -> str:
    """把文本中的图片引用重写为相对 target_file 所在目录的路径。

    源 md 里的图片路径相对源文件（如 imgs/xxx.jpg）；按源文件目录解析
    存在性后改写。HTML 属性值引号内允许空格/括号，写普通相对路径
    （与 v1/v2 产物形态一致）。URL/data:/锚点与无法解析的引用保持原样。
    暂不处理 markdown 形式目标的编码/包裹。
    """
    if not text or source_md is None or target_file is None:
        return text
    src_dir = Path(source_md).parent
    dst_dir = Path(target_file).parent

    def remap(path: str) -> str:
        inner = path.strip()
        if inner.startswith("<") and inner.endswith(">"):
            inner = inner[1:-1]
        low = inner.lower()
        if low.startswith(("http://", "https://", "data:", "ftp://", "#", "//")):
            return path
        cand = src_dir / inner
        if not cand.is_file():
            cand = _fuzzy_resolve(cand) or cand
        if not cand.is_file():
            if (dst_dir / inner).is_file():
                return path  # 已相对目标目录且存在 -> 保持
            return path  # 无法解析，保持原样
        return os.path.relpath(cand, dst_dir).replace("\\", "/")

    text = re.sub(
        r'(<img\b[^>]*?\bsrc\s*=)(["\'])([^"\']*)(\2)',
        lambda m: m.group(1) + m.group(2) + remap(m.group(3)) + m.group(4),
        text, flags=re.I)
    text = re.sub(
        r'(!\[[^\]]*\]\(\s*<)([^>]*)(>\s*\))',
        lambda m: m.group(1) + remap(m.group(2)) + m.group(3),
        text)
    text = re.sub(
        r'(!\[[^\]]*\]\()([^)\s]+)(\))',
        lambda m: m.group(1) + remap(m.group(2)) + m.group(3),
        text)
    return text
