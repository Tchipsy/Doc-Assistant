"""知识库/文档域：CRUD、上传、解析、状态、手动排序、移动/复制（9.5 步骤10）。"""
import errno
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path

from app import db, paths
from app.events import emit
from app.jobs import manager
from app.services import settings_service

ALLOWED_EXT = {".pdf", ".md"}

# 运行中状态：移动/复制拒绝（正在跑/将跑的任务引用着 work 目录与 chunks；
# "indexing" 不是独立 doc.status——入库跑在 done 之后，由 _active_job_doc_ids 兜底。
# debug3 3.1：queued=已提交生成尚在队列等待，同样占用 work 目录，纳入拒绝；
# debug4：fetching=链接导入后台抓取中（work 目录即将写入），同样拒绝）
RUNNING_STATUSES = {"parsing", "generating", "queued", "fetching"}


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _uid():
    return uuid.uuid4().hex[:12]


def _top_sort_order(kb_id: str | None = None) -> float:
    """当前最小 sort_order − 1000（新建文档/知识库插入最前面，分数定位法）。"""
    conn = db.get()
    if kb_id is None:
        row = conn.execute("SELECT MIN(sort_order) m FROM kbs").fetchone()
    else:
        row = conn.execute("SELECT MIN(sort_order) m FROM docs WHERE kb_id = ?",
                           (kb_id,)).fetchone()
    return (row["m"] - 1000.0) if (row and row["m"] is not None) else 1000.0


def _active_job_doc_ids() -> set[str]:
    """有进行中任务的文档 id（parse/index/export/snapshot 用 doc_id 登记；
    gen 批次在 payload.docIds）。用于移动/复制的运行中校验兜底。"""
    out: set[str] = set()
    for j in manager.list_jobs(active_only=True):
        if j.get("doc_id"):
            out.add(j["doc_id"])
        payload = j.get("payload") or {}
        for did in (payload.get("docIds") or []):
            out.add(did)
    return out


def _doc_row(doc_id: str) -> dict | None:
    row = db.get().execute("SELECT * FROM docs WHERE id = ?", (doc_id,)).fetchone()
    return dict(row) if row else None


def _public(d: dict) -> dict:
    kb = d.get("kb_id")
    from app import pauses   # 局部导入避免循环（pauses → events）
    return {
        "id": d["id"], "kbId": kb, "name": d["name"],
        "sourceKind": d["source_kind"], "docType": d.get("doc_type") or "doc",
        "size": d["size"], "status": d["status"],
        "genConfig": json.loads(d["gen_config"] or "{}"),
        "indexConfig": json.loads(d["index_config"] or "{}"),
        "indexedAt": d["indexed_at"], "createdAt": d["created_at"],
        "paused": pauses.is_paused(d["id"]),
    }


def _set_status(doc_id: str, status: str, **fields):
    conn = db.get()
    conn.execute("UPDATE docs SET status = ? WHERE id = ?", (status, doc_id))
    for k, v in fields.items():
        conn.execute(f"UPDATE docs SET {k} = ? WHERE id = ?", (v, doc_id))
    conn.commit()
    emit("doc.status", docId=doc_id, status=status)


# ============================ 知识库 ============================

def list_kbs() -> list[dict]:
    conn = db.get()
    rows = conn.execute(
        "SELECT k.*, COUNT(d.id) n FROM kbs k LEFT JOIN docs d ON d.kb_id = k.id"
        " GROUP BY k.id ORDER BY k.sort_order, k.created_at").fetchall()
    return [{"id": r["id"], "name": r["name"], "docCount": r["n"],
             "createdAt": r["created_at"]} for r in rows]


def create_kb(name: str) -> dict:
    kid = _uid()
    conn = db.get()
    conn.execute("INSERT INTO kbs (id, name, created_at, sort_order) VALUES (?,?,?,?)",
                 (kid, name, _now(), _top_sort_order()))
    conn.commit()
    return {"id": kid, "name": name, "docCount": 0, "createdAt": _now()}


