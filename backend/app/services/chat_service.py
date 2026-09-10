"""助手聊天：三模式（chat / query / automatic）+ RAG 检索 + ①引用。

流式帧（SSE，2026-09 步骤2 起带分段序号）：
    {"type":"session","sessionId","title"}
    {"type":"delta","content","seg"}            正文增量（seg=正文段下标）
    {"type":"reasoning","content","seg"}        思维链增量（seg=思考段下标）
    {"type":"citations","citations"}            检索条目（①②…，可能多次追加）
    {"type":"tool_call","name","arguments","seg","callId"}
    {"type":"tool_result","name","result","seg","callId","fragments"}
    {"type":"done","messageId","sessionId","citations","stopped"?}
    {"type":"error","detail"}

分段模型：助手消息按发生顺序交错为 thinking/tool/text 段（messages.segments JSON），
SSE 帧的 seg 指向段下标；工具结果按 tool_call 的 id（callId）回填，附带结构化
fragments（片段序号 n 即步骤3 引用协议的基础）。

停止/断连：路由层把 _impl 桥接为 async 生成器；客户端断开时 uvicorn 触发
http.disconnect / 任务取消 → 路由调 ChatStream.abort() → worker 在下一次 emit
抛 _ChatAborted（BaseException，绕过 llm._consume 对 on_delta 异常的吞咽）→
finally 保存已生成部分（stopped=1）。
"""
import asyncio
import json
import threading
import time
import traceback
import uuid

import openai

from app import db, websearch
from app.events import emit
from app.rag import vectorstore
from app.rag.retriever import retrieve
from app.services import kb_service, settings_service
from engine.config import log
from engine.llm import LLMClient, TOOLS_SPEC

MODES = ("chat", "query", "automatic")
MAX_TOOL_ROUNDS = 5

PERSONA = "你是文档助手，基于知识库中的资料回答用户问题。"
# 步骤3 引用协议：模型写 [[c:N]]（N=参考资料/工具片段的编号），前端渲染为行内①
CITE_RULE = ("回答中参考了检索条目或工具片段时，必须在对应句子末尾写引用标记 "
             "[[c:N]]（N 为该条目的编号数字，如 [[c:1]]、[[c:2]]，前端会渲染为①②…）；"
             "不要虚构条目，未参考则不写任何标记。")
# 步骤4：会话开启联网搜索时的系统提示词补充
WEB_HINT = ("你还可以调用 web_search（联网搜索）/web_fetch（读取网页）工具获取互联网资料"
            "（时效性问题、知识库未覆盖的常识/事实）；引用工具返回的片段时按 [[c:N]] 协议标注"
            "（N=片段编号）；工具返回错误消息时基于已有知识继续，不要提及工具失败细节。")
REFUSAL = "知识库中没有找到与这个问题相关的信息。"

TITLE_PROMPT = ("为以下用户提问生成一个简洁的对话标题。要求：直接输出标题本身；"
                "不超过 20 个字；不加引号、句号或任何前后缀；不要回答问题本身。\n\n用户提问：")


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _uid():
    return uuid.uuid4().hex[:12]


class _ChatAborted(BaseException):
    """客户端断开/前端停止：从 emit 抛出并贯穿 LLM 流式消费，触发部分保存。"""


# ============================ 分段（segments） ============================

class _Segments:
    """一次助手消息生成期间按时间序维护 thinking/tool/text 交错段。"""

    def __init__(self):
        self.list: list[dict] = []

    def _append(self, seg: dict) -> int:
        self.list.append(seg)
        return len(self.list) - 1

    def add_thinking(self, delta: str) -> int:
        if self.list and self.list[-1]["kind"] == "thinking":
            self.list[-1]["text"] += delta
            return len(self.list) - 1
        return self._append({"kind": "thinking", "text": delta})

    def add_text(self, delta: str) -> int:
        if self.list and self.list[-1]["kind"] == "text":
            self.list[-1]["text"] += delta
            return len(self.list) - 1
        return self._append({"kind": "text", "text": delta})

    def open_tool(self, call_id: str, name: str, args) -> int:
        return self._append({"kind": "tool", "callId": call_id, "name": name,
                             "args": args, "result": "", "fragments": []})

    def fill_tool(self, call_id: str, result: str, fragments: list) -> bool:
        for seg in reversed(self.list):
            if seg["kind"] == "tool" and seg.get("callId") == call_id:
                seg["result"] = result
                seg["fragments"] = fragments
                return True
        return False


