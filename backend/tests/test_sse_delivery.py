"""SSE 投递链修复——离线单测（不触碰运行中后端、不写 data/app.db、不起服务）。

覆盖（2026-09-07 "实时预览流式失效"修复 + 同日 debug1 "流式直达渲染"）：
- EventBus 丢弃策略：满队列丢旧保新（新事件必达）、关键事件表命中、
  丢弃计数与 `[bus]` 分钟聚合日志、_id 单调不重、replay_after 上限=BUFFER_SIZE(4000)
  无 500 残留、unsubscribe 干净。
- 僵尸订阅者回收（routers/events.py）：queue.get 与断连轮询并行等待——
  "事件持续到达 + 连接已死"的僵尸形态在秒级被拆订（旧实现检测只在循环顶部）；
  Last-Event-ID 重放路径；aclose 清理。
- render.op 直通（liveview/tree.py，debug1：50ms 节流移除）：append/setmd 逐条
  立即发射（发射与树变更同在树锁内原子）、文本完整保序、remove/replace_all
  真源一致、flush_pending 空操作保险无补发。
- 水位线不变式（debug1）：并发 append 下 snapshot_and_watermark 的快照内容
  恰等于 _id<=水位线 事件的重放结果（无字符空洞/无重复）；get_preview
  generating 分支接线（锁内 flush→snapshot→current_id）。
- 重连重复投递去重（debug1）：订阅→重放扫描窗口内发布的事件只投递一次
  （旧实现队列+重放双份、append 翻倍）。
- 重建实验（debug1）：300 append@10ms 发射近逐条（>=290）、零滞留零丢失、
  收尾 flush 无补发。

运行：cd backend && python tests/test_sse_delivery.py   （或 pytest tests/）
"""
import asyncio
import logging
import sys
import threading
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import app.events as evmod  # noqa: E402
from app.events import BUFFER_SIZE, SUB_QUEUE_MAX, EventBus, is_critical  # noqa: E402

_passed = 0


def ok(name: str) -> None:
    global _passed
    _passed += 1
    print(f"  ok {name}")


def _drain(q) -> list:
    items = []
    while not q.empty():
        items.append(q.get_nowait())
    return items


