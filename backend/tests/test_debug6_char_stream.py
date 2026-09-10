"""debug6——流式逐字符直通（最小拦截集状态机）单测（离线，不触运行中后端/数据库）。

覆盖：任意 chunk 切分下树状态一致（黄金对照）/ chunk 劈开结构前缀（@@、<!--、
``` 等）安全 / @@summary→框→@@end→正文 目标切换时序 / 图片行重写与丢弃两态 /
fence 内直通与开关行翻态 / 页标记 span / pass2 块外丢弃+重复块+未知插件 /
回滚快照往返（含直通中状态）/ flush 落尾（含扣留前缀）/ 事件量（逐 chunk 直推）。

运行：cd backend && python tests/test_debug6_char_stream.py   （或 pytest tests/）
"""
import random
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.liveview.parser import Pass1StreamParser, Pass2StreamParser  # noqa: E402
from app.liveview import tree as tree_mod  # noqa: E402
from app.liveview.tree import LiveTree  # noqa: E402

_passed = 0
FB = "http://127.0.0.1:8000/api/files/work/kb1/doc1"


def ok(name: str) -> None:
    global _passed
    _passed += 1
    print(f"  ok {name}")


def _chunks(s: str, kind: str, seed: int = 7):
    if kind == "one":
        return [s]
    if kind == "char":
        return list(s)
    if kind == "rand":
        rng = random.Random(seed)
        out, i = [], 0
        while i < len(s):
            n = rng.randint(1, 7)
            out.append(s[i:i + n])
            i += n
        return out
    raise ValueError(kind)


def _run_pass1(md: str, *, show_images=True, show_toc=False, chunk="one") -> LiveTree:
    tree = LiveTree("doc_t", "preset", base="live")
    p = Pass1StreamParser(tree, FB, show_toc=show_toc, show_images=show_images)
    for c in _chunks(md, chunk):
        p.feed(c)
    p.flush()
    return tree


def _run_pass2(md: str, base_tree: LiveTree, enabled=("explain",), chunk="one") -> LiveTree:
    p = Pass2StreamParser(base_tree, set(enabled))
    for c in _chunks(md, chunk):
        p.feed(c)
    p.flush()
    return base_tree


def _md_of(tree: LiveTree, pred) -> str:
    for n in tree.snapshot()["nodes"].values():
        if pred(n):
            return n.get("md") or ""
    raise AssertionError("node not found")


SAMPLE = (
    "@@title\n数据库系统概念\n@@end\n"
    "@@digest\n数据库教材的一句话简介\n@@end\n"
    "前言正文一行\n\n"
    "## 1 概述（p.1-2）\n"
    "<!-- page:1 -->\n"
    "概述正文，含行内 `code` 与 **加粗**。\n"
    "```python\n"
    "## 围栏内不是标题\n"
    "print('hi')\n"
    "```\n"
    "![架构图](imgs/arch.png)\n"
    "@@summary 1\n"
    "本节摘要内容。\n"
    "@@end\n"
    "### 1.1 背景\n"
    "背景正文。\n"
    "概述收尾。\n"
)

GOLD_TITLE = "数据库系统概念"


def _snap_md(tree: LiveTree) -> dict:
    """按 (type, props 关键字段, md) 提炼快照（node id 由计数器生成，切分一致即一致）。"""
    out = []
    for n in tree.snapshot()["nodes"].values():
        out.append((n["type"], str(sorted(n["props"].items())), n.get("md") or "",
                    list(n.get("children") or [])))
    return out