def _load_segments(r) -> list:
    """读取消息分段；旧消息无 segments 时读时迁移（thinking→tool→text，现状渲染顺序）。"""
    try:
        segs = json.loads(r["segments"] or "[]")
    except (json.JSONDecodeError, TypeError):
        segs = []
    if not isinstance(segs, list) or not segs:
        segs = []
        if r["reasoning"]:
            segs.append({"kind": "thinking", "text": r["reasoning"]})
        for i, tc in enumerate(json.loads(r["tool_calls"] or "[]")):
            segs.append({"kind": "tool", "callId": tc.get("callId") or tc.get("id") or f"legacy-{i}",
                         "name": tc.get("name", ""), "args": tc.get("arguments"),
                         "result": tc.get("result", ""), "fragments": []})
        if r["content"]:
            segs.append({"kind": "text", "text": r["content"]})
    return segs


# ============================ 会话 ============================

def list_sessions() -> list[dict]:
    rows = db.get().execute("SELECT * FROM sessions ORDER BY updated_at DESC").fetchall()
    out = []
    for r in rows:
        out.append({
            "id": r["id"], "title": r["title"],
            "mode": r["mode"] or "chat", "model": r["model"],
            "kbIds": json.loads(r["kb_ids"] or "[]"),
            "webSearch": bool(r["web_search"]) if "web_search" in r.keys() else False,
            "createdAt": r["created_at"], "updatedAt": r["updated_at"],
        })
    return out


def create_session(title: str = "新会话") -> dict:
    sid = _uid()
    conn = db.get()
    conn.execute("INSERT INTO sessions (id, title, mode, model, kb_ids, created_at, updated_at)"
                 " VALUES (?,?,?,NULL,'[]',?,?)", (sid, title, "chat", _now(), _now()))
    conn.commit()
    return {"id": sid, "title": title, "createdAt": _now(), "updatedAt": _now()}


def rename_session(sid: str, title: str):
    conn = db.get()
    conn.execute("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
                 (title, _now(), sid))
    conn.commit()


def update_session(sid: str, fields: dict):
    """部分更新会话（title/mode/model/kbIds/webSearch 任意子集，路由传 exclude_unset 后的显式键）。"""
    sets, params = [], []
    if "title" in fields:
        sets.append("title = ?")
        params.append(fields["title"])
    if "mode" in fields:
        sets.append("mode = ?")
        params.append(fields["mode"] if fields["mode"] in MODES else "chat")
    if "model" in fields:
        sets.append("model = ?")
        params.append(fields["model"] or None)
    if "kbIds" in fields:
        sets.append("kb_ids = ?")
        params.append(json.dumps(fields["kbIds"] or [], ensure_ascii=False))
    if "webSearch" in fields:
        sets.append("web_search = ?")
        params.append(1 if fields["webSearch"] else 0)
    if sets:
        params.append(sid)
        conn = db.get()
        conn.execute(f"UPDATE sessions SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()


def _save_session_settings(sid: str, *, mode: str, model, kb_ids: list,
                           web_search: bool = False):
    """每次发送即持久化该会话当前的 模式/模型/知识库/联网开关（步骤2/步骤4）。"""
    conn = db.get()
    conn.execute("UPDATE sessions SET mode = ?, model = ?, kb_ids = ?, web_search = ?"
                 " WHERE id = ?",
                 (mode if mode in MODES else "chat", model or None,
                  json.dumps(kb_ids or [], ensure_ascii=False),
                  1 if web_search else 0, sid))
    conn.commit()


def delete_session(sid: str):
    conn = db.get()
    conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
    conn.commit()


def get_messages(sid: str) -> list[dict]:
    rows = db.get().execute(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid",
        (sid,)).fetchall()
    out = []
    for r in rows:
        out.append({
            "id": r["id"], "sessionId": r["session_id"], "role": r["role"],
            "content": r["content"], "reasoning": r["reasoning"],
            "toolCalls": json.loads(r["tool_calls"] or "[]"),
            "citations": json.loads(r["citations"] or "[]"),
            "kbIds": json.loads(r["kb_ids"] or "[]"),
            "model": r["model"], "mode": r["mode"],
            "segments": _load_segments(r), "stopped": bool(r["stopped"]),
            "createdAt": r["created_at"],
        })
    return out


def _save_message(sid, role, *, content="", reasoning="", tool_calls=None,
                  citations=None, kb_ids=None, model="", mode="chat",
                  segments=None, stopped=False):
    mid = _uid()
    conn = db.get()
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls,"
        " citations, kb_ids, model, mode, segments, stopped, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (mid, sid, role, content, reasoning,
         json.dumps(tool_calls or [], ensure_ascii=False),
         json.dumps(citations or [], ensure_ascii=False),
         json.dumps(kb_ids or [], ensure_ascii=False), model, mode,
         json.dumps(segments or [], ensure_ascii=False),
         1 if stopped else 0, _now()))
    conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (_now(), sid))
    conn.commit()
    return mid


