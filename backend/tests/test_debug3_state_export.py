"""debug3 步骤3——后端状态与导出离线单测（不触运行中后端/真实 app.db，全程临时库与临时目录）。

覆盖（任务书 AGENT/9.5_debug/步骤3-后端状态与导出.md）：
- 3.1 #6 queued 状态机：start_generation 置 queued + doc.status 事件；解析完成保留
  queued（不闪回 ready）；RUNNING_STATUSES 纳入 queued；
- 3.2 #8 index_fp 新口径（去 gen.plugins）：口径差异 / gen.plugins 为空时等价 /
  migrate_index_fp 只覆写"纯口径差异"的存量指纹（真实漂移不动）+ 幂等；
- 3.3 #11 启动恢复 recover_stale_status：generating/queued→ready、parsing 按产物
  判定、逐篇 doc.status 事件；pause/resume 僵尸区分返回 + 路由 409（TestClient 临时库）；
- 3.4 #15 pdf 指纹缓存：未命中转换写缓存 / 同指纹二次秒回（不重跑转换）/
  根目录最新语义 / per-doc LRU=3 / 指纹随 PdfOptions 变化；
- 3.5 #4 title 贯通：_assemble 取 meta.title 回退文档名；产物树/流式树 title 节点
  位于 root 子序第一（toc 之前）；
- 3.7 pass1 合并 title+digest：块剥离/仅窗口1 生效/缺块回退/未闭合丢弃/digest 随
  stats 返回；流式 @@title 即时上屏（update 占位节点）、@@digest 不上屏、正文开始
  后的信息块按杂散块丢弃；pass1 契约节参与指纹（common sha）。

运行：cd backend && python tests/test_debug3_state_export.py   （或 pytest tests/）
"""
import asyncio
import json
import sys
import tempfile
import threading
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import app.events as evmod  # noqa: E402
import app.db as dbmod  # noqa: E402
import app.paths as paths  # noqa: E402

_passed = 0


def ok(name: str) -> None:
    global _passed
    _passed += 1
    print(f"  ok {name}")


# ---------------- 公共工具 ----------------

class _Tmp:
    """临时库 + 事件快照记录（db.init 到临时文件；bus 用真实例读 _buffer 差量）。"""

    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="debug3_test_"))
        dbmod.init(self.dir / "app.db")
        self.bus = evmod.bus
        self.mark = self._buf_len()

    def _buf_len(self):
        return len(list(self.bus._buffer))

    def events(self):
        """自标记以来的全部事件 [{channel, **data}]。"""
        return [ev for _, ev in list(self.bus._buffer)[self.mark:]]

    def cleanup(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)


def _mk_kb(d, name="库A"):
    conn = dbmod.get()
    conn.execute("INSERT INTO kbs (id, name, created_at) VALUES (?, ?, ?)",
                 (d.kb_id, name, "2026-09-07 00:00:00"))


def _mk_doc(d, did, name="文档", status="ready", gen_config="{}",
            index_config="{}", index_fp=None):
    conn = dbmod.get()
    conn.execute(
        "INSERT INTO docs (id, kb_id, name, source_kind, doc_type, size, status,"
        " gen_config, index_config, index_fp, created_at, sort_order)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (did, d.kb_id, name, "pdf", "doc", 10, status, gen_config, index_config,
         index_fp, "2026-09-07 00:00:00", 1000.0))
    conn.commit()


def _doc_row(did):
    return dbmod.get().execute("SELECT * FROM docs WHERE id = ?", (did,)).fetchone()


