"""路径约定：data/（app.db + work/ + exports/）。"""
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent          # backend/
DATA_DIR = BACKEND_DIR / "data"
WORK_DIR = DATA_DIR / "work"
EXPORT_DIR = DATA_DIR / "exports"
PROMPTS_DIR = BACKEND_DIR / "prompts"
DB_PATH = DATA_DIR / "app.db"


def doc_dir(kb_id: str, doc_id: str) -> Path:
    return WORK_DIR / kb_id / doc_id


def stage_dir(kb_id: str, doc_id: str, preset_id: str) -> Path:
    return doc_dir(kb_id, doc_id) / preset_id


def files_base(kb_id: str, doc_id: str) -> str:
    """前端可访问的文件基址（图片等静态资源）。"""
    return f"/api/files/work/{kb_id}/{doc_id}"


# 步骤9 快照文件名约定（落盘在 stage_dir/ 下；原子顶替写 <name>.tmp → os.replace）
SNAPSHOT_PREVIEW = ".preview.json"   # 预览树快照（与 /preview 的 tree 同构 + genFp/cfgHash/builtAt）
SNAPSHOT_EXPORT = ".export.md"       # 按当前显示配置预组装的导出 markdown