def reorder_kbs(ids: list[str]):
    """手动排序（步骤10）：一次拖动=整列表新顺序下发，按位赋 1000, 2000, …。"""
    conn = db.get()
    for i, kid in enumerate(ids):
        conn.execute("UPDATE kbs SET sort_order = ? WHERE id = ?", (1000.0 * (i + 1), kid))
    conn.commit()


def rename_kb(kb_id: str, name: str):
    conn = db.get()
    conn.execute("UPDATE kbs SET name = ? WHERE id = ?", (name, kb_id))
    conn.commit()


def delete_kbs(kb_ids: list[str]):
    conn = db.get()
    for kid in kb_ids:
        conn.execute("DELETE FROM kbs WHERE id = ?", (kid,))
        conn.execute("DELETE FROM chunks WHERE kb_id = ?", (kid,))
        # 级联删 docs（外键）
    conn.commit()
    for kid in kb_ids:
        shutil.rmtree(paths.WORK_DIR / kid, ignore_errors=True)


# ==================== 知识库默认配置 / 配置继承（9.5 步骤11） ====================
#
# kbs.gen_config / kbs.index_config：JSON 文本，结构 {"doc": {…完整配置…}, "web": {…}}，
# 文档类/网页类各一份完整配置（显式、无隐藏合并规则）；NULL = 库未设置。
# 文档级继承语义：docs.gen_config == '{}'（空对象）= 完全继承库默认（按 doc_type 取）；
# 非空 = 显式覆盖（现状行为，整体生效）。新建文档默认 '{}'（继承），存量不动。

KB_CONFIG_TYPES = ("doc", "web")


def _load_json(text) -> dict:
    try:
        return json.loads(text) if text else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _sanitize_kb_config(cfg) -> dict:
    """库级配置仅保留 doc/web 两个类型键下的非空对象。"""
    out = {}
    for t in KB_CONFIG_TYPES:
        part = (cfg or {}).get(t)
        if isinstance(part, dict) and part:
            out[t] = part
    return out


def get_kb_config(kb_id: str) -> dict:
    row = db.get().execute(
        "SELECT gen_config, index_config FROM kbs WHERE id = ?", (kb_id,)).fetchone()
    if row is None:
        raise KeyError(kb_id)
    return {"genConfig": _load_json(row["gen_config"]),
            "indexConfig": _load_json(row["index_config"])}


def save_kb_config(kb_id: str, gen_config: dict, index_config: dict) -> dict:
    """保存库级默认配置（整体替换；不触发生成——继承方在下次生成时按新配置走指纹）。"""
    conn = db.get()
    if conn.execute("SELECT 1 FROM kbs WHERE id = ?", (kb_id,)).fetchone() is None:
        raise KeyError(kb_id)
    conn.execute("UPDATE kbs SET gen_config = ?, index_config = ? WHERE id = ?",
                 (json.dumps(_sanitize_kb_config(gen_config), ensure_ascii=False),
                  json.dumps(_sanitize_kb_config(index_config), ensure_ascii=False), kb_id))
    conn.commit()
    return get_kb_config(kb_id)


def _default_gen_for(doc_type: str) -> dict:
    """无任何配置时的兜底默认（presetId 取该类型组第一个预设，无同组预设回退第一个）。"""
    from app.services.gen_service import default_gen_config
    base = default_gen_config()
    orgs = settings_service.list_presets("organization")
    if orgs:
        same = [p for p in orgs if (p.get("group") or "doc") == doc_type]
        base["presetId"] = (same or orgs)[0]["id"]
    return base


def _default_index_for(_doc_type: str) -> dict:
    from app.services.index_service import default_index_config
    return default_index_config()


