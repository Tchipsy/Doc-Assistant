"""文档路由：CRUD/上传/生成配置/入库配置/预览/导出入口。"""
import json

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from app import paths, pauses
from app.services import (chat_service, export_service, gen_service,
                          index_service, kb_service)
from engine import meta as meta_mod
from engine.errors import ArtifactMissing

router = APIRouter(prefix="/api", tags=["documents"])


class RenameBody(BaseModel):
    name: str


class DeleteBody(BaseModel):
    ids: list[str]


class ConfigBody(BaseModel):
    config: dict


class BatchConfigBody(BaseModel):
    ids: list[str]
    config: dict


class GenerateBody(BaseModel):
    ids: list[str]
    force: bool = False


class DocsReorderBody(BaseModel):
    kbId: str
    ids: list[str]   # 整列表新顺序（一次拖动全量下发）


class MoveBody(BaseModel):
    docIds: list[str]
    targetKbId: str


class CopyBody(BaseModel):
    docId: str
    targetKbId: str


class ExportMdBody(BaseModel):
    ids: list[str]


class PdfPreviewBody(BaseModel):
    docId: str
    options: dict = {}


class ExportPdfBody(BaseModel):
    ids: list[str]
    options: dict = {}


# ---------------- 列表 / CRUD ----------------

@router.get("/knowledge-bases/{kb_id}/documents")
def list_docs(kb_id: str):
    docs = kb_service.list_docs(kb_id)
    for d in docs:
        d["indexStale"] = index_service.is_index_stale(d["id"])
    return {"docs": docs}


@router.post("/knowledge-bases/{kb_id}/documents")
async def upload_docs(kb_id: str, files: list[UploadFile] = File(...)):
    items = []
    for f in files:
        content = await f.read()
        items.append((f.filename or "untitled", content))
    docs = kb_service.upload_docs(kb_id, items)
    if not docs:
        raise HTTPException(400, "没有可导入的文件（支持 .pdf / .md）")
    return {"docs": docs}


@router.get("/documents/{doc_id}")
def get_doc(doc_id: str):
    d = kb_service.get_doc(doc_id)
    if d is None:
        raise HTTPException(404, "文档不存在")
    d["indexStale"] = index_service.is_index_stale(doc_id)
    return d


@router.patch("/documents/{doc_id}")
def rename_doc(doc_id: str, body: RenameBody):
    kb_service.rename_doc(doc_id, body.name.strip())
    return {"ok": True}


@router.delete("/documents")
def delete_docs(body: DeleteBody):
    kb_service.delete_docs(body.ids)
    return {"ok": True}


@router.post("/documents/{doc_id}/reparse")
def reparse_doc(doc_id: str):
    try:
        return {"job": kb_service.reparse_doc(doc_id)}
    except (KeyError, FileNotFoundError) as e:
        raise HTTPException(404, str(e))


@router.post("/documents/{doc_id}/retry")
def retry(doc_id: str):
    try:
        return {"job": gen_service.service.retry(doc_id)}
    except KeyError:
        raise HTTPException(404, "文档不存在")


_ZOMBIE_DETAIL = "服务曾重启，该任务已丢失；已完成部分自动跳过，请重新点生成续跑"


def _pause_resume_err(result: str) -> HTTPException:
    """pause/resume 返回值 → HTTP 语义（debug3 3.3，#11）：
    zombie（status 声称在跑但进程内无任务=服务曾重启）→ 409 + 明确指引；
    inactive（无进行中任务）→ 400。"""
    if result == "zombie":
        return HTTPException(409, _ZOMBIE_DETAIL)
    return HTTPException(400, "文档不在执行中")


@router.post("/documents/{doc_id}/pause")
def pause_doc(doc_id: str):
    """暂停该文档进行中的生成/入库流水线（当前窗口/批次跑完后挂起）。"""
    r = pauses.pause(doc_id)
    if r != "ok":
        raise _pause_resume_err(r)
    return {"ok": True}


@router.post("/documents/{doc_id}/resume")
def resume_doc(doc_id: str):
    r = pauses.resume(doc_id)
    if r != "ok":
        raise _pause_resume_err(r)
    return {"ok": True}


# ---------------- 生成配置 / 执行 ----------------

@router.put("/documents/{doc_id}/gen-config")
def put_gen_config(doc_id: str, body: ConfigBody):
    try:
        gen_service.service.save_gen_config([doc_id], body.config)
        return {"ok": True}
    except KeyError:
        raise HTTPException(404, "文档不存在")


