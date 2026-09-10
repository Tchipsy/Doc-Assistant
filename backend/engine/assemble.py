"""拼装器：中间产物 -> 导出 md。移植自老项目 assemble.py，差异：

- 目录基点改为 <docId>/<presetId>/（organized/summary/toc/插件都在此）；
  imgs/ 在共享层 <docId>/imgs/，图片路径据此重写；
- meta 头不再包含 work 路径信息；
- 步骤3 引用协议：插件产物中的 [[c:N]] 标记查 <插件名>.refs.json 转为 ① 字符，
  文末追加「## 引用来源」附录（全文档无引用则不出现）。
"""
import json
import re
import time
from pathlib import Path

from engine import atblock, textutil
from engine.config import (
    PLUGIN_CALLOUTS, PLUGIN_CALLOUT_DEFAULT, SUMMARY_CALLOUT, TOC_HEADING,
    log, read_text_guess,
)
from engine.errors import ArtifactMissing

RESERVED = {"pdf2md.md", "organized.md", "summary.md", "toc.md"}

CITE_RE = re.compile(r"\[\[c:(\d+)\]\]")
CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"


def _cite_mark(idx: int) -> str:
    return CIRCLED[idx - 1] if 1 <= idx <= 20 else f"[{idx}]"


def _load_plugin_refs(stage_dir: Path, name: str) -> dict:
    rf = stage_dir / f"{name}.refs.json"
    if not rf.is_file():
        return {}
    try:
        return json.loads(rf.read_text(encoding="utf-8")) or {}
    except (json.JSONDecodeError, OSError):
        return {}


class _CiteConverter:
    """[[c:N]] -> 全局顺序 ① 编号（同 (docId, anchor) 去重复用同一编号），
    并收集「引用来源」附录条目。n 未命中的标记剔除（与前端协议一致）。"""

    def __init__(self):
        self.entries: list[dict] = []
        self._keys: dict[tuple, int] = {}

    def convert(self, content: str, refs: list[dict]) -> str:
        if "[[c:" not in content:
            return content

        def _sub(m):
            n = int(m.group(1))
            r = next((x for x in refs if x.get("n") == n), None)
            if not r:
                return ""
            key = (r.get("docId", ""), r.get("anchor", ""))
            idx = self._keys.get(key)
            if idx is None:
                idx = len(self.entries) + 1
                self._keys[key] = idx
                entry = {"docName": r.get("docName", ""),
                         "breadcrumb": r.get("breadcrumb", "")}
                # 步骤4：URL 型引用（web 片段，anchor 存 URL）附录带出链接
                url = r.get("url") or r.get("anchor", "")
                if r.get("kind") == "web" or url.startswith(("http://", "https://")):
                    entry["url"] = url
                self.entries.append(entry)
            return _cite_mark(idx)

        return CITE_RE.sub(_sub, content)

    def appendix(self) -> str:
        if not self.entries:
            return ""
        lines = ["## 引用来源", ""]
        for i, e in enumerate(self.entries, 1):
            head = f"《{e['docName']}》" if e["docName"] else "（未知文档）"
            bc = f" {e['breadcrumb']}" if e["breadcrumb"] else ""
            url = f" ｜ {e['url']}" if e.get("url") else ""
            lines.append(f"{_cite_mark(i)} {head}{bc}{url}".strip())
        return "\n".join(lines) + "\n"


def plugin_callout(name: str) -> str:
    return PLUGIN_CALLOUTS.get(name, PLUGIN_CALLOUT_DEFAULT.format(name=name))


def wrap_callout(header_line: str, content: str) -> str:
    out = [header_line]
    for l in content.split("\n"):
        out.append("> " + l if l.strip() else ">")
    return "\n".join(out)


def _insert_at_section_ends(lines, pieces: list[tuple[str, str]], warnings: list[str]) -> int:
    """pieces: [(编号, callout 文本)]。插入到各编号节的 span 末尾（行号原地修改）。

    返回跳过数。同位置多块按传入顺序堆叠（先插者在下）；从后往前插入防行号失效。
    """
    inserts: list[tuple[int, str, str]] = []
    n_skip = 0
    for num, chunk in pieces:
        if not atblock.valid_target(num):
            warnings.append(f"无效编号，跳过：{num!r}")
            n_skip += 1
            continue
        span = textutil.section_span(lines, num)
        if span is None:
            warnings.append(f"编号不存在，跳过：{num}")
            n_skip += 1
            continue
        inserts.append((span[1] + 1, num, chunk))
    for pos, _num, chunk in sorted(inserts, key=lambda x: (-x[0], x[1])):
        start = pos
        while start > 0 and not lines[start - 1].strip():
            start -= 1
        seg = chunk.split("\n")
        if start > 0:
            seg = [""] + seg
        if pos < len(lines) and lines[pos].strip():
            seg = seg + [""]
        lines[start:pos] = seg
    return n_skip