def resolve_effective_config(doc: dict, kind: str = "gen") -> dict:
    """文档生效配置（步骤11 配置继承，唯一解析点）：
    ① doc 自身配置非空（≠'{}'）→ 显式，整体生效（现状行为）；
    ② 否则继承知识库默认 kbs.<kind>_config[doc.doc_type]；
    ③ 仍无 → 内置默认（gen 的 presetId 取该类型组第一个预设）。
    doc 为 docs 表原始行（dict，含 kb_id/doc_type）；kind='gen'|'index'。"""
    col = "gen_config" if kind == "gen" else "index_config"
    own = _load_json(doc.get(col))
    if own:
        return own
    doc_type = doc.get("doc_type") or "doc"
    try:
        cfg = get_kb_config(doc["kb_id"])["genConfig" if kind == "gen" else "indexConfig"]
        part = cfg.get(doc_type)
    except KeyError:
        part = None
    if isinstance(part, dict) and part:
        return part
    return _default_gen_for(doc_type) if kind == "gen" else _default_index_for(doc_type)


def is_inherited(doc: dict, kind: str = "gen") -> bool:
    """文档配置是否处于继承态（自身为 '{}' 空对象）。"""
    col = "gen_config" if kind == "gen" else "index_config"
    return not _load_json(doc.get(col))


# ============================ 文档 ============================

def list_docs(kb_id: str) -> list[dict]:
    """手动顺序优先（步骤10）：ORDER BY sort_order；状态只作徽章不再参与排序。"""
    conn = db.get()
    rows = conn.execute(
        "SELECT * FROM docs WHERE kb_id = ? ORDER BY sort_order, created_at DESC, id",
        (kb_id,)).fetchall()
    return [_public(dict(r)) for r in rows]


def reorder_docs(kb_id: str, ids: list[str]):
    conn = db.get()
    for i, did in enumerate(ids):
        conn.execute("UPDATE docs SET sort_order = ? WHERE id = ? AND kb_id = ?",
                     (1000.0 * (i + 1), did, kb_id))
    conn.commit()


def get_doc(doc_id: str) -> dict | None:
    d = _doc_row(doc_id)
    return _public(d) if d else None


def upload_docs(kb_id: str, files: list[tuple[str, bytes]]) -> list[dict]:
    """files: [(filename, content)]。创建文档并立即启动解析（OCR/pdf2md）。
    步骤10：新建文档 sort_order=当前最小−1000，插入列表最前面。"""
    out = []
    for filename, content in files:
        ext = Path(filename).suffix.lower()
        if ext not in ALLOWED_EXT:
            continue
        did = _uid()
        ddir = paths.doc_dir(kb_id, did)
        ddir.mkdir(parents=True, exist_ok=True)
        src = ddir / ("原文档.pdf" if ext == ".pdf" else "原文档.md")
        src.write_bytes(content)
        conn = db.get()
        conn.execute(
            "INSERT INTO docs (id, kb_id, name, source_kind, doc_type, size, status,"
            " sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (did, kb_id, Path(filename).stem, ext.lstrip("."), "doc", len(content),
             "pending", _top_sort_order(kb_id), _now()))
        conn.commit()
        _set_status(did, "parsing")
        out.append(_public(_doc_row(did)))
        # 步骤10：解析启动前登记完成事件（排队生成在事件上挂起；先登记防竞态漏置位）
        from app.jobs import register_parse
        register_parse(did)
        manager.start(
            "parse", lambda job, did=did, kb_id=kb_id, src=src: _parse_job(job, did, kb_id, src),
            doc_id=did)
    return out


def _parse_job(job, doc_id: str, kb_id: str, src: Path):
    ddir = paths.doc_dir(kb_id, doc_id)
    cfg = settings_service.parser_engine_cfg()
    from app.jobs import set_parse_done
    try:
        from engine import ocr as ocr_mod
        stats = ocr_mod.parse_document(src, ddir, cfg)
    except Exception as e:  # noqa: BLE001
        _set_status(doc_id, "failed")
        set_parse_done(doc_id, False, str(e))   # 唤醒排队生成 → 该 gen 项报「解析失败」
        emit("doc.error", docId=doc_id, detail=f"解析失败：{e}")
        raise
    # debug3 3.1：解析成功时若该文档已排队生成（status='queued'）则保留排队态，
    # 不回写 ready 造成"排队中"闪回"待生成"（生成开跑时自然置 generating）
    cur = _doc_row(doc_id)
    if cur is not None and cur["status"] == "queued":
        from engine.config import log
        log(f"[parse] {doc_id} 解析完成，保留排队生成状态（queued）")
    else:
        _set_status(doc_id, "ready")
    set_parse_done(doc_id, True)
    emit("doc.parsed", docId=doc_id, **stats)