# ============================ 流控制器 ============================

class ChatStream:
    """一次生成的流控制器：worker 线程跑 _impl，帧经事件循环桥到 asyncio.Queue。

    断连传播（2026-09-05 实验定稿）：uvicorn 0.51 + starlette 1.3.1（ASGI spec 2.3）
    下同步生成器不会收到 GeneratorExit（GC 不可靠）——必须用 async 生成器 + 
    receive() 监听 / 任务取消双通道。路由层检测到断开即调 abort()；worker 在
    下一次 emit 时抛 _ChatAborted，finally 保存已生成部分（stopped=1）。
    """

    def __init__(self, payload: dict, *, save_user: bool = True):
        self.payload = payload
        self.save_user = save_user
        self.q: asyncio.Queue = asyncio.Queue()
        self.cancelled = threading.Event()
        self.loop = asyncio.get_running_loop()
        self.run: dict = {}
        self._finished = False
        threading.Thread(target=self._worker, daemon=True, name="chat").start()

    # ---- worker 线程侧 ----
    def _emit(self, frame: dict):
        if self.cancelled.is_set():
            raise _ChatAborted()
        self._async_put(frame)

    def _async_put(self, frame: dict):
        """跨线程投递帧（asyncio.Queue 仅在事件循环线程操作）。"""
        try:
            self.loop.call_soon_threadsafe(self._put, frame)
        except RuntimeError:
            pass  # 事件循环已关闭（进程退出）

    def _put(self, frame: dict):
        # 无条件入队：即使 _finished（消费者已离开）也不丢弃——
        # call_soon_threadsafe 的回调可能在 worker 置 _finished 之后才执行，
        # 若在此丢弃会导致消费者在 q.get() 上永久等待（空帧竞态，实测踩坑）。
        self.q.put_nowait(frame)

    def _worker(self):
        try:
            _impl(self.payload, self._emit, self.run, save_user=self.save_user)
        except _ChatAborted:
            log("[chat] 客户端断开/停止，保存已生成部分")
        except Exception as e:  # noqa: BLE001
            log(f"[chat] ❌ {type(e).__name__}: {e}")
            traceback.print_exc()
            try:
                self._emit({"type": "error", "detail": f"{type(e).__name__}: {e}"})
            except Exception:  # noqa: BLE001
                pass
        finally:
            if self.cancelled.is_set():
                _save_partial(self.run)
                self._async_put({"type": "done", "messageId": self.run.get("message_id"),
                                 "sessionId": self.run.get("session_id"),
                                 "citations": self.run.get("citations") or [],
                                 "stopped": True})
            self._finished = True
            self._async_put(None)

    # ---- 事件循环侧（路由层调用） ----
    async def next(self) -> dict | None:
        return await self.q.get()

    def abort(self):
        """客户端断开：置取消标记并唤醒消费循环；worker 在下次 emit 中止。"""
        if self._finished or self.cancelled.is_set():
            return
        self.cancelled.set()
        try:
            self.q.put_nowait(None)
        except Exception:  # noqa: BLE001
            pass


