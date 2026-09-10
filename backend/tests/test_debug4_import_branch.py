"""debug4 步骤4——导入与分支离线单测（不触运行中后端/真实 app.db，全程临时库与临时目录）。

覆盖（任务书 AGENT/9.5_debug/步骤4-导入与分支.md）：
- #3 链接导入异步化：import_link 同步段立即返回 fetching 占位文档（占位名=域名、
  docType=web、sourceKind=md）；同 URL 抓取进行中重复提交 400（不同 URL 放行）；
  无效 URL 400 且不建文档；后台抓取成功 → 改名（页面标题截 120）+ready+原文档.md/
  pdf2md.md 落盘+size+doc.parsed 事件；抓取失败 → failed+doc.error 事件（文档保留）；
  失败后重新提交可重试；
- #14 分支语义：branch_session includeCurrent true/false 的复制消息行集合
  （rowid<=/rowid<）；会话首条用户消息分支 → 空会话；会话状态
  （mode/model/kbIds/webSearch）照抄；HTTP 端点 includeCurrent 两态。

⚠️ 顺序铁律（debug3 §③ 事故固化）：app.main 在模块级执行 `app = create_app()`
（含启动恢复与指纹迁移，会写库）——TestClient 用例必须先把 paths.DB_PATH 重定向到
临时文件再 import app.main，绝不能让模块级 create_app 摸到真实 backend/data/app.db。

运行：cd backend && python tests/test_debug4_import_branch.py   （或 pytest tests/）
"""
import json
import sys
import tempfile
import threading
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import app.db as dbmod  # noqa: E402
import app.events as evmod  # noqa: E402
import app.paths as paths  # noqa: E402

_passed = 0


def ok(name: str) -> None:
    global _passed
    _passed += 1
    print(f"  ok {name}")


def _wait_status(did: str, want: str, timeout: float = 10.0) -> dict:
    """轮询等后台 import 任务把文档置到目标状态（job 跑在真实线程池）。"""
    dl = time.time() + timeout
    row = None
    while time.time() < dl:
        row = dbmod.get().execute(
            "SELECT * FROM docs WHERE id = ?", (did,)).fetchone()
        if row is not None and row["status"] == want:
            return dict(row)
        time.sleep(0.05)
    raise AssertionError(f"等待 doc {did} → {want} 超时（最后：{dict(row) if row else None}）")


