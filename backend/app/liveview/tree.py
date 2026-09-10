"""LiveTree：服务端权威组件树 + render.op 事件 + 快照/回滚。

render.op 发射（2026-09-07 debug1：append 直通）：
append_md/set_md 直接 `self._op(...)`——**发射与树变更同在 `_lock` 临界区内
原子完成**（insert/update/remove/replace_all 同理）。这既是"LLM 输出流直达
渲染"的目标本身，也是 `snapshot_and_watermark()` 水位线不变式的前提。

此前的 50ms 节流（`_op_tx`/`_tx_flush`/TX_WINDOW，(会话,节点) 滚动窗口合并）
经离线实验证伪了"滚动防抖"假说后移除：实验实测 Timer 只建一次不随事件重置、
300 条 append@10ms 滞留上限 ~79ms、零丢失——节流层并非滚动体验的必要条件，
却给流式输出加了固定延迟；且逐行 append 速率与 chat 逐 token 同级，
2000 深队列 + 丢旧保新（events.py）足够承载。
`flush_pending()` 保留为**空操作保险**（生成收尾调用点不变；若未来重新引入
任何缓冲层，此处是收尾强制落地点，且已并入 snapshot_and_watermark 临界区）。
"""
import copy
import threading

from app.events import current_event_id, emit


class LiveTree:
    """单个文档的实时渲染组件树。所有变更发 render.op 事件。"""

    def __init__(self, doc_id: str, preset_id: str, base: str = "live"):
        self.doc_id = doc_id
        self.preset_id = preset_id
        self.base = base          # live | artifact
        self.nodes: dict[str, dict] = {
            "root": {"id": "root", "type": "root", "parent": None,
                     "children": [], "props": {}}}
        self._counter = 0
        self._lock = threading.Lock()

    # ---------------- 基础操作 ----------------
    def _new_id(self, prefix: str) -> str:
        self._counter += 1
        return f"{prefix}{self._counter}"

    def _op(self, op: dict):
        emit("render.op", docId=self.doc_id, presetId=self.preset_id, op=op)

    def flush_pending(self):
        """空操作保险（2026-09-07 debug1 起恒为空）：append/setmd 已直通发射，
        无缓冲可言。保留签名让 gen_service 生成收尾的调用点不变；若未来重新
        引入缓冲层，收尾 flush 已并入 snapshot_and_watermark 的树锁临界区。"""

    def insert(self, node_type: str, parent: str = "root", after: str | None = None,
               props: dict | None = None, node_id: str | None = None) -> str:
        with self._lock:
            nid = node_id or self._new_id(node_type[0] if node_type != "toc_entry" else "te")
            parent_node = self.nodes.get(parent) or self.nodes["root"]
            children = parent_node["children"]
            if after and after in children:
                children.insert(children.index(after) + 1, nid)
            else:
                children.append(nid)
            self.nodes[nid] = {"id": nid, "type": node_type, "parent": parent_node["id"],
                               "children": [], "props": props or {}, "md": ""}
            self._op({"op": "insert", "id": nid, "type": node_type,
                      "parent": parent_node["id"], "props": props or {}})
        return nid

    def update(self, node_id: str, props: dict):
        with self._lock:
            node = self.nodes.get(node_id)
            if node is None:
                return
            node["props"].update(props)
            self._op({"op": "update", "id": node_id, "props": props})

    def append_md(self, node_id: str, text: str):
        if not text:
            return
        with self._lock:
            node = self.nodes.get(node_id)
            if node is None:
                return
            node["md"] = node.get("md", "") + text
            self._op({"op": "append", "id": node_id, "text": text})

    def set_md(self, node_id: str, text: str):
        with self._lock:
            node = self.nodes.get(node_id)
            if node is None:
                return
            node["md"] = text
            self._op({"op": "setmd", "id": node_id, "text": text})

    def remove(self, node_id: str):
        with self._lock:
            node = self.nodes.pop(node_id, None)
            if node is None:
                return
            parent = self.nodes.get(node["parent"])
            if parent and node_id in parent["children"]:
                parent["children"].remove(node_id)
            # 级联删除子节点
            for cid in list(node.get("children", [])):
                self.nodes.pop(cid, None)
            self._op({"op": "remove", "id": node_id})

    def replace_all(self, nodes: dict):
        """全量替换（回滚 / 产物快照替换实时树）。"""
        with self._lock:
            self.nodes = copy.deepcopy(nodes)
            self._op({"op": "replace", "nodes": copy.deepcopy(self.nodes)})

    # ---------------- 快照 / 回滚 ----------------
    def snapshot_nodes(self) -> dict:
        with self._lock:
            return copy.deepcopy(self.nodes)

    def snapshot(self) -> dict:
        with self._lock:
            return {"docId": self.doc_id, "presetId": self.preset_id,
                    "base": self.base, "nodes": copy.deepcopy(self.nodes)}

    def snapshot_and_watermark(self) -> tuple[dict, int]:
        """生成中预览专用：快照 + 事件水位线（原子，水位线不变式）。

        不变式：**快照内容 == 已发布且 _id <= 返回水位线 的事件重放结果**。
        append/setmd 等所有树 op 的 变更与发射 同在 `_lock` 内原子完成，本方法
        持同一把锁先 deepcopy 快照、再读 `bus.current_id()`——两步之间不可能
        插入任何树 op，因此：
        - 读水位线前已发布的 op（_id <= 水位线）其变更必然已落入快照——前端
          按水位线丢弃这些事件不会产生字符空洞；
        - 快照里已有的变更其发射必然发生在本临界区获锁之前（_id 严格更小）——
          前端不会因 _id > 水位线而二次应用造成重复。
        旧实现"先 snapshot() 后 bus.current_id()"两步之间发布的 append 既不在
        快照里、又被前端按 _id <= lastId 丢弃——字符级永久空洞
        （2026-09-07 debug1 根除；并发不变式见 tests/test_sse_delivery.py t5）。
        """
        with self._lock:
            self.flush_pending()   # 空操作保险（有缓冲层的未来实现也在此收尾）
            snap = {"docId": self.doc_id, "presetId": self.preset_id,
                    "base": self.base, "nodes": copy.deepcopy(self.nodes)}
            return snap, current_event_id()