def _insert_after_headings(lines, pieces: list[tuple[str, str]], warnings: list[str]) -> int:
    """pieces: [(编号, callout 文本)]。插入到各编号节标题行的下一行（紧跟大标题，
    与预览一致）。从后往前插入防行号失效。返回跳过数。"""
    inserts: list[tuple[int, str]] = []
    n_skip = 0
    for num, chunk in pieces:
        if not atblock.valid_target(num):
            warnings.append(f"无效编号，跳过：{num!r}")
            n_skip += 1
            continue
        span = textutil.section_span(lines, num)
        if span is None:
            warnings.append(f"编号不存在，跳过：{num}")
            n_skip += 1
            continue
        inserts.append((span[0] + 1, chunk))
    for pos, chunk in sorted(inserts, key=lambda x: -x[0]):
        lines[pos:pos] = ["", *chunk.split("\n"), ""]
    return n_skip


def _blocks_by_num(blocks, expect_type: str, warnings: list[str]):
    out, seen = [], set()
    for b in blocks:
        if b["type"] != expect_type:
            warnings.append(f"块类型 {b['type']!r} ≠ {expect_type!r}，跳过")
            continue
        if not b["content"]:
            warnings.append(f"空块跳过：@@{b['type']} {b['target']}")
            continue
        key = b["target"]
        if key in seen:
            warnings.append(f"重复块跳过：@@{b['type']} {b['target']}")
            continue
        seen.add(key)
        out.append((key, b["content"]))
    return out


def assemble_document(stage_dir: Path, out_path: Path, parts: list[str],
                      doc_meta: dict, kb_name: str, source_name: str) -> dict:
    """stage_dir = <docId>/<presetId>/；图片基点为 stage_dir 上层的 imgs/。"""
    stage_dir = Path(stage_dir)
    organized = stage_dir / "organized.md"
    if not organized.is_file():
        raise ArtifactMissing(f"缺少 organized.md：{stage_dir}")
    warnings: list[str] = []

    text = read_text_guess(organized).replace("\r\n", "\n")
    text, _ = textutil.strip_page_markers(text)
    numbered, headings = textutil.number_headings(text)
    lines = numbered.split("\n")

    plugin_parts = [p for p in parts if p not in ("toc", "summary")]
    cites = _CiteConverter()

    # 节摘要 callout（紧跟各节大标题，与预览一致）
    if "summary" in parts and (stage_dir / "summary.md").is_file():
        _, blocks, _ = atblock.parse_at_blocks(read_text_guess(stage_dir / "summary.md"))
        items = _blocks_by_num(blocks, "summary", warnings)
        pieces = [(num, wrap_callout(SUMMARY_CALLOUT, content))
                  for num, content in items]
        _insert_after_headings(lines, pieces, warnings)

    # 插件 callout（按 parts 顺序，插到各节末尾）；[[c:N]] -> ①（查 refs.json）
    for name in plugin_parts:
        f = stage_dir / f"{name}.md"
        if not f.is_file():
            # pass2 窗口输出为空时按设计不写产物文件（保留待重跑状态）；
            # 组装与预览一致：无 @@block 就不组装，告警跳过
            warnings.append(f"插件 {name} 无产物（未生成或输出为空），已跳过")
            continue
        refs_by_target = _load_plugin_refs(stage_dir, name)
        _, blocks, _ = atblock.parse_at_blocks(read_text_guess(f))
        items = _blocks_by_num(blocks, name, warnings)
        pieces = []
        for num, content in items:
            refs = refs_by_target.get(num) or []
            if "[[c:" in content:
                content = cites.convert(content, refs)
            pieces.append((num, wrap_callout(plugin_callout(name), content)))
        _insert_at_section_ends(lines, pieces, warnings=warnings)

    body = "\n".join(lines)
    # imgs/ 位于共享层（stage_dir 上一级），重写相对 out_path 的路径
    body = textutil.rewrite_image_paths(body, stage_dir.parent / "pdf2md.md", out_path)

    title = doc_meta.get("title") or stage_dir.parent.name
    header = (f"> [!info] Doc-Assistant ｜ 知识库：{kb_name} ｜ 源文件：`{source_name}` ｜ "
              f"生成：{time.strftime('%Y-%m-%d %H:%M')} ｜ 组成：{' + '.join(parts)}\n\n")
    doc = header + f"# {title}\n\n"
    if "toc" in parts:
        toc_file = stage_dir / "toc.md"
        toc_text = read_text_guess(toc_file).strip() if toc_file.is_file() \
            else textutil.build_toc(headings)
        doc += TOC_HEADING + "\n\n" + toc_text + "\n\n"
    doc += body.strip("\n") + "\n"
    appendix = cites.appendix()
    if appendix:
        doc += "\n" + appendix

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(doc, encoding="utf-8", newline="\n")
    log(f"[assemble] ✅ {out_path.name}（组成：{' + '.join(parts)}）")
    return {"output": str(out_path), "parts": list(parts),
            "headings": len(headings), "warnings": warnings}
