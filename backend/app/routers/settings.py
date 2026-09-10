"""设置路由：服务商/模型/默认值/解析/预设与插件。"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import settings_service

router = APIRouter(prefix="/api", tags=["settings"])


class ProviderBody(BaseModel):
    name: str
    baseUrl: str = ""
    apiKey: str = ""


class ProviderPatch(BaseModel):
    name: str | None = None
    baseUrl: str | None = None
    apiKey: str | None = None


class ModelAttrsBody(BaseModel):
    """模型属性（步骤12）：modelType ∈ ''|chat|embedding|rerank；imageInput 能力标记。"""
    modelType: str | None = None
    imageInput: bool | None = None


class ModelsBody(BaseModel):
    checked: list[str]
    attrs: dict[str, ModelAttrsBody] | None = None   # {modelId: {modelType?, imageInput?}}


class DefaultsBody(BaseModel):
    assistant: str | None = None
    organize: str | None = None
    contentGen: str | None = None
    assist: str | None = None
    embedding: str | None = None
    rerank: str | None = None


class ParserBody(BaseModel):
    parser: str | None = None
    paddleocr: dict | None = None
    mineru: dict | None = None
    local: dict | None = None


class WebSearchBody(BaseModel):
    """网络搜索设置（apiKey 空值/打码回传 = 不修改，见 settings_service）。"""
    provider: str | None = None
    apiUrl: str | None = None
    apiKey: str | None = None


class PresetBody(BaseModel):
    kind: str
    displayName: str = ""
    name: str = ""                # 兼容旧调用；displayName 为空时用作显示名
    content: str = ""
    group: str | None = None      # organization 专用：doc | web
    whereId: str | None = None    # plugin 专用：指向 kind='where' 的预设


class PresetPatch(BaseModel):
    displayName: str | None = None
    content: str | None = None
    whereId: str | None = None
    group: str | None = None


@router.get("/settings")
def get_settings():
    return {
        **settings_service.get_settings(),
        "checkedModels": settings_service.checked_models(),
        "defaultLabels": settings_service.DEFAULT_LABELS,
    }


@router.put("/settings/defaults")
def put_defaults(body: DefaultsBody):
    return {"defaults": settings_service.set_defaults(body.model_dump(exclude_unset=True))}


@router.put("/settings/parser")
def put_parser(body: ParserBody):
    return {"parser": settings_service.set_parser_settings(body.model_dump(exclude_none=True))}


@router.get("/settings/websearch")
def get_websearch():
    return {"websearch": settings_service.mask_websearch(
        settings_service.get_websearch_settings())}


@router.put("/settings/websearch")
def put_websearch(body: WebSearchBody):
    saved = settings_service.set_websearch_settings(body.model_dump(exclude_none=True))
    return {"websearch": settings_service.mask_websearch(saved)}


# ---------------- 服务商 ----------------

@router.post("/providers")
def create_provider(body: ProviderBody):
    if not body.name.strip():
        raise HTTPException(400, "名称不能为空")
    return settings_service.create_provider(body.name.strip(), body.baseUrl, body.apiKey)


@router.patch("/providers/{pid}")
def patch_provider(pid: str, body: ProviderPatch):
    settings_service.update_provider(pid, **body.model_dump(exclude_none=True))
    return {"ok": True}


@router.delete("/providers/{pid}")
def delete_provider(pid: str):
    settings_service.delete_provider(pid)
    return {"ok": True}


@router.post("/providers/{pid}/models")
def fetch_models(pid: str):
    try:
        items = settings_service.fetch_provider_models(pid)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"拉取模型列表失败：{e}")
    return {"models": [it["modelId"] for it in items], "items": items}


@router.put("/providers/{pid}/models")
def set_models(pid: str, body: ModelsBody):
    attrs = {mid: a.model_dump(exclude_none=True)
             for mid, a in (body.attrs or {}).items()}
    try:
        settings_service.set_checked_models(pid, body.checked, attrs)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


# ---------------- 预设（文档整理 / 生成位置 / 内容生成） ----------------

def _validate_preset_extra(kind: str, group: str | None, where_id: str | None):
    if kind == "organization" and group is not None and group not in ("doc", "web"):
        raise HTTPException(400, "group 必须是 doc | web")
    if where_id:
        p = settings_service.get_preset(where_id)
        if p is None or p["kind"] != "where":
            raise HTTPException(400, "生成位置不存在（whereId 指向 kind='where' 的预设）")


@router.get("/presets")
def list_presets(kind: str | None = None):
    return {"presets": settings_service.list_presets(kind)}


@router.post("/presets")
def create_preset(body: PresetBody):
    if body.kind not in ("organization", "plugin", "where"):
        raise HTTPException(400, "kind 必须是 organization | plugin | where")
    display = (body.displayName or body.name).strip()
    if not display:
        raise HTTPException(400, "名称不能为空")
    _validate_preset_extra(body.kind, body.group, body.whereId)
    return settings_service.create_preset(body.kind, display, body.content,
                                          group=body.group, where_id=body.whereId)


@router.patch("/presets/{pid}")
def patch_preset(pid: str, body: PresetPatch):
    row = settings_service.get_preset(pid)
    if row is None:
        raise HTTPException(404, f"预设不存在：{pid}")
    data = body.model_dump(exclude_unset=True)
    if data.get("group") is not None and data["group"] not in ("doc", "web"):
        raise HTTPException(400, "group 必须是 doc | web")
    if data.get("whereId"):
        p = settings_service.get_preset(data["whereId"])
        if p is None or p["kind"] != "where":
            raise HTTPException(400, "生成位置不存在（whereId 指向 kind='where' 的预设）")
    patch: dict = {}
    if "displayName" in data:
        patch["display_name"] = data["displayName"]
    if "content" in data:
        patch["content"] = data["content"]
    if "whereId" in data:
        patch["where_id"] = data["whereId"]   # 显式 null = 解绑生成位置
    if "group" in data:
        patch["group"] = data["group"]
    settings_service.update_preset(pid, **patch)
    return {"ok": True}


@router.delete("/presets/{pid}")
def delete_preset(pid: str):
    try:
        settings_service.delete_preset(pid)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}
