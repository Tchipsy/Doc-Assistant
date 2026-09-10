"""入库域：入库配置 -> 分块 -> 嵌入 -> 向量库（进度事件）。

增量策略（配合生成域的 pass1_rerun 信号）：
- 全量：pass1 重跑 / organized 或组件或预设变化 / 无历史快照 -> 删全部重嵌；
- 插件 diff：新增插件 -> 只嵌该插件产物；删除插件 -> 按 artifact 删除；
  内容变化 -> 删旧插新；
- 软关闭：enabled=False 不删向量，检索时排除（见 disabled_doc_ids）；
  重新启用且指纹未变 -> 直接恢复，不重新嵌入。
指纹（compute_index_fp）剔除 enabled 键，保证"取消再勾选"指纹不变；
debug3（3.2）起再剔除显示配置插件（gen.plugins）——显示插件只影响 pass2
产物（经 organized_sha/入库插件 diff 覆盖），不影响入库分块内容，计入指纹
会让"只改显示配置"的文档 indexStale 徽章误亮（#8）。
"""
import hashlib
import json
import time

from app import db, paths, pauses
from app.events import emit
from app.jobs import manager
from app.rag import vectorstore
from app.rag.chunker import chunk_document, chunk_plugin
from app.rag.embeddings import embed_texts
from app.services import kb_service, settings_service
from app.services.kb_service import resolve_effective_config
from engine.config import log


def default_index_config() -> dict:
    return {"enabled": False,
            "components": {"summary": False, "images": False},
            "plugins": []}


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def index_enabled(cfg: dict) -> bool:
    if "enabled" in cfg:
        return bool(cfg.get("enabled"))
    # 旧配置兼容：无 enabled 键时按旧规则（任一勾选即启用）推导
    c = cfg.get("components", {})
    return bool(c.get("summary") or c.get("images") or cfg.get("plugins"))


def _effective(cfg: dict) -> dict:
    """指纹/快照用有效配置（剔除 enabled —— 取消入库不改变指纹）。"""
    return {k: v for k, v in cfg.items() if k != "enabled"}


def _plugin_sha(pid: str) -> str:
    p = settings_service.get_preset(pid)
    return hashlib.sha256((p["content"] if p else "").encode()).hexdigest()[:16]


def compute_index_fp(doc: dict, *, legacy_gen_plugins: bool = False) -> str:
    """入库指纹：有效入库配置 + 预设 + organized sha + 入库插件内容 sha。
    步骤11 配置继承：gen/index 均按生效配置解析（继承中的文档=库默认）。
    debug3 3.2：不再把显示配置插件（gen.plugins）计入——legacy_gen_plugins=True
    复刻旧口径，仅供存量指纹迁移比对（migrate_index_fp）。"""
    raw = _effective(resolve_effective_config(doc, "index"))
    gen = resolve_effective_config(doc, "gen")
    parts = [json.dumps(raw, sort_keys=True, ensure_ascii=False),
             str(gen.get("presetId", ""))]
    sdir = paths.stage_dir(doc["kb_id"], doc["id"], gen.get("presetId", ""))
    org = sdir / "organized.md"
    if org.is_file():
        parts.append(hashlib.sha256(org.read_bytes()).hexdigest())
    pids = list(raw.get("plugins", []))
    if legacy_gen_plugins:
        pids += list(gen.get("plugins", []))
    for pid in pids:
        parts.append(f"{pid}:{_plugin_sha(pid)}")
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


_FP_MIGRATE_KEY = "index_fp_migrated_genplugins"