def start_chat(payload: dict) -> ChatStream:
    return ChatStream(payload, save_user=True)


def _save_partial(run: dict):
    if run.get("saved") or not run.get("session_id"):
        return
    run["saved"] = True
    run["message_id"] = _save_message(
        run["session_id"], "assistant", content=run.get("content", ""),
        reasoning=run.get("reasoning", ""), tool_calls=run.get("tool_calls") or [],
        segments=run.get("segments") or [], citations=run.get("citations") or [],
        kb_ids=run.get("kb_ids") or [], model=run.get("model", ""),
        mode=run.get("mode", "chat"), stopped=True)
    log(f"[chat] 已保存停止点消息 {run['message_id']}（content {len(run.get('content', ''))} 字）")


# ============================ 主流程 ============================

def _impl(p: dict, emit, run: dict, *, save_user: bool = True):
    content = (p.get("content") or "").strip()
    if not content:
        emit({"type": "error", "detail": "消息为空"})
        return
    mode = p.get("mode") if p.get("mode") in MODES else "chat"
    kb_ids = list(p.get("kbIds") or [])
    if "*" in kb_ids:
        kb_ids = [k["id"] for k in kb_service.list_kbs()]
    # 会话级联网开关（步骤4）：仅 chat/automatic 生效；query 模式忽略
    web_on = bool(p.get("webSearch")) and mode in ("chat", "automatic")
    session_id = p.get("sessionId")
    session = None
    if session_id:
        row = db.get().execute("SELECT * FROM sessions WHERE id = ?",
                               (session_id,)).fetchone()
        session = dict(row) if row else None
    if session is None:
        session = create_session(content[:24] or "新会话")
    session_id = session["id"]
    emit({"type": "session", "sessionId": session_id, "title": session["title"]})

    model_cfg = settings_service.resolve_model(p.get("model"), "assistant")
    llm = LLMClient(**model_cfg)
    # run：停止/断连时部分保存所需的最小状态（segments/citations 由引用共享）
    run.update(session_id=session_id, model=model_cfg["model"], mode=mode,
               kb_ids=kb_ids, content="", reasoning="", tool_calls=[],
               citations=[], segments=[], saved=False)
    if save_user:
        _save_message(session_id, "user", content=content, kb_ids=kb_ids,
                      model=model_cfg["model"], mode=mode)
    _save_session_settings(session_id, mode=mode, model=p.get("model"), kb_ids=kb_ids,
                           web_search=bool(p.get("webSearch")))

    # ---------- 检索（automatic 模式交给模型自主检索，不预注入） ----------
    hits = []
    if kb_ids and mode != "automatic":
        try:
            embed_cfg = settings_service.resolve_model(None, "embedding")
            rerank_cfg = None
            rv = settings_service.get_defaults().get("rerank")
            if rv:
                try:
                    rerank_cfg = settings_service.resolve_model(rv, "rerank")
                except KeyError:
                    pass
            hits = retrieve(content, kb_ids, embed_cfg=embed_cfg, rerank_cfg=rerank_cfg)
        except Exception as e:  # noqa: BLE001
            log(f"[chat] ⚠️ 检索失败：{e}")
            if mode == "query":
                _refuse(session_id, emit, run)
                return

    # ---------- query 模式拒绝守卫 ----------
    if mode == "query":
        if not hits or vectorstore.count_by_kb(kb_ids) == 0:
            _refuse(session_id, emit, run)
            return

    # ---------- 引用条目 ----------
    doc_names = {d["id"]: d["name"]
                 for d in [kb_service.get_doc(r["id"])
                           for r in db.get().execute(
                               "SELECT id FROM docs").fetchall()] if d}
    citations = _hits_to_citations(hits, doc_names)
    run["citations"] = citations  # 同一 list 对象：工具轮追加对部分保存同样可见
    emit({"type": "citations", "citations": citations})

    # ---------- 系统提示词 ----------
    sys_parts = [PERSONA, CITE_RULE]
    if hits:
        ctx = []
        for i, h in enumerate(hits):
            head = h.get("breadcrumb") or h.get("section_num") or ""
            ctx.append(f"[{i + 1}] 【{doc_names.get(h['doc_id'], '文档')} {head}】\n{h['text']}")
        sys_parts.append("以下是知识库检索到的参考资料（编号 [N] 对应引用标记 [[c:N]]）：\n\n"
                         + "\n\n".join(ctx))
    elif mode == "automatic":
        sys_parts.append("你可以调用 rag_search 工具在指定知识库中检索资料；"
                         "引用工具返回的片段时按 [[c:N]] 协议标注（N=片段编号）。")
    else:
        sys_parts.append("知识库中没有检索到相关资料。"
                         + ("" if mode == "chat" else "请说明无法从知识库回答。"))
    if mode == "query":
        sys_parts.append("只依据参考资料回答；资料不足时明确说明。")
    if web_on:
        sys_parts.append(WEB_HINT)
    messages = [{"role": "system", "content": "\n\n".join(sys_parts)}]
    for m in get_messages(session_id)[:-1][-12:]:
        if m["role"] in ("user", "assistant") and m["content"]:
            messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": content})

    # ---------- 生成（分段交错维护） ----------
    segs = _Segments()
    run["segments"] = segs.list

    def on_delta(c, r):
        if r:
            i = segs.add_thinking(r)
            run["reasoning"] += r
            emit({"type": "reasoning", "content": r, "seg": i})
        if c:
            i = segs.add_text(c)
            run["content"] += c
            emit({"type": "delta", "content": c, "seg": i})

    if mode == "automatic" or (mode == "chat" and web_on):
        # chat+联网：web 二件套；automatic：rag_search +（开关打开时的）web 二件套
        tools = list(TOOLS_SPEC) if mode == "automatic" else []
        if web_on:
            tools += list(websearch.WEB_TOOLS_SPEC)
        answer = _run_tool_loop(
            llm, messages, tools,
            lambda name, args: _exec_chat_tool(name, args, kb_ids, doc_names),
            emit, on_delta, run, segs, citations, doc_names)
    else:
        resp = llm.chat_with_retry(messages, None, on_delta=on_delta)
        answer = resp["content"] or ""

    # ---------- 收尾 ----------
    if session["title"] == "新会话" and answer:
        rename_session(session_id, content[:24])
        emit({"type": "session_renamed", "sessionId": session_id,
              "title": content[:24]})
    mid = _save_message(session_id, "assistant", content=answer,
                        reasoning=run["reasoning"], tool_calls=run["tool_calls"],
                        segments=segs.list, citations=citations, kb_ids=kb_ids,
                        model=model_cfg["model"], mode=mode)
    run["saved"] = True
    run["message_id"] = mid
    emit({"type": "done", "messageId": mid, "sessionId": session_id,
          "citations": citations})


