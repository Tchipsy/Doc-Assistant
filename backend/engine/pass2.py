"""Pass 2 引擎：插件化内容生成。算法移植自老项目 pass2.py，差异：

- 系统提示词外部组装传入；不再走 Exa 网络搜索（Web 服务版暂不启用）；
- 新增 on_delta 流式回调（带窗口序号与 @@ 块头状态，供实时渲染）；
- 步骤3 跨文档查询：可选工具循环（kb_toc/kb_summary/rag_search，executor 注入，
  引擎不碰 DB）；模型正文中的 [[c:N]] 引用标记按窗口工具结果组装块级 refs，
  落盘 <插件名>.refs.json（标记保留在 artifact md 中，前端/导出各自转换）。
"""
import json
import re
from pathlib import Path

from engine import atblock, meta as meta_mod, textutil
from engine.config import (
    CONTINUE_MAX_CONTEXT_TOKENS, CONTINUE_MSG, PASS2_BATCH_TOKENS,
    ROLLING_SUMMARY_TOKENS, ROLLING_TAIL_TOKENS, log, read_text_guess,
)
from engine.errors import LLMError
from engine.llm import ContextOverflowError
from engine.state import StageState

MAX_TOOL_ROUNDS = 3

CITE_RE = re.compile(r"\[\[c:(\d+)\]\]")


class _Checkpoint(Exception):
    def __init__(self, partial=""):
        super().__init__("pass2 checkpoint")
        self.partial = partial


