"""SSE 事件流路由：GET /api/events（Last-Event-ID 重放）。

2026-09-07 修复"僵尸订阅者"：旧实现断连检测只在循环顶部——连接卡在
`queue.get()` 上且事件持续到达时 `request.is_disconnected()` 永不执行，
死连接的队列持续被投递（满后按总线丢旧保新策略空转吞事件），永不回收。
现改为 **queue.get 与断连轮询并行等待**（asyncio.wait + FIRST_COMPLETED）：
断连侧每秒轮询一次，任一完成即清理另一方并退出——卡死连接秒级拆订；
finally 里可靠 bus.unsubscribe（任何退出路径都执行）。
"""
import asyncio
import json
from contextlib import suppress

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.events import bus

router = APIRouter(prefix="/api", tags=["events"])

DC_POLL_INTERVAL = 1.0     # 断连轮询间隔（秒）——卡死连接秒级拆订
QUEUE_GET_TIMEOUT = 15.0   # 队列等待超时（秒）——期间发 keep-alive 注释帧


def _frame(eid: int, ev: dict) -> str:
    return (f"id: {eid}\nevent: {ev.get('channel', 'message')}"
            f"\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n")


@router.get("/events")
async def events(request: Request):
    header = request.headers.get("Last-Event-ID")
    if header and header.isdigit():
        last_id = int(header)          # 重连：补发断线期间的事件
    else:
        last_id = bus.current_id()     # 全新连接：不重放历史（旧状态事件会污染新页面）

    loop = asyncio.get_running_loop()
    sub = bus.subscribe(loop)

    async def _poll_disconnect():
        while True:
            if await request.is_disconnected():
                return
            await asyncio.sleep(DC_POLL_INTERVAL)

    async def _read_one():
        """读一条事件；15s 无事件返回 keep-alive 标记。"""
        try:
            eid, ev = await asyncio.wait_for(sub["queue"].get(), timeout=QUEUE_GET_TIMEOUT)
            return ("ev", eid, ev)
        except asyncio.TimeoutError:
            return ("ka",)

    async def gen():
        read_task: asyncio.Task | None = None
        poll_task = asyncio.create_task(_poll_disconnect())
        try:
            # 重连重复投递去重（2026-09-07 debug1）：订阅在上方先行、重放扫描在
            # 此——两次操作之间发布的事件既进队列又被重放（insert 幂等、append
            # 会被前端翻倍）。记录重放最大 _id，队列消费时丢弃 _id <= 该值的
            # 事件（_id 全局单调；重放段与队列段的重叠恰为"订阅→扫描"窗口，
            # 该窗口内的队列事件必在重放集合里，丢弃不漏）。备选方案"把重放
            # 扫描移到 subscribe 之前"会引入真空洞（重放扫描与订阅之间发布的
            # 事件既不在重放结果里也不在队列里），故弃用。
            replay = bus.replay_after(last_id)
            replay_max = replay[-1][0] if replay else last_id
            for eid, ev in replay:
                yield _frame(eid, ev)
            while True:
                read_task = asyncio.create_task(_read_one())
                done, _ = await asyncio.wait({read_task, poll_task},
                                             return_when=asyncio.FIRST_COMPLETED)
                if poll_task.done():
                    break              # 断连：立即拆订退出（读侧任务在 finally 取消）
                kind, *rest = read_task.result()
                if kind == "ka":
                    yield ": keep-alive\n\n"
                else:
                    eid, ev = rest
                    if eid <= replay_max:
                        continue       # 重放已覆盖：去重（防 append 翻倍）
                    yield _frame(eid, ev)
        finally:
            if read_task is not None:
                read_task.cancel()
            poll_task.cancel()
            bus.unsubscribe(sub)       # 可靠拆订：断连/异常/正常结束全覆盖
            for t in (read_task, poll_task):
                if t is not None:
                    with suppress(BaseException):
                        await t

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