def _refuse(session_id, emit, run):
    """query 模式拒答：同样维护分段（单个 text 段）。"""
    segs = _Segments()
    idx = segs.add_text(REFUSAL)
    run["segments"] = segs.list
    run["content"] = REFUSAL
    emit({"type": "citations", "citations": []})
    emit({"type": "delta", "content": REFUSAL, "seg": idx})
    mid = _save_message(session_id, "assistant", content=REFUSAL,
                        model=run.get("model", ""), mode=run.get("mode", "query"),
                        segments=segs.list)
    run["saved"] = True
    run["message_id"] = mid
    emit({"type": "done", "messageId": mid, "refused": True})


def _hits_to_citations(hits, doc_names) -> list[dict]:
    return [{
        "idx": i + 1, "docId": h["doc_id"], "kbId": h.get("kb_id", ""),
        "docName": doc_names.get(h["doc_id"], h["doc_id"]),
        "artifact": h["artifact"], "sectionNum": h.get("section_num", ""),
        "breadcrumb": h.get("breadcrumb", ""), "anchor": h.get("anchor", ""),
        "text": (h["text"] or "")[:160], "score": h.get("score"),
    } for i, h in enumerate(hits)]


def _norm_kb_hit(h: dict, doc_names: dict) -> dict:
    """检索命中 -> 标准化片段（kb）。"""
    return {"kind": "kb", "chunkId": h.get("id", ""), "kbId": h.get("kb_id", ""),
            "docId": h["doc_id"],
            "docName": doc_names.get(h["doc_id"], h["doc_id"]),
            "anchor": h.get("anchor", ""), "breadcrumb": h.get("breadcrumb", ""),
            "sectionNum": h.get("section_num", ""), "text": h.get("text", "")}