def migrate_index_fp() -> int:
    """存量 index_fp 口径迁移（debug3 3.2，一次性幂等）。

    存量 docs.index_fp 是旧口径（含 gen.plugins）。对每篇有指纹的文档用旧口径
    重算并比对：一致（差异纯由口径引起）才覆写为新口径——避免把真实的产物
    漂移误标为新鲜；旧口径都对不上的文档保持原样（本来就 stale，等重入库）。
    迁移标记存 settings_kv，成功一次后跳过。返回重算篇数。"""
    if db.kv_get(_FP_MIGRATE_KEY):
        return 0
    conn = db.get()
    rows = conn.execute("SELECT id FROM docs WHERE index_fp IS NOT NULL"
                        " AND index_fp != ''").fetchall()
    n = 0
    for r in rows:
        d = kb_service.raw_doc(r["id"])
        if d is None:
            continue
        try:
            old_fp = compute_index_fp(d, legacy_gen_plugins=True)
        except Exception:  # noqa: BLE001  单篇失败不阻塞迁移
            continue
        if old_fp == d["index_fp"]:
            new_fp = compute_index_fp(d)
            if new_fp != d["index_fp"]:
                conn.execute("UPDATE docs SET index_fp = ? WHERE id = ?",
                             (new_fp, r["id"]))
                n += 1
    conn.commit()
    db.kv_set(_FP_MIGRATE_KEY, True)
    log(f"[index] index_fp 口径迁移完成：{n}/{len(rows)} 篇重算"
        f"（debug3 3.2 去 gen.plugins）")
    return n


def _snapshot(doc: dict, cfg: dict) -> dict:
    """入库状态快照（存 docs.index_state）：供插件级 diff。gen 按生效配置解析（步骤11）。"""
    gen = resolve_effective_config(doc, "gen")
    sdir = paths.stage_dir(doc["kb_id"], doc["id"], gen.get("presetId", ""))
    org = sdir / "organized.md"
    plugins = {}
    for pid in cfg.get("plugins", []):
        p = settings_service.get_preset(pid)
        plugins[p["name"] if p else pid] = _plugin_sha(pid)
    return {"preset": gen.get("presetId", ""),
            "components": cfg.get("components", {}),
            "organized_sha": (hashlib.sha256(org.read_bytes()).hexdigest()
                              if org.is_file() else ""),
            "plugins": plugins}


def is_index_stale(doc_id: str) -> bool:
    d = kb_service.raw_doc(doc_id)
    if d is None or not index_enabled(resolve_effective_config(d, "index")):
        return False
    return d["index_fp"] != compute_index_fp(d)


def disabled_doc_ids(kb_ids: list[str] | None = None) -> list[str]:
    """软关闭的文档：向量在库但检索时排除。步骤11：enabled 按生效配置判断
    （继承中的文档=库默认对应 doc_type 的 enabled）。"""
    conn = db.get()
    if kb_ids:
        marks = ",".join("?" * len(kb_ids))
        rows = conn.execute(
            f"SELECT id, kb_id, doc_type, index_config FROM docs WHERE kb_id IN ({marks})",
            list(kb_ids)).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, kb_id, doc_type, index_config FROM docs").fetchall()
    out = []
    for r in rows:
        cfg = resolve_effective_config(dict(r), "index")
        if not index_enabled(cfg):
            out.append(r["id"])
    return out


def save_index_config(doc_ids: list[str], cfg_patch: dict) -> None:
    """只保存配置，不启动任务（执行由 /documents/generate 或 /reindex 触发）。
    步骤9：入库配置变化若给 pass2 带来新产物（指纹判定）→ 等生成完成后重建快照；
    无新产物则快照内容不受影响，入队仅做一次幂等新鲜度校验。"""
    from app.services.gen_service import service as gen_service
    for did in doc_ids:
        cur = (kb_service.get_doc(did) or {}).get("indexConfig") or {}
        merged = {**default_index_config(), **cur, **(cfg_patch or {})}
        kb_service.save_index_config(did, merged)
        try:
            gen_service._maybe_snapshot(did)
        except Exception as e:  # noqa: BLE001  触发失败不影响配置保存
            log(f"[snapshot] ⚠️ {did} 入库配置保存后快照触发失败：{type(e).__name__}: {e}")


