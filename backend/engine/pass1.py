"""Pass 1 引擎：整理 + 节摘要。算法移植自老项目 pass1.py，差异：

- 系统提示词由外部组装传入（不再持有 PromptKit）；
- 新增 on_delta 流式回调：每个窗口生成时把 token 增量连同窗口序号交给
  liveview 解析器（实时渲染）；截断续写/检查点恢复时通过 on_reset 通知
  liveview 回滚到检查点边界。
"""
import re
from pathlib import Path

from engine import atblock, meta as meta_mod, textutil
from engine.config import (
    CONTINUE_MAX_CONTEXT_TOKENS, CONTINUE_MSG, ORGANIZE_BATCH_TOKENS,
    ROLLING_SUMMARY_TOKENS, log, read_text_guess,
)
from engine.errors import LLMError
from engine.llm import ContextOverflowError
from engine.state import StageState


class _Checkpoint(Exception):
    def __init__(self, partial=""):
        super().__init__("pass1 checkpoint")
        self.partial = partial


class Pass1Engine:
    def __init__(self, llm, system_prompt, batch_tokens=None,
                 emit=None, on_delta=None, on_reset=None, on_window_start=None,
                 gate=None, common_spec=None):
        self.llm = llm
        self.system_prompt = system_prompt
        self.batch_tokens = batch_tokens or ORGANIZE_BATCH_TOKENS
        self.emit = emit or (lambda **ev: None)
        self.on_delta = on_delta or (lambda text, window: None)
        self.on_reset = on_reset or (lambda window: None)
        self.on_window_start = on_window_start or (lambda window: None)
        self.gate = gate or (lambda: None)   # 暂停闸门：窗口边界阻塞
        # common.md 契约节 PromptSpec（debug3：参与 pass1 指纹，与 _prepare 口径一致）
        self.common_spec = common_spec
        self.partial_failure = False
        self.warnings: list[str] = []

    # ---------------- 主流程 ----------------
    def run(self, stage_dir, pdf2md_path, doc_title: str | None = None) -> dict:
        stage_dir = Path(stage_dir)
        text = read_text_guess(pdf2md_path).replace("\r\n", "\n")
        if doc_title is None:
            m = re.search(r"^#\s+(.+?)\s*$", text, re.M)
            doc_title = m.group(1) if m else Path(pdf2md_path).stem

        params = meta_mod.pass1_params(
            pdf2md_path, *self._org_pair, self.batch_tokens, self.llm.model,
            common=self.common_spec)
        state = StageState(stage_dir / ".state" / "pass1", params)
        blocks = textutil.page_blocks(text)
        pending = blocks[state.counters.get("blocks_done", 0):]
        windows = textutil.make_page_windows(pending, self.batch_tokens)
        self.emit(stage="pass1", type="stage_start", windows=len(windows),
                  resumed=state.resumed, pages=len(blocks))
        log(f"[pass1] {len(blocks)} 页块 -> {len(windows)} 窗（目标 {self.batch_tokens} token），"
            f"续传 {state.counters.get('blocks_done', 0)} 页块")

        for wi, win in enumerate(windows):
            self.gate()   # 暂停闸门：窗口边界（检查点已落盘，阻塞不丢进度）
            self.emit(stage="pass1", type="window_start", window=f"{wi + 1}/{len(windows)}",
                      page_blocks=len(win))
            self.on_window_start(wi)
            self._organize_window(win, state, doc_title, wi, depth=0)
            self.emit(stage="pass1", type="window_done", window=f"{wi + 1}/{len(windows)}")

        # debug3（#4 定案）：@@title/@@digest 信息块由 pass1 窗口1 输出——
        # 从各窗口产物中剥离（后续窗口出现的同样剥离不入正文），仅窗口1 的块
        # 生效写入 meta；缺块回退现状逻辑（pdf2md 首个 `# `→文件名）。
        parts, llm_title, llm_digest = self._harvest_title_digest(list(state.parts))
        if llm_title:
            doc_title = llm_title
        raw = "\n\n".join(parts)
        stats = self._finalize(raw, stage_dir, doc_title, digest=llm_digest)
        stats.update({"pages": len(blocks), "windows": len(windows),
                      "params": params, "partial": self.partial_failure})
        state.cleanup(False)
        self.emit(stage="pass1", type="stage_done",
                  **{k: v for k, v in stats.items() if k not in ("params",)})
        return stats

    # ---------------- @@title/@@digest 信息块（debug3 #4） ----------------
    @staticmethod
    def _strip_title_digest(text: str, harvest: bool = False):
        """从一段窗口输出中剥离 @@title/@@digest 块（轻量行解析）。

        返回 (剥离后的文本, title|None, digest|None)；harvest=True 时返回首个
        完整闭合块的内容（窗口1 生效），harvest=False 时忽略内容只剥离。
        未闭合的块整体丢弃（残内容不进正文、半截标题不采用）。"""
        lines = text.split("\n")
        out: list[str] = []
        title = digest = None
        cur: str | None = None
        buf: list[str] = []
        for ln in lines:
            s = ln.strip()
            if cur is None:
                m = re.match(r"^@@(title|digest)\s*$", s, re.I)
                if m:
                    cur = m.group(1).lower()
                    buf = []
                    continue
                out.append(ln)
            else:
                if atblock.AT_END_RE.match(s):
                    val = " ".join("\n".join(buf).split())   # 折叠换行/多余空白
                    if harvest:
                        if cur == "title" and title is None and val:
                            title = val
                        elif cur == "digest" and digest is None and val:
                            digest = val
                    cur = None
                    buf = []
                    continue
                buf.append(ln)
        # 未闭合块：起始行与内容一并丢弃（cur 残留即不回写）
        return "\n".join(out), title, digest

    @classmethod
    def _harvest_title_digest(cls, parts: list[str]):
        """对全部窗口产物剥离 @@title/@@digest 块；仅窗口1（parts[0]）的块生效。

        返回 (剥离后的窗口列表, title|None, digest|None)。"""
        cleaned: list[str] = []
        title = digest = None
        for i, p in enumerate(parts):
            c, t, d = cls._strip_title_digest(p, harvest=(i == 0))
            cleaned.append(c)
            if i == 0:
                title, digest = t, d
        return cleaned, title, digest

    # ---------------- 窗口生成与恢复 ----------------
    def _organize_window(self, win_blocks, state, doc_title, wi, depth=0):
        try:
            out = self._gen_window(win_blocks, state, doc_title, wi)
            state.write_part(out)
            state.counters["blocks_done"] = state.counters.get("blocks_done", 0) + len(win_blocks)
            state.save()
            return
        except _Checkpoint as cp:
            partial = cp.partial

        # liveview 回滚到本窗口开头（丢弃本窗口的全部流式输出）
        self.on_reset(wi)
        kept = atblock.last_complete_block_cut(partial or "", "summary") if partial else None
        if kept:
            pages = [m.group(1) for m in textutil.PAGE_RE.finditer(kept)]
            consumed = 0
            if pages:
                last_p = pages[-1]
                consumed = next((i + 1 for i, (p, _) in enumerate(win_blocks)
                                 if p is not None and str(p) == last_p), 0)
            if 0 < consumed < len(win_blocks):
                state.write_part(kept)
                state.counters["blocks_done"] = state.counters.get("blocks_done", 0) + consumed
                state.save()
                rest = win_blocks[consumed:]
                log(f"[pass1] 检查点恢复：保留 {consumed} 页块，剩余 {len(rest)} 页块重试")
                smaller = max(self.batch_tokens // 2, 10_000)
                for sub in textutil.make_page_windows(rest, smaller):
                    self._organize_window(sub, state, doc_title, wi, depth + 1)
                return

        if len(win_blocks) <= 1 or depth >= 3:
            self.partial_failure = True
            self.warnings.append(f"窗口整理失败（输出/上下文受限），{len(win_blocks)} 页块可能不完整")
            state.write_part((partial or "").rstrip()
                             + "\n\n> [!warning] 本窗口整理因输出/上下文受限被截断，内容可能不完整。\n")
            state.counters["blocks_done"] = state.counters.get("blocks_done", 0) + len(win_blocks)
            state.save()
            return
        mid = len(win_blocks) // 2
        log(f"[pass1] 检查点无法定位，拆半重试：{mid} + {len(win_blocks) - mid} 页块")
        self._organize_window(win_blocks[:mid], state, doc_title, wi, depth + 1)
        self._organize_window(win_blocks[mid:], state, doc_title, wi, depth + 1)

    def _gen_window(self, win_blocks, state, doc_title, wi) -> str:
        user_msg = self._user_message(win_blocks, state, doc_title, wi)
        messages = [{"role": "system", "content": self.system_prompt},
                    {"role": "user", "content": user_msg}]
        master: list[str] = []
        while True:
            try:
                resp = self.llm.chat_with_retry(
                    messages, None,
                    on_delta=lambda c, r: self.on_delta(c, wi))
            except ContextOverflowError as e:
                raise _Checkpoint("".join(master)) from e
            except LLMError:
                raise
            content = resp["content"] or ""
            master.append(content)
            if resp["finish_reason"] != "length":
                return "".join(master)
            ctx = (textutil.estimate_tokens("".join(master))
                   + textutil.estimate_tokens(user_msg)
                   + textutil.estimate_tokens(self.system_prompt))
            if ctx >= CONTINUE_MAX_CONTEXT_TOKENS:
                raise _Checkpoint("".join(master))
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": CONTINUE_MSG})

    def _user_message(self, win_blocks, state, doc_title, wi: int = 0) -> str:
        parts = []
        summaries = []
        for p in state.parts:
            _, blocks, _ = atblock.parse_at_blocks(p)
            summaries.extend(b["content"] for b in blocks if b["type"] == "summary")
        if summaries:
            s = "\n\n".join(f"【{i}】{t}" for i, t in enumerate(summaries, 1))
            s = textutil.tail_by_tokens(s, ROLLING_SUMMARY_TOKENS)
            parts.append(f"----- 已完成部分摘要 -----\n{s}\n----- 摘要结束 -----")
        if state.parts:
            hs = textutil.recent_headings("\n".join(state.parts[-2:]))
            if hs:
                parts.append(f"----- 当前标题层级状态 -----\n{hs}\n----- 状态结束 -----")
        body = "\n".join(b[1] for b in win_blocks)
        parts.append(f"----- 本片段原文开始（{len(win_blocks)} 个页块）-----\n\n"
                     f"{body}\n\n----- 本片段原文结束 -----")
        head = f"《{doc_title}》-- 整理任务（本片段含 {len(win_blocks)} 个页块）"
        if wi > 0:
            # debug3：@@title/@@digest 只在窗口1 输出——后续窗口在用户消息里显式提醒
            head += "（本片段非全文开头：直接输出正文，不要再输出 @@title/@@digest 信息块）"
        return head + "\n\n" + "\n\n".join(parts)

    # ---------------- finalize：拆分三件产物 ----------------
    def _finalize(self, raw: str, stage_dir: Path, doc_title: str,
                  digest: str | None = None) -> dict:
        body_lines, summaries, stray, unclosed = self._split_raw(raw)
        if stray:
            self.warnings.append(f"Pass1 输出含 {stray} 个非 summary 的 @@ 块，已丢弃")
        if unclosed:
            self.warnings.append("Pass1 输出存在未闭合 @@ 块，其残内容保留在正文")
        # 9.5 步骤6：页标记保留在 organized.md（liveview 预览树据此生成页码锚点，
        # 供双窗口同步滚动用）；所有非预览消费方各自剥离：pass2 窗口（pass2.py）、
        # 入库分块（chunker.py）、导出组装（assemble.py）、kb_summary 节标题
        # （gen_service.py）——产物内容不受影响，仅 organized.md 磁盘形态多出页标记。
        body = "\n".join(body_lines)
        numbered, headings = textutil.number_headings(body)
        assigned = self._assign_summaries(summaries, headings)

        (stage_dir / "organized.md").write_text(numbered.strip("\n") + "\n",
                                                encoding="utf-8", newline="\n")
        (stage_dir / "summary.md").write_text(
            atblock.serialize_blocks(
                [{"type": "summary", "target": a["num"], "content": a["content"]}
                 for a in assigned]) + ("\n" if assigned else ""),
            encoding="utf-8", newline="\n")
        (stage_dir / "toc.md").write_text(textutil.build_toc(headings) + "\n",
                                          encoding="utf-8", newline="\n")

        h2 = [h for h in headings if h["level"] == 2]
        n_pages = len(textutil.page_blocks(raw))
        if len(h2) == 1 and n_pages > 10:
            self.warnings.append("整篇仅 1 个二级标题（疑似标题塌缩），请检查 organized.md")
        if len(assigned) < len(summaries):
            self.warnings.append(f"{len(summaries) - len(assigned)} 个摘要未能归属章节编号，已丢弃")
        log(f"[pass1] finalize：标题 {len(headings)}（## {len(h2)}）｜ 摘要 {len(assigned)}/{len(summaries)}")
        return {"headings": len(headings), "h2": len(h2),
                "summaries": len(assigned), "title": doc_title, "digest": digest}

    @staticmethod
    def _split_raw(raw: str):
        """顺序扫描：摘出 @@summary 块（携带所在 ## 标题），剔除全部 @@ 块。"""
        lines = raw.split("\n")
        out, summaries = [], []
        stray, unclosed, cur_h2, i = 0, False, None, 0
        while i < len(lines):
            s = lines[i].strip()
            if atblock.AT_END_RE.match(s):
                i += 1  # 孤立 @@end 丢弃
                continue
            m = atblock.AT_BLOCK_RE.match(s)
            if m:
                j, buf = i + 1, []
                while j < len(lines) and not atblock.AT_END_RE.match(lines[j].strip()):
                    buf.append(lines[j])
                    j += 1
                unclosed = unclosed or j >= len(lines)
                content = "\n".join(buf).strip()
                if m.group(1) == "summary" and content:
                    summaries.append({"h2": cur_h2, "content": content})
                else:
                    stray += 1
                i = j + 1
                continue
            hm = textutil.H_RE[2].match(lines[i])
            if hm:
                cur_h2 = hm.group(1).strip()
            out.append(lines[i])
            i += 1
        return out, summaries, stray, unclosed

    @staticmethod
    def _norm_title(t: str | None):
        if not t:
            return ""
        t = textutil.NUM_PREFIX_RE.sub(r"\2", t)
        t = re.sub(r"[（(]\s*p\.[^）)]*[）)]\s*$", "", t)
        return t.strip()

    def _assign_summaries(self, summaries, headings) -> list[dict]:
        h2 = [h for h in headings if h["level"] == 2]
        used: set[str] = set()
        assigned: list[dict] = []
        for sm in summaries:
            target = next((h for h in h2 if h["num"] not in used
                           and self._norm_title(h["title"]) == self._norm_title(sm["h2"])),
                          None)
            if target is None:
                target = next((h for h in h2 if h["num"] not in used), None)
            if target is None:
                continue
            used.add(target["num"])
            assigned.append({"num": target["num"], "content": sm["content"]})
        return assigned

    # 由 pipeline 注入（供 pass1_params 计算指纹）
    _org_pair = None

    def set_org_pair(self, org, summ):
        self._org_pair = (org, summ)