def reparse_doc(doc_id: str):
    """按当前全局解析配置重新解析（重跑 OCR）。"""
    d = _doc_row(doc_id)
    if d is None:
        raise KeyError(doc_id)
    ddir = paths.doc_dir(d["kb_id"], doc_id)
    src = ddir / ("原文档.pdf" if d["source_kind"] == "pdf" else "原文档.md")
    if not src.is_file():
        raise FileNotFoundError("源文件缺失")
    _set_status(doc_id, "parsing")
    from app.jobs import register_parse
    register_parse(doc_id)   # 步骤10：重新解析也换新完成事件（排队中的旧等待走超时兜底）
    return manager.start("parse", lambda job: _parse_job(job, doc_id, d["kb_id"], src),
                         doc_id=doc_id)


def rename_doc(doc_id: str, name: str):
    conn = db.get()
    conn.execute("UPDATE docs SET name = ? WHERE id = ?", (name, doc_id))
    conn.commit()


def delete_docs(doc_ids: list[str]):
    conn = db.get()
    dirs = []
    for did in doc_ids:
        row = _doc_row(did)
        if row:
            dirs.append(paths.doc_dir(row["kb_id"], did))
        conn.execute("DELETE FROM docs WHERE id = ?", (did,))
        conn.execute("DELETE FROM chunks WHERE doc_id = ?", (did,))
    conn.commit()
    for d in dirs:
        shutil.rmtree(d, ignore_errors=True)


def set_status(doc_id: str, status: str, **fields):
    _set_status(doc_id, status, **fields)


def recover_stale_status() -> int:
    """启动恢复（debug3 3.3，#11）：服务重启会丢掉运行中的任务线程，但 status
    持久化在库里——僵尸 generating/queued 一律回 ready；parsing/fetching 看产物判定
    （work 目录已有 pdf2md.md → ready，否则 failed；fetching=debug4 链接导入后台
    抓取线程同样随重启丢失）。每篇 emit doc.status（重启后首批订阅者经 EventBus
    重放拿到最终状态），日志一行汇总。在 create_app（db.init 后、开始服务前）调用；
    返回清理篇数。"""
    conn = db.get()
    rows = conn.execute(
        "SELECT id, kb_id, status FROM docs"
        " WHERE status IN ('generating', 'queued', 'parsing', 'fetching')").fetchall()
    if not rows:
        return 0
    for r in rows:
        if r["status"] in ("parsing", "fetching"):
            target = ("ready" if (paths.doc_dir(r["kb_id"], r["id"])
                                  / "pdf2md.md").is_file() else "failed")
        else:
            target = "ready"
        conn.execute("UPDATE docs SET status = ? WHERE id = ?", (target, r["id"]))
        emit("doc.status", docId=r["id"], status=target)
    conn.commit()
    from engine.config import log
    log(f"[recover] 启动恢复：清理 {len(rows)} 篇僵尸状态"
        f"（generating/queued→ready，parsing/fetching 按产物判定 ready/failed）")
    return len(rows)


# ==================== 移动 / 复制（9.5 步骤10） ====================

def _validate_targets(doc_ids: list[str]) -> list[dict]:
    """移动/复制公共校验：文档存在、不在运行中（parsing/generating）、无进行中任务
    （入库跑在 done 之后无独立状态、导出/快照占着 work 目录——用任务表兜底）。"""
    active = _active_job_doc_ids()
    docs = []
    for did in doc_ids:
        d = _doc_row(did)
        if d is None:
            raise ValueError(f"文档不存在：{did}")
        if d["status"] in RUNNING_STATUSES:
            raise ValueError(f"「{d['name']}」正在解析/生成/抓取中，请稍后再试")
        if did in active:
            raise ValueError(f"「{d['name']}」有进行中的任务（解析/生成/入库/导出），请稍后再试")
        docs.append(d)
    return docs