# ---------------------------------------------------------------- #3 import_link
def t0_import_link_async_http():
    print("0) import_link 异步化（TestClient 临时库）：立即 fetching / 防抖 400 / 成功改名 / 失败 failed")
    #
    # ⚠️ 顺序铁律：先重定向 paths.DB_PATH → 再 import app.main（模块级 create_app
    # → 临时库；教训见 测试记录与已知问题.md §0r ③）。
    import shutil as _shutil
    from fastapi.testclient import TestClient

    tmp = Path(tempfile.mkdtemp(prefix="debug4_t0_"))
    old_db, old_work = paths.DB_PATH, paths.WORK_DIR
    assert str(old_db).endswith("app.db")
    paths.DB_PATH = tmp / "app.db"      # 先重定向，再 import（模块级 create_app → 临时库）
    paths.WORK_DIR = tmp / "work"       # 导入产物写临时 work 目录
    try:
        import app.main as mainmod   # noqa: F401  模块级 create_app：seed/recover 全在临时库
        dbmod.init(paths.DB_PATH)   # 主线程连接对齐临时库（同一路径，幂等）
        import app.services.web_import as web_import

        with TestClient(mainmod.app) as client:
            r = client.post("/api/knowledge-bases", json={"name": "导入库"})
            assert r.status_code == 200, r.text
            kid = r.json()["id"]

            # 抓取桩：按 URL 分 Gate（阻塞后台任务，便于断言中间态）+ 分 URL 结果
            gates: dict[str, threading.Event] = {}
            results: dict[str, tuple] = {}

            def fake_fetch(url: str):
                gates[url].wait(timeout=15)
                return results[url]

            old_fetch = web_import.fetch_page
            web_import.fetch_page = fake_fetch
            try:
                u1 = "https://example.com/articles/deep?x=1"
                u2 = "https://demo.org/page"
                gates[u1] = threading.Event()
                gates[u2] = threading.Event()
                results[u1] = (None, {"url": u1, "title": "测试标题甲乙丙丁",
                                      "markdown": "# 测试\n\n" + "正文内容" * 200})
                results[u2] = ("HTTP 404", None)

                # ① 同步段：立即返回 fetching 占位文档（不等抓取）
                r1 = client.post(f"/api/knowledge-bases/{kid}/import-link",
                                 json={"url": u1})
                assert r1.status_code == 200, r1.text
                doc = r1.json()["doc"]
                assert doc["status"] == "fetching", doc
                assert doc["name"] == "example.com", doc    # 占位名=域名（去 www.）
                assert doc["docType"] == "web" and doc["sourceKind"] == "md", doc
                ok("import_link 立即返回 fetching 占位文档（name=域名、docType=web、sourceKind=md）")

                # ② 防抖：同 URL 抓取进行中 → 400；不同 URL 放行
                r_dup = client.post(f"/api/knowledge-bases/{kid}/import-link",
                                    json={"url": u1})
                assert r_dup.status_code == 400, r_dup.text
                assert "抓取中" in r_dup.json()["detail"]
                r2 = client.post(f"/api/knowledge-bases/{kid}/import-link",
                                 json={"url": u2})
                assert r2.status_code == 200, r2.text
                doc2 = r2.json()["doc"]
                assert doc2["status"] == "fetching" and doc2["name"] == "demo.org"
                ok("同 URL fetching 中重复提交 → 400；不同 URL 放行")

                # ③ 无效 URL：400 且不建文档
                n_docs = dbmod.get().execute(
                    "SELECT COUNT(*) c FROM docs").fetchone()["c"]
                r_bad = client.post(f"/api/knowledge-bases/{kid}/import-link",
                                    json={"url": "ftp://not-http.example"})
                assert r_bad.status_code == 400
                n_after = dbmod.get().execute(
                    "SELECT COUNT(*) c FROM docs").fetchone()["c"]
                assert n_docs == 2 and n_after == 2, "无效 URL 不应创建文档"
                ok("无效 URL → 400 且不建文档")

                # ④ 后台成功：改名（截 120）+ ready + 产物落盘 + size + doc.parsed
                gates[u1].set()
                row = _wait_status(doc["id"], "ready")
                assert row["name"] == "测试标题甲乙丙丁", row["name"]
                md = results[u1][1]["markdown"]
                assert row["size"] == len(md.encode("utf-8"))
                ddir = paths.WORK_DIR / kid / doc["id"]
                assert (ddir / "原文档.md").read_text(encoding="utf-8") == md
                assert (ddir / "pdf2md.md").read_text(encoding="utf-8") == md
                ok("后台抓取成功：rename_doc(标题截120) + ready + 原文档.md/pdf2md.md + size")

                # ⑤ 后台失败：failed + doc.error（文档保留，可删除/重试）
                gates[u2].set()
                row2 = _wait_status(doc2["id"], "failed")
                assert row2["name"] == "demo.org", "失败文档保留占位名"
                ok("后台抓取失败：failed + 占位名保留（文档不删除）")

                # ⑥ 失败后重新提交同一 URL = 重试（无活动任务即放行）
                results[u2] = (None, {"url": u2, "title": "重试后的标题",
                                      "markdown": "# 重试\n内容" * 50})
                gates[u2] = threading.Event()   # 新一轮 gate
                r3 = client.post(f"/api/knowledge-bases/{kid}/import-link",
                                 json={"url": u2})
                assert r3.status_code == 200, r3.text
                gates[u2].set()
                row3 = _wait_status(r3.json()["doc"]["id"], "ready")
                assert row3["name"] == "重试后的标题"
                ok("失败后重新提交同 URL 可重试（新任务成功改名 ready）")

                # ⑦ 事件：fetching/ready/failed 的 doc.status + doc.parsed + doc.error
                buf = [ev for _, ev in list(evmod.bus._buffer)]
                chans = [(e["channel"], e.get("docId"), e.get("status", e.get("detail")))
                         for e in buf if e["channel"].startswith("doc.")]
                assert any(c == ("doc.status", doc["id"], "fetching") for c in chans)
                assert any(c == ("doc.status", doc["id"], "ready") for c in chans)
                assert any(c == ("doc.status", doc2["id"], "failed") for c in chans)
                assert any(c[0] == "doc.parsed" and c[1] == doc["id"] for c in chans), \
                    "成功后应 emit doc.parsed（前端 refreshDoc 拉改名后的行）"
                assert any(c[0] == "doc.error" and c[1] == doc2["id"]
                           and "404" in (c[2] or "") for c in chans)
                ok("事件链：doc.status(fetching/ready/failed) + doc.parsed + doc.error(detail)")
            finally:
                web_import.fetch_page = old_fetch
    finally:
        paths.DB_PATH, paths.WORK_DIR = old_db, old_work
        _shutil.rmtree(tmp, ignore_errors=True)