# ---------------------------------------------------------------- EventBus
async def t1_drop_oldest_and_critical():
    print("1) EventBus：满队列丢旧保新 / 关键事件必达 / 丢弃计数")
    bus = EventBus()
    loop = asyncio.get_running_loop()
    sub = bus.subscribe(loop)
    q = sub["queue"]

    for i in range(SUB_QUEUE_MAX):
        bus.publish({"channel": "render.op", "seq": i})
    await asyncio.sleep(0.1)
    assert q.qsize() == SUB_QUEUE_MAX, q.qsize()
    ok(f"灌满队列 {SUB_QUEUE_MAX} 条")

    for i in range(50):                       # 继续灌普通事件：丢旧保新
        bus.publish({"channel": "render.op", "seq": SUB_QUEUE_MAX + i})
    bus.publish({"channel": "doc.status", "docId": "d", "status": "done"})  # 关键事件
    await asyncio.sleep(0.1)
    assert q.qsize() == SUB_QUEUE_MAX, q.qsize()          # 队列不涨（旧的被挤掉）

    items = _drain(q)
    ids = [eid for eid, _ in items]
    assert ids == sorted(ids) and len(set(ids)) == len(ids), "队列内 _id 必须单调不重"
    ok("满队列下 _id 单调不重")

    assert items[0][0] == 52, items[0][0]  # ids 1..51 被挤掉（50 普通溢出 + 关键事件到达挤 1）
    assert items[0][1]["channel"] == "render.op"
    assert items[-1][1]["channel"] == "doc.status"        # 最后发布的关键事件必达
    assert any(ev["channel"] == "doc.status" for _, ev in items)
    ok("关键事件 doc.status 必达；队头=最旧幸存者")

    assert sub["drops"] == 51, sub["drops"]               # 50 普通 + 1 关键事件挤掉的旧条
    assert sub["drops_critical"] == 0, sub["drops_critical"]  # 被挤掉的全是 render.op
    ok(f"丢弃计数：drops={sub['drops']}（关键事件 {sub['drops_critical']}）")

    # 关键性判定表
    for ch in ("doc.status", "doc.generated", "doc.paused", "doc.resumed",
               "doc.error", "doc.parsed", "index.done", "index.error",
               "export.done", "export.error", "job.started", "job.progress",
               "session.title"):
        assert is_critical(ch), ch
    for ch in ("render.op", "doc.stage", "index.progress", "chat.delta", None):
        assert not is_critical(ch), ch
    ok("关键事件常量表（含 job.*/session.* 前缀；render.op/doc.stage 非关键）")

    # 队列有空间时：关键事件 10 连发全部在队、有序
    for i in range(10):
        bus.publish({"channel": "doc.generated", "docId": f"d{i}"})
    await asyncio.sleep(0.1)
    items = _drain(q)
    crit_ids = [eid for eid, ev in items if ev["channel"] == "doc.generated"]
    assert len(crit_ids) == 10 and crit_ids == sorted(crit_ids), crit_ids
    ok("有余量时关键事件不重不漏（10/10）")

    # `[bus]` 分钟聚合日志（强制到期）
    records: list[str] = []

    class _H(logging.Handler):
        def emit(self, r):
            records.append(r.getMessage())

    h = _H()
    evmod._log.addHandler(h)
    try:
        sub["log_due"] = 0.0                  # 强制下一条投递时聚合计数
        bus.publish({"channel": "render.op"})  # 队列已空 → 正常入队不计数；先灌满
        for i in range(3):
            bus.publish({"channel": "render.op"})
        await asyncio.sleep(0.1)
        _drain(q)
        for i in range(SUB_QUEUE_MAX):
            bus.publish({"channel": "render.op"})
        await asyncio.sleep(0.1)
        bus.publish({"channel": "render.op"})  # 挤掉 1 条
        sub["log_due"] = 0.0
        bus.publish({"channel": "doc.status"})  # 关键事件到达时触发日志检查
        await asyncio.sleep(0.1)
    finally:
        evmod._log.removeHandler(h)
    assert any("[bus]" in m and "dropped" in m for m in records), records
    ok(f"[bus] 聚合日志输出：{[m for m in records if '[bus]' in m][0]!r}")

    # unsubscribe 干净
    _drain(q)                                 # 清掉日志块遗留，隔离断言
    bus.unsubscribe(sub)
    bus.publish({"channel": "render.op"})
    await asyncio.sleep(0.1)
    assert q.empty() and bus._subs == []
    ok("unsubscribe 干净（再发布不入队，订阅表清空）")


async def t2_replay_cap():
    print("2) EventBus：replay_after 上限=BUFFER_SIZE(4000)，无 500 残留")
    bus = EventBus()
    total = BUFFER_SIZE + 500                  # 4500
    for i in range(total):
        bus.publish({"channel": "render.op", "seq": i})
    r = bus.replay_after(0)
    assert len(r) == BUFFER_SIZE == 4000, len(r)
    assert r[0][0] == total - BUFFER_SIZE + 1 and r[-1][0] == total
    ok(f"重放 {len(r)} 条（保留最近 {BUFFER_SIZE}，截去前 {total - BUFFER_SIZE}）")
    r2 = bus.replay_after(total - 50)
    assert [eid for eid, _ in r2] == list(range(total - 49, total + 1))
    ok("按 Last-Event-ID 续传正确")
    import inspect
    sig = inspect.signature(EventBus.replay_after)
    assert sig.parameters["max_items"].default == BUFFER_SIZE
    ok("签名兼容：max_items 默认值=BUFFER_SIZE（500 已移除）")


# ---------------------------------------------------------- 僵尸订阅者回收
class FakeRequest:
    """鸭子类型 Request：路由只消费 headers 与 is_disconnected。"""

    def __init__(self, headers=None):
        self.headers = headers or {}
        self._dc = False
        self.checks = 0

    async def is_disconnected(self):
        self.checks += 1
        return self._dc


async def _consume_until_closed(gen) -> float:
    """持续拉取生成器（模拟 ASGI 框架逐帧发送），返回耗时（秒）。"""
    t0 = time.monotonic()
    try:
        while True:
            await gen.__anext__()
    except StopAsyncIteration:
        return time.monotonic() - t0
    finally:
        pass