def _norm_web_item(title, url, snippet) -> dict:
    """web 结果 -> 标准化片段（anchor 存 URL，前端按 URL 型引用渲染）。"""
    return {"kind": "web", "chunkId": "", "kbId": "", "docId": "",
            "docName": (title or url or "（无标题）").strip(),
            "anchor": url or "", "breadcrumb": "网页", "sectionNum": "",
            "text": snippet or ""}


def _citation_of(f: dict, idx: int) -> dict:
    """标准化片段 -> citations 条目（web 条目额外带 url 字段）。"""
    c = {"idx": idx, "docId": f.get("docId", ""), "kbId": f.get("kbId", ""),
         "docName": f.get("docName", ""), "artifact": f.get("artifact", ""),
         "sectionNum": f.get("sectionNum", ""), "breadcrumb": f.get("breadcrumb", ""),
         "anchor": f.get("anchor", ""), "text": (f.get("text") or "")[:160],
         "kind": f.get("kind", "kb")}
    if c["kind"] == "web":
        c["url"] = c["anchor"]
    return c


def _fragment_of(f: dict, n: int) -> dict:
    """标准化片段 -> tool_result fragments 条目（结构同 citations，n=全局编号）。"""
    frag = {"n": n, "chunkId": f.get("chunkId", ""), "kbId": f.get("kbId", ""),
            "docId": f.get("docId", ""), "docName": f.get("docName", ""),
            "anchor": f.get("anchor", ""), "breadcrumb": f.get("breadcrumb", ""),
            "sectionNum": f.get("sectionNum", ""), "text": (f.get("text") or "")[:200],
            "kind": f.get("kind", "kb")}
    if frag["kind"] == "web":
        frag["url"] = frag["anchor"]
    return frag


def _exec_chat_tool(name: str, args: dict, kb_ids: list[str],
                    doc_names: dict) -> tuple[str | None, list[dict]]:
    """chat 侧统一工具执行器 -> (错误文本|None, 标准化片段列表)。

    kb 检索错误/联网失败均以错误文本返回（模型据此降级，流水线不中断）。"""
    if name == "rag_search":
        err, hits = _rag_search(str(args.get("query") or ""),
                                list(args.get("kb_ids") or kb_ids))
        return err, [_norm_kb_hit(h, doc_names) for h in hits]
    if name == "web_search":
        err, results = websearch.web_search(str(args.get("query") or ""),
                                            args.get("max_results") or 5)
        if err:
            return err, []
        return None, [_norm_web_item(r.get("title"), r.get("url"), r.get("snippet"))
                      for r in (results or [])]
    if name == "web_fetch":
        url = str(args.get("url") or "").strip()
        err, page = websearch.web_fetch(url)
        if err:
            return err, []
        return None, [_norm_web_item(page.get("title"), page.get("url") or url,
                                     (page.get("content") or "")[:300])]
    return f"未知工具：{name}", []


