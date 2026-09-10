"""从磁盘产物构建组件树（完成态预览 / pass2 流式基底）。"""
import json
import re
from pathlib import Path

from engine import atblock, textutil
from engine.config import log, read_text_guess
from app.liveview.parser import _rewrite_img, _is_img_line
from app.liveview.tree import LiveTree

# 旧版 pass1 剥离页标记的存量文档：##/###/#### 标题尾部残留的页码标注
# （形如 `## 1 标题（p.5–7）` / `(p.2)`，全角/半角括号，–/—/-/~/〜 分隔符均兼容；
# 须在标题行尾，避免误伤标题正文中偶然出现的 p.N 字样）
_LEGACY_PAGENUM_RE = re.compile(
    r"[（(]\s*p\.\s*(\d+)(?:\s*[–—－\-~〜～−]\s*\d+)?\s*[）)]\s*$")


def _markers_to_spans(text: str) -> tuple[str, int]:
    """页标记 → 零高页码锚点（9.5 步骤6）：`<!-- page:N -->` 替换为
    `<span class="page-anchor" data-page="N"></span>`，原位留在节点 md 流中。
    整行标记 → 独立 span 行；行尾标记：标题行剥离标记后 span 落到标题行后
    （「小节标题后」），正文行内联追加（不拆列表/段落结构）；围栏代码块内不动。
    返回 (新文本, 锚点数)。入库（chunker）/导出（assemble）路径仍剥离标记，不受影响。"""
    lines = text.split("\n")
    fence = textutil.fence_scan(lines)
    out: list[str] = []
    n = 0
    for i, line in enumerate(lines):
        if fence[i]:
            out.append(line)
            continue
        m = textutil.PAGE_TAIL_RE.search(line)
        if not m:
            out.append(line)
            continue
        pm = re.search(r"page:\s*(\d+)", m.group(0))
        if not pm:
            out.append(line)
            continue
        n += 1
        span = f'<span class="page-anchor" data-page="{pm.group(1)}"></span>'
        rest = line[: m.start()].rstrip()
        if not rest:
            out.append(span)
        elif any(textutil.H_RE[k].match(rest) for k in (2, 3, 4)):
            out.append(rest)
            out.append(span)
        else:
            out.append(f"{rest} {span}")
    return "\n".join(out), n


def _legacy_heading_anchors(text: str) -> tuple[str, int]:
    """旧文档动态页锚点（9.6 修复，零 LLM 费用）：文档无任何 `<!-- page:N -->`
    真标记（旧版 pass1 剥离所致，且重新生成会被指纹跳过、旧产物永不修复）时，
    解析 ##/###/#### 标题尾部的页码标注，取每节**起始页**，在标题行后插入与真
    标记转换后同形的零高页锚点 span（「小节标题后」约定一致）。
    仅作用于构建树的内存文本——**不改写 organized.md 产物文件**。
    有真标记的文档不调用（真标记优先）；两者皆无（md 源文档无页码标注）保持 0。
    返回 (新文本, 动态锚点数)。"""
    lines = text.split("\n")
    fence = textutil.fence_scan(lines)
    out: list[str] = []
    n = 0
    for i, line in enumerate(lines):
        out.append(line)
        if fence[i]:
            continue
        if not any(textutil.H_RE[k].match(line) for k in (2, 3, 4)):
            continue
        if "page-anchor" in line or "page:" in line:   # 防御：已有锚点/标记不重复插
            continue
        m = _LEGACY_PAGENUM_RE.search(line)
        if not m:
            continue
        n += 1
        out.append(f'<span class="page-anchor" data-page="{m.group(1)}"></span>')
    return "\n".join(out), n