async def t3_zombie_reaper():
    print("3) routers/events.py：僵尸订阅者秒级回收 / Last-Event-ID 重放 / aclose 清理")
    from app.routers import events as ev_router

    fresh = EventBus()
    old_bus = ev_router.bus
    ev_router.bus = fresh
    try:
        # 场景A：事件持续到达 + 连接已死（旧实现的僵尸形态——检测只在循环顶部时被饿死）
        req = FakeRequest()
        resp = await ev_router.events(req)
        gen = resp.body_iterator
        deadline = time.monotonic() + 10.0

        async def publish_loop():
            while time.monotonic() < deadline:
                fresh.publish({"channel": "render.op", "n": 1})
                await asyncio.sleep(0.005)

        async def set_dc():
            await asyncio.sleep(0.3)
            req._dc = True

        pub = asyncio.create_task(publish_loop())
        dc = asyncio.create_task(set_dc())
        elapsed = await _consume_until_closed(gen)
        pub.cancel()
        dc.cancel()
        with_suppress = __import__("contextlib").suppress
        with with_suppress(asyncio.CancelledError):
            await pub
        with with_suppress(asyncio.CancelledError):
            await dc
        assert elapsed < 2.5, f"断连后 {elapsed:.2f}s 才拆订（应秒级）"
        ok(f"事件流不断 + 连接死亡 → {elapsed:.2f}s 拆订（旧实现被饿死永不回收）")
        assert fresh._subs == [], "订阅表残留"
        assert req.checks >= 1
        ok(f"断连轮询生效（is_disconnected 查询 {req.checks} 次，订阅表清空）")

        # 场景B：Last-Event-ID 重放
        fresh2 = EventBus()
        ev_router.bus = fresh2
        for i in range(10):
            fresh2.publish({"channel": "render.op", "seq": i})
        req2 = FakeRequest({"Last-Event-ID": "7"})
        resp2 = await ev_router.events(req2)
        gen2 = resp2.body_iterator
        f1 = await gen2.__anext__()
        f2 = await gen2.__anext__()
        f3 = await gen2.__anext__()
        assert "id: 8" in f1 and "id: 9" in f2 and "id: 10" in f3, (f1, f2, f3)
        ok("Last-Event-ID=7 → 补发 id 8/9/10")
        await gen2.aclose()                    # 半途关闭：finally 也要拆订
        assert fresh2._subs == [], "aclose 后订阅残留"
        ok("生成器 aclose → finally 可靠 bus.unsubscribe")

        # 场景C：全新连接不重放历史（防旧状态污染）
        fresh3 = EventBus()
        ev_router.bus = fresh3
        fresh3.publish({"channel": "doc.status", "status": "generating"})
        req3 = FakeRequest()
        resp3 = await ev_router.events(req3)
        gen3 = resp3.body_iterator
        task = asyncio.create_task(gen3.__anext__())
        await asyncio.sleep(0.2)
        assert not task.done(), "全新连接不应立即产出历史帧"
        task.cancel()
        with __import__("contextlib").suppress(asyncio.CancelledError):
            await task                            # 先让生成器内的取消落地
        await gen3.aclose()
        assert fresh3._subs == []
        ok("全新连接不重放历史（last_id=current）")
    finally:
        ev_router.bus = old_bus


# ---------------------------------------------------------- render.op 直通
async def _reconstruct(fresh, sub_q, wait: float) -> tuple[list[dict], list[tuple]]:
    """等待并拉取事件，返回 (op 列表, 原始 items)。"""
    if wait:
        await asyncio.sleep(wait)
    items = _drain(sub_q)
    return [ev.get("op") for _, ev in items if ev.get("channel") == "render.op"], items


