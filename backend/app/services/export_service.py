"""导出域：markdown（拼装+预览+下载）与 pdf（设置+HTML 实时预览+后台转换）。

debug3（3.4）pdf 指纹缓存：转换成功的产品按
`data/exports/cache/{docId}/{fp}.pdf` 留底，fp = sha256(cfgHash(生效显示配置)
+ artifacts_fp(产物) + 规范化 PdfOptions JSON)；同指纹再次导出秒回（不重跑
Chrome 转换），per-doc LRU 保留最近 3 个指纹。`exports/` 根目录维持
"最新一次导出"覆盖语义（缓存命中也回写根目录），历史版本由 cache 层保留。
"""
import dataclasses
import hashlib
import json
import re
import shutil
import time
import uuid
from pathlib import Path

from app import db, paths
from app.events import emit
from app.jobs import manager
from app.services import kb_service, snapshot_service
from engine.assemble import assemble_document
from engine.config import log
from engine.md2pdf import PdfOptions, convert_md_to_html, markdown_to_pdf, verify

_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

PDF_CACHE_KEEP = 3   # per-doc 缓存保留的最近指纹数（debug3 3.4）


def _safe(name: str) -> str:
    return _INVALID.sub("_", name).strip() or "doc"


def _parts(cfg: dict) -> list[str]:
    comps = cfg.get("components", {})
    parts = []
    if comps.get("toc"):
        parts.append("toc")
    if comps.get("summary"):
        parts.append("summary")
    for pid in cfg.get("plugins", []):
        from app.services import settings_service
        p = settings_service.get_preset(pid)
        if p is not None:
            parts.append(p["name"])
    return parts