def test_t1_equivalence_across_chunkings() -> None:
    """同一输入任意 chunk 切分 → 树状态完全一致（含 id 顺序），且与黄金值一致。"""
    ref = _snap_md(_run_pass1(SAMPLE))
    for kind in ("char", "rand", "rand", "one"):
        got = _snap_md(_run_pass1(SAMPLE, chunk=kind))
        assert got == ref, f"chunk={kind} 树状态不一致"
    # 黄金抽查：title 节点（root 之后第一个）、前言节、两个小节、summary 框
    nodes = list(_run_pass1(SAMPLE).snapshot()["nodes"].values())
    non_root = [n for n in nodes if n["type"] != "root"]
    assert non_root[0]["type"] == "title", f"首节点应为 title：{non_root[0]['type']}"
    tl = [n for n in nodes if n["type"] == "title"][0]
    assert tl["props"]["title"] == GOLD_TITLE
    sec1 = [n for n in nodes if n["type"] == "section" and n["props"].get("num") == "1"][0]
    assert "概述正文" in sec1["md"] and f"![架构图]({FB}/imgs/arch.png)" in sec1["md"]
    assert 'data-page="1"' in sec1["md"]
    box = [n for n in nodes if n["type"] == "summary_box"][0]
    assert box["md"] == "本节摘要内容。\n"
    assert box["props"]["anchor"] == "summary:1"
    sec11 = [n for n in nodes if n["type"] == "section" and n["props"].get("num") == "1.1"][0]
    assert sec11["md"] == "背景正文。\n概述收尾。\n"
    ok("t1 任意切分等价 + 黄金抽查")


def test_t2_structural_prefix_split() -> None:
    """chunk 劈开结构前缀（@@ / <!-- / ``` / ## / ![）不误判。"""
    tree = _run_pass1("@\n@summary 9\n块\n@@end\n" , chunk="char")
    assert not [n for n in tree.snapshot()["nodes"].values()
                if n["type"] == "summary_box"], "孤立 @ 与 @@ 分行不应建框"
    tree = _run_pass1("正文A\n@@summa\nry 3\n内容\n@@end\n", chunk="char")
    # "@@summa\nry 3" 是两行：@@summa（未知块→杂散丢弃）+ ry 3（正文）
    assert not [n for n in tree.snapshot()["nodes"].values()
                if n["type"] == "summary_box"]
    tree = _run_pass1("正文B\n<!--pag\ne:3-->\n正文C\n", chunk="char")
    assert "<!--pag" in _md_of(tree, lambda n: n["type"] == "section"), "劈开的注释行按普通文本直通"
    tree = _run_pass1("## 1 T\n```\n## not heading\n```\n", chunk="char")
    sec = _md_of(tree, lambda n: n["type"] == "section" and n["props"].get("num") == "1")
    assert "## not heading" in sec
    assert len([n for n in tree.snapshot()["nodes"].values()
                if n["type"] == "section"]) == 1, "围栏内 ## 不得建节"
    ok("t2 结构前缀劈开安全")


def test_t3_image_rewrite_and_drop() -> None:
    """图片行：show_images=True 重写相对 src；False 整行丢弃（含行中图片）。"""
    tree = _run_pass1("## 1 T\n![图](imgs/a.png)\n后文\n", chunk="char")
    sec = _md_of(tree, lambda n: n["type"] == "section" and n["props"].get("num") == "1")
    assert f"![图]({FB}/imgs/a.png)" in sec, "相对 src 必须重写"
    tree = _run_pass1("## 1 T\n![图](imgs/a.png)\n后文\n", show_images=False, chunk="char")
    sec = _md_of(tree, lambda n: n["type"] == "section" and n["props"].get("num") == "1")
    assert "imgs/a.png" not in sec and "后文" in sec, "图片行整行丢弃"
    tree = _run_pass1("## 1 T\n文字含 ![图](imgs/a.png) 行中图片\n", show_images=False, chunk="char")
    sec = _md_of(tree, lambda n: n["type"] == "section" and n["props"].get("num") == "1")
    assert sec.strip() == "", "行中图片同样整行丢弃（旧语义）"
    ok("t3 图片重写/丢弃两态")