async def t4_direct_passthrough():
    print("4) liveview/tree.py：append/setmd 直通（50ms 节流移除，发射与树变更同锁原子）")
    from app.liveview.tree import LiveTree

    fresh = EventBus()
    old_bus = evmod.bus
    evmod.bus = fresh
    try:
        loop = asyncio.get_running_loop()
        sub = fresh.subscribe(loop)
        q = sub["queue"]

        tree = LiveTree("d1", "p1")
        nid = tree.insert("section", props={"title": "s"})
        ops, _ = await _reconstruct(fresh, q, 0.05)
        assert [o["op"] for o in ops] == ["insert"], ops
        ok("insert 立即发射")

        # append 逐条直通：3 次 append → 3 条事件、保序、零合并
        tree.append_md(nid, "A")
        tree.append_md(nid, "B")
        tree.append_md(nid, "C")
        ops, _ = await _reconstruct(fresh, q, 0.05)
        appends = [o for o in ops if o.get("id") == nid and o["op"] == "append"]
        assert [o["text"] for o in appends] == ["A", "B", "C"], appends
        assert tree.nodes[nid]["md"] == "ABC"
        ok("append 逐条直通发射（无 50ms 合并），文本完整保序")

        # 100 次 append → 100 条事件、全部立即发射、真源一致
        nid2 = tree.insert("section", props={"title": "s2"})
        for i in range(100):
            tree.append_md(nid2, f"t{i};")
        ops, _ = await _reconstruct(fresh, q, 0.05)
        appends = [o for o in ops if o.get("id") == nid2 and o["op"] == "append"]
        assert len(appends) == 100, len(appends)
        assert "".join(o["text"] for o in appends) == "".join(f"t{i};" for i in range(100))
        assert tree.nodes[nid2]["md"] == "".join(f"t{i};" for i in range(100))
        ok(f"100 次 append = {len(appends)} 条事件逐条发射，零丢失")

        # setmd 直通（绝对覆盖保序）
        nc = tree.insert("section")
        tree.append_md(nc, "x1")
        tree.set_md(nc, "FULL")
        ops, _ = await _reconstruct(fresh, q, 0.05)
        seq_c = [(o["op"], o.get("text", "")) for o in ops if o.get("id") == nc and o["op"] in ("append", "setmd")]
        assert seq_c == [("append", "x1"), ("setmd", "FULL")], seq_c
        assert tree.nodes[nc]["md"] == "FULL"
        ok("setmd 直通发射（绝对覆盖，客户端重放=服务端真源）")

        # remove 直通；已删节点的 append 不再外发（append_md 内部拒绝，真源一致）
        ne = tree.insert("section")
        tree.append_md(ne, "kept")
        tree.remove(ne)
        tree.append_md(ne, "after-del")
        ops, _ = await _reconstruct(fresh, q, 0.05)
        seq_e = [(o["op"], o.get("text", "")) for o in ops
                 if o.get("id") == ne and o["op"] in ("append", "remove")]
        assert seq_e == [("append", "kept"), ("remove", "")], seq_e
        ok("remove 直通；已删节点的 append 永不外发（真源一致）")

        # replace_all（回滚路径）直通
        ng = tree.insert("section")
        tree.append_md(ng, "pre")
        tree.replace_all({"root": {"id": "root", "type": "root", "parent": None,
                                   "children": [], "props": {}}})
        ops, _ = await _reconstruct(fresh, q, 0.05)
        assert any(o["op"] == "replace" for o in ops)
        ok("replace_all（回滚）直通发射全量替换")

        # flush_pending 空操作保险：直通后无补发（gen_service 收尾调用点不变）
        nf = tree.insert("section")
        tree.append_md(nf, "tail")
        ops, _ = await _reconstruct(fresh, q, 0.05)
        assert [o["text"] for o in ops if o.get("id") == nf and o["op"] == "append"] == ["tail"]
        tree.flush_pending()
        ops, items = await _reconstruct(fresh, q, 0.05)
        assert items == [], items
        ok("flush_pending 空操作保险：直通后无缓冲、无补发（收尾调用零副作用）")

        bus_check = evmod.bus
        bus_check.unsubscribe(sub)
    finally:
        evmod.bus = old_bus