def reindex(doc_id: str) -> dict:
    return manager.start("index", lambda job: _run(job, [doc_id]), doc_id=doc_id)


def _run(job, doc_ids: list[str]):
    """批量重入库：每篇一个任务提交 index_pool（跨文档并行，单篇内部串行）。
    编排线程只在此等待全部完成。"""
    import threading

    from app.jobs import index_pool
    total = len(doc_ids)
    state = {"done": 0}
    lock = threading.Lock()
    finished = threading.Semaphore(0)

    def _one(did: str):
        pauses.start(did)
        try:
            reindex_doc(did)
        except Exception as e:  # noqa: BLE001
            log(f"[index] ❌ {did}：{type(e).__name__}: {e}")
            emit("index.error", docId=did, detail=str(e))
        finally:
            pauses.finish(did)
            with lock:
                state["done"] += 1
                n = state["done"]
            manager.progress(job, int(n / total * 100), f"{n}/{total} 篇完成")
            finished.release()

    for did in doc_ids:
        index_pool.submit(_one, did)
    for _ in doc_ids:
        finished.acquire()


def auto_reindex(doc_id: str, pass1_rerun: bool = False):
    """生成完成后自动增量更新。步骤11：入库配置按生效配置解析
    （修复存量边界：gen/index 均为 '{}' 的文档曾在此以空 presetId 拼 stage_dir 报
    organized.md 缺失——resolve 后继承库默认，presetId 正确）。"""
    d = kb_service.raw_doc(doc_id)
    if d is None:
        return
    cfg = resolve_effective_config(d, "index") or default_index_config()
    if not index_enabled(cfg):
        return                      # 软关闭：保留向量，检索时排除
    if pass1_rerun:
        reindex_doc(doc_id)         # 正文重写 -> 全量
        return
    _diff_index(doc_id, d, cfg)


def _diff_index(doc_id: str, d: dict, cfg: dict):
    gen = resolve_effective_config(d, "gen")
    ddir = paths.doc_dir(d["kb_id"], doc_id)
    sdir = paths.stage_dir(d["kb_id"], doc_id, gen.get("presetId", ""))
    if not (sdir / "organized.md").is_file():
        raise FileNotFoundError("organized.md 缺失（请先生成）")
    new_state = _snapshot(d, cfg)
    try:
        old = json.loads(d["index_state"]) if d["index_state"] else None
    except json.JSONDecodeError:
        old = None
    if (old is None or old.get("preset") != new_state["preset"]
            or old.get("organized_sha") != new_state["organized_sha"]
            or old.get("components") != new_state["components"]):
        reindex_doc(doc_id)         # 结构性变化 -> 全量
        return

    old_p: dict = old.get("plugins", {})
    new_p: dict = new_state["plugins"]
    added = [n for n in new_p if n not in old_p]
    removed = [n for n in old_p if n not in new_p]
    changed = [n for n in new_p if n in old_p and old_p[n] != new_p[n]]
    if not (added or removed or changed):
        _mark_indexed(doc_id, d, cfg)       # 指纹恢复（如取消后重新勾选）
        emit("index.done", docId=doc_id, chunks=0)
        return

    for n in removed + changed:
        vectorstore.delete_chunks(doc_id, artifact=n)

    todo = added + changed
    # 产物缺失（如未经生成直接改入库配置）：补跑该插件自身分组
    missing_ids = []
    for n in todo:
        if not (sdir / f"{n}.md").is_file():
            for pid in cfg.get("plugins", []):
                p = settings_service.get_preset(pid)
                if p and p["name"] == n and pid not in (gen.get("plugins") or []):
                    missing_ids.append(pid)
    if missing_ids:
        from app.services.gen_service import service as gen_service
        gen_service.generate_doc(doc_id, extra_plugins=missing_ids, auto_index=False)

    n_chunks = _index_artifacts(doc_id, d, sdir, ddir, gen, todo)
    _mark_indexed(doc_id, d, cfg)
    emit("index.done", docId=doc_id, chunks=n_chunks)


