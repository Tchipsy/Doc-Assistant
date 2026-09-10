"""知识库路由。"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import kb_service

router = APIRouter(prefix="/api/knowledge-bases", tags=["kbs"])


class KbCreate(BaseModel):
    name: str


class KbRename(BaseModel):
    name: str


class KbDelete(BaseModel):
    ids: list[str]


class KbReorder(BaseModel):
    ids: list[str]   # 整列表新顺序（一次拖动全量下发）


class KbConfigBody(BaseModel):
    """库级默认配置（步骤11）：文档类/网页类各一份完整配置 {"doc": {...}, "web": {...}}。"""
    genConfig: dict = {}
    indexConfig: dict = {}


class ImportLinkBody(BaseModel):
    url: str
    presetId: str | None = None   # 网页类整理预设（可选；不给=继承库默认配置）


@router.get("")
def list_kbs():
    return {"kbs": kb_service.list_kbs()}


@router.post("")
def create_kb(body: KbCreate):
    if not body.name.strip():
        raise HTTPException(400, "名称不能为空")
    return kb_service.create_kb(body.name.strip())


@router.post("/reorder")
def reorder_kbs(body: KbReorder):
    """手动排序（9.5 步骤10）：按 ids 顺序赋 sort_order=1000,2000,…。"""
    if not body.ids:
        raise HTTPException(400, "ids 为空")
    kb_service.reorder_kbs(body.ids)
    return {"ok": True}


@router.patch("/{kb_id}")
def rename_kb(kb_id: str, body: KbRename):
    kb_service.rename_kb(kb_id, body.name.strip())
    return {"ok": True}


@router.get("/{kb_id}/config")
def get_kb_config(kb_id: str):
    """库级默认配置（步骤11）：{genConfig: {doc?, web?}, indexConfig: {doc?, web?}}。"""
    try:
        return kb_service.get_kb_config(kb_id)
    except KeyError:
        raise HTTPException(404, "知识库不存在")


@router.put("/{kb_id}/config")
def put_kb_config(kb_id: str, body: KbConfigBody):
    """保存库级默认配置（**只保存不触发生成**）：新建/继承中的文档在下次生成时生效。"""
    try:
        return kb_service.save_kb_config(kb_id, body.genConfig, body.indexConfig)
    except KeyError:
        raise HTTPException(404, "知识库不存在")


@router.post("/{kb_id}/import-link")
def import_link(kb_id: str, body: ImportLinkBody):
    """链接导入（debug4 异步化）：同步段=校验+建 fetching 占位文档（占位名=域名截 60）
    立即返回；后台任务抓取网页，成功自动改名（页面标题截 120）并 ready，失败置 failed
    + doc.error。400 {detail}：无效 URL / 预设不存在 / 同 URL 抓取进行中（前端 toast）。"""
    if not body.url.strip():
        raise HTTPException(400, "URL 不能为空")
    try:
        return {"doc": kb_service.import_link(kb_id, body.url.strip(), body.presetId)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("")
def delete_kbs(body: KbDelete):
    kb_service.delete_kbs(body.ids)
    return {"ok": True}
