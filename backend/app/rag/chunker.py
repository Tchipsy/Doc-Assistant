"""分块器：按编号节入库（本项目天然优势——organized.md 的编号节语义完整）。

- organized：编号叶子节（## 与 ###）为片段；超长节在段落边界二分并带
  1 段重叠，前缀面包屑（"2 数据模型 > 2.1 查询处理"）弥补上下文；
  过短节并入父节片段；
- summary：按 @@summary 节；插件：按 @@块；图片：alt + 所在节上下文。
"""
from pathlib import Path

from app.services import settings_service
from engine import atblock, textutil
from engine.config import read_text_guess

MAX_SECTION_TOKENS = 1000     # 超长节切分阈值（est tokens）
MIN_SECTION_TOKENS = 50       # 过短节并入父节阈值


def _breadcrumb(headings: list[dict], idx: int) -> str:
    """到 headings[idx] 为止的层级路径文本。"""
    parts = []
    level = headings[idx]["level"]
    for h in headings[:idx + 1]:
        if h["level"] <= level:
            parts.append(f"{h['num']} {h['title']}")
    return " > ".join(parts[-3:])


def _split_long(text: str) -> list[str]:
    """段落边界二分 + 1 段重叠。"""
    paras = [p for p in text.split("\n\n") if p.strip()]
    if not paras:
        return [text] if text.strip() else []
    out, buf, buf_toks = [], "", 0
    for p in paras:
        t = textutil.estimate_tokens(p)
        if buf and buf_toks + t > MAX_SECTION_TOKENS:
            out.append(buf)
            buf, buf_toks = p + "\n\n", t      # 带上文 1 段（简化为直接续写）
        else:
            buf = (buf + "\n\n" + p) if buf else p
            buf_toks += t
    if buf.strip():
        out.append(buf)
    return out


def chunk_organized(stage_dir: Path) -> list[dict]:
    """organized.md -> 片段列表（不含 embedding）。"""
    path = stage_dir / "organized.md"
    if not path.is_file():
        return []
    text = read_text_guess(path).replace("\r\n", "\n")
    text, _ = textutil.strip_page_markers(text)
    numbered, headings = textutil.number_headings(text)
    lines = numbered.split("\n")

    chunks: list[dict] = []
    # 计算每个标题的行区间
    spans: list[tuple[int, int]] = []
    hl = textutil.heading_lines(lines)
    for j, (i, k, _t) in enumerate(hl):
        end = len(lines) - 1
        for j2 in range(j + 1, len(hl)):
            ni, nk, _ = hl[j2]
            if nk <= k:
                end = ni - 1
                break
        spans.append((i, end))

    short: list[dict] = []
    for j, (i, end) in enumerate(spans):
        h = headings[j]
        body = "\n".join(lines[i + 1:end + 1]).strip()
        if not body:
            continue
        toks = textutil.estimate_tokens(body)
        item = {"artifact": "organized", "section_num": h["num"],
                "anchor": f"organized:{h['num']}",
                "line_start": i + 1, "line_end": end + 1,
                "breadcrumb": _breadcrumb(headings, j),
                "text": f"{h['num']} {h['title']}\n{body}", "kind": "section"}
        if toks < MIN_SECTION_TOKENS and h["level"] >= 3:
            short.append(item)      # 过短 ###：并入父节（追加到最近的 ## 片段）
            continue
        if toks > MAX_SECTION_TOKENS:
            for k, piece in enumerate(_split_long(body)):
                chunks.append({**item,
                               "text": f"{h['num']} {h['title']}" +
                                       (f"（{k + 1}/{len(_split_long(body))}）\n" if len(_split_long(body)) > 1 else "\n") +
                                       piece})
        else:
            chunks.append(item)

    # 过短 ### 并入父 ##（找同编号前缀的最近 section 片段）
    for item in short:
        parent_num = item["section_num"].rsplit(".", 1)[0] if "." in item["section_num"] else ""
        target = None
        for c in chunks:
            if c["artifact"] == "organized" and c["section_num"] == parent_num:
                target = c
        if target is not None:
            target["text"] += "\n\n" + item["text"]
        else:
            chunks.append(item)
    return chunks