def test_t4_box_switch_sequence() -> None:
    """@@summary/@@end 目标切换：前后正文入节、块内入框（跨 chunk 时序一致）。
    （parser 对标题重编号：首个 ## → num=1，源编号剥离——与 finalize 同算法）"""
    md = "## 1 节\n前文\n@@summary 1\n摘要A\n摘要B\n@@end\n后文\n"
    for kind in ("one", "char", "rand"):
        tree = _run_pass1(md, chunk=kind)
        sec = _md_of(tree, lambda n: n["type"] == "section" and n["props"].get("num") == "1")
        box = _md_of(tree, lambda n: n["type"] == "summary_box")
        assert sec == "前文\n后文\n", f"chunk={kind} 节正文不符：{sec!r}"
        assert box == "摘要A\n摘要B\n", f"chunk={kind} 框内容不符：{box!r}"
    ok("t4 目标切换三态时序")


def test_t5_fence_and_toggle_stream() -> None:
    """围栏开关行本身直通入正文，围栏内行直通（无结构判定），闭合翻态。"""
    md = "## 1 T\n```text\n<!-- page:9 -->\n@@summary fake\n```\n尾行\n"
    for kind in ("one", "char"):
        tree = _run_pass1(md, chunk=kind)
        sec = _md_of(tree, lambda n: n["type"] == "section" and n["props"].get("num") == "1")
        assert "```text" in sec and "```" in sec
        assert "<!-- page:9 -->" in sec, "围栏内页标记原样（不转 span）"
        assert "@@summary fake" in sec, "围栏内 @@ 原样"
        assert "尾行" in sec
        assert not [n for n in tree.snapshot()["nodes"].values()
                    if n["type"] == "summary_box"], "围栏内 @@ 不建框"
        assert 'data-page="9"' not in sec
    ok("t5 围栏直通与翻态")


def test_t6_rollback_roundtrip() -> None:
    """回滚快照含字符级状态机字段：恢复后重喂剩余流，结果与一次喂全等价。"""
    from app.liveview.tree import LiveSession
    md_head = "## 1 T\n正文头\n@@summary 1\n摘要前半"
    md_tail = "摘要后半\n@@end\n正文尾\n"
    # 路径A：一次喂全
    sess_a = LiveSession("d", "p")
    sess_a.begin_pass1(FB, show_toc=False, show_images=True, doc_title="T")
    sess_a.p1.feed(md_head + md_tail)
    sess_a.p1.flush()
    # 路径B1：手动快照对（树+parser 状态，含 MODE_STREAM 直通中状态）→ 喂尾 →
    # 恢复 → 重喂尾（flush 只允许在流真正结束时调用，流中不可插 flush）
    sess_b = LiveSession("d", "p")
    sess_b.begin_pass1(FB, show_toc=False, show_images=True, doc_title="T")
    sess_b.p1.feed(md_head)
    nodes_b, st_b = sess_b.tree.snapshot_nodes(), sess_b.p1.state_snapshot()
    sess_b.p1.feed(md_tail)
    sess_b.tree.replace_all(nodes_b)
    sess_b.p1.restore_state(st_b)
    sess_b.p1.feed(md_tail)
    sess_b.p1.flush()
    assert sess_a.tree.snapshot()["nodes"] == sess_b.tree.snapshot()["nodes"], \
        "手动快照恢复后重喂与一次喂全不等价"
    # 路径B2：窗口检查点回滚（尾部无 @@end → 无恢复点 → 落到窗口快照）
    md_tail2 = "摘要后半\n摘要更多\n"
    sess_c = LiveSession("d", "p")
    sess_c.begin_pass1(FB, show_toc=False, show_images=True, doc_title="T")
    sess_c.p1.feed(md_head)
    sess_c.checkpoint()
    sess_c.p1.feed(md_tail2)
    sess_c.rollback()
    sess_c.p1.feed(md_tail2)
    sess_c.p1.flush()
    # 对照：一次喂全（head + tail2，无 @@end）
    sess_d = LiveSession("d", "p")
    sess_d.begin_pass1(FB, show_toc=False, show_images=True, doc_title="T")
    sess_d.p1.feed(md_head + md_tail2)
    sess_d.p1.flush()
    assert sess_d.tree.snapshot()["nodes"] == sess_c.tree.snapshot()["nodes"], \
        "窗口检查点回滚后重喂不等价"
    ok("t6 回滚往返等价（手动快照对 + 窗口检查点）")