def t0b_placeholder_name():
    print("0b) 占位名函数：域名去 www. / 截 60 / 无域回退")
    from app.services.kb_service import _placeholder_name
    assert _placeholder_name("https://www.example.com/a/b?q=1") == "example.com"
    long_host = "a" * 80 + ".com"
    assert _placeholder_name(f"https://{long_host}/x") == ("a" * 80 + ".com")[:60]
    assert _placeholder_name("not-a-url") == "not-a-url"
    assert _placeholder_name("") == "网页文档"
    ok("占位名=域名（去 www.）截 60；无域名回退 URL/兜底文案")


# ---------------------------------------------------------------- #14 branch
def _mk_session(title="源会话", mode="chat", model=None, kb_ids="[]", web_search=0):
    conn = dbmod.get()
    sid = f"s_{title}_{time.time_ns()}"
    conn.execute(
        "INSERT INTO sessions (id, title, mode, model, kb_ids, web_search, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (sid, title, mode, model, kb_ids, web_search, "2026-09-07 00:00:00",
         "2026-09-07 00:00:00"))
    conn.commit()
    return sid


def _mk_msg(sid, i, role, content, created_at):
    conn = dbmod.get()
    mid = f"m_{sid}_{i}"
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)",
        (mid, sid, role, content, created_at))
    conn.commit()
    return mid


def _msg_contents(sid):
    rows = dbmod.get().execute(
        "SELECT role, content FROM messages WHERE session_id = ?"
        " ORDER BY created_at, rowid", (sid,)).fetchall()
    return [(r["role"], r["content"]) for r in rows]


def t1_branch_include_current():
    print("1) branch_session includeCurrent：rowid<= / rowid< / 空会话 / 状态照抄")
    from app.services import chat_service

    d_dir = Path(tempfile.mkdtemp(prefix="debug4_t1_"))
    dbmod.init(d_dir / "app.db")
    try:
        sid = _mk_session(title="源会话", mode="automatic", model="p/m1",
                          kb_ids='["kb1"]', web_search=1)
        u1 = _mk_msg(sid, 1, "user", "问题一", "2026-09-07 00:00:01")
        a1 = _mk_msg(sid, 2, "assistant", "回答一", "2026-09-07 00:00:02")
        u2 = _mk_msg(sid, 3, "user", "问题二", "2026-09-07 00:00:03")
        a2 = _mk_msg(sid, 4, "assistant", "回答二", "2026-09-07 00:00:04")

        # includeCurrent=True：复制该消息及其之前（含本条）
        b1 = chat_service.branch_session(sid, u2, True)
        assert b1["title"] == "源会话（分支）"
        assert _msg_contents(b1["id"]) == [("user", "问题一"), ("assistant", "回答一"),
                                           ("user", "问题二")]
        ok("includeCurrent=true → 复制该消息及之前（rowid<=）")

        # includeCurrent=False：严格小于（不含本条）
        b2 = chat_service.branch_session(sid, u2, False)
        assert _msg_contents(b2["id"]) == [("user", "问题一"), ("assistant", "回答一")]
        ok("includeCurrent=false → 只复制之前的消息（rowid<，本条不入新会话）")

        # 会话首条用户消息分支 → 空会话（语义正确：本条放输入框草稿）
        b3 = chat_service.branch_session(sid, u1, False)
        assert _msg_contents(b3["id"]) == []
        ok("会话首条用户消息 includeCurrent=false → 空会话")

        # 会话状态照抄（mode/model/kb_ids/web_search）
        for b in (b1, b2, b3):
            assert b["mode"] == "automatic" and b["model"] == "p/m1"
            assert b["kbIds"] == ["kb1"] and b["webSearch"] is True
        srow = dbmod.get().execute("SELECT * FROM sessions WHERE id = ?",
                                   (b2["id"],)).fetchone()
        assert json.loads(srow["kb_ids"]) == ["kb1"] and srow["web_search"] == 1
        ok("会话状态（mode/model/kbIds/webSearch）复制保持不动")

        # 原会话不动
        assert len(_msg_contents(sid)) == 4
        ok("原会话消息不受影响")
    finally:
        import shutil
        shutil.rmtree(d_dir, ignore_errors=True)