def _migrate_dir(old: Path, new: Path, attempts: int = 3):
    """磁盘目录迁移：os.replace 同盘原子；跨盘（EXDEV）fallback shutil.move（非原子）。
    Windows 下目录内偶发短暂句柄占用（快照写入/杀软扫描）→ 少量重试。"""
    for attempt in range(attempts):
        try:
            os.replace(old, new)
            return
        except OSError as e:
            if e.errno == errno.EXDEV:
                shutil.move(str(old), str(new))
                return
            if attempt == attempts - 1:
                raise
            time.sleep(0.3)


def _rewrite_snapshot_base(ddir: Path, old_kb: str, new_kb: str, doc_id: str):
    """迁移/复制后把落盘快照内嵌的绝对文件基址改指新位置。

    `.preview.json` 的树节点 md 内嵌构建时的 files_base（/api/files/work/{oldKb}/{docId}/…），
    目录迁移到新库后不重写会 404；`.export.md` 为相对路径不受影响，防御性一并处理。
    失败只记日志（快路径 miss 时现场重组/重建快照会自愈）。"""
    old_base = f"/api/files/work/{old_kb}/{doc_id}"
    new_base = f"/api/files/work/{new_kb}/{doc_id}"
    for name in (paths.SNAPSHOT_PREVIEW, paths.SNAPSHOT_EXPORT):
        f = ddir / name
        try:
            if not f.is_file():
                continue
            data = f.read_text(encoding="utf-8")
            if old_base in data:
                f.write_text(data.replace(old_base, new_base), encoding="utf-8")
        except OSError as e:
            from engine.config import log
            log(f"[kb] ⚠️ {doc_id} 快照文件基址重写失败（快照重建时自愈）：{e}")


def move_docs(doc_ids: list[str], target_kb_id: str) -> list[dict]:
    """移动文档到目标知识库（事务性：任一失败整体回滚）。

    1) 校验：目标库存在；文档不在运行中；
    2) 同一未提交事务里 UPDATE docs.kb_id + chunks.kb_id（检索按 kb 过滤必须同步）；
    3) 磁盘目录迁移 work/{oldKb}/{docId} → {newKb}/{docId}（os.replace 同盘原子）；
    4) 全部成功才 commit——磁盘迁移失败 rollback（铁律：磁盘迁移失败回滚 DB）。
    index_state/指纹/indexed_at 不变（内容没动）；快照内嵌文件基址重写为新库。
    """
    conn = db.get()
    if conn.execute("SELECT 1 FROM kbs WHERE id = ?", (target_kb_id,)).fetchone() is None:
        raise ValueError("目标知识库不存在")
    docs = _validate_targets(doc_ids)
    moving = [d for d in docs if d["kb_id"] != target_kb_id]
    if not moving:
        return [get_doc(d["id"]) for d in docs]
    try:
        for d in moving:
            conn.execute("UPDATE docs SET kb_id = ? WHERE id = ?", (target_kb_id, d["id"]))
        marks = ",".join("?" * len(moving))
        conn.execute(f"UPDATE chunks SET kb_id = ? WHERE doc_id IN ({marks})",
                     [target_kb_id, *[d["id"] for d in moving]])
        for d in moving:   # 磁盘迁移放在 DB 提交之前：失败即 rollback
            old_dir = paths.doc_dir(d["kb_id"], d["id"])
            new_dir = paths.doc_dir(target_kb_id, d["id"])
            if old_dir.is_dir():
                if new_dir.exists():
                    raise ValueError(f"目标目录已存在，无法迁移：{new_dir}")
                new_dir.parent.mkdir(parents=True, exist_ok=True)
                _migrate_dir(old_dir, new_dir)
                _rewrite_snapshot_base(new_dir, d["kb_id"], target_kb_id, d["id"])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return [get_doc(d["id"]) for d in docs]