@router.put("/documents/gen-config-batch")
def put_gen_config_batch(body: BatchConfigBody):
    gen_service.service.save_gen_config(body.ids, body.config)
    return {"ok": True}


@router.post("/documents/generate")
def generate(body: GenerateBody):
    """总是执行流水线：pass1/pass2/入库按指纹跳过未变化步骤。
    步骤10：文档解析中提交 → 排队（配置照常生效），解析完成后自动续跑。"""
    if not body.ids:
        raise HTTPException(400, "ids 为空")
    return {"job": gen_service.service.start_generation(body.ids, force=body.force)}


# ---------------- 排序 / 移动 / 复制（9.5 步骤10） ----------------

@router.post("/documents/reorder")
def reorder_docs(body: DocsReorderBody):
    """手动排序：按 ids 顺序赋 sort_order=1000,2000,…（限 kbId 范围内）。"""
    if not body.ids:
        raise HTTPException(400, "ids 为空")
    kb_service.reorder_docs(body.kbId, body.ids)
    return {"ok": True}


@router.post("/documents/move")
def move_docs(body: MoveBody):
    """移动文档到目标知识库（事务性；运行中文档 409 拒绝）。"""
    if not body.docIds:
        raise HTTPException(400, "docIds 为空")
    try:
        docs = kb_service.move_docs(body.docIds, body.targetKbId)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"docs": docs}


@router.post("/documents/copy")
def copy_doc(body: CopyBody):
    """复制文档到目标知识库（chunks 向量复用零重嵌入；运行中文档 409 拒绝）。"""
    try:
        doc = kb_service.copy_doc(body.docId, body.targetKbId)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"doc": doc}


# ---------------- 入库配置 / 执行 ----------------

@router.put("/documents/{doc_id}/index-config")
def put_index_config(doc_id: str, body: ConfigBody):
    index_service.save_index_config([doc_id], body.config)
    return {"ok": True}


@router.put("/documents/index-config-batch")
def put_index_config_batch(body: BatchConfigBody):
    index_service.save_index_config(body.ids, body.config)
    return {"ok": True}


@router.post("/documents/{doc_id}/reindex")
def reindex(doc_id: str):
    return {"job": index_service.reindex(doc_id)}


# ---------------- 预览（组件树快照） ----------------

@router.get("/documents/{doc_id}/preview")
def preview(doc_id: str):
    p = gen_service.service.get_preview(doc_id)
    if p is None:
        raise HTTPException(404, "文档不存在")
    return p


@router.get("/documents/{doc_id}/generated-title")
def generated_title(doc_id: str):
    """读 pass1 生成的标题（需求9）：gen_config.presetId 的 stage_dir/.meta.json title。

    无预设/未生成/无标题 → {title: null}。列表接口 _public 不塞该字段（避免每次列表 IO），
    仅右键菜单按需读取。步骤11：按生效配置解析（继承中的文档=库默认 presetId）。
    """
    d = kb_service.raw_doc(doc_id)
    if d is None:
        raise HTTPException(404, "文档不存在")
    try:
        cfg = kb_service.resolve_effective_config(d, "gen") or {}
    except Exception:  # noqa: BLE001
        cfg = {}
    preset_id = cfg.get("presetId")
    if not preset_id:
        return {"title": None}
    meta_path = paths.stage_dir(d["kb_id"], doc_id, preset_id) / meta_mod.META_NAME
    if not meta_path.is_file():
        return {"title": None}
    try:
        title = (json.loads(meta_path.read_text(encoding="utf-8")) or {}).get("title")
    except Exception:  # noqa: BLE001
        return {"title": None}
    return {"title": title if isinstance(title, str) and title.strip() else None}


# ---------------- 导出 ----------------

@router.post("/documents/export-md")
def export_md(body: ExportMdBody):
    try:
        docs = export_service.export_markdown(body.ids)
        return {"docs": docs}
    except (ValueError, FileNotFoundError, KeyError) as e:
        raise HTTPException(400, str(e))
    except ArtifactMissing as e:
        raise HTTPException(400, str(e))


@router.post("/documents/export-pdf/preview")
def pdf_preview(body: PdfPreviewBody):
    try:
        return export_service.pdf_preview(body.docId, body.options)
    except (ValueError, FileNotFoundError, KeyError) as e:
        raise HTTPException(400, str(e))


@router.post("/documents/export-pdf")
def export_pdf(body: ExportPdfBody):
    return {"job": export_service.export_pdf(body.ids, body.options)}