def _index_artifacts(doc_id: str, d: dict, sdir, ddir, gen: dict,
                     names: list[str]) -> int:
    """对指定插件产物分块+嵌入+插入（不动其它 artifact）。"""
    chunks = []
    for n in names:
        chunks += chunk_plugin(sdir, n)
    if not chunks:
        return 0
    for c in chunks:
        c["kb_id"] = d["kb_id"]
        c["doc_id"] = doc_id
        c["preset_id"] = gen.get("presetId", "")
    emb_cfg = settings_service.resolve_model(None, "embedding")

    def _prog(done, total):
        emit("index.progress", docId=doc_id, progress=int(done / total * 100))

    vectors = embed_texts([c["text"] for c in chunks], **emb_cfg, on_progress=_prog,
                          gate=lambda: pauses.wait(doc_id))
    for c, v in zip(chunks, vectors):
        c["embedding"] = v
    vectorstore.insert_chunks(chunks)
    return len(chunks)


def reindex_doc(doc_id: str):
    """全量重入库（删全部重嵌）。步骤11：gen/index 配置按生效配置解析。"""
    d = kb_service.raw_doc(doc_id)
    if d is None:
        raise KeyError(doc_id)
    cfg = resolve_effective_config(d, "index") or default_index_config()
    if not index_enabled(cfg):
        emit("index.done", docId=doc_id, chunks=0)   # 软关闭：向量保留
        return

    gen = resolve_effective_config(d, "gen")
    preset_id = gen.get("presetId", "")
    ddir = paths.doc_dir(d["kb_id"], doc_id)
    sdir = paths.stage_dir(d["kb_id"], doc_id, preset_id)
    if not (sdir / "organized.md").is_file():
        raise FileNotFoundError("organized.md 缺失（请先生成）")

    # 指纹未变且库里有该文档片段：直接恢复（取消入库后重新勾选的路径）
    if d["index_fp"] and d["index_fp"] == compute_index_fp(d) \
            and vectorstore.count_doc(doc_id) > 0:
        _mark_indexed(doc_id, d, cfg)
        emit("index.done", docId=doc_id, chunks=0)
        return

    # 入库需要但尚未生成的插件产物：先补跑 pass2（只跑缺失插件自身分组）
    gen_plugins = set(gen.get("plugins", []))
    missing = [p for p in cfg.get("plugins", []) if p not in gen_plugins]
    if missing:
        from app.services.gen_service import service as gen_service
        gen_service.generate_doc(doc_id, extra_plugins=missing, auto_index=False)

    emit("index.progress", docId=doc_id, progress=0)
    pauses.wait(doc_id)   # 暂停闸门：分块前
    doc_pub = {"id": doc_id, "kb_id": d["kb_id"], "gen_config": gen}
    chunks = chunk_document(doc_pub, sdir, ddir, cfg)

    emb_cfg = settings_service.resolve_model(None, "embedding")

    def _prog(done, total):
        emit("index.progress", docId=doc_id, progress=int(done / total * 100))

    if chunks:
        vectors = embed_texts([c["text"] for c in chunks], **emb_cfg, on_progress=_prog,
                              gate=lambda: pauses.wait(doc_id))
        for c, v in zip(chunks, vectors):
            c["embedding"] = v
    vectorstore.delete_doc_chunks(doc_id)
    if chunks:
        vectorstore.insert_chunks(chunks)
    _mark_indexed(doc_id, d, cfg)
    emit("index.done", docId=doc_id, chunks=len(chunks))


def _mark_indexed(doc_id: str, d: dict, cfg: dict):
    state = _snapshot(d, cfg)
    conn = db.get()
    conn.execute(
        "UPDATE docs SET indexed_at = ?, index_fp = ?, index_state = ? WHERE id = ?",
        (_now(), compute_index_fp(d), json.dumps(state, ensure_ascii=False), doc_id))
    conn.commit()