def _fake_stage(work_dir: Path, kb: str, did: str, preset: str,
                organized: str = "## 1 甲\n甲文\n",
                meta: dict | None = None) -> Path:
    sdir = work_dir / kb / did / preset
    sdir.mkdir(parents=True, exist_ok=True)
    (sdir / "organized.md").write_text(organized, encoding="utf-8")
    if meta is not None:
        (sdir / ".meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return sdir


# ---------------------------------------------------------------- 3.7 指纹
def t0_pass1_common_fingerprint():
    print("0) pass1 契约节参与指纹（common sha）")
    from app.services.gen_service import _pass1_common_spec
    from engine import meta as meta_mod

    spec = _pass1_common_spec()
    assert spec.sha, "common 契约 spec 应有 sha"
    p1 = Path(BACKEND) / "prompts" / "common.md"
    text = p1.read_text(encoding="utf-8")
    assert "@@title" in text and "@@digest" in text, "common.md 契约应含信息块"
    assert "pass1.title" not in text, "旧 ## pass1.title 小节应已删除"
    # 契约变化 → 指纹变化
    p2 = Path(tempfile.mkdtemp()) / "pdf2md.md"
    p2.write_text("# t\n", encoding="utf-8")

    class _S:
        name, sha = "x", "AAA"
    base = meta_mod.pass1_params(p2, _S(), _S(), 1000, "m")
    with_common = meta_mod.pass1_params(p2, _S(), _S(), 1000, "m", common=spec)
    assert "common" not in base and with_common["common"]["sha"] == spec.sha
    ok("pass1_params 含 common 契约指纹；common.md 已改写为 @@title/@@digest 契约")


# ---------------------------------------------------------------- 3.1 queued
def t1_queued_state_machine():
    print("1) queued 状态机：提交置 queued + 事件 / 解析完成保留 queued")
    from app.services import gen_service, kb_service

    d = _Tmp()
    d.kb_id = "kb_t1"
    _mk_kb(d)
    did = "doc_t1"
    _mk_doc(d, did, status="ready")
    try:
        # start_generation：置 queued 并广播 doc.status（_run 用桩替换不触流水线）
        old_run = gen_service.service._run
        gen_service.service._run = lambda job, ids, force: None
        try:
            gen_service.service.start_generation([did])
        finally:
            gen_service.service._run = old_run
        assert _doc_row(did)["status"] == "queued", "提交后应持久 queued"
        evs = [e for e in d.events() if e["channel"] == "doc.status"]
        assert evs and evs[-1]["docId"] == did and evs[-1]["status"] == "queued"
        ok("start_generation 置 status='queued' 并 emit doc.status")

        # 解析完成路径：status=queued 时保留排队态（不闪回 ready）
        src = d.dir / "src.pdf"
        src.write_bytes(b"%PDF-1.4 fake")
        import engine.ocr as ocr_mod
        old_parse = ocr_mod.parse_document
        ocr_mod.parse_document = lambda s, ddir, cfg: {"pages": 1}
        try:
            kb_service._parse_job({"id": "j1"}, did, d.kb_id, src)
        finally:
            ocr_mod.parse_document = old_parse
        assert _doc_row(did)["status"] == "queued", "解析完成应保留 queued"
        ok("解析完成时 queued 保留（_parse_job 不回写 ready）")

        # 普通 parsing 文档解析完成 → ready（原语义不回归）
        did2 = "doc_t1b"
        _mk_doc(d, did2, status="parsing")
        ocr_mod.parse_document = lambda s, ddir, cfg: {"pages": 1}
        try:
            kb_service._parse_job({"id": "j2"}, did2, d.kb_id, src)
        finally:
            ocr_mod.parse_document = old_parse
        assert _doc_row(did2)["status"] == "ready"
        ok("parsing 文档解析完成仍置 ready（原语义不变）")

        # RUNNING_STATUSES 纳入 queued：移动/复制校验拒绝排队中文档
        from app.services.kb_service import RUNNING_STATUSES, _validate_targets
        assert "queued" in RUNNING_STATUSES
        try:
            _validate_targets([did])
            raise AssertionError("queued 文档应被 _validate_targets 拒绝")
        except ValueError:
            pass
        ok("RUNNING_STATUSES 含 queued（移动/复制拒绝排队中文档）")
    finally:
        d.cleanup()


# ---------------------------------------------------------------- 3.2 index_fp
def t2_index_fp_scope_and_migrate():
    print("2) index_fp 新口径（去 gen.plugins）+ 存量一次性重算")
    from app.services import index_service

    d = _Tmp()
    d.kb_id = "kb_t2"
    _mk_kb(d)
    work = d.dir / "work"
    old_work = paths.WORK_DIR
    paths.WORK_DIR = work
    try:
        did = "doc_t2"
        gen_cfg = json.dumps({"presetId": "pA", "plugins": ["pShow"]})
        idx_cfg = json.dumps({"enabled": True, "components": {},
                              "plugins": ["pIdx"]})
        _mk_doc(d, did, status="done", gen_config=gen_cfg, index_config=idx_cfg)
        _fake_stage(work, d.kb_id, did, "pA")
        doc = dict(_doc_row(did))

        fp_new = index_service.compute_index_fp(doc)
        fp_old = index_service.compute_index_fp(doc, legacy_gen_plugins=True)
        assert fp_new != fp_old, "显示插件不应再计入指纹（新旧口径应有差异）"

        # gen.plugins 为空 → 新旧口径等价（多数存量文档无差异）
        doc2 = dict(doc)
        doc2["id"] = "doc_t2b"
        doc2["gen_config"] = json.dumps({"presetId": "pA", "plugins": []})
        _mk_doc(d, doc2["id"], status="done", gen_config=doc2["gen_config"],
                index_config=idx_cfg)
        _fake_stage(work, d.kb_id, doc2["id"], "pA")
        row2 = dict(_doc_row(doc2["id"]))
        assert (index_service.compute_index_fp(row2)
                == index_service.compute_index_fp(row2, legacy_gen_plugins=True))
        ok("compute_index_fp 去 gen.plugins；空显示插件时新旧口径等价")

        # 存量迁移：旧口径指纹（纯口径差异）→ 覆写为新口径
        dbmod.get().execute("UPDATE docs SET index_fp = ? WHERE id = ?",
                            (fp_old, did))
        dbmod.get().commit()
        assert index_service.migrate_index_fp() >= 1
        assert _doc_row(did)["index_fp"] == fp_new
        ok("migrate_index_fp：旧口径指纹重算为新口径")

        # 真实漂移（旧口径也对不上）→ 不动；幂等（kv 标记后二次调用 0 篇）
        dbmod.get().execute("UPDATE docs SET index_fp = ? WHERE id = ?",
                            ("deadbeef", did))
        dbmod.get().commit()
        n = index_service.migrate_index_fp()
        assert n == 0, f"kv 标记后应跳过，实际 {n}"
        assert _doc_row(did)["index_fp"] == "deadbeef", "真实漂移指纹不应被覆写"
        dbmod.kv_set(index_service._FP_MIGRATE_KEY, None)   # 复位再验证一次保守性
        n2 = index_service.migrate_index_fp()
        assert n2 == 0 and _doc_row(did)["index_fp"] == "deadbeef"
        ok("migrate_index_fp 幂等且不误覆写真实漂移的指纹")
    finally:
        paths.WORK_DIR = old_work
        d.cleanup()


# ---------------------------------------------------------------- 3.3 启动恢复
def t3_startup_recovery():
    print("3) 启动恢复 recover_stale_status：generating/queued→ready、parsing 看产物")
    from app.services import kb_service

    d = _Tmp()
    d.kb_id = "kb_t3"
    _mk_kb(d)
    try:
        _mk_doc(d, "doc_gen", status="generating")
        _mk_doc(d, "doc_que", status="queued")
        _mk_doc(d, "doc_par_ok", status="parsing")
        _mk_doc(d, "doc_par_bad", status="parsing")
        # 产物目录：doc_par_ok 有 pdf2md.md，doc_par_bad 无 → failed
        pdir = d.dir / "work" / d.kb_id / "doc_par_ok"
        pdir.mkdir(parents=True)
        (pdir / "pdf2md.md").write_text("# x\n", encoding="utf-8")
        old_doc_dir = paths.doc_dir
        paths.doc_dir = lambda kb, did: d.dir / "work" / kb / did
        try:
            n = kb_service.recover_stale_status()
        finally:
            paths.doc_dir = old_doc_dir
        assert n == 4, f"应清理 4 篇，实际 {n}"
        assert _doc_row("doc_gen")["status"] == "ready"
        assert _doc_row("doc_que")["status"] == "ready"
        assert _doc_row("doc_par_ok")["status"] == "ready"
        assert _doc_row("doc_par_bad")["status"] == "failed"
        evs = [e for e in d.events() if e["channel"] == "doc.status"]
        got = {(e["docId"], e["status"]) for e in evs}
        assert ("doc_gen", "ready") in got and ("doc_par_bad", "failed") in got
        assert len(evs) == 4, "每篇恰好一次 doc.status"
        # 无僵尸时零清理
        assert kb_service.recover_stale_status() == 0
        ok("僵尸 generating/queued→ready、parsing 按产物 ready/failed，逐篇 emit")
    finally:
        d.cleanup()


def t4_pause_zombie_and_409():
    print("4) pause/resume 僵尸区分返回 + 路由 409")
    from app import pauses
    from app.routers.documents import _pause_resume_err

    d = _Tmp()
    d.kb_id = "kb_t4"
    _mk_kb(d)
    did = "doc_t4"
    _mk_doc(d, did, status="generating")
    try:
        assert pauses.pause(did) == "zombie"
        assert pauses.resume(did) == "zombie"
        e = _pause_resume_err("zombie")
        assert e.status_code == 409 and "服务曾重启" in e.detail
        ok("status=generating 但无活动流水线 → zombie（路由 409 + 重启指引 detail）")

        dbmod.get().execute("UPDATE docs SET status='ready' WHERE id=?", (did,))
        dbmod.get().commit()
        assert pauses.pause(did) == "inactive"
        e2 = _pause_resume_err("inactive")
        assert e2.status_code == 400
        ok("普通无任务文档 → inactive（路由 400）")

        pauses.start(did)
        assert pauses.pause(did) == "ok" and pauses.is_paused(did)
        assert pauses.resume(did) == "ok" and not pauses.is_paused(did)
        pauses.finish(did)
        ok("活动流水线 pause/resume 正常（ok）")
    finally:
        pauses.finish(did)
        d.cleanup()


def t4b_pause_409_http():
    print("4b) TestClient（临时库）：create_app 启动恢复后 pause 僵尸 → 409")
    #
    # ⚠️ 顺序铁律：app.main 在模块级执行 `app = create_app()`（含启动恢复与
    # index_fp 迁移，会写库）——必须先把 paths.DB_PATH 重定向到临时文件再
    # import，绝不能让模块级 create_app 摸到真实 backend/data/app.db。
    import shutil as _shutil
    from fastapi.testclient import TestClient

    tmp = Path(tempfile.mkdtemp(prefix="debug3_t4b_"))
    old_db = paths.DB_PATH
    assert str(old_db).endswith("app.db")
    paths.DB_PATH = tmp / "app.db"     # 先重定向，再 import（模块级 create_app → 临时库）
    try:
        import app.main as mainmod   # 模块级 create_app()：seed/recover/migrate 全在临时库
        dbmod.init(paths.DB_PATH)   # 主线程连接对齐临时库（同一路径，幂等）

        class _D:   # 造库（kb + 僵尸 generating 文档）
            pass
        d = _D()
        d.kb_id = "kb_t4b"
        d.dir = tmp
        _mk_kb(d)
        _mk_doc(d, "doc_z", status="generating")

        with TestClient(mainmod.app) as client:
            r = client.post("/api/documents/doc_z/pause")
            assert r.status_code == 409, r.text
            assert "服务曾重启" in r.json()["detail"]
            r2 = client.post("/api/documents/doc_z/resume")
            assert r2.status_code == 409
        ok("POST pause/resume 僵尸文档 → HTTP 409 + detail 指引")

        # 启动恢复在 create_app 内生效：再造僵尸 → 新建 app 实例 → 状态被清 ready
        dbmod.get().execute("UPDATE docs SET status='generating' WHERE id='doc_z'")
        dbmod.get().commit()
        mainmod.create_app()
        assert _doc_row("doc_z")["status"] == "ready"
        ok("create_app 启动清理：僵尸 generating→ready（临时库）")
    finally:
        paths.DB_PATH = old_db
        _shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- 3.4 pdf 缓存
def t5_pdf_cache():
    print("5) pdf 指纹缓存：未命中写缓存 / 二次秒回 / 根目录最新语义 / LRU=3")
    from app.services import export_service, snapshot_service

    d = _Tmp()
    d.kb_id = "kb_t5"
    _mk_kb(d)
    did = "doc_t5"
    gen_cfg = json.dumps({"presetId": "pA", "plugins": [],
                          "components": {"toc": True, "summary": False,
                                         "images": True}})
    _mk_doc(d, did, status="done", gen_config=gen_cfg)
    work = d.dir / "work"
    exports = d.dir / "exports"
    _fake_stage(work, d.kb_id, did, "pA")

    old_work, old_export = paths.WORK_DIR, paths.EXPORT_DIR
    paths.WORK_DIR = work
    paths.EXPORT_DIR = exports
    calls = {"n": 0}

    def _fake_convert(md_path, pdf_path, options):
        calls["n"] += 1
        Path(pdf_path).write_bytes(b"%PDF-1.4 fake " + str(calls["n"]).encode())
        return {"pages": 1, "size_mb": 0.01}

    old_conv = export_service.markdown_to_pdf
    export_service.markdown_to_pdf = _fake_convert
    old_md = snapshot_service.load_export_md
    snapshot_service.load_export_md = lambda doc_id: "# 标题\n\n正文\n"
    try:
        job = {"id": "j", "kind": "export_pdf", "doc_id": did}   # 假 job（_wrap 之外手工驱动）
        export_service._pdf_job(job, [did], {})
        cache_files = list((exports / "cache" / did).glob("*.pdf"))
        assert len(cache_files) == 1 and calls["n"] == 1, "首次导出应转换并写缓存"
        root_pdf = exports / "文档.pdf"   # 根目录文件名 = _safe(文档名)
        assert root_pdf.is_file(), "exports 根目录应保留最新一次导出"
        fp1 = cache_files[0].stem
        evs = [e for e in d.events() if e["channel"] == "export.done"]
        assert evs and evs[-1]["url"].endswith(root_pdf.name)
        ok("未命中：转换后写入 cache/{docId}/{fp}.pdf 并回写根目录")

        export_service._pdf_job(job, [did], {})
        assert calls["n"] == 1, "同配置二次导出应命中缓存不重跑转换"
        ok("同指纹二次导出秒回（不重跑 Chrome 转换）")

        # 改 PdfOptions → 新指纹 → 未命中；LRU 收敛到 3 个
        export_service._pdf_job(job, [did], {"columns": 3})
        export_service._pdf_job(job, [did], {"columns": 1})
        export_service._pdf_job(job, [did], {"fontScale": 1.5})
        assert calls["n"] == 4, "不同 PdfOptions 应各自转换"
        cache_files = list((exports / "cache" / did).glob("*.pdf"))
        assert len(cache_files) == export_service.PDF_CACHE_KEEP == 3
        assert fp1 not in {f.stem for f in cache_files}, "最旧的指纹应被 LRU 淘汰"
        ok(f"per-doc LRU 保留最近 {export_service.PDF_CACHE_KEEP} 个指纹")

        # 指纹随 cfgHash / 产物 / PdfOptions 变化
        from app.services.kb_service import resolve_effective_config
        doc = dict(_doc_row(did))
        cfg = resolve_effective_config(doc, "gen")
        sdir = paths.stage_dir(d.kb_id, did, "pA")
        from engine.md2pdf import PdfOptions
        opts = PdfOptions()
        fp_a = export_service._pdf_fp(doc, cfg, sdir, opts)
        fp_b = export_service._pdf_fp(doc, cfg, sdir, PdfOptions(columns=3))
        assert fp_a != fp_b
        time.sleep(0.01)
        (sdir / "organized.md").write_text("## 1 甲\n甲文改\n", encoding="utf-8")
        assert export_service._pdf_fp(doc, cfg, sdir, opts) != fp_a, "产物变化应换指纹"
        ok("缓存指纹 = cfgHash + artifacts_fp + 规范化 PdfOptions（各分量敏感）")
    finally:
        export_service.markdown_to_pdf = old_conv
        snapshot_service.load_export_md = old_md
        paths.WORK_DIR, paths.EXPORT_DIR = old_work, old_export
        d.cleanup()


# ---------------------------------------------------------------- 3.5 title 贯通
def t6_assemble_title():
    print("6) _assemble 标题：meta.title 优先 / 回退文档名")
    from app.services import export_service

    d = _Tmp()
    d.kb_id = "kb_t6"
    _mk_kb(d)
    did = "doc_t6"
    gen_cfg = json.dumps({"presetId": "pA", "plugins": [],
                          "components": {"toc": False, "summary": False,
                                         "images": True}})
    _mk_doc(d, did, name="文档名甲", status="done", gen_config=gen_cfg)
    work, exports = d.dir / "work", d.dir / "exports"
    old_work, old_export = paths.WORK_DIR, paths.EXPORT_DIR
    paths.WORK_DIR, paths.EXPORT_DIR = work, exports
    try:
        out = exports / "out.md"
        sdir = _fake_stage(work, d.kb_id, did, "pA",
                           meta={"title": "pass1 拟的标题", "digest": "简介"})
        export_service._assemble(did, out)
        text = out.read_text(encoding="utf-8")
        assert "# pass1 拟的标题" in text and "# 文档名甲" not in text
        (sdir / ".meta.json").unlink()
        export_service._assemble(did, out)
        text = out.read_text(encoding="utf-8")
        assert "# 文档名甲" in text
        ok("导出 md `# 标题` 取 .meta.json title，缺 meta 回退 docs.name")
    finally:
        paths.WORK_DIR, paths.EXPORT_DIR = old_work, old_export
        d.cleanup()


def t7_title_node_position():
    print("7) title 节点位置：产物树与流式树 root 子序第一（toc 之前）")
    from app.liveview.build import build_tree_from_artifacts
    from app.liveview.tree import LiveSession

    d = _Tmp()
    try:
        work = d.dir / "work"
        sdir = _fake_stage(work, "kb", "doc", "pA",
                           meta={"title": "产物树标题"})
        tree = build_tree_from_artifacts(
            "doc", sdir, "/fb", "pA", show_toc=True, show_summary=False,
            show_images=True, plugins=[], doc_name="文档名")
        root = tree.snapshot()["nodes"]["root"]
        kinds = [root and tree.snapshot()["nodes"][cid]["type"]
                 for cid in root["children"]]
        assert kinds[0] == "title" and kinds[1] == "toc", kinds
        tnode = tree.snapshot()["nodes"][root["children"][0]]
        assert tnode["props"]["title"] == "产物树标题"
        ok("产物树 title 节点第一、toc 其次、props.title=meta.title")

        # 无 meta → 回退文档名
        sdir2 = _fake_stage(work, "kb", "doc2", "pA")
        tree2 = build_tree_from_artifacts(
            "doc2", sdir2, "/fb", "pA", show_toc=False, show_summary=False,
            show_images=True, plugins=[], doc_name="回退名")
        r2 = tree2.snapshot()["nodes"]["root"]
        assert tree2.snapshot()["nodes"][r2["children"][0]]["props"]["title"] == "回退名"
        ok("无 meta 时 title 节点回退文档名")

        # 流式树：begin_pass1 占位 + root 子序第一
        session = LiveSession("doc3", "pA")
        session.begin_pass1("/fb", show_toc=True, show_images=True,
                            doc_title="占位标题")
        r3 = session.tree.snapshot()["nodes"]["root"]
        n3 = session.tree.snapshot()["nodes"]
        assert n3[r3["children"][0]]["type"] == "title"
        assert n3[r3["children"][0]]["props"]["title"] == "占位标题"
        assert n3[r3["children"][1]]["type"] == "toc"
        ok("begin_pass1 流式树 title 节点第一（toc 之前，占位=旧 meta/文档名）")
    finally:
        d.cleanup()


# ---------------------------------------------------------------- 3.7 pass1 块
def t8_pass1_harvest():
    print("8) pass1 @@title/@@digest：剥离 / 仅窗口1 / 缺块回退 / 未闭合丢弃")
    from engine.pass1 import Pass1Engine

    p1 = "@@title\n第一窗口 标题\n@@end\n@@digest\n一句话简介。\n@@end\n## 1 甲\n甲文\n"
    p2 = "## 2 乙\n乙文\n@@title\n迟到的标题\n@@end\n"
    cleaned, title, digest = Pass1Engine._harvest_title_digest([p1, p2])
    assert title == "第一窗口 标题" and digest == "一句话简介。"
    assert "@@title" not in cleaned[0] and "@@digest" not in cleaned[0]
    assert "迟到的标题" not in "".join(cleaned), "窗口2 的信息块应剥离"
    assert "## 1 甲" in cleaned[0] and "乙文" in cleaned[1], "正文不受影响"
    ok("窗口1 信息块采集 + 全窗口剥离；窗口2 出现的 @@title 剥离且不采集")

    cleaned1, t1_, d1_ = Pass1Engine._harvest_title_digest(["## 1 甲\n无块\n"])
    assert t1_ is None and d1_ is None and "无块" in cleaned1[0]
    ok("缺块：文本不变、title/digest 为 None（回退现状逻辑由 run 承担）")

    unclosed = "@@title\n半截标题\n## 1 甲\n甲文\n"
    cu, tu, du = Pass1Engine._harvest_title_digest([unclosed])
    assert tu is None and "半截标题" not in cu[0] and "@@title" not in cu[0]
    ok("未闭合信息块整体丢弃（残内容不进正文、半截标题不采用）")

    # digest 随 finalize stats 返回
    import tempfile
    eng = Pass1Engine(None, "sys")
    sd = Path(tempfile.mkdtemp()) / "stage"
    sd.mkdir(parents=True)
    raw = "## 1 甲\n甲文\n@@summary\n摘要甲\n@@end\n"
    stats = eng._finalize(raw, sd, "标题X", digest="简介Y")
    assert stats["digest"] == "简介Y" and stats["title"] == "标题X"
    assert (sd / "organized.md").read_text(encoding="utf-8").startswith("## 1 甲")
    ok("finalize stats 携带 title/digest（gen_service 据此写 .meta.json）")


# ---------------------------------------------------------------- 3.7 流式
def t9_stream_title_digest():
    print("9) 流式：@@title 即时上屏 / @@digest 不上屏 / 正文后信息块丢弃")
    from app.liveview.parser import Pass1StreamParser
    from app.liveview.tree import LiveTree, LiveSession

    def _tree_with_placeholder():
        s = LiveSession("doc_s", "pA")
        s.begin_pass1("/fb", show_toc=True, show_images=True, doc_title="占位标题")
        return s

    # ① 信息块即时更新 title 节点；digest 不产生任何节点/文本
    s = _tree_with_placeholder()
    p = s.p1
    p.feed("@@title\n新标题甲\n@@end\n")
    snap = s.tree.snapshot()["nodes"]
    tid = snap["root"]["children"][0]
    assert snap[tid]["type"] == "title" and snap[tid]["props"]["title"] == "新标题甲"
    p.feed("@@digest\n一句简介内容\n@@end\n## 1 甲\n正文\n")
    snap = s.tree.snapshot()["nodes"]
    all_md = "\n".join(n.get("md") or "" for n in snap.values())
    assert "一句简介内容" not in all_md, "digest 不得上屏"
    assert "新标题甲" == snap[tid]["props"]["title"]
    assert any(n["type"] == "section" and "正文" in (n.get("md") or "")
               for n in snap.values())
    ok("@@title 闭合即时 update title 节点（占位→新标题）；@@digest 只捕获不上屏")

    # ② 正文开始后（=后续窗口）的信息块按杂散块丢弃：无新节点、标题不变、无泄漏
    before_ids = set(s.tree.snapshot()["nodes"].keys())
    p.feed("@@title\n迟到的标题\n@@end\n@@digest\n迟到的简介\n@@end\n")
    snap = s.tree.snapshot()["nodes"]
    assert set(snap.keys()) == before_ids, "不应新建节点"
    assert snap[tid]["props"]["title"] == "新标题甲"
    all_md = "\n".join(n.get("md") or "" for n in snap.values())
    assert "迟到的标题" not in all_md and "迟到的简介" not in all_md
    ok("正文出现后的 @@title/@@digest（窗口2+）按杂散块丢弃，不污染树")

    # ③ 增量喂入（块行跨 chunk）+ 回滚状态含捕获态
    s2 = _tree_with_placeholder()
    p2_ = s2.p1
    for chunk in ["@@ti", "tle\n跨", "chunk 标题\n@@", "end\n"]:
        p2_.feed(chunk)
    p2_.flush()
    snap = s2.tree.snapshot()["nodes"]
    tid2 = snap["root"]["children"][0]
    assert snap[tid2]["props"]["title"] == "跨chunk 标题"
    st = p2_.state_snapshot()
    assert st["title_id"] == tid2 and st["saw_content"] is False
    ok("信息块跨 chunk 增量喂入正常；捕获态入状态快照（回滚安全）")

    # ④ 防御：无占位节点时 @@title 闭合补插 title 节点
    tree3 = LiveTree("doc_s3", "pA", base="live")
    p3 = Pass1StreamParser(tree3, "/fb", show_toc=False)
    assert p3.title_id is None
    p3.feed("@@title\n兜底标题\n@@end\n")
    snap = tree3.snapshot()["nodes"]
    assert any(n["type"] == "title" and n["props"]["title"] == "兜底标题"
               for n in snap.values())
    ok("无占位节点时闭合补插 title 节点（防御路径）")


def main():
    t0_pass1_common_fingerprint()
    t1_queued_state_machine()
    t2_index_fp_scope_and_migrate()
    t3_startup_recovery()
    t4_pause_zombie_and_409()
    t4b_pause_409_http()
    t5_pdf_cache()
    t6_assemble_title()
    t7_title_node_position()
    t8_pass1_harvest()
    t9_stream_title_digest()
    print(f"\n全部通过：{_passed} 组断言")


if __name__ == "__main__":
    main()