def _run_tool_loop(llm, messages, tools, exec_fn, emit, on_delta, run, segs,
                   citations, doc_names) -> str:
    """通用工具循环（步骤4 由 _agent_loop 泛化）：chat+联网 / automatic 共用。

    exec_fn(name, args) -> (错误文本|None, 标准化片段列表)（见 _exec_chat_tool）。
    片段实时并入 citations 并分配全局编号（同 anchor 去重复用；web 片段 anchor=URL），
    工具结果文本按 [N] 列出，模型写 [[c:N]] 与 citations[N-1] 一一对应。"""
    rounds = 0
    while True:
        try:
            resp = llm.chat_with_retry(messages, tools, on_delta=on_delta)
        except openai.BadRequestError as e:
            if tools and ("tool" in str(e).lower()):
                log(f"[chat] ⚠️ 模型不支持工具调用，回退普通模式：{str(e)[:120]}")
                tools = None
                continue
            raise
        tcs = resp.get("tool_calls") or []
        if not tcs:
            return resp.get("content") or ""
        messages.append({"role": "assistant", "content": resp.get("content") or None,
                         "tool_calls": tcs})
        for tc in tcs:
            call_id = tc.get("id") or f"call_{len(run['tool_calls'])}"
            try:
                args = json.loads(tc["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            name = tc["function"]["name"]
            seg_idx = segs.open_tool(call_id, name, args)
            emit({"type": "tool_call", "name": name, "arguments": args,
                  "seg": seg_idx, "callId": call_id})
            run["tool_calls"].append({"callId": call_id, "name": name,
                                      "arguments": args})
            err, frags = exec_fn(name, args)
            # 片段并入引用并分配全局编号（同 anchor 保留首次）
            known = {c["anchor"]: c["idx"] for c in citations if c.get("anchor")}
            fragments, lines = [], []
            for f in frags:
                anchor = f.get("anchor", "")
                idx = known.get(anchor) if anchor else None
                if idx is None:
                    idx = len(citations) + 1
                    citations.append(_citation_of(f, idx))
                    if anchor:
                        known[anchor] = idx
                fragments.append(_fragment_of(f, idx))
                if f.get("kind") == "web":
                    lines.append(f"[{idx}] 【{f['docName']}】\nURL: {anchor}\n"
                                 f"{(f.get('text') or '')[:400]}")
                else:
                    lines.append(f"[{idx}] 【{f['docName']} "
                                 f"{f.get('breadcrumb') or f.get('sectionNum')}】\n"
                                 f"{(f.get('text') or '')[:400]}")
            emit({"type": "citations", "citations": citations})
            if err:
                result = err
            elif not lines:
                result = "未检索到相关内容。"
            else:
                result = "\n\n".join(lines)
            segs.fill_tool(call_id, result[:400], fragments)
            for entry in reversed(run["tool_calls"]):
                if entry.get("callId") == call_id:
                    entry["result"] = result[:400]
                    break
            emit({"type": "tool_result", "name": name, "result": result[:400],
                  "seg": seg_idx, "callId": call_id, "fragments": fragments})
            messages.append({"role": "tool", "tool_call_id": call_id,
                             "content": result})
        rounds += 1
        if rounds >= MAX_TOOL_ROUNDS:
            messages.append({"role": "system",
                             "content": "已达到工具调用上限，请基于现有信息作答。"})
            tools = None


def _rag_search(query: str, kb_ids: list[str]) -> tuple[str | None, list[dict]]:
    """检索：返回 (错误文本|None, hits)。格式化由调用方按全局编号拼装。"""
    if not query.strip():
        return "查询为空。", []
    try:
        embed_cfg = settings_service.resolve_model(None, "embedding")
        hits = retrieve(query, kb_ids, embed_cfg=embed_cfg, top_n=6)
    except Exception as e:  # noqa: BLE001
        return f"检索失败：{e}", []
    return None, hits


# ============================ 编辑重发 / 分支 / 对话名 ============================

def start_regenerate(sid: str, message_id: str, content: str) -> ChatStream:
    """编辑用户消息：原位替换内容、删除其后全部消息，重新流式生成回答。"""
    conn = db.get()
    row = conn.execute("SELECT * FROM messages WHERE id = ? AND session_id = ?",
                       (message_id, sid)).fetchone()
    if row is None or row["role"] != "user":
        raise ValueError("找不到要编辑的用户消息")
    conn.execute("UPDATE messages SET content = ? WHERE id = ?", (content, message_id))
    # 删除该消息（rowid）之后的全部消息（created_at 秒级可能并列，用 rowid 保证有序）
    conn.execute("DELETE FROM messages WHERE session_id = ? AND rowid > "
                 "(SELECT rowid FROM messages WHERE id = ?)", (sid, message_id))
    conn.commit()
    srow = conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
    payload = {
        "sessionId": sid, "content": content,
        "kbIds": json.loads(row["kb_ids"] or "[]"),
        "model": (srow["model"] if srow else None),  # providerId/modelId 或 None（跟随默认）
        "mode": row["mode"] if row["mode"] in MODES else "chat",
        "webSearch": bool(srow["web_search"]) if srow else False,
    }
    return ChatStream(payload, save_user=False)


def branch_session(sid: str, message_id: str, include_current: bool = True) -> dict:
    """对话分支：新建会话，复制该消息及其之前的全部消息（原会话不动）。

    debug4 #14：include_current=False 时不复制该消息本身（rowid< 严格小于）——
    user 消息分支=复制之前的消息，本条内容由前端放回输入框草稿；会话首条用户消息
    分支 → 空会话（语义正确）。会话状态（mode/model/kb_ids/web_search）照抄。"""
    conn = db.get()
    srow = conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
    if srow is None:
        raise ValueError("会话不存在")
    mrow = conn.execute("SELECT * FROM messages WHERE id = ? AND session_id = ?",
                        (message_id, sid)).fetchone()
    if mrow is None:
        raise ValueError("消息不存在")
    new_id = _uid()
    now = _now()
    title = (srow["title"] or "会话") + "（分支）"
    conn.execute(
        "INSERT INTO sessions (id, title, mode, model, kb_ids, web_search, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (new_id, title, srow["mode"] or "chat", srow["model"],
         srow["kb_ids"] or "[]", 1 if srow["web_search"] else 0, now, now))
    op = "<=" if include_current else "<"
    rows = conn.execute(
        f"SELECT * FROM messages WHERE session_id = ? AND rowid {op} "
        "(SELECT rowid FROM messages WHERE id = ?) ORDER BY created_at, rowid",
        (sid, message_id)).fetchall()
    for r in rows:
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls,"
            " citations, kb_ids, model, mode, segments, stopped, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (_uid(), new_id, r["role"], r["content"], r["reasoning"], r["tool_calls"],
             r["citations"], r["kb_ids"], r["model"], r["mode"], r["segments"],
             r["stopped"], r["created_at"]))
    conn.commit()
    log(f"[chat] 分支 {sid} -> {new_id}（复制 {len(rows)} 条消息，"
        f"includeCurrent={'true' if include_current else 'false'}）")
    return {"id": new_id, "title": title,
            "mode": srow["mode"] or "chat", "model": srow["model"],
            "kbIds": json.loads(srow["kb_ids"] or "[]"),
            "webSearch": bool(srow["web_search"]),
            "createdAt": now, "updatedAt": now}