class LiveSession:
    """一个文档的实时渲染会话：树 + 解析器 + 状态快照（回滚用）。

    回滚策略：优先恢复到最近的"完整块闭合"恢复点（检查点保留了已完成
    @@ 块的视觉状态）；无恢复点时退回窗口边界快照。
    """

    def __init__(self, doc_id: str, preset_id: str):
        self.tree = LiveTree(doc_id, preset_id, base="live")
        self.p1: "Pass1StreamParser | None" = None
        self.p2: "Pass2StreamParser | None" = None
        self._window_ckpt: tuple | None = None      # (tree_nodes, parser_state)
        self._recovery: list[tuple] = []            # [(tree_nodes, parser_state)]

    # ---------- 快照 / 回滚 ----------
    def _snapshot_pair(self) -> tuple:
        st = (self.p1.state_snapshot() if self.p1
              else self.p2.state_snapshot() if self.p2 else None)
        return (self.tree.snapshot_nodes(), st)

    def checkpoint(self):
        """窗口边界快照（供检查点回滚兜底）。"""
        self._window_ckpt = self._snapshot_pair()
        self._recovery = []

    def add_recovery_point(self):
        """完整 @@ 块闭合时的恢复点。"""
        self._recovery.append(self._snapshot_pair())

    def rollback(self):
        pair = self._recovery[-1] if self._recovery else self._window_ckpt
        if pair is None:
            return
        nodes, st = pair
        self.tree.replace_all(nodes)
        if st is not None and self.p1 is not None:
            self.p1.restore_state(st)
        elif st is not None and self.p2 is not None:
            self.p2.restore_state(st)

    # ---------- pass1 ----------
    def begin_pass1(self, files_base: str, show_toc: bool, show_images: bool,
                    doc_title: str | None = None):
        """doc_title（debug3 3.5）：pass1 开始时先插 type='title' 节点（parent=root、
        位于 toc 之前），props.title=旧 meta 标题或文档名占位；pass1 流式输出的
        @@title 块闭合时由解析器 update 该节点（pass1 第一屏即见标题）。"""
        from app.liveview.parser import Pass1StreamParser
        self.tree.replace_all({"root": {"id": "root", "type": "root", "parent": None,
                                        "children": [], "props": {}}})
        if doc_title:
            self.tree.insert("title", parent="root", props={"title": doc_title})
        self.p1 = Pass1StreamParser(self.tree, files_base,
                                     show_toc=show_toc, show_images=show_images,
                                     on_recovery_point=self.add_recovery_point)

    # ---------- pass2 ----------
    def begin_pass2(self, tree_nodes: dict, files_base: str, enabled_plugins: set[str]):
        """pass2 以 organized 产物树为基底（若实时树已有则保留）。"""
        from app.liveview.parser import Pass2StreamParser
        if self.p1 is None:
            # pass1 被跳过：从产物构建基底
            self.tree.replace_all(tree_nodes)
        self.p2 = Pass2StreamParser(self.tree, enabled_plugins,
                                    on_recovery_point=self.add_recovery_point)


# 全局注册表：doc_id -> LiveSession（生成中的文档才有）
live_sessions: dict[str, LiveSession] = {}
_sessions_lock = threading.Lock()


def get_or_create_session(doc_id: str, preset_id: str) -> LiveSession:
    with _sessions_lock:
        s = live_sessions.get(doc_id)
        if s is None or s.tree.preset_id != preset_id:
            s = LiveSession(doc_id, preset_id)
            live_sessions[doc_id] = s
        return s


def drop_session(doc_id: str):
    with _sessions_lock:
        live_sessions.pop(doc_id, None)