def _meta_title(sdir: Path) -> str | None:
    """stage_dir/.meta.json 的 title（debug3 3.5：与 pass1 生成标题一致；
    读法同 gen_service._doc_meta_brief）。"""
    try:
        data = json.loads((Path(sdir) / ".meta.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    t = (data or {}).get("title")
    return t if isinstance(t, str) and t.strip() else None


def _assemble(doc_id: str, out_path: Path) -> dict:
    d = kb_service.raw_doc(doc_id)
    if d is None:
        raise KeyError(doc_id)
    # 步骤11 配置继承：按生效配置组装（继承中的文档=库默认）
    cfg = kb_service.resolve_effective_config(d, "gen")
    if not cfg.get("presetId"):
        raise ValueError("未选择文档整理预设")
    sdir = paths.stage_dir(d["kb_id"], doc_id, cfg["presetId"])
    kb = db.get().execute("SELECT name FROM kbs WHERE id = ?",
                          (d["kb_id"],)).fetchone()
    # debug3 3.5：`# 标题` 优先取 pass1 生成的 meta.title（与预览树 title 节点
    # 同源），无 meta 时回退文档名
    stats = assemble_document(
        sdir, out_path, _parts(cfg), {"title": _meta_title(sdir) or d["name"]},
        kb["name"] if kb else "", d["name"])
    # 图片未勾选显示：剔除图片引用行
    if not cfg.get("components", {}).get("images"):
        text = out_path.read_text(encoding="utf-8")
        lines = [l for l in text.split("\n")
                 if not re.match(r"\s*(!\[|<img)", l, re.I)]
        out_path.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return stats


# ============================ markdown ============================

def export_markdown(doc_ids: list[str]) -> list[dict]:
    out = []
    for did in doc_ids:
        d = kb_service.raw_doc(did)
        if d is None:
            continue
        out_path = paths.EXPORT_DIR / f"{_safe(d['name'])}.md"
        paths.EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        # 步骤9 快路径：命中预组装快照直接返回（毫秒级）；未命中现场组装并入队
        md = snapshot_service.load_export_md(did)
        warnings: list = []
        if md is not None:
            out_path.write_text(md, encoding="utf-8", newline="\n")
        else:
            stats = _assemble(did, out_path)
            md = out_path.read_text(encoding="utf-8")
            warnings = stats.get("warnings", [])
            snapshot_service.enqueue(did)
        out.append({"docId": did, "name": d["name"],
                    "md": md,
                    "warnings": warnings,
                    "url": f"/api/files/exports/{out_path.name}"})
    return out


# ============================ pdf ============================

def _pdf_options(opts: dict) -> PdfOptions:
    font = 9.0 * float(opts.get("fontScale") or 1.0)
    return PdfOptions(
        paper=opts.get("paper") or "a4",
        orientation=opts.get("orientation") or "portrait",
        columns=int(opts.get("columns") or 2),
        margin=float(opts.get("margin") or 4.0),
        font_pt=max(5.0, min(24.0, font)),
    )


def pdf_preview(doc_id: str, opts: dict) -> dict:
    """设置变更时即时转换 HTML（前端防抖调用）。步骤9：优先复用预组装快照
    省一次组装；未命中现场组装并入队快照。"""
    paths.EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    d = kb_service.raw_doc(doc_id)
    if d is None:
        raise KeyError(doc_id)
    md_path = paths.EXPORT_DIR / f".preview_{doc_id}.md"
    md = snapshot_service.load_export_md(doc_id)
    if md is not None:
        md_path.write_text(md, encoding="utf-8", newline="\n")
    else:
        _assemble(doc_id, md_path)
        snapshot_service.enqueue(doc_id)
    html = convert_md_to_html(md_path, _pdf_options(opts))
    return {"docId": doc_id, "name": d["name"], "html": html}


def export_pdf(doc_ids: list[str], opts: dict) -> dict:
    payload = {"docIds": doc_ids, "opts": opts}
    job = manager.start("export_pdf", lambda job: _pdf_job(job, doc_ids, opts),
                        payload=payload)
    return job


# ---------------- pdf 指纹缓存（debug3 3.4，#15） ----------------

def _pdf_fp(d: dict, cfg: dict, sdir: Path, options: PdfOptions) -> str | None:
    """pdf 缓存指纹：sha256(cfgHash(生效显示配置) + artifacts_fp(产物)
    + 规范化 PdfOptions JSON)。产物缺失（无 organized.md）→ None（不缓存）。"""
    afp = snapshot_service.artifacts_fp(sdir)
    if not afp:
        return None
    opts_json = json.dumps(dataclasses.asdict(options), sort_keys=True,
                           ensure_ascii=False)
    h = hashlib.sha256()
    h.update(snapshot_service.cfg_hash(cfg).encode("utf-8"))
    h.update(("|" + afp).encode("utf-8"))
    h.update(("|" + opts_json).encode("utf-8"))
    return h.hexdigest()


def _cache_path(doc_id: str, fp: str | None) -> Path | None:
    if not fp:
        return None
    return paths.EXPORT_DIR / "cache" / doc_id / f"{fp}.pdf"


def _cache_write(doc_id: str, cache_path: Path, pdf_path: Path) -> None:
    """写入缓存留底并做 per-doc LRU（保留最近 PDF_CACHE_KEEP 个指纹）。"""
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(pdf_path, cache_path)
        files = sorted(cache_path.parent.glob("*.pdf"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[PDF_CACHE_KEEP:]:
            try:
                old.unlink()
            except OSError:
                pass
    except OSError as e:
        log(f"[export] ⚠️ {doc_id} pdf 缓存写入失败（不影响本次导出）：{e}")


def _pdf_stats(pdf_path: Path) -> dict:
    pages, _boxes = verify(pdf_path)
    return {"pages": pages,
            "size_mb": round(pdf_path.stat().st_size / 1048576, 2)}


def _pdf_job(job, doc_ids: list[str], opts: dict):
    options = _pdf_options(opts)
    for i, did in enumerate(doc_ids):
        d = kb_service.raw_doc(did)
        if d is None:
            continue
        try:
            paths.EXPORT_DIR.mkdir(parents=True, exist_ok=True)
            cfg = kb_service.resolve_effective_config(d, "gen")
            sdir = (paths.stage_dir(d["kb_id"], did, cfg["presetId"])
                    if cfg.get("presetId") else None)
            fp = _pdf_fp(d, cfg, sdir, options) if sdir is not None else None
            cache_path = _cache_path(did, fp)
            out_path = paths.EXPORT_DIR / f"{_safe(d['name'])}.pdf"
            url = f"/api/files/exports/{out_path.name}"
            if cache_path is not None and cache_path.is_file():
                # 缓存命中：不重跑 Chrome 转换（实现择优记录——job 照常建立，
                # 此处直接 emit export.done 秒完成，保持前端事件流兼容）；
                # 回写 exports/ 根目录维持"最新一次导出"覆盖语义
                try:
                    shutil.copyfile(cache_path, out_path)
                except OSError:
                    url = f"/api/files/exports/cache/{did}/{fp}.pdf"
                stats = _pdf_stats(out_path)
                log(f"[export] {did} pdf 缓存命中（fp {fp[:8]}），秒回")
            else:
                # md 组装统一走 load_export_md 快路径（与 pdf_preview 同源，
                # 命中预组装快照省一次组装）；未命中现场组装并入队重建
                md_path = paths.EXPORT_DIR / f"{_safe(d['name'])}.md"
                md = snapshot_service.load_export_md(did)
                if md is not None:
                    md_path.write_text(md, encoding="utf-8", newline="\n")
                else:
                    _assemble(did, md_path)
                    snapshot_service.enqueue(did)
                stats = markdown_to_pdf(md_path, out_path, options)
                if cache_path is not None:
                    _cache_write(did, cache_path, out_path)
            emit("export.done", docId=did, name=d["name"], kind="pdf",
                 url=url, pages=stats.get("pages"), sizeMb=stats.get("size_mb"))
        except Exception as e:  # noqa: BLE001
            emit("export.error", docId=did, detail=f"{type(e).__name__}: {e}")
        manager.progress(job, int((i + 1) / len(doc_ids) * 100))
