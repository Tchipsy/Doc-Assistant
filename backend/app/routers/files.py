"""静态文件路由：work 工件（imgs/原文档）与导出产物。"""
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app import paths

router = APIRouter(prefix="/api/files", tags=["files"])

_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8",
    ".html": "text/html; charset=utf-8",
}


def _safe_join(base: Path, rel: str) -> Path:
    target = (base / rel).resolve()
    if not str(target).startswith(str(base.resolve())):
        raise HTTPException(403, "非法路径")
    return target


@router.get("/work/{kb_id}/{doc_id}/{file_path:path}")
def work_file(kb_id: str, doc_id: str, file_path: str):
    target = _safe_join(paths.WORK_DIR / kb_id / doc_id, file_path)
    if not target.is_file():
        raise HTTPException(404, "文件不存在")
    mime = _MIME.get(target.suffix.lower(), "application/octet-stream")
    return FileResponse(target, media_type=mime)


@router.get("/exports/{file_path:path}")
def export_file(file_path: str):
    target = _safe_join(paths.EXPORT_DIR, file_path)
    if not target.is_file():
        raise HTTPException(404, "文件不存在")
    mime = _MIME.get(target.suffix.lower(), "application/octet-stream")
    return FileResponse(target, media_type=mime,
                        filename=target.name)
