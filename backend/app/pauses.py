"""文档级暂停/继续闸门：协作式 Event 注册表。

流水线（pass1→pass2→入库）在窗口/批次边界调用 wait(doc_id)——暂停时阻塞在
检查点上，继续后从下一窗口无缝续跑（引擎检查点保证进度不丢）。
纯内存：服务重启后任务与暂停状态一并消失。
"""
import threading

from app.events import emit

_lock = threading.RLock()                        # 可重入：start() 持锁时 _gate() 会再次申请
_active: set[str] = set()                        # 有流水线在跑（含排队）的文档
_gates: dict[str, threading.Event] = {}          # set=运行中，clear=暂停


def _gate(doc_id: str) -> threading.Event:
    with _lock:
        g = _gates.get(doc_id)
        if g is None:
            g = threading.Event()
            g.set()
            _gates[doc_id] = g
        return g


def start(doc_id: str):
    """流水线开始：登记 active（幂等）。"""
    with _lock:
        _active.add(doc_id)
        _gate(doc_id)


def finish(doc_id: str):
    """流水线结束：清理登记与闸门。"""
    with _lock:
        _active.discard(doc_id)
        _gates.pop(doc_id, None)


def wait(doc_id: str):
    """检查点闸门：暂停状态下阻塞，继续后返回。"""
    g = _gate(doc_id)
    g.wait()


def _is_zombie(doc_id: str) -> bool:
    """僵尸任务（debug3 3.3，#11）：status 声称在跑（generating/queued）但本进程
    无流水线登记 —— 任务是服务重启前遗留的持久化状态，本进程永远不会续跑。
    （启动恢复 recover_stale_status 会把这类状态清成 ready；此检查兜底覆盖
    恢复未生效/清库外的窗口。）惰性导入 kb_service 避免循环依赖。"""
    if doc_id in _active:
        return False
    try:
        from app.services import kb_service
        d = kb_service.raw_doc(doc_id)
    except Exception:  # noqa: BLE001
        return False
    return bool(d) and d.get("status") in ("generating", "queued")


def pause(doc_id: str) -> str:
    """暂停。返回 "ok"（已暂停）/"zombie"（服务曾重启，任务已丢失）/
    "inactive"（无进行中任务）。"""
    with _lock:
        g = _gates.get(doc_id)
        if doc_id not in _active or g is None or not g.is_set():
            return "zombie" if _is_zombie(doc_id) else "inactive"
        g.clear()
    emit("doc.paused", docId=doc_id)
    return "ok"


def resume(doc_id: str) -> str:
    """继续。返回值语义同 pause（幂等：未暂停也返回 "ok" 并发事件，便于前端对齐）。"""
    with _lock:
        g = _gates.get(doc_id)
        if doc_id not in _active or g is None:
            return "zombie" if _is_zombie(doc_id) else "inactive"
        was_paused = not g.is_set()
        g.set()
    if was_paused:
        emit("doc.resumed", docId=doc_id)
    return "ok"


def is_paused(doc_id: str) -> bool:
    with _lock:
        g = _gates.get(doc_id)
        return doc_id in _active and g is not None and not g.is_set()