def generate_title(sid: str) -> dict:
    """生成对话名：辅助模型（未配置回退内容生成模型）读首条用户消息（截 600 字）。"""
    conn = db.get()
    srow = conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
    if srow is None:
        raise ValueError("会话不存在")
    row = conn.execute(
        "SELECT * FROM messages WHERE session_id = ? AND role = 'user'"
        " ORDER BY created_at, rowid LIMIT 1", (sid,)).fetchone()
    if row is None or not (row["content"] or "").strip():
        raise ValueError("会话中没有用户消息")
    text = row["content"].strip()[:600]
    try:
        cfg = settings_service.resolve_model(None, "assist")
    except KeyError:
        cfg = settings_service.resolve_model(None, "contentGen")
    llm = LLMClient(**cfg)
    t0 = time.time()
    resp = llm.chat_with_retry([{"role": "user", "content": TITLE_PROMPT + text}])
    usage = resp.get("usage")
    log(f"[chat] 生成对话名 {sid}: usage={getattr(usage, 'total_tokens', None)} tokens, "
        f"{time.time() - t0:.1f}s")
    raw = (resp.get("content") or "").strip().strip('"“”‘’')
    title = next((ln.strip() for ln in raw.splitlines() if ln.strip()), "")
    title = title[:20] or "新会话"
    rename_session(sid, title)
    emit("session.title", sessionId=sid, title=title)  # 全局广播（前端刷新列表）
    log(f"[chat] 生成对话名 {sid}: {title}")
    return {"sessionId": sid, "title": title}