def copy_doc(doc_id: str, target_kb_id: str) -> dict:
    """复制文档到目标知识库（语义=复制不删除；新文档名=原名+"（副本）"）。

    - work 目录 shutil.copytree 整体拷贝（原文档/pdf2md/imgs/各 stage 产物；
      步骤9 快照随目录拷走，cfgHash 相同仍有效——内嵌文件基址重写为新库）；
    - gen/index 配置、index_state/指纹照抄（内容没变，指纹路径无关）；
    - chunks INSERT...SELECT 复用嵌入向量（chunk 主键重生成、kb_id/doc_id 换新），
      零重嵌入、零 API 费用；indexed_at 置当前；
    - status：原文档已完成 → done（产物已全量拷贝）；未完成（ready/failed/pending）
      保持原状态（产物缺失时行为与原文档一致）。
    - 大文档 copytree 同步执行（几百 MB 级耗时，v1 不做异步 job，见已知问题）。
    """
    conn = db.get()
    if conn.execute("SELECT 1 FROM kbs WHERE id = ?", (target_kb_id,)).fetchone() is None:
        raise ValueError("目标知识库不存在")
    (d,) = _validate_targets([doc_id])
    new_id = _uid()
    new_name = f"{d['name']}（副本）"
    src_dir = paths.doc_dir(d["kb_id"], doc_id)
    dst_dir = paths.doc_dir(target_kb_id, new_id)
    dst_dir.parent.mkdir(parents=True, exist_ok=True)
    if src_dir.is_dir():
        shutil.copytree(src_dir, dst_dir)
        _rewrite_snapshot_base(dst_dir, d["kb_id"], target_kb_id, new_id)
    else:
        dst_dir.mkdir(parents=True, exist_ok=True)
    status = "done" if d["status"] == "done" else d["status"]
    conn.execute(
        "INSERT INTO docs (id, kb_id, name, source_kind, doc_type, size, status, parse_config,"
        " gen_config, index_config, indexed_at, index_fp, index_state, sort_order, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (new_id, target_kb_id, new_name, d["source_kind"], d.get("doc_type") or "doc",
         d["size"], status, d["parse_config"], d["gen_config"], d["index_config"],
         _now(), d["index_fp"], d["index_state"], _top_sort_order(target_kb_id), _now()))
    # 向量复用：嵌入向量与文本完全相同，直接 INSERT...SELECT，零重嵌入
    conn.execute(
        "INSERT INTO chunks (id, kb_id, doc_id, preset_id, artifact, section_num, anchor,"
        " line_start, line_end, breadcrumb, text, kind, embedding)"
        " SELECT lower(hex(randomblob(8))), ?, ?, preset_id, artifact, section_num, anchor,"
        " line_start, line_end, breadcrumb, text, kind, embedding"
        " FROM chunks WHERE doc_id = ?",
        (target_kb_id, new_id, doc_id))
    conn.commit()
    return get_doc(new_id)


def _placeholder_name(url: str) -> str:
    """导入占位名（debug4 #3）：域名（去 www.）或 URL 截 60 字；抓取成功后由
    _import_job 改名为页面标题。"""
    m = re.match(r"^https?://([^/?#]+)", url or "")
    name = (m.group(1) if m else (url or "")).strip() or url
    if name.lower().startswith("www."):
        name = name[4:]
    return name[:60] or "网页文档"


def _import_in_progress(kb_id: str, url: str) -> bool:
    """同库同 URL 防抖（debug4）：已有进行中的 import 任务 → 重复提交拒绝。"""
    for j in manager.list_jobs(active_only=True):
        if j.get("kind") == "import":
            p = j.get("payload") or {}
            if p.get("kbId") == kb_id and p.get("url") == url:
                return True
    return False