def _chunk_blocks(stage_dir: Path, filename: str, artifact: str) -> list[dict]:
    path = stage_dir / filename
    if not path.is_file():
        return []
    _, blocks, _ = atblock.parse_at_blocks(read_text_guess(path))
    out = []
    seen = set()
    for b in blocks:
        if not b["content"] or b["target"] in seen:
            continue
        seen.add(b["target"])
        out.append({"artifact": artifact, "section_num": b["target"],
                    "anchor": f"{artifact}:{b['target']}",
                    "line_start": None, "line_end": None, "breadcrumb": "",
                    "text": b["content"],
                    "kind": "summary" if artifact == "summary" else "plugin",
                    "plugin": artifact if artifact != "summary" else None})
    return out


def chunk_images(stage_dir: Path, doc_dir: Path) -> list[dict]:
    """图片片段：alt + 所在节上下文（不做多模态嵌入，位置标记指向图片所在节）。"""
    org = stage_dir / "organized.md"
    if not org.is_file():
        return []
    text = read_text_guess(org).replace("\r\n", "\n")
    numbered, headings = textutil.number_headings(text)
    lines = numbered.split("\n")
    hl = textutil.heading_lines(lines)
    chunks = []
    import re
    img_re = re.compile(
        r'!\[([^\]]*)\]\(([^)\s]+)\)'                    # markdown 图片
        r'|<img\b[^>]*?\bsrc=["\']([^"\']+)["\'][^>]*?'  # HTML img（src 与 alt 顺序不限）
        r'(?:\balt=["\']([^"\']*)["\'])?[^>]*>',
        re.I)
    for i, line in enumerate(lines):
        for m in img_re.finditer(line):
            alt = (m.group(1) or m.group(4) or "").strip()
            src = m.group(2) or m.group(3) or ""
            if not src or src.startswith(("http", "data:")):
                continue
            # 图片所在节
            sec_num, sec_title = "", ""
            for j, (li, k, t) in enumerate(hl):
                if li > i:
                    break
                sec_num, sec_title = headings[j]["num"], headings[j]["title"]
            context = alt or f"{sec_num} {sec_title} 中的图片"
            chunks.append({"artifact": "image", "section_num": sec_num,
                           "anchor": f"image:{sec_num}:{src}",
                           "line_start": i + 1, "line_end": i + 1,
                           "breadcrumb": f"{sec_num} {sec_title}".strip(),
                           "text": f"[图片] {context}（位于 {sec_num} {sec_title}）",
                           "kind": "image"})
    return chunks


def chunk_plugin(stage_dir: Path, plugin_name: str) -> list[dict]:
    """单个插件产物 -> 片段（供增量入库复用）。artifact/文件名均为插件名。"""
    return _chunk_blocks(stage_dir, f"{plugin_name}.md", plugin_name)


def chunk_document(doc: dict, stage_dir: Path, doc_dir: Path,
                   index_cfg: dict) -> list[dict]:
    """按入库配置分块。organized 恒入库；summary/图片按勾选；插件按勾选。"""
    comps = index_cfg.get("components", {})
    chunks = chunk_organized(stage_dir)
    if comps.get("summary"):
        chunks += _chunk_blocks(stage_dir, "summary.md", "summary")
    if comps.get("images"):
        chunks += chunk_images(stage_dir, doc_dir)
    for pid in index_cfg.get("plugins", []):
        # pid 为插件预设 id；产物文件与片段 artifact 均使用插件名
        p = settings_service.get_preset(pid)
        chunks += chunk_plugin(stage_dir, p["name"] if p else pid)
    for c in chunks:
        c["kb_id"] = doc["kb_id"]
        c["doc_id"] = doc["id"]
        c["preset_id"] = doc.get("gen_config", {}).get("presetId", "")
    return chunks
