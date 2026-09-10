"""9.6 同步滚动修复——离线单测（不触碰运行中后端与 data/app.db）。

覆盖（临时产物目录，全部只读写 tempdir）：
- build.py 动态页锚点：真标记优先（有真标记完全不动态补）/ 无真标记有页码标注
  （取每节起始页，span 插在标题行后，与真标记转换后同形）/ 全无保持 0 /
  全角半角括号与 –/—/-/~ 分隔符变体 / 非行尾标注与围栏代码块内不误插 /
  不写回 organized.md 产物文件
- snapshot_service.py anchorGen 版本失效：缺字段/旧值 → preview_tree_fresh STALE
  （调用方走现场重组并入队重建的现有失效路径），snapshots_fresh 旧判据不受影响
  （.export.md 快路径不因锚点版本失效）；写入当前 anchorGen 后恢复新鲜

运行：cd backend && python tests/test_dynamic_page_anchors.py   （或 pytest tests/）
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.liveview.build import build_tree_from_artifacts  # noqa: E402
from app.services import snapshot_service as ss  # noqa: E402

# 简易用例计数（pytest 不在时直接 python 运行也可见进度）
_passed = 0


def ok(name: str) -> None:
    global _passed
    _passed += 1
    print(f"  ok {name}")


def _anchor_pages(tree) -> list[int]:
    """树节点 md 里的页锚点 data-page 列表（按出现顺序）。"""
    import re
    pages = []
    for node in tree.snapshot()["nodes"].values():
        pages += [int(m) for m in re.findall(r'data-page="(\d+)"', node.get("md") or "")]
    return pages


def _build(sdir: Path, **kw):
    return build_tree_from_artifacts(
        "doc_test", sdir, "", "preset",
        show_toc=kw.get("show_toc", False), show_summary=False,
        show_images=True, plugins=[])


def test_true_markers_win() -> None:
    """有真标记的文档完全不动态补：标题页码标注保持原样（不插第二个锚点）。"""
    tmp = Path(tempfile.mkdtemp())
    try:
        sdir = tmp / "preset"
        sdir.mkdir(parents=True)
        (sdir / "organized.md").write_text(
            "## 1 有标记（p.9）\n<!-- page:4 -->\n正文甲\n## 2 无标记\n正文乙\n",
            encoding="utf-8")
        pages = _anchor_pages(_build(sdir))
        assert pages == [4], pages   # 只认真标记；（p.9）不动态补
        ok("真标记优先：有真标记时不动态补标题页码标注")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_legacy_annotations_become_anchors() -> None:
    """无真标记 + 标题尾页码标注：取起始页，span 落在标题行后（节 md 首行）。"""
    tmp = Path(tempfile.mkdtemp())
    try:
        sdir = tmp / "preset"
        sdir.mkdir(parents=True)
        (sdir / "organized.md").write_text(
            "## 1 课程信息（p.1–3）\n正文甲\n### 1.1 明细（p.2）\n正文乙\n"
            "## 2 概念（p.4–7）\n正文丙\n",
            encoding="utf-8")
        tree = _build(sdir)
        pages = _anchor_pages(tree)
        assert pages == [1, 2, 4], pages   # 每节起始页（en-dash 区间取左端）
        # span 紧跟标题行后 = 所在小节 md 的首个非空行
        for node in tree.snapshot()["nodes"].values():
            md = (node.get("md") or "").strip()
            if md.startswith('<span class="page-anchor"'):
                assert md.splitlines()[0].startswith('<span class="page-anchor"')
        ok("无真标记有页码标注 → 动态锚点（起始页，标题行后）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_neither_keeps_zero() -> None:
    """两者皆无保持 0：md 源文档（pages=0）无页码标注，不应误插。"""
    tmp = Path(tempfile.mkdtemp())
    try:
        sdir = tmp / "preset"
        sdir.mkdir(parents=True)
        (sdir / "organized.md").write_text(
            "## 1 标题（注）\n正文\n## 2 另一节\n详见 p.3 的说明\n", encoding="utf-8")
        assert _anchor_pages(_build(sdir)) == []
        ok("两者皆无（md 源/正文出现 p.3 字样）→ 0 锚点")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_paren_and_separator_variants() -> None:
    """全角/半角括号与 –/—/-/~ 分隔符及空格变体均可解析起始页。"""
    tmp = Path(tempfile.mkdtemp())
    try:
        sdir = tmp / "preset"
        sdir.mkdir(parents=True)
        cases = [
            ("## 1 半角括号 (p.7)", 7),
            ("## 2 波浪线（p.8~9）", 8),
            ("## 3 em-dash（p.10—11）", 10),
            ("## 4 连字符（p.12-13）", 12),
            ("## 5 空格（p. 14 – 15）", 14),
            ("### 5.1 全角波浪（p.16～17）", 16),
        ]
        text = "".join(f"{h}\n正文\n" for h, _ in cases)
        (sdir / "organized.md").write_text(text, encoding="utf-8")
        assert _anchor_pages(_build(sdir)) == [p for _, p in cases]
        ok("括号/分隔符变体（(p.7)（p.8~9）（p.10—11）等）→ 起始页")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_no_false_positive() -> None:
    """非标题行尾标注不误插：行中 p.N、围栏代码块内的标题形行均跳过。"""
    tmp = Path(tempfile.mkdtemp())
    try:
        sdir = tmp / "preset"
        sdir.mkdir(parents=True)
        (sdir / "organized.md").write_text(
            "## 1 p.3 开头的标题（不是页码标注结尾）\n正文\n"
            "```\n## 2 代码块里的标题（p.9）\n```\n"
            "正文引用 (p.5)\n", encoding="utf-8")
        assert _anchor_pages(_build(sdir)) == []
        ok("行中/围栏内标注不误插（正则锚定标题行尾 + fence 跳过）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_artifact_file_untouched() -> None:
    """动态插入只发生在构建树的内存文本里：organized.md 产物文件逐字节不变。"""
    tmp = Path(tempfile.mkdtemp())
    try:
        sdir = tmp / "preset"
        sdir.mkdir(parents=True)
        src = "## 1 课程信息（p.1–3）\n正文甲\n### 1.1 明细 (p.2)\n正文乙\n"
        (sdir / "organized.md").write_text(src, encoding="utf-8")
        before = (sdir / "organized.md").read_bytes()
        assert len(_anchor_pages(_build(sdir))) == 2
        assert (sdir / "organized.md").read_bytes() == before
        assert b"page-anchor" not in (sdir / "organized.md").read_bytes()
        ok("不写回产物文件：organized.md 逐字节不变")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _make_snapshot(sdir: Path, cfg: dict, meta: dict) -> None:
    (sdir / ".preview.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    (sdir / ".export.md").write_text("导出内容", encoding="utf-8")


def test_anchor_gen_stale_rebuild() -> None:
    """快照 anchorGen 失效：缺字段/旧值 → preview_tree_fresh STALE（走现场重组+入队
    重建路径）；snapshots_fresh 旧判据不受影响；写入当前版本后恢复新鲜。"""
    tmp = Path(tempfile.mkdtemp())
    try:
        sdir = tmp / "kb" / "doc" / "preset"
        sdir.mkdir(parents=True)
        (sdir / "organized.md").write_text("## 1 t（p.3）\n正文\n", encoding="utf-8")
        cfg = {"presetId": "preset", "components": {"toc": True}}
        fp = ss.artifacts_fp(sdir)
        assert fp
        tree = {"docId": "doc", "nodes": {}}
        meta = {"genFp": fp, "cfgHash": ss.cfg_hash(cfg), "builtAt": "x", "tree": tree}

        _make_snapshot(sdir, cfg, meta)   # 旧快照：无 anchorGen 字段
        assert ss.snapshots_fresh(sdir, cfg)           # 旧判据通过（导出路径不受影响）
        assert not ss.preview_tree_fresh(sdir, cfg)    # 锚点版本缺失 → STALE
        assert ss.load_preview_tree(sdir, cfg) is None
        ok("缺 anchorGen 字段 → STALE（现场重组+入队重建），导出快路径不受影响")

        _make_snapshot(sdir, cfg, {**meta, "anchorGen": ss.ANCHOR_GEN - 1})
        assert not ss.preview_tree_fresh(sdir, cfg)
        assert ss.load_preview_tree(sdir, cfg) is None
        ok("anchorGen 旧值 → STALE")

        _make_snapshot(sdir, cfg, {**meta, "anchorGen": ss.ANCHOR_GEN})
        assert ss.preview_tree_fresh(sdir, cfg)
        assert ss.load_preview_tree(sdir, cfg) == tree
        ok(f"anchorGen={ss.ANCHOR_GEN} → 新鲜，快路径返回 tree")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    test_true_markers_win()
    test_legacy_annotations_become_anchors()
    test_neither_keeps_zero()
    test_paren_and_separator_variants()
    test_no_false_positive()
    test_artifact_file_untouched()
    test_anchor_gen_stale_rebuild()
    print(f"\n全部通过：{_passed} 项断言组")