# ---------------------------------------------------------- 水位线不变式（并发）
async def t5_watermark_invariant():
    print("5) 水位线不变式（并发）：快照内容 == _id<=水位线 事件的重放结果")
    from app.liveview.tree import LiveTree

    fresh = EventBus()
    old_bus = evmod.bus
    evmod.bus = fresh
    try:
        tree = LiveTree("d1", "p1")
        nid = tree.insert("section", props={"title": "s"})
        append_done = threading.Event()
        samples: list[tuple[str, int]] = []

        def appender():
            for i in range(400):
                tree.append_md(nid, f"w{i};")
                time.sleep(0.002)
            append_done.set()

        def sampler():
            # 与 append 线程并发取（快照, 水位线）——任意交错都必须满足不变式
            while not append_done.is_set():
                snap, last_id = tree.snapshot_and_watermark()
                samples.append((snap["nodes"][nid]["md"], last_id))
                time.sleep(0.001)

        th_a = threading.Thread(target=appender)
        th_s = threading.Thread(target=sampler)
        th_a.start()
        th_s.start()
        th_a.join()
        th_s.join(timeout=5.0)

        replay = fresh.replay_after(0)
        appends = [(eid, ev["op"]["text"]) for eid, ev in replay
                   if ev.get("channel") == "render.op"
                   and isinstance(ev.get("op"), dict)
                   and ev["op"].get("op") == "append" and ev["op"].get("id") == nid]
        assert len(appends) == 400, len(appends)
        assert len(samples) >= 50, f"并发采样过少（{len(samples)}），实验无效"
        for md, last_id in samples:
            expected = "".join(text for eid, text in appends if eid <= last_id)
            assert md == expected, (
                f"水位线 {last_id} 处快照 md 长度 {len(md)} != 事件重放长度 {len(expected)}")
        ok(f"并发采样 {len(samples)} 次：每次快照内容恰等于 _id<=水位线 事件的拼接"
           f"（无字符空洞/无重复）")
    finally:
        evmod.bus = old_bus


async def t6_get_preview_watermark():
    print("6) gen_service.get_preview：generating 分支锁内 flush→snapshot→current_id")
    import app.services.gen_service as gs
    from app.liveview.tree import get_or_create_session, drop_session

    fresh = EventBus()
    old_bus = evmod.bus
    old_kb = gs.kb_service

    class _KBStub:
        @staticmethod
        def raw_doc(doc_id):
            return {"id": doc_id, "kb_id": "k1", "status": "generating", "name": "doc"}

        @staticmethod
        def resolve_effective_config(d, kind):
            return {"presetId": "p1",
                    "components": {"toc": True, "summary": True, "images": True},
                    "plugins": []}

    gs.kb_service = _KBStub()
    evmod.bus = fresh
    try:
        drop_session("d-prev")
        session = get_or_create_session("d-prev", "p1")
        nid = session.tree.insert("section", props={"title": "s"})
        session.tree.append_md(nid, "abc")

        result = gs.GenService.get_preview(None, "d-prev")
        assert result["status"] == "generating"
        last_id = result["lastId"]
        md = result["tree"]["nodes"][nid]["md"]
        replay = fresh.replay_after(0)
        expected = "".join(ev["op"]["text"] for eid, ev in replay
                           if eid <= last_id and isinstance(ev.get("op"), dict)
                           and ev["op"].get("op") == "append" and ev["op"].get("id") == nid)
        assert md == expected == "abc", (md, expected)
        ok("get_preview 快照内容与 lastId 满足不变式（前端丢弃 _id<=lastId 不产生空洞）")

        session.tree.append_md(nid, "d")
        replay2 = fresh.replay_after(0)
        new_ids = [eid for eid, ev in replay2
                   if isinstance(ev.get("op"), dict) and ev["op"].get("op") == "append"
                   and ev["op"].get("text") == "d"]
        assert new_ids and new_ids[0] > last_id, (new_ids, last_id)
        ok(f"水位线后发布的 append _id={new_ids[0]} > lastId={last_id}（前端必应用，不丢）")
        drop_session("d-prev")
    finally:
        gs.kb_service = old_kb
        evmod.bus = old_bus