def import_link(kb_id: str, url: str, preset_id: str | None = None) -> dict:
    """链接导入（debug4 #3 异步化：占位名→抓完改名）。

    同步段（立即返回）：校验 URL/预设 → 同 URL 防抖 → 先 INSERT 占位文档
    （name=_placeholder_name、status='fetching'、doc_type='web'、source_kind='md'、
    sort_order 置顶）→ emit doc.status（关键事件必达）→ 立即返回 {doc}；
    后台段（jobs 任务类型 `import`，编排池轻任务）：web_import.fetch_page 抓取——
    成功 → 写 原文档.md/pdf2md.md → rename_doc(页面标题截 120，无标题保留占位名)
    → ready + emit doc.parsed（前端 refreshDoc 刷新行拿到新名）；
    失败 → failed + emit doc.error（detail=原因）——文档保留，可删除/重新提交。
    抓取内核（web_import.py trust_env/trafilatura/jina fallback）不动。"""
    conn = db.get()
    if conn.execute("SELECT 1 FROM kbs WHERE id = ?", (kb_id,)).fetchone() is None:
        raise ValueError("知识库不存在")
    if not re.match(r"^https?://", (url or "").strip()):
        raise ValueError("URL 无效（仅支持 http/https）")
    if preset_id:
        p = settings_service.get_preset(preset_id)
        if p is None or p["kind"] != "organization":
            raise ValueError("整理预设不存在")
    if _import_in_progress(kb_id, url):
        raise ValueError("该链接正在抓取中，请勿重复提交")
    did = _uid()
    conn.execute(
        "INSERT INTO docs (id, kb_id, name, source_kind, doc_type, size, status,"
        " gen_config, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (did, kb_id, _placeholder_name(url), "md", "web", 0, "fetching",
         json.dumps({"presetId": preset_id} if preset_id else {}, ensure_ascii=False),
         _top_sort_order(kb_id), _now()))
    conn.commit()
    emit("doc.status", docId=did, status="fetching")   # 关键事件（必达）：前端徽章「抓取中」
    manager.start("import", lambda job: _import_job(job, did, kb_id, url),
                  doc_id=did, payload={"url": url, "kbId": kb_id})
    return get_doc(did)


def _import_job(job, doc_id: str, kb_id: str, url: str):
    """后台抓取（任务类型 import，编排池轻任务——不占 parse 专用池）。
    成功改名+ready；失败 failed+doc.error（不向 job 包装层抛错，避免双重失败事件）。"""
    from app.services import web_import
    from engine.config import log
    if _doc_row(doc_id) is None:   # 抓取期间文档被删除：直接结束，不留孤儿产物
        return
    try:
        err, page = web_import.fetch_page(url)
        if err:
            raise ValueError(err)
        md = page["markdown"] or ""
        if not md.strip():
            raise ValueError("未能从网页中抽取到正文内容")
        ddir = paths.doc_dir(kb_id, doc_id)
        ddir.mkdir(parents=True, exist_ok=True)
        (ddir / "原文档.md").write_text(md, encoding="utf-8")
        (ddir / "pdf2md.md").write_text(md, encoding="utf-8")
        title = re.sub(r"[\x00-\x1f]", "", (page.get("title") or "").strip())
        if title:
            rename_doc(doc_id, title[:120])
        _set_status(doc_id, "ready", size=len(md.encode("utf-8")))
        emit("doc.parsed", docId=doc_id, pages=0)   # 前端 refreshDoc → 拉到改名后的文档行
        log(f"[import] {doc_id} 抓取成功：{title[:50] or '（无标题，保留占位名）'}"
            f"（{len(md)} 字符）")
    except Exception as e:  # noqa: BLE001  失败：文档保留为 failed（可删除/重新提交重试）
        _set_status(doc_id, "failed")
        emit("doc.error", docId=doc_id, detail=f"网页抓取失败：{e}")
        log(f"[import] {doc_id} 抓取失败：{e}")


def save_gen_config(doc_id: str, cfg: dict):
    conn = db.get()
    conn.execute("UPDATE docs SET gen_config = ? WHERE id = ?",
                 (json.dumps(cfg, ensure_ascii=False), doc_id))
    conn.commit()


def save_index_config(doc_id: str, cfg: dict):
    conn = db.get()
    conn.execute("UPDATE docs SET index_config = ? WHERE id = ?",
                 (json.dumps(cfg, ensure_ascii=False), doc_id))
    conn.commit()


def raw_doc(doc_id: str) -> dict | None:
    return _doc_row(doc_id)