def _meta_title(stage_dir: Path) -> str | None:
    """stage_dir/.meta.json 的 title（debug3 3.5，读法与 gen_service._doc_meta_brief
    同源）；缺失/空/非字符串返回 None。"""
    try:
        data = json.loads((Path(stage_dir) / ".meta.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    t = (data or {}).get("title")
    return t if isinstance(t, str) and t.strip() else None


def build_tree_from_artifacts(doc_id: str, stage_dir: Path, files_base: str,
                              preset_id: str, *, show_toc: bool, show_summary: bool,
                              show_images: bool, plugins: list[str],
                              doc_name: str | None = None) -> LiveTree:
    """stage_dir = work/<kbId>/<docId>/<presetId>/；plugins 为有序插件名列表。
    doc_name（debug3 3.5）：title 节点的回退名（meta.title or 文档名）。"""
    tree = LiveTree(doc_id, preset_id, base="artifact")
    stage_dir = Path(stage_dir)
    organized = stage_dir / "organized.md"
    true_n = dyn_n = 0

    # debug3 3.5：title 节点贯通——产物树最前（toc 之前）挂文档大标题；
    # 标题与导出 md `# 标题`（export_service._assemble 取同一 meta.title）一致
    title_text = _meta_title(stage_dir) or (doc_name or "").strip() or doc_id
    tree.insert("title", parent="root", props={"title": title_text})

    section_by_num: dict[str, str] = {}
    toc_id = None
    if show_toc:
        toc_id = tree.insert("toc", parent="root", props={"title": "目录"})

    if organized.is_file():
        text = read_text_guess(organized).replace("\r\n", "\n")
        text, true_n = _markers_to_spans(text)
        if true_n == 0:   # 无真标记才动态补（旧文档锚点重建，仅内存文本）
            text, dyn_n = _legacy_heading_anchors(text)
        numbered, headings = textutil.number_headings(text)
        lines = numbered.split("\n")
        fence = textutil.fence_scan(lines)
        cur: str | None = None
        for i, line in enumerate(lines):
            if fence[i]:
                if cur is not None:
                    tree.append_md(cur, line + "\n")
                continue
            handled = False
            for k in (2, 3, 4):
                m = textutil.H_RE[k].match(line)
                if m:
                    title = textutil.NUM_PREFIX_RE.sub(r"\2", m.group(1)).strip()
                    num = textutil.num_of(m.group(1)) or ""
                    sid = tree.insert("section", parent="root",
                                      props={"num": num, "level": k, "title": title,
                                             "anchor": f"organized:{num}"})
                    if num:
                        section_by_num[num] = sid
                    if toc_id:
                        tree.insert("toc_entry", parent=toc_id,
                                    props={"num": num, "title": title, "target": sid})
                    cur = sid
                    handled = True
                    break
            if handled:
                continue
            if not show_images and _is_img_line(line):
                continue
            if cur is None:
                cur = tree.insert("section", parent="root",
                                  props={"num": "", "level": 0, "title": "",
                                         "anchor": "organized:pre"})
            tree.append_md(cur, _rewrite_img(line, files_base) + "\n")

        # 摘要框（勾选 summary 时）
        if show_summary and (stage_dir / "summary.md").is_file():
            _, blocks, _ = atblock.parse_at_blocks(read_text_guess(stage_dir / "summary.md"))
            seen = set()
            for b in blocks:
                if b["type"] != "summary" or not b["content"] or b["target"] in seen:
                    continue
                seen.add(b["target"])
                parent = section_by_num.get(b["target"], "root")
                bid = tree.insert("summary_box", parent=parent,
                                  props={"num": b["target"],
                                         "anchor": f"summary:{b['target']}"})
                tree.set_md(bid, _rewrite_img(b["content"], files_base))

        # 插件框（按生成配置顺序）
        for name in plugins:
            f = stage_dir / f"{name}.md"
            if not f.is_file():
                continue
            # 块级引用（步骤3 [[c:N]] 协议）：refs.json 与 <name>.md 的块一一对应
            refs_by_target: dict = {}
            rf = stage_dir / f"{name}.refs.json"
            if rf.is_file():
                try:
                    refs_by_target = json.loads(rf.read_text(encoding="utf-8")) or {}
                except (json.JSONDecodeError, OSError):
                    refs_by_target = {}
            _, blocks, _ = atblock.parse_at_blocks(read_text_guess(f))
            seen = set()
            for b in blocks:
                if b["type"] != name or not b["content"] or b["target"] in seen:
                    continue
                seen.add(b["target"])
                parent = section_by_num.get(b["target"], "root")
                bid = tree.insert("plugin_box", parent=parent,
                                  props={"plugin": name, "num": b["target"],
                                         "anchor": f"plugin:{name}:{b['target']}",
                                         "refs": refs_by_target.get(b["target"]) or []})
                tree.set_md(bid, _rewrite_img(b["content"], files_base))

    # 可观测性（9.6）：锚点数此前零日志——旧产物 0 标记导致同步静默禁用无从排查
    log(f"[liveview] {doc_id} 页锚点 {true_n + dyn_n} 个"
        f"（真标记 {true_n}/动态补 {dyn_n}）")
    return tree