def t2_branch_http_include_current():
    print("2) 分支 HTTP 端点（TestClient 临时库）：includeCurrent 两态 / 默认 true")
    #
    # ⚠️ 顺序铁律：先重定向 paths.DB_PATH → 再 import app.main（教训见 §0r ③）。
    import shutil as _shutil
    from fastapi.testclient import TestClient

    tmp = Path(tempfile.mkdtemp(prefix="debug4_t2_"))
    old_db = paths.DB_PATH
    paths.DB_PATH = tmp / "app.db"
    try:
        import app.main as mainmod   # 模块级 create_app → 临时库（首次 import 缓存后仍同库）
        dbmod.init(paths.DB_PATH)

        with TestClient(mainmod.app) as client:
            r = client.post("/api/sessions", json={"title": "HTTP源"})
            sid = r.json()["id"]
            dbmod.get().execute("UPDATE sessions SET mode='query', kb_ids='[\"k9\"]'"
                                " WHERE id = ?", (sid,))
            u1 = _mk_msg(sid, 1, "user", "问一", "2026-09-07 01:00:01")
            a1 = _mk_msg(sid, 2, "assistant", "答一", "2026-09-07 01:00:02")
            u2 = _mk_msg(sid, 3, "user", "问二", "2026-09-07 01:00:03")
            dbmod.get().commit()

            # includeCurrent=false
            rb = client.post(f"/api/sessions/{sid}/branch",
                             json={"messageId": u2, "includeCurrent": False})
            assert rb.status_code == 200, rb.text
            ns = rb.json()
            assert ns["mode"] == "query" and ns["kbIds"] == ["k9"]
            lm = client.get(f"/api/sessions/{ns['id']}/messages").json()["messages"]
            assert [m["content"] for m in lm] == ["问一", "答一"]
            ok("POST branch includeCurrent=false → 新会话只含之前的消息 + 会话状态照抄")

            # 默认（不传 includeCurrent）=true：含本条
            rd = client.post(f"/api/sessions/{sid}/branch", json={"messageId": a1})
            assert rd.status_code == 200
            lm2 = client.get(f"/api/sessions/{rd.json()['id']}/messages").json()["messages"]
            assert [m["content"] for m in lm2] == ["问一", "答一"]
            ok("POST branch 缺省 includeCurrent=true → 复制该消息及之前（兼容旧调用）")

            # 消息不存在 → 404
            r404 = client.post(f"/api/sessions/{sid}/branch",
                               json={"messageId": "nope"})
            assert r404.status_code == 404
            ok("消息不存在 → 404")

            # 原会话消息数不变
            assert len(client.get(f"/api/sessions/{sid}/messages").json()["messages"]) == 3
            ok("原会话消息不受影响（u1/a1/u2 三条）")
    finally:
        paths.DB_PATH = old_db
        _shutil.rmtree(tmp, ignore_errors=True)


def t3_running_statuses_and_recover():
    print("3) RUNNING_STATUSES 含 fetching（移动/复制拒绝）+ 启动恢复覆盖 fetching")
    from app.services import kb_service

    assert "fetching" in kb_service.RUNNING_STATUSES

    d_dir = Path(tempfile.mkdtemp(prefix="debug4_t3_"))
    dbmod.init(d_dir / "app.db")
    old_doc_dir = paths.doc_dir
    try:
        conn = dbmod.get()
        conn.execute("INSERT INTO kbs (id, name, created_at) VALUES ('kb_t3', '库', '2026-09-07 00:00:00')")
        conn.execute(
            "INSERT INTO docs (id, kb_id, name, source_kind, doc_type, size, status,"
            " created_at, sort_order) VALUES ('doc_f', 'kb_t3', '占位', 'md', 'web', 0,"
            " 'fetching', '2026-09-07 00:00:00', 1000.0)")
        conn.commit()
        try:
            kb_service._validate_targets(["doc_f"])
            raise AssertionError("fetching 文档应被 _validate_targets 拒绝")
        except ValueError:
            pass
        ok("fetching 文档移动/复制被拒（RUNNING_STATUSES）")

        # 启动恢复：fetching 无产物 → failed；有产物 → ready
        paths.doc_dir = lambda kb, did: d_dir / "work" / kb / did   # 无产物
        n = kb_service.recover_stale_status()
        assert n == 1
        row = dbmod.get().execute("SELECT status FROM docs WHERE id='doc_f'").fetchone()
        assert row["status"] == "failed"
        (d_dir / "work" / "kb_t3" / "doc_f").mkdir(parents=True)
        (d_dir / "work" / "kb_t3" / "doc_f" / "pdf2md.md").write_text("# x\n", encoding="utf-8")
        dbmod.get().execute("UPDATE docs SET status='fetching' WHERE id='doc_f'")
        dbmod.get().commit()
        kb_service.recover_stale_status()
        row = dbmod.get().execute("SELECT status FROM docs WHERE id='doc_f'").fetchone()
        assert row["status"] == "ready"
        ok("启动恢复覆盖 fetching：无产物 failed / 有 pdf2md.md ready（重启丢抓取线程自愈）")
    finally:
        paths.doc_dir = old_doc_dir
        import shutil
        shutil.rmtree(d_dir, ignore_errors=True)


def main():
    t0_import_link_async_http()
    t0b_placeholder_name()
    t1_branch_include_current()
    t2_branch_http_include_current()
    t3_running_statuses_and_recover()
    print(f"\n全部通过：{_passed} 组断言")


if __name__ == "__main__":
    main()
