"""任务管理器：长任务（生成/入库/导出/解析/快照）跑线程池，事件总线汇报进度。

并发模型（详见 AGENT/后端指南.md 并发模型一节）：
- self.executor(4)：批次编排线程（gen/index 批次在这里只做提交+等待，轻量）
  + PDF 导出 + snapshot 快照任务（步骤9，轻量文件 IO）；
- parse_pool(4)：OCR 解析专用，恒 4 并发（云端轮询占线程，不被编排线程挤占）；
- pass1_pool / pass2_pool / index_pool（各 10）：生成流水线三阶段，
  文档在阶段间链式流转（pass1 完成即进 pass2，跨文档并发，同文档内串行）。
"""
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor

from app import db
from app.events import emit

MAX_WORKERS = 4
STAGE_WORKERS = 10


class JobManager:
    def __init__(self):
        self.executor = ThreadPoolExecutor(max_workers=MAX_WORKERS,
                                            thread_name_prefix="job")
        self._lock = threading.Lock()
        self._jobs: dict[str, dict] = {}

    def start(self, kind: str, fn, *, doc_id: str | None = None,
              payload: dict | None = None) -> dict:
        job_id = uuid.uuid4().hex[:12]
        job = {"id": job_id, "kind": kind, "status": "running",
               "doc_id": doc_id, "payload": payload or {},
               "progress": 0, "detail": "", "created_at": _now()}
        with self._lock:
            self._jobs[job_id] = job
        emit("job.started", job_id=job_id, kind=kind, doc_id=doc_id)
        # 解析专用池（OCR 轮询长时间占线程），其余在编排池
        pool = parse_pool if kind == "parse" else self.executor
        pool.submit(self._wrap, job, fn)
        return job

    def _wrap(self, job: dict, fn):
        try:
            fn(job)
            job["status"] = "done"
            emit("job.done", job_id=job["id"], kind=job["kind"],
                 doc_id=job["doc_id"], progress=job["progress"])
        except Exception as e:  # noqa: BLE001
            job["status"] = "failed"
            job["detail"] = f"{type(e).__name__}: {e}"
            traceback.print_exc()
            emit("job.failed", job_id=job["id"], kind=job["kind"],
                 doc_id=job["doc_id"], detail=job["detail"])

    def progress(self, job: dict, pct: int, detail: str = ""):
        with self._lock:   # 多阶段线程并发汇报
            job["progress"] = max(0, min(100, int(pct)))
            if detail:
                job["detail"] = detail
        emit("job.progress", job_id=job["id"], kind=job["kind"],
             doc_id=job["doc_id"], progress=job["progress"], detail=detail)

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list_jobs(self, active_only=True) -> list[dict]:
        with self._lock:
            jobs = list(self._jobs.values())
        if active_only:
            jobs = [j for j in jobs if j["status"] == "running"]
        return sorted(jobs, key=lambda j: j["created_at"])


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ==================== 解析完成事件表（9.5 步骤10：解析中排队生成） ====================
#
# gen 批次提交时文档可能仍在解析（status=parsing）：_prepare 挂起在 per-doc 事件上，
# 解析成功/失败时置位。事件在解析任务启动时登记（register_parse，重复解析覆盖旧事件），
# 保证"gen 检查 status=parsing 之后、等待之前解析恰好完成"的竞态下等待方也能立即通过
# （Event 初始态检查）。条目置位后保留在表中（迟到的等待方直接通过），下次解析覆盖。

PARSE_WAIT_TIMEOUT = 30 * 60   # 等待解析完成上限（分钟级超时防线程泄漏）

_parse_events_lock = threading.Lock()
_parse_events: dict[str, dict] = {}   # doc_id -> {event: Event, ok: bool|None, detail: str}


def register_parse(doc_id: str) -> None:
    """解析任务启动时登记完成事件（上传解析 / 重新解析入口各调一次）。"""
    with _parse_events_lock:
        _parse_events[doc_id] = {"event": threading.Event(), "ok": None, "detail": ""}


def set_parse_done(doc_id: str, ok: bool, detail: str = "") -> None:
    """解析结束（成功/失败都算）时置位；失败时 detail=异常文本（gen 项报「解析失败：…」）。"""
    with _parse_events_lock:
        entry = _parse_events.get(doc_id)
        if entry is None:
            return
        entry["ok"] = ok
        entry["detail"] = detail
        entry["event"].set()


def wait_parse_done(doc_id: str, timeout: float = PARSE_WAIT_TIMEOUT) -> tuple[bool, str]:
    """等待该文档解析完成（排队生成的挂起点，gen _prepare 调用）。

    返回 (True, "")=解析成功可继续；(False, 原因)=解析失败/等待超时。
    无登记事件（解析从未启动 / 服务重启后遗留的 parsing 状态）→ 立即放行：
    后续 _prepare 对 pdf2md.md 缺失的自然报错即旧行为。"""
    with _parse_events_lock:
        entry = _parse_events.get(doc_id)
    if entry is None:
        return True, ""
    if not entry["event"].wait(timeout):
        return False, "等待解析完成超时（30 分钟）"
    if entry["ok"]:
        return True, ""
    reason = entry["detail"] or "未知原因"
    return False, f"解析失败：{reason}"


manager = JobManager()
parse_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="parse")
pass1_pool = ThreadPoolExecutor(max_workers=STAGE_WORKERS, thread_name_prefix="pass1")
pass2_pool = ThreadPoolExecutor(max_workers=STAGE_WORKERS, thread_name_prefix="pass2")
index_pool = ThreadPoolExecutor(max_workers=STAGE_WORKERS, thread_name_prefix="index")
