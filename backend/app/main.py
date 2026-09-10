"""Doc-Assistant v1.0 后端入口：FastAPI 单进程（API + SSE + 静态前端）。"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app import db, paths
from app.routers import chat, documents, events, files, kbs, settings
from app.services import settings_service
from engine.config import setup_console_utf8

setup_console_utf8()


def create_app() -> FastAPI:
    app = FastAPI(title="Doc-Assistant", version="1.0.0")

    # 初始化数据库 + 播种默认预设/插件
    paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
    db.init(paths.DB_PATH)
    settings_service.seed()

    # 启动恢复（debug3 3.3，#11）：清理服务重启遗留的僵尸状态
    # （generating/queued→ready；parsing 按产物判定 ready/failed），先于服务开始
    try:
        from app.services import kb_service
        kb_service.recover_stale_status()
    except Exception as e:  # noqa: BLE001  恢复失败不阻塞启动
        print(f"[recover] ⚠️ 启动恢复失败：{type(e).__name__}: {e}")

    # index_fp 口径迁移（debug3 3.2，#8）：一次性把存量指纹重算为去 gen.plugins
    # 的新口径（幂等，kv 标记），避免升级后 indexStale 徽章全量误亮
    try:
        from app.services import index_service
        index_service.migrate_index_fp()
    except Exception as e:  # noqa: BLE001  迁移失败不阻塞启动（下次启动重试）
        print(f"[index] ⚠️ index_fp 口径迁移失败：{type(e).__name__}: {e}")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"], allow_headers=["*"],
    )

    app.include_router(kbs.router)
    app.include_router(documents.router)
    app.include_router(settings.router)
    app.include_router(chat.router)
    app.include_router(events.router)
    app.include_router(files.router)

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": "1.0.0"}

    # 托管前端构建产物（存在 dist 时）
    dist = paths.BACKEND_DIR.parent / "webui" / "dist"
    if dist.is_dir():

        @app.get("/")
        async def index():
            return FileResponse(dist / "index.html")

        @app.get("/{file_path:path}")
        async def spa(file_path: str):
            target = (dist / file_path).resolve()
            if str(target).startswith(str(dist.resolve())) and target.is_file():
                return FileResponse(target)
            return FileResponse(dist / "index.html")

    return app


app = create_app()