def test_t7_flush_tail() -> None:
    """flush 落尾：无换行尾巴、扣留前缀（@summa 类）均不丢。"""
    tree = LiveTree("d", "p")
    p = Pass1StreamParser(tree, FB, show_toc=False, show_images=True)
    p.feed("## 1 T\n正文无换行尾巴")
    p.flush()
    sec = _md_of(tree, lambda n: n["type"] == "section" and n["props"].get("num") == "1")
    assert sec.endswith("正文无换行尾巴\n"), f"尾行丢失：{sec!r}"
    tree = LiveTree("d", "p")
    p = Pass1StreamParser(tree, FB, show_toc=False, show_images=True)
    p.feed("## 1 T\n正文\n@summa")
    p.flush()
    sec = _md_of(tree, lambda n: n["type"] == "section" and n["props"].get("num") == "1")
    assert "@summa" in sec, "扣留前缀按普通文本落地"
    ok("t7 flush 落尾")


def test_t8_pass2_blockout_dup_unknown() -> None:
    """pass2：块外丢弃、重复块丢弃、未知插件丢弃、框内容直通。"""
    base = _run_pass1("## 1 A\n内容甲\n## 2 B\n内容乙\n")
    md = ("块外丢弃甲\n@@explain 1\n解释甲内容\n@@end\n"
          "块外丢弃乙\n@@explain 1\n重复块\n@@end\n"
          "@@unknown 2\n未知\n@@end\n@@explain 2\n解释乙内容\n@@end\n")
    for kind in ("one", "char"):
        tree = _run_pass2(md, _run_pass1(
            "## 1 A\n内容甲\n## 2 B\n内容乙\n"), enabled=("explain",), chunk=kind)
        boxes = [n for n in tree.snapshot()["nodes"].values()
                 if n["type"] == "plugin_box"]
        assert len(boxes) == 2, f"chunk={kind} 框数 {len(boxes)}"
        by_anchor = {n["props"]["anchor"]: n["md"] for n in boxes}
        assert by_anchor["plugin:explain:1"] == "解释甲内容\n"
        assert by_anchor["plugin:explain:2"] == "解释乙内容\n"
        joined = "".join(n.get("md") or "" for n in tree.snapshot()["nodes"].values())
        assert "块外" not in joined and "重复块" not in joined and "未知" not in joined
    ok("t8 pass2 块外/重复/未知丢弃")


def test_t9_event_volume() -> None:
    """逐 chunk 直推：每 feed 一次 append（100 chunk ≈ 100 op），零丢失。"""
    ops: list[dict] = []
    orig = tree_mod.emit

    def capture(channel, **kw):
        if channel == "render.op":
            ops.append(kw["op"])
        return orig(channel, **kw)

    tree_mod.emit = capture
    try:
        tree = LiveTree("d", "p")
        p = Pass1StreamParser(tree, FB, show_toc=False, show_images=True)
        p.feed("## 1 T\n")
        body = "流式正文一段" * 25   # 150 字符 → 100 个 1.5 字符 chunk 的近似
        body = body[:150]
        for i in range(0, len(body), 2):
            p.feed(body[i:i + 2])
        p.flush()
    finally:
        tree_mod.emit = orig
    appends = [o for o in ops if o["op"] == "append"]
    sec_md = _md_of(tree, lambda n: n["type"] == "section" and n["props"].get("num") == "1")
    assert sec_md == body + "\n", f"正文不完整：{sec_md!r}"
    assert 50 <= len(appends) <= 160, f"append 事件量异常：{len(appends)}"
    assert "".join(o["text"] for o in appends if o["id"] == [k for k, v in
                   tree.snapshot()["nodes"].items() if v["type"] == "section"][0]) \
        .startswith("流式正文")
    ok(f"t9 事件量直推（append={len(appends)}）")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            print(name)
            fn()
    print(f"\n全部通过：{_passed} 组")