class Pass2Engine:
    def __init__(self, llm, group, system_prompt, batch_tokens=None, where=None,
                 emit=None, on_delta=None, on_reset=None, on_window_start=None,
                 gate=None, tools_spec=None, executor=None):
        """group: list[PromptSpec]（同组插件，生成位置相同）；where: 生成位置
        PromptSpec（kind='where'，其 ## meta 可带 coverage: leaf）。

        tools_spec/executor（步骤3 跨文档查询）：tools=None 或 executor=None 时
        工具循环关闭。executor(name, args, start_n) -> (result_text, fragments)，
        fragments 为 [{n, chunkId, kbId, docId, docName, anchor, breadcrumb,
        sectionNum, text}]（n 从 start_n 起连续编号，与 result_text 中的 [N] 一致），
        kb_toc/kb_summary 返回 fragments=None。"""
        self.llm = llm
        self.group = list(group)
        self.system_prompt = system_prompt
        self.batch_tokens = batch_tokens or PASS2_BATCH_TOKENS
        self.emit = emit or (lambda **ev: None)
        self.on_delta = on_delta or (lambda text, window: None)
        self.on_reset = on_reset or (lambda window: None)
        self.on_window_start = on_window_start or (lambda window: None)
        self.gate = gate or (lambda: None)   # 暂停闸门：窗口边界阻塞
        self.where = where
        self.group_names = [p.name for p in self.group]
        self.coverage_leaf = (
            any(p.meta().get("coverage") == "leaf" for p in self.group)
            or bool(where is not None and where.meta().get("coverage") == "leaf"))
        self.partial_failure = False
        self.warnings: list[str] = []
        self.tools_spec = tools_spec
        self.executor = executor
        # (块类型, 目标编号) -> refs；窗口工具轮结果的 n -> 片段映射（每窗重置）
        self.block_refs: dict[tuple[str, str], list[dict]] = {}
        self._frag_map: dict[int, dict] = {}

    # ---------------- 主流程 ----------------
    def run(self, stage_dir, organized_path, doc_title, toc_path=None) -> dict:
        stage_dir = Path(stage_dir)
        text = read_text_guess(organized_path).replace("\r\n", "\n")
        text, _ = textutil.strip_page_markers(text)
        numbered, headings = textutil.number_headings(text)

        toc_text = None
        if toc_path and Path(toc_path).is_file():
            toc_text = read_text_guess(toc_path).strip()
        if not toc_text:
            toc_text = textutil.build_toc(headings)

        params = meta_mod.pass2_params(organized_path, self.group,
                                       self.batch_tokens, self.llm.model)
        state = StageState(stage_dir / ".state" / meta_mod.stage_state_id("pass2", params),
                           params)
        # 检查点恢复：随 counters 持久化的块级 refs 一并恢复（引用与块对应不丢）
        self.block_refs = {}
        for k, v in (state.counters.get("block_refs") or {}).items():
            try:
                btype, target = str(k).split("|", 1)
            except ValueError:
                continue
            if isinstance(v, list) and v:
                self.block_refs[(btype, target)] = v
        items = textutil.build_pass2_items(numbered, self.batch_tokens)
        windows = textutil.make_item_windows(items, self.batch_tokens)
        done0 = len(state.counters.get("items_done", []))
        self.emit(stage="pass2:" + "+".join(self.group_names), type="stage_start",
                  windows=len(windows), items=len(items), resumed=state.resumed)
        log(f"[pass2:{'+'.join(self.group_names)}] {len(items)} 节项 -> "
            f"{len(windows)} 窗（目标 {self.batch_tokens} token），续传 {done0} 项")

        for wi, win in enumerate(windows):
            rest = [it for it in win
                    if it["key"] not in set(state.counters.get("items_done", []))]
            if not rest:
                continue
            self.gate()   # 暂停闸门：窗口边界（items_done 检查点已落盘）
            self.emit(stage="pass2", type="window_start", window=f"{wi + 1}/{len(windows)}",
                      items=len(rest))
            self.on_window_start(wi)
            try:
                self._window(rest, state, doc_title, stage_dir, toc_text, wi)
            except Exception as e:  # noqa: BLE001
                self.partial_failure = True
                self.warnings.append(f"窗口 {wi + 1} 最终失败：{type(e).__name__}: {e}")
                log(f"[pass2] ❌ 窗口 {wi + 1} 最终失败：{type(e).__name__}: {e}")
                self._mark(state, rest)
            self.emit(stage="pass2", type="window_done", window=f"{wi + 1}/{len(windows)}")

        stats = self._collect_and_write(state, stage_dir, headings)
        stats.update({"items": len(items), "windows": len(windows), "params": params,
                      "partial": self.partial_failure})
        state.cleanup(False)
        self.emit(stage="pass2", type="stage_done",
                  **{k: v for k, v in stats.items() if k != "params"})
        return stats

    # ---------------- 窗口生成与恢复 ----------------
    def _window(self, win_items, state, doc_title, stage_dir, toc_text, wi, depth=0):
        try:
            out = self._gen(win_items, state, doc_title, toc_text, wi)
            if not out.strip():
                self._on_empty_window(win_items, state)
                return
            self._note_refs(out, state)
            state.write_part(out)
            self._mark(state, win_items)
            return
        except _Checkpoint as cp:
            partial = cp.partial

        self.on_reset(wi)
        _, blocks, _ = atblock.parse_at_blocks(partial or "")
        done_keys = {b["target"] for b in blocks if b["target"]}
        if blocks:
            state.write_part(atblock.serialize_blocks(blocks))
        rest = [it for it in win_items
                if it["num"] is None or not atblock.num_covered(it["num"], done_keys)]
        if not rest:
            self._mark(state, win_items)
            return
        log(f"[pass2] 检查点恢复：保留 {len(blocks)} 完整块，剩余 {len(rest)} 节项重试")

        if not blocks:
            if len(rest) > 1 and depth < 3:
                mid = len(rest) // 2
                log(f"[pass2] 无产出，拆半重试：{mid} + {len(rest) - mid} 节项")
                self._window(rest[:mid], state, doc_title, stage_dir, toc_text, wi, depth + 1)
                self._window(rest[mid:], state, doc_title, stage_dir, toc_text, wi, depth + 1)
                return
            if len(rest) == 1 and depth < 3:
                sub_items = self._subdivide_item(rest[0])
                if sub_items:
                    half = max(self.batch_tokens // 2, 10_000)
                    for sub in textutil.make_item_windows(sub_items, half):
                        self._window(sub, state, doc_title, stage_dir, toc_text, wi, depth + 1)
                    self._mark(state, rest)
                    return
            self.partial_failure = True
            self.warnings.append("窗口生成失败（输出/上下文受限），已跳过")
            self._mark(state, rest)
            return

        note = ("【勿重复】以下编号已完成：" + "、".join(sorted(done_keys))
                + "；请只为其余编号生成。")
        for sub in textutil.make_item_windows(rest, self.batch_tokens):
            try:
                out = self._gen(sub, state, doc_title, toc_text, wi, include_summary=True,
                                done_note=note)
                if not out.strip():
                    self._on_empty_window(sub, state)
                    continue
                self._note_refs(out, state)
                state.write_part(out)
                self._mark(state, sub)
            except _Checkpoint as cp2:
                self._retry_single(cp2, sub, state, doc_title, toc_text, note, wi)
            except Exception as e:  # noqa: BLE001
                self.partial_failure = True
                self.warnings.append(f"重试失败：{type(e).__name__}: {e}")
                log(f"[pass2] ❌ 重试失败：{type(e).__name__}: {e}")
                self._mark(state, sub)

    def _on_empty_window(self, win_items, state):
        self._mark(state, win_items)
        if self.coverage_leaf:
            self.partial_failure = True
            self.warnings.append("窗口输出为空（coverage:leaf 视为失败，可重跑）")
            log("[pass2] ⚠️ 窗口输出为空，标记失败")
        else:
            self.warnings.append("窗口输出为空（稀疏型插件视为无内容；若应有产出请重跑）")
            log("[pass2] ⚠️ 窗口输出为空（视为无内容）")

    def _retry_single(self, cp, win_items, state, doc_title, toc_text, note, wi):
        _, blocks, _ = atblock.parse_at_blocks(cp.partial or "")
        if blocks:
            state.write_part(atblock.serialize_blocks(blocks))
        keys = {b["target"] for b in blocks if b["target"]}
        if keys:
            note = note + "、" + "、".join(sorted(keys))
        for it in win_items:
            if it["num"] is not None and atblock.num_covered(it["num"], keys):
                self._mark(state, [it])
                continue
            try:
                out = self._gen([it], state, doc_title, toc_text, wi,
                                include_summary=True, done_note=note)
                if not out.strip():
                    self._on_empty_window([it], state)
                    continue
                self._note_refs(out, state)
                state.write_part(out)
                self._mark(state, [it])
            except Exception as e:  # noqa: BLE001
                self.partial_failure = True
                self.warnings.append(f"单节重试失败：{type(e).__name__}: {e}")
                log(f"[pass2] ❌ 单节重试失败：{type(e).__name__}: {e}")
                self._mark(state, [it])

    def _subdivide_item(self, item):
        half = max(self.batch_tokens // 2, 10_000)
        subs = textutil.split_h3(item["content"])
        sub_items = []
        for num, txt in (subs if subs else [(item.get("num"), item["content"])]):
            if textutil.estimate_tokens(txt) <= half:
                sub_items.append({"num": num, "content": txt})
            else:
                for w in textutil.para_windows(txt, max(1000, int(half * 1.2))):
                    sub_items.append({"num": num, "content": w})
        if len(sub_items) <= 1:
            ws = textutil.para_windows(item["content"],
                                       max(500, len(item["content"]) // 2))
            if len(ws) > 1:
                sub_items = [{"num": item.get("num"), "content": w} for w in ws]
        return sub_items

    def _gen(self, win_items, state, doc_title, toc_text, wi,
             include_summary=False, done_note="") -> str:
        user_msg = self._user_message(win_items, state, doc_title, toc_text,
                                      include_summary, done_note)
        master: list[str] = []
        messages = [{"role": "system", "content": self.system_prompt},
                    {"role": "user", "content": user_msg}]
        tools = self.tools_spec if (self.tools_spec and self.executor) else None
        self._frag_map = {}          # 本窗口工具结果的 n -> 片段（refs 组装依据）
        rounds = 0
        tool_tokens = 0
        while True:
            try:
                resp = self.llm.chat_with_retry(
                    messages, tools,
                    on_delta=lambda c, r: self.on_delta(c, wi))
            except ContextOverflowError as e:
                raise _Checkpoint("".join(master)) from e
            except LLMError:
                raise
            content = resp["content"] or ""
            tcs = resp.get("tool_calls") or []
            u = getattr(resp.get("usage"), "total_tokens", None)
            if u:
                tool_tokens += int(u)
            if tcs and tools and rounds < MAX_TOOL_ROUNDS:
                # 中间轮：正文不并入最终产物（@@ 块外的过渡文本本就被解析器丢弃）
                messages.append({"role": "assistant", "content": content or None,
                                 "tool_calls": tcs})
                for tc in tcs:
                    call_id = tc.get("id") or f"call_{rounds}_{len(messages)}"
                    try:
                        fn = tc.get("function") or {}
                        args = json.loads(fn.get("arguments") or "{}")
                    except (json.JSONDecodeError, AttributeError):
                        args = {}
                    name = (tc.get("function") or {}).get("name", "")
                    result, frags = self._exec_tool(name, args)
                    if frags:
                        for f in frags:
                            try:
                                self._frag_map[int(f["n"])] = f
                            except (KeyError, TypeError, ValueError):
                                pass
                    messages.append({"role": "tool", "tool_call_id": call_id,
                                     "content": result})
                rounds += 1
                log(f"[pass2] 窗口 {wi + 1} 工具轮 {rounds}/{MAX_TOOL_ROUNDS}："
                    f"{', '.join((tc.get('function') or {}).get('name', '?') for tc in tcs)}")
                if rounds >= MAX_TOOL_ROUNDS:
                    messages.append({"role": "system",
                                     "content": "工具调用已达上限，请基于已获取的信息完成本轮输出。"})
                    tools = None
                continue
            if tcs:
                log(f"[pass2] ⚠️ 窗口 {wi + 1} 忽略超限/未启用时的 {len(tcs)} 个工具调用")
            master.append(content)
            if resp["finish_reason"] != "length":
                if tool_tokens:
                    log(f"[pass2] 窗口 {wi + 1} usage≈{tool_tokens} tokens"
                        f"（含 {rounds} 个工具轮）")
                return "".join(master)
            ctx = (textutil.estimate_tokens("".join(master))
                   + textutil.estimate_tokens(user_msg)
                   + textutil.estimate_tokens(self.system_prompt))
            if ctx >= CONTINUE_MAX_CONTEXT_TOKENS:
                raise _Checkpoint("".join(master))
            # 续写沿用完整消息历史（含工具轮消息），工具可用性保持当前状态
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": CONTINUE_MSG})

    def _exec_tool(self, name: str, args: dict) -> tuple[str, list[dict] | None]:
        """执行工具；任何异常降级为错误 tool 消息让模型继续（不炸流水线）。"""
        if not self.executor:
            return "工具不可用。", None
        try:
            start_n = (max(self._frag_map) + 1) if self._frag_map else 1
            return self.executor(name, args or {}, start_n)
        except Exception as e:  # noqa: BLE001
            log(f"[pass2] ⚠️ 工具 {name} 执行异常：{type(e).__name__}: {e}")
            return f"工具执行失败：{type(e).__name__}: {e}", None

    def _note_refs(self, out: str, state) -> None:
        """扫描本次输出完整 @@ 块中的 [[c:N]] 标记，按本窗口工具结果组装块级 refs。

        标记保留在 md 原文中；n 未命中的标记剔除。同 (类型,编号) 首个生效
        （与 _collect_and_write 去重一致），随 counters 持久化供检查点恢复。
        """
        if not self._frag_map:
            return
        _, blocks, _ = atblock.parse_at_blocks(out)
        changed = False
        for b in blocks:
            nums = {int(m) for m in CITE_RE.findall(b["content"])}
            if not nums:
                continue
            key = (b["type"], b["target"])
            if key in self.block_refs:
                continue
            refs = []
            for n in sorted(nums):
                frag = self._frag_map.get(n)
                if not frag:
                    continue
                refs.append({
                    "n": n, "chunkId": frag.get("chunkId", ""),
                    "kbId": frag.get("kbId", ""), "docId": frag.get("docId", ""),
                    "docName": frag.get("docName", ""),
                    "anchor": frag.get("anchor", ""),
                    "breadcrumb": frag.get("breadcrumb", ""),
                    "sectionNum": frag.get("sectionNum", ""),
                    "text": (frag.get("text") or "")[:160],
                    # 步骤4：web 片段 kind='web'（anchor 存 URL），缺省按 kb 处理
                    **({"kind": "web"} if frag.get("kind") == "web" else {}),
                })
            if refs:
                self.block_refs[key] = refs
                changed = True
        if changed:
            state.counters["block_refs"] = {
                f"{t}|{tgt}": refs for (t, tgt), refs in self.block_refs.items()}
            state.save()

    def _user_message(self, win_items, state, doc_title, toc_text,
                      include_summary, done_note) -> str:
        parts = [f"----- 全文目录 -----\n{toc_text}\n----- 目录结束 -----"]
        if include_summary:
            summary_path = Path(state.dir).parent.parent / "summary.md"
            if summary_path.is_file():
                s = read_text_guess(summary_path)
                s = textutil.tail_by_tokens(s, ROLLING_SUMMARY_TOKENS)
                parts.append(f"----- 全文摘要（上下文压缩）-----\n{s}\n----- 摘要结束 -----")
        if state.parts:
            tail = textutil.tail_by_tokens(state.parts[-1], ROLLING_TAIL_TOKENS)
            if tail.strip():
                parts.append(f"----- 已生成部分（节选，仅供衔接）-----\n{tail}\n----- 结束 -----")
        body = "\n\n".join(it["content"] for it in win_items)
        parts.append(f"----- 本次章节开始（{len(win_items)} 个节项）-----\n\n"
                     f"{body}\n\n----- 本次章节结束 -----")
        if done_note:
            parts.append(done_note)
        return (f"《{doc_title}》-- 生成任务（组件：{'、'.join(self.group_names)}；"
                f"本片段含 {len(win_items)} 个节项）\n\n" + "\n\n".join(parts))

    # ---------------- 收集与落盘 ----------------
    def _collect_and_write(self, state, stage_dir, headings) -> dict:
        all_blocks: list[dict] = []
        stray_chars = 0
        for p in state.parts:
            residue, bs, _ = atblock.parse_at_blocks(p)
            stray_chars += len(residue.strip())
            all_blocks.extend(bs)
        if stray_chars > 50:
            self.warnings.append(f"输出含 {stray_chars} 字符 @@ 块外内容（已忽略）")

        by_plugin: dict[str, list[dict]] = {name: [] for name in self.group_names}
        unknown = 0
        seen: set[tuple[str, str]] = set()
        for b in all_blocks:
            key = (b["type"], b["target"])
            if b["type"] not in by_plugin:
                unknown += 1
                continue
            if key in seen:
                continue  # 同类型同编号保留首个
            seen.add(key)
            by_plugin[b["type"]].append(b)
        if unknown:
            self.warnings.append(f"{unknown} 个未知类型 @@ 块被丢弃（不属于本组插件）")

        for name, blocks in by_plugin.items():
            if not blocks:
                log(f"[pass2] 插件 {name}：0 块，不写文件（保留待重跑状态）")
                continue
            (stage_dir / f"{name}.md").write_text(
                atblock.serialize_blocks(blocks) + "\n",
                encoding="utf-8", newline="\n")
            log(f"[pass2] 插件 {name}：{len(blocks)} 块 -> {name}.md")
            # 块级 refs（[[c:N]] 协议）：与 <name>.md 一同重写，防止陈旧 refs 残留
            refs_by_target = {}
            for (ptype, target), refs in self.block_refs.items():
                if ptype == name:
                    refs_by_target[target] = refs
            (stage_dir / f"{name}.refs.json").write_text(
                json.dumps(refs_by_target, ensure_ascii=False, indent=1) + "\n",
                encoding="utf-8", newline="\n")
            if refs_by_target:
                n_refs = sum(len(v) for v in refs_by_target.values())
                log(f"[pass2] 插件 {name}：{len(refs_by_target)} 块 / {n_refs} 条引用"
                    f" -> {name}.refs.json")

        if self.coverage_leaf:
            leaf = textutil.leaf_section_nums(headings)
            for name in self.group_names:
                n = len(by_plugin[name])
                if n == 0:
                    self.warnings.append(f"插件 {name} 输出 0 个块（叶子节 {len(leaf)} 个）")
                elif n != len(leaf):
                    self.warnings.append(
                        f"插件 {name} 块数 {n} ≠ 最小编号节数 {len(leaf)}（coverage: leaf）")
        stats = {f"blocks_{name}": len(blocks) for name, blocks in by_plugin.items()}
        stats["refs"] = {
            name: {tgt: refs for (ptype, tgt), refs in self.block_refs.items()
                   if ptype == name}
            for name in self.group_names}
        return stats

    @staticmethod
    def _mark(state, items) -> None:
        done = state.counters.setdefault("items_done", [])
        for it in items:
            k = it.get("key")
            if k is not None and k not in done:
                done.append(k)
        state.save()
