"""debug2 #1——流式解析器页标记转零高页锚点单测（离线，不触运行中后端/数据库）。

背景：流式 parser 此前把 `<!-- page:N -->` 整行丢弃 → 生成中实时预览无页锚点、
双窗口同步滚动生成中不可用。修复后页标记整行转为
`<span class="page-anchor" data-page="N"></span>` 走 _append_body 追加当前节
（与 build.py 产物树 _markers_to_spans 同语义：span 行落入标记所在当前节；
fence 内原样保留；产物侧不改动）。

覆盖：整行标记转 span 追加当前节 / 跨节归属 / fence 内不动 / 正文完整性 /
show_images=False 不误滤 span / 前言节（organized:pre）/ 块内标记走 _append_body
落点 / 增量 feed（标记行跨 chunk 到达）。

运行：cd backend && python tests/test_stream_page_anchors.py   （或 pytest tests/）
"""
import re
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.liveview.parser import Pass1StreamParser  # noqa: E402
from app.liveview.tree import LiveTree  # noqa: E402

_passed = 0


def ok(name: str) -> None:
    global _passed
    _passed += 1
    print(f"  ok {name}")


def _feed(md: str, show_images: bool = True, show_toc: bool = False) -> LiveTree:
    tree = LiveTree("doc_t", "preset", base="live")
    p = Pass1StreamParser(tree, "", show_toc=show_toc, show_images=show_images)
    p.feed(md)
    p.flush()
    return tree


def _section_md(tree: LiveTree, num: str) -> str:
    for n in tree.snapshot()["nodes"].values():
        if n["type"] == "section" and n["props"].get("num") == num:
            return n.get("md") or ""
    return ""


def _anchor_pages(tree: LiveTree) -> list[int]:
    pages = []
    for n in tree.snapshot()["nodes"].values():
        pages += [int(m) for m in re.findall(r'data-page="(\d+)"', n.get("md") or "")]
    return pages


def test_marker_becomes_span_line() -> None:
    """整行页标记不再丢弃：转为独立 span 行追加当前节，原标记不残留。"""
    tree = _feed("## 1 标题甲\n<!-- page:3 -->\n正文甲\n")
    md = _section_md(tree, "1")
    assert 'data-page="3"' in md, md
    assert '<!-- page:' not in md, "原始标记不应残留在节点文本"
    assert '正文甲' in md, "正文完整性"
    assert '<span class="page-anchor" data-page="3"></span>\n' in md, "span 独立成行"
    ok("整行页标记 → span 行追加当前节（原标记不残留、正文完整）")


def test_marker_belongs_to_current_section() -> None:
    """跨节归属：span 落入标记出现时的当前节（与产物树同语义）。"""
    tree = _feed("## 1 甲\n<!-- page:1 -->\n甲文\n## 2 乙\n<!-- page:2 -->\n乙文\n")
    assert 'data-page="1"' in _section_md(tree, "1")
    assert 'data-page="2"' in _section_md(tree, "2")
    assert _anchor_pages(tree) == [1, 2]
    ok("跨节归属正确（span 落入所在当前节）")


def test_marker_inside_fence_untouched() -> None:
    """围栏代码块内的页标记原样保留（不转 span）。"""
    tree = _feed("## 1 甲\n```\n<!-- page:9 -->\n```\n后文\n")
    md = _section_md(tree, "1")
    assert '<!-- page:9 -->' in md, "fence 内标记原样保留"
    assert 'data-page=' not in md, "fence 内不生成锚点"
    ok("fence 内不动")


def test_span_survives_show_images_false() -> None:
    """show_images=False 时 span 仍保留（跳过图片过滤——span 非图片行）。"""
    tree = _feed("## 1 甲\n<!-- page:4 -->\n![x](img.png)\n", show_images=False)
    md = _section_md(tree, "1")
    assert 'data-page="4"' in md, "锚点不被图片过滤吃掉"
    assert "img" not in md, "图片行照常被过滤"
    ok("show_images=False 不误滤 span")


def test_marker_in_pre_section() -> None:
    """首个标题前的标记：落入前言节（organized:pre）。"""
    tree = _feed("<!-- page:1 -->\n前言\n## 1 甲\n甲\n")
    md = _section_md(tree, "")
    assert 'data-page="1"' in md and "前言" in md, "前言节拿到锚点与正文"
    ok("前言节（organized:pre）")


def test_marker_inside_block_goes_through_append_body() -> None:
    """块打开期间的标记行：走 _append_body 落点（与任意正文行同落点，入块 md）。"""
    tree = _feed("@@summary 1\n<!-- page:2 -->\n摘要内容\n@@end\n")
    box_md = ""
    for n in tree.snapshot()["nodes"].values():
        if n["type"] == "summary_box":
            box_md = n.get("md") or ""
    assert 'data-page="2"' in box_md and "摘要内容" in box_md
    ok("块内标记走 _append_body 落点")


def test_incremental_feed_split_marker() -> None:
    """增量喂入：标记行跨 chunk 到达（行缓冲拼接后仍正确识别转换）。"""
    tree = LiveTree("doc_t", "preset", base="live")
    p = Pass1StreamParser(tree, "", show_toc=False, show_images=True)
    p.feed("## 1 甲\n<!-- pa")
    p.feed("ge:5 -->\n甲文\n")
    p.flush()
    md = _section_md(tree, "1")
    assert 'data-page="5"' in md and "甲文" in md
    assert '<!-- page:' not in md
    ok("标记行跨 chunk 增量喂入")


def test_toc_and_body_coexist() -> None:
    """带目录+多节+图片行完整流：正文/目录/锚点互不干扰（回归）。"""
    md_src = ("## 1 甲\n<!-- page:1 -->\n![图](pic.png)\n## 2 乙\n<!-- page:2 -->\n乙文\n")
    tree = _feed(md_src, show_toc=True)
    assert _anchor_pages(tree) == [1, 2]
    assert "![图](/pic.png)" in _section_md(tree, "1"), "图片重写不受影响"
    toc_entries = [n for n in tree.snapshot()["nodes"].values() if n["type"] == "toc_entry"]
    assert len(toc_entries) == 2, "目录条目正常"
    ok("目录/图片重写/锚点共存回归")


if __name__ == "__main__":
    test_marker_becomes_span_line()
    test_marker_belongs_to_current_section()
    test_marker_inside_fence_untouched()
    test_span_survives_show_images_false()
    test_marker_in_pre_section()
    test_marker_inside_block_goes_through_append_body()
    test_incremental_feed_split_marker()
    test_toc_and_body_coexist()
    print(f"\n全部通过：{_passed} 项断言组")
