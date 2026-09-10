"""事件总线与 SSE Hub。

- EventBus（线程安全）：任意线程 publish；订阅者分两类——
  * 同步回调（服务端内部，如 liveview 服务端 fold）；
  * 每客户端 asyncio.Queue（投递到 SSE 订阅者的事件循环，
    用 loop.call_soon_threadsafe 保证跨线程安全）。
- 投递丢弃策略（2026-09-07 修复"实时预览流式失效"）：订阅者队列满时不再静默
  丢弃（旧实现 QueueFull 直接异常消失，实测 5.2 万次丢事件），改为
  **丢旧保新**——弹出最旧一条腾位保证新事件必达；被挤掉的旧事件按
  关键性计数，每订阅者每分钟聚合打一行 `[bus]` 日志。
- 关键事件表（CRITICAL_*）：doc.status / doc.generated / doc.paused /
  doc.resumed / doc.error / doc.parsed / index.done / index.error /
  export.done / export.error 及 job.* / session.* 前缀——状态类一次性事件，
  丢失会让前端卡在旧状态（必须手动刷新），满队列时同样丢旧保新腾位送达。
- render.op 直通（2026-09-07 debug1）：append/setmd 在 liveview/tree.py 生成端
  逐条直达发射（发射与树变更同在树锁内原子完成），总线本身不缓存。
- 环形缓冲：全局保留最近 BUFFER_SIZE 条，SSE 重连时按 Last-Event-ID 重放
  （上限=BUFFER_SIZE，2026-09-07 起不再 500 截断造成补发空洞；重放正确性
  由前端 onopen resync 快照兜底）。
"""
import asyncio
import logging
import threading
import time
from collections import deque

BUFFER_SIZE = 4000
SUB_QUEUE_MAX = 2000        # 每订阅者队列上限（投递层丢旧保新的触发阈值）
DROP_LOG_INTERVAL = 60.0    # 丢弃计数聚合日志间隔（秒），避免刷屏

# 关键事件：满队列时也必须送达（丢旧保新腾位）。精确通道名 + 前缀两类。
CRITICAL_CHANNELS = frozenset({
    "doc.status", "doc.generated", "doc.paused", "doc.resumed",
    "doc.error", "doc.parsed",
    "index.done", "index.error",
    "export.done", "export.error",
})
CRITICAL_PREFIXES = ("job.", "session.")

_log = logging.getLogger("docassistant.bus")


def is_critical(channel: str | None) -> bool:
    """按通道名/前缀判关键性（唯一判据，集中在这张表）。"""
    if not channel:
        return False
    return channel in CRITICAL_CHANNELS or channel.startswith(CRITICAL_PREFIXES)


def _maybe_log_drops(sub: dict) -> None:
    """每订阅者丢弃计数按分钟聚合打日志（在订阅者事件循环线程内调用）。"""
    now = time.monotonic()
    if now < sub["log_due"]:
        return
    sub["log_due"] = now + DROP_LOG_INTERVAL
    drops, crit = sub["drops"], sub["drops_critical"]
    if drops:
        _log.warning("[bus] subscriber dropped %d（关键事件 %d）", drops, crit)
        sub["drops"] = 0
        sub["drops_critical"] = 0


class EventBus:
    def __init__(self):
        self._lock = threading.Lock()
        self._subs: list[dict] = []          # {queue, loop, id, drops, drops_critical, log_due}
        self._next_id = 0
        self._buffer = deque(maxlen=BUFFER_SIZE)  # [(id, event_dict)]
        self._raw = threading.local()       # 同步回调（同线程 fold 用）

    # ---------------- 发布 ----------------
    def publish(self, event: dict) -> int:
        with self._lock:
            self._next_id += 1
            eid = self._next_id
            ev = {**event, "_id": eid}
            item = (eid, ev)
            self._buffer.append(item)
            subs = list(self._subs)
        for sub in subs:
            q, loop = sub["queue"], sub["loop"]
            try:
                loop.call_soon_threadsafe(self._deliver, sub, item)
            except RuntimeError:  # 事件循环已关闭
                pass
        return eid

    @staticmethod
    def _deliver(sub: dict, item: tuple) -> None:
        """投递回调（在订阅者事件循环线程内串行执行，队列操作无竞争）。

        满队列：丢旧保新——弹出最旧一条腾位后重投。普通事件丢旧保新避免
        队列被历史塞死；关键事件（is_critical）同样必达。被挤掉的旧事件
        按其关键性计数，分钟聚合打 `[bus]` 日志。
        """
        q = sub["queue"]
        try:
            q.put_nowait(item)
        except asyncio.QueueFull:
            try:
                dropped = q.get_nowait()      # 弹最旧一条腾位
            except asyncio.QueueEmpty:
                dropped = None
            try:
                q.put_nowait(item)            # 刚弹一条，必能放入
            except asyncio.QueueFull:
                pass
            if dropped is not None:
                sub["drops"] += 1
                if is_critical(dropped[1].get("channel")):
                    sub["drops_critical"] += 1
        _maybe_log_drops(sub)

    def current_id(self) -> int:
        with self._lock:
            return self._next_id

    # ---------------- 订阅（SSE 客户端） ----------------
    def subscribe(self, loop: asyncio.AbstractEventLoop):
        q: asyncio.Queue = asyncio.Queue(maxsize=SUB_QUEUE_MAX)
        sub = {"queue": q, "loop": loop, "id": id(q),
               "drops": 0, "drops_critical": 0,
               "log_due": time.monotonic() + DROP_LOG_INTERVAL}
        with self._lock:
            self._subs.append(sub)
        return sub

    def unsubscribe(self, sub: dict) -> None:
        with self._lock:
            try:
                self._subs.remove(sub)
            except ValueError:
                pass

    def replay_after(self, last_id: int, max_items: int = BUFFER_SIZE):
        """重放 id > last_id 的缓冲事件（断线重连；上限=BUFFER_SIZE，
        不再 500 截断——曾造成重连补发空洞，正确性另由前端 onopen
        resync 快照兜底）。"""
        with self._lock:
            items = [(eid, ev) for eid, ev in self._buffer if eid > last_id]
        return items[:max_items]


bus = EventBus()


def emit(channel: str, **data) -> int:
    """便捷发布：事件 = {channel, ts, **data}。"""
    ev = {"channel": channel, "ts": time.time(), **data}
    return bus.publish(ev)


def current_event_id() -> int:
    """便捷读取当前全局事件水位线（经模块级函数动态解析 bus，
    与 emit 同模式——单测可整体替换 bus 实例）。"""
    return bus.current_id()


# ---------- 通道命名 ----------
# job.*      任务生命周期/进度（type: started|progress|done|failed, job_id, kind, doc_id, ...）——关键
# doc.*      文档状态变更（doc_id, status；doc.stage 为高频进度，非关键）
# render.*   实时渲染树操作（doc_id, ...，见 liveview；高频，满队列丢旧保新）
# chat.*     聊天流（session_id, type: delta|reasoning|tool_call|citations|done；POST SSE 直推不经总线）
# session.*  会话级广播（session.title 等）——关键
# index.*    入库进度（doc_id, progress；done/error 关键）
# export.*   导出完成（doc_id, kind: md|pdf, path/download_url）——关键
