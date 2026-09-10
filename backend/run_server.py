"""启动脚本：python run_server.py（绑定 127.0.0.1:8000）。"""
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND))

import uvicorn  # noqa: E402

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000,
                reload=False, log_level="info")