# ---------------------------------------------------------- 重连重复投递去重
async def t7_replay_dedup():
    print("7) routers/events.py：重连重复投递去重（订阅→重放扫描窗口内发布的事件只投一次）")
    from app.routers import events as ev_router

    fresh = EventBus()
    old_bus = ev_router.bus
    ev_router.bus = fresh
    try:
        for i in range(1, 6):
            fresh.publish({"channel": "render.op", "seq": i})    # id 1..5（断线前）
        req = FakeRequest({"Last-Event-ID": "3"})
        resp = await ev_router.events(req)          # 内部：subscribe 先行
        gen = resp.body_iterator
        # 此刻订阅已建立、重放扫描尚未跑（在 gen 首次迭代时）——发布的 id=6
        # 既进队列又被重放（旧实现会重复投递：4/5/6 + 6/7/8，append 翻倍）
        fresh.publish({"channel": "render.op", "seq": 6})

        async def next_frame():
            return await asyncio.wait_for(gen.__anext__(), timeout=2.0)

        f4, f5, f6 = await next_frame(), await next_frame(), await next_frame()
        assert "id: 4" in f4 and "id: 5" in f5 and "id: 6" in f6, (f4, f5, f6)
        ok("Last-Event-ID=3 → 重放 4/5/6（含订阅后发布的 6）")

        fresh.publish({"channel": "render.op", "seq": 7})   # 只进队列（重放已过）
        f7 = await next_frame()
        fresh.publish({"channel": "render.op", "seq": 8})
        f8 = await next_frame()
        all_ids = [int(f.split("id: ")[1].split("\n")[0]) for f in (f4, f5, f6, f7, f8)]
        assert all_ids == [4, 5, 6, 7, 8], all_ids
        ok(f"队列消费去重：{all_ids}——重叠段 id=6 只出现一次（旧实现 6×2）")
        await gen.aclose()
        assert fresh._subs == []
        ok("去重路径下 aclose 拆订干净")
    finally:
        ev_router.bus = old_bus


# ---------------------------------------------------------- 重建实验
async def t8_rebuild_experiment():
    print("8) 重建实验：300 append@10ms——发射近逐条（>=290）、零滞留零丢失、收尾无补发")
    from app.liveview.tree import LiveTree

    fresh = EventBus()
    old_bus = evmod.bus
    evmod.bus = fresh
    try:
        loop = asyncio.get_running_loop()
        sub = fresh.subscribe(loop)
        q = sub["queue"]
        tree = LiveTree("d1", "p1")
        nid = tree.insert("section", props={"title": "s"})
        await _reconstruct(fresh, q, 0.02)                 # 清掉 insert

        expected = "".join(f"chunk{i};" for i in range(300))
        t0 = time.monotonic()
        for i in range(300):
            tree.append_md(nid, f"chunk{i};")
            await asyncio.sleep(0.01)
        elapsed = time.monotonic() - t0
        ops, _ = await _reconstruct(fresh, q, 0.02)
        appends = [o for o in ops if o.get("id") == nid and o["op"] == "append"]
        assert len(appends) >= 290, f"发射 {len(appends)}/300（应近逐条）"
        assert "".join(o["text"] for o in appends) == expected
        assert tree.nodes[nid]["md"] == expected
        ok(f"300 append@10ms（耗时 {elapsed:.2f}s）发射 {len(appends)}/300 条，零丢失零合并")

        # 零滞留：最后一条 append 立即可读；收尾 flush 无补发
        tree.append_md(nid, "LAST")
        ops, _ = await _reconstruct(fresh, q, 0.02)
        last = [o for o in ops if o.get("id") == nid and o["op"] == "append"]
        assert last and last[-1]["text"] == "LAST", last
        ok("最后一条 append 立即发射（零滞留，无 50ms 尾巴）")
        tree.flush_pending()
        _, items = await _reconstruct(fresh, q, 0.05)
        assert items == [], items
        ok("收尾 flush_pending 无补发（直通后恒空）")
        bus_check = evmod.bus
        bus_check.unsubscribe(sub)
    finally:
        evmod.bus = old_bus


async def main():
    await t1_drop_oldest_and_critical()
    await t2_replay_cap()
    await t3_zombie_reaper()
    await t4_direct_passthrough()
    await t5_watermark_invariant()
    await t6_get_preview_watermark()
    await t7_replay_dedup()
    await t8_rebuild_experiment()
    print(f"\n全部通过：{_passed} 组断言")


if __name__ == "__main__":
    asyncio.run(main())
