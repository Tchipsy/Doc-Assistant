"""引擎常量与工具（无全局环境依赖；运行参数由调用方注入）。"""
import sys
import threading
import time
from pathlib import Path

# ---------- token 估算（启发式） ----------
TOKEN_CJK_RATIO = 0.8
TOKEN_OTHER_RATIO = 3.5

# ---------- 批处理窗口 ----------
ORGANIZE_BATCH_TOKENS = 100_000
ROLLING_SUMMARY_TOKENS = 30_000
PASS2_BATCH_TOKENS = 100_000
ROLLING_TAIL_TOKENS = 15_000

# ---------- 截断续写 / 溢出检查点 ----------
CONTINUE_MAX_CONTEXT_TOKENS = 600_000
CONTINUE_MSG = "请严格从中断处继续输出剩余内容，不要重复任何已输出的部分。"

# ---------- 拼装外观（callout 模板） ----------
SUMMARY_CALLOUT = "> [!abstract]- 📌 本节摘要（Summary）"
PLUGIN_CALLOUTS = {
    "explain": "> [!tip]- 🎓 深入讲解（Explain）",
    "homework": "> [!example]- 📝 作业解答（Homework）",
}
PLUGIN_CALLOUT_DEFAULT = "> [!tip]- 🔌 {name}"
TOC_HEADING = "## 📑 目录"


# ---------- 日志（控制台，线程安全） ----------
class _Logger:
    def __init__(self):
        self._lock = threading.Lock()

    def __call__(self, msg: str) -> None:
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        with self._lock:
            try:
                print(line, flush=True)
            except UnicodeEncodeError:
                print(line.encode("ascii", "replace").decode("ascii"), flush=True)


log = _Logger()


def setup_console_utf8() -> None:
    """防止 Windows 管道/重定向下中文输出崩溃。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:  # noqa: BLE001
            pass


def read_text_guess(path) -> str:
    """读文本：utf-8（含 BOM）优先，回退 gb18030，最后无损替换；统一 \\n。"""
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "gb18030"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("utf-8", errors="replace")
    return text.replace("\r\n", "\n").replace("\r", "\n")
