"""流式解析器：把 LLM delta 流实时解析为组件树操作。

debug6（2026-09-07）字符级状态机：feed 逐字符推进，普通文本**逐 LLM-chunk 直通**
（tree.append_md 当前目标节点），仅"最小拦截集"整行缓冲后走 _line 分发——
@@ 行（块创建/闭合/捕获）、##/###/#### 标题行、![/<img 图片行、<!-- 页标记行、
```/~~~ 围栏开关行。行首判定（含前导空白扣留）在字符粒度进行：结构前缀的
真前缀（@、#、!、<、`、~、纯空白等）扣留到可判定，chunk 劈开结构前缀安全；
判定为普通文本后本行不再拦截，剩余字符与换行符随流直达。cap 捕获态、杂散块
（in_other_block）、pass2 块外/重复块无直通目标，维持整行缓冲（分发后进
cap_buf/丢弃）。

直通行行末做一次"图片校正"：旧实现对 _append_body 路径的每一行做行级图片
重写/丢弃（_rewrite_img / show_images=False 整行丢弃），直通无法在行首预知
行中图片语法，故行末若发现差异则用 set_md 一次性修正（截回行起始 md 长度
后重写/截除）——保证最终 md 与旧行缓冲实现**逐字节一致**。拦截行仍走 _line
原路径无需校正；框内行旧实现本就不做图片处理，同样不校正。

Pass1：标题行 -> 建节 + 目录条目（增量编号与 finalize 同算法）；
@@summary 块 -> 当前节挂摘要框；页标记整行转零高页锚点 span 追加当前节
（debug2 #1 起，与 build.py 产物树同语义）；图片引用重写。
Pass2：块外内容丢弃；@@<插件> <编号> 块 -> 对应节挂插件框。

state_snapshot/restore_state 纳入状态机新增字段（mode/line_acc/line_buf/
stream_*），ContextOverflow 回滚不错位；flush() 由 gen_service 在 pass1/pass2
各自流收尾调用（修掉"尾行滞留"存量 bug——旧 flush 无任何调用方）。
"""
import re

from engine import atblock, textutil

FENCE_RE = textutil.FENCE_RE
PAGE_RE = textutil.PAGE_RE
MD_IMG_RE = re.compile(r'(!\[[^\]]*\]\()([^)\s]+)(\))')
HTML_IMG_RE = re.compile(r'(<img\b[^>]*?\bsrc\s*=)(["\'])([^"\']*)(\2)', re.I)

# ---------------- 字符级状态机（debug6） ----------------
MODE_NORMAL = "normal"   # 行首判定中：line_acc 扣留未决前缀
MODE_LINE = "line"       # 整行缓冲：line_buf 累积至 \n 后走 _line 分发
MODE_STREAM = "stream"   # 直通中：本行剩余字符逐段 append 当前目标节点
_WS = " \t\v\f\r"        # 行首可扣留的空白（\n 是行终结符单独处理）


def _leading_ws(s: str) -> int:
    i = 0
    while i < len(s) and s[i] in _WS:
        i += 1
    return i


def _verdict_fence(rest: str) -> str:
    """rest（去行首空白后）：```/~~~ 围栏开关行判定。返回 S（拦截分发）/
    U（继续扣留）/ P（判定为普通文本，可直通）。"""
    run = len(rest) - len(rest.lstrip("`~"))
    if run == 0:
        return "P"
    if run >= 3:
        return "S"
    return "U" if len(rest) == run else "P"   # "`x"/"~~x" 已不可构成开关行


def _verdict_angle(rest: str) -> str:
    """rest：<!--（页标记/注释行）或 <img（HTML 图片行）判定。"""
    if rest.startswith(("<img", "<!--")):
        return "S"
    if "<img".startswith(rest) or "<!--".startswith(rest):
        return "U"
    return "P"


def _verdict_at(rest: str) -> str:
    """rest：@@ 块行判定（@@ 开头即拦截；_line 的正则锚定 strip 后文本）。"""
    if rest.startswith("@@"):
        return "S"
    if rest == "@":
        return "U"
    return "P"


def _verdict_bang(rest: str) -> str:
    """rest：![ md 图片行判定。"""
    if rest.startswith("!["):
        return "S"
    if rest == "!":
        return "U"
    return "P"


def _verdict_hash(rest: str) -> str:
    """rest：##/###/#### 标题行判定（仅限真正行首——带前导空白的 # 不是标题）。"""
    run = len(rest) - len(rest.lstrip("#"))
    if run == 0:
        return "P"
    if run >= 2:
        return "S"
    return "U" if len(rest) == 1 else "P"   # "#x" 已不可构成标题


def _rewrite_img(line: str, files_base: str) -> str:
    def _md(m):
        ref = m.group(2)
        if ref.startswith(("<", "http", "https:", "data:", "//")):
            return m.group(0)
        return f"{m.group(1)}{files_base}/{ref}{m.group(3)}"

    def _html(m):
        ref = m.group(3)
        if ref.startswith(("http", "data:", "//")):
            return m.group(0)
        return f"{m.group(1)}{m.group(2)}{files_base}/{ref}{m.group(4)}"

    line = MD_IMG_RE.sub(_md, line)
    return HTML_IMG_RE.sub(_html, line)


def _is_img_line(line: str) -> bool:
    s = line.strip()
    return bool(MD_IMG_RE.search(s) or HTML_IMG_RE.search(s) or "<img" in s.lower())


class _CharStreamParser:
    """字符级状态机公共骨架（debug6）。

    feed 逐字符推进：
      MODE_LINE   —— 累积至 \\n 后 _line 分发（语义与旧全行缓冲完全一致）；
      MODE_STREAM —— 直通：字符进段缓冲 _seg，行尾（\\n）落地 + 图片校正；
      MODE_NORMAL —— 行首判定：line_acc 逐字符扣留，_classify 命中 S/B 转
                     MODE_LINE、P 转 MODE_STREAM（前缀随首段一并直通）。
    直通段在 chunk 边界（feed 返回前）落地一次 append——直通粒度 = LLM chunk。
    """

    def _init_char_state(self):
        self.mode = MODE_NORMAL
        self.line_acc = ""       # 行首扣留的未决前缀（不含 \n）
        self.line_buf = ""       # 整行缓冲中的行（不含 \n）
        self.stream_line = ""    # 直通中的行（含已流出全部字符；\n 并入后即闭合）
        self._seg: list[str] = []            # 待落地直通段（chunk 边界 flush）
        self._seg_target: str | None = None  # 当前直通行目标节点

    # ---- 子类钩子 ----
    def _classify(self, acc: str) -> str:
        raise NotImplementedError

    def _can_stream(self) -> bool:
        raise NotImplementedError

    def _begin_stream(self, prefix: str):
        raise NotImplementedError

    def _close_stream_line(self):
        raise NotImplementedError

    # ---- 公共推进 ----
    def feed(self, text: str):
        for ch in text:
            if self.mode == MODE_LINE:
                if ch == "\n":
                    line, self.line_buf = self.line_buf, ""
                    self.mode = MODE_NORMAL
                    self._line(line)
                else:
                    self.line_buf += ch
            elif self.mode == MODE_STREAM:
                self._seg.append(ch)
                self.stream_line += ch
                if ch == "\n":
                    self._close_stream_line()
            elif ch == "\n":
                # 行首即换行（空行），或扣留前缀遇行尾：无直通态走分发（与旧
                # 实现 _line(buf) 尾行语义一致），有直通态照常落流
                acc = self.line_acc
                self.line_acc = ""
                if self._can_stream():
                    self._begin_stream(acc)
                    self._seg.append("\n")
                    self.stream_line += "\n"
                    self._close_stream_line()
                else:
                    self._line(acc)
            else:
                self.line_acc += ch
                v = self._classify(self.line_acc)
                if v == "U":
                    continue
                if v == "P":
                    self._begin_stream(self.line_acc)
                    self.line_acc = ""
                else:   # S/B：整行缓冲分发
                    self.mode = MODE_LINE
                    self.line_buf = self.line_acc
                    self.line_acc = ""
        self._flush_segment()   # chunk 粒度落地（一次 append 一段）

    def flush(self):
        """流收尾：落地扣留中的行/字符与直通行尾（gen_service 在 pass1/pass2
        各流结束后调用——修复旧实现"尾行滞留"存量 bug）。"""
        self._flush_segment()
        if self.mode == MODE_STREAM:
            if self.stream_line and not self.stream_line.endswith("\n"):
                self._seg.append("\n")   # 补行尾换行（与行分发语义一致）
                self.stream_line += "\n"
            self._close_stream_line()
        if self.mode == MODE_LINE:
            if self.line_buf:
                self._line(self.line_buf)
            self.line_buf = ""
            self.mode = MODE_NORMAL
        if self.mode == MODE_NORMAL and self.line_acc:
            acc = self.line_acc
            self.line_acc = ""
            if self._can_stream():
                self._begin_stream(acc)
                self._seg.append("\n")
                self.stream_line += "\n"
                self._close_stream_line()
            else:
                self._line(acc)
        self._flush_segment()

    def _flush_segment(self):
        if self._seg:
            text = "".join(self._seg)
            self._seg = []
            self.tree.append_md(self._seg_target, text)


class Pass1StreamParser(_CharStreamParser):
    def __init__(self, tree, files_base: str, show_toc=True, show_images=True,
                 on_recovery_point=None):
        self.tree = tree
        self.files_base = files_base.rstrip("/")
        self.show_toc = show_toc
        self.show_images = show_images
        self.on_recovery_point = on_recovery_point or (lambda: None)
        self.in_fence = False
        self.cur_section: str | None = None
        self.section_by_num: dict[str, str] = {}
        self.c2 = self.c3 = self.c4 = 0
        self.toc_id: str | None = None
        self.box: str | None = None          # 当前 summary 框
        self.in_other_block = False          # 非 summary 块（丢弃）
        # debug3（#4）：@@title/@@digest 信息块（pass1 输出最开头，仅首个内容前生效）
        # title 块闭合 → 即时 update title 节点 props.title（pass1 第一屏即见标题）；
        # digest 只捕获不显示（meta 落盘由引擎 finalize 承担）；正文开始后出现的
        # title/digest 块（后续窗口/违规输出）走杂散块路径丢弃。
        self.title_id: str | None = next(
            (nid for nid, n in tree.nodes.items() if n.get("type") == "title"), None)
        self.cap: str | None = None          # None | "title" | "digest"（块捕获态）
        self.cap_buf: list[str] = []
        self.saw_content = False             # 已输出任何正文/标题 → 不再采信信息块
        if show_toc:
            self.toc_id = tree.insert("toc", parent="root",
                                      props={"title": "目录"})
        # debug6：直通行行末图片校正状态
        self.stream_start = 0    # 直通行起始时目标节点 md 长度
        self.stream_fix = False  # 直通行是否需要行末校正（box 内行不需要）
        self._init_char_state()

    # ---------------- 状态快照（回滚用） ----------------
    def state_snapshot(self):
        return {"in_fence": self.in_fence,
                "cur_section": self.cur_section,
                "section_by_num": dict(self.section_by_num),
                "c2": self.c2, "c3": self.c3, "c4": self.c4,
                "toc_id": self.toc_id, "box": self.box,
                "in_other_block": self.in_other_block,
                "title_id": self.title_id, "cap": self.cap,
                "cap_buf": list(self.cap_buf), "saw_content": self.saw_content,
                # debug6：字符级状态机字段
                "mode": self.mode, "line_acc": self.line_acc,
                "line_buf": self.line_buf, "stream_line": self.stream_line,
                "stream_start": self.stream_start, "stream_fix": self.stream_fix,
                "stream_target": self._seg_target}

    def restore_state(self, st: dict):
        self.in_fence = st["in_fence"]
        self.cur_section = st["cur_section"]
        self.section_by_num = dict(st["section_by_num"])
        self.c2, self.c3, self.c4 = st["c2"], st["c3"], st["c4"]
        self.toc_id = st["toc_id"]
        self.box = st["box"]
        self.in_other_block = st["in_other_block"]
        self.title_id = st.get("title_id")
        self.cap = st.get("cap")
        self.cap_buf = list(st.get("cap_buf") or [])
        self.saw_content = bool(st.get("saw_content"))
        # debug6：字符级状态机字段（旧快照缺省回落 NORMAL，语义等价行缓冲清空）
        self.mode = st.get("mode", MODE_NORMAL)
        self.line_acc = st.get("line_acc", "")
        self.line_buf = st.get("line_buf", "")
        self.stream_line = st.get("stream_line", "")
        self.stream_start = st.get("stream_start", 0)
        self.stream_fix = bool(st.get("stream_fix", False))
        self._seg_target = st.get("stream_target")
        self._seg = []

    # ---------------- 行首判定（debug6） ----------------
    def _classify(self, acc: str) -> str:
        """返回 S（整行缓冲分发）/ U（继续扣留）/ P（普通文本，直通）。
        判定顺序与 _line 的分支顺序一致（围栏 → 页标记/图片 → cap → box →
        AT 块 → 标题 → 正文），保证拦截的超集安全：多拦的行走 _line 分发后
        产出与旧实现逐字节一致的结果。"""
        ws = _leading_ws(acc)
        rest = acc[ws:]
        if not rest:
            return "U"
        v = _verdict_fence(rest)
        if v != "P":
            return v
        v = _verdict_angle(rest)
        if v != "P":
            return v
        if self.in_fence:
            # 围栏内：页标记与 @@ 行原样入正文（_line 首支先于一切），仅围栏
            # 闭合行与图片行需拦截分发（图片行走 _append_body 的重写/丢弃）
            return _verdict_bang(rest)
        if self.cap is not None or self.in_other_block:
            return "B"    # 捕获态/杂散块：整行缓冲（分发后进 cap_buf / 丢弃）
        if self.box is not None:
            return _verdict_at(rest)   # 框内仅 @@ 行需分发（闭合；其余字面入框）
        if ws:
            # 行首空白：围栏/<!-- 已判定；@@ 与 ![ 剥离空白后仍识别
            # （AT/PAGE/图片判定锚定 strip 后文本），标题必须顶格（H_RE 锚 ^##）
            if rest[0] == "@":
                return _verdict_at(rest)
            if rest[0] == "!":
                return _verdict_bang(rest)
            return "P"
        v = _verdict_at(rest)
        if v != "P":
            return v
        v = _verdict_bang(rest)
        if v != "P":
            return v
        return _verdict_hash(rest)

    def _can_stream(self) -> bool:
        # cap 捕获 / 杂散块丢弃：无直通目标，整行缓冲
        return self.cap is None and not self.in_other_block

    def _begin_stream(self, prefix: str):
        """进入直通行：解析当前目标（与 _append_body 落点一致）并记录行起始
        md 长度（行末图片校正用）。"""
        self.mode = MODE_STREAM
        self.stream_line = prefix
        self._seg = [prefix]
        if self.box is not None:
            self._seg_target = self.box
            self.stream_fix = False   # 框内行不做图片处理（与旧实现一致）
        else:
            self.saw_content = True
            if self.cur_section is None:
                # 前言（首个标题前的正文）
                self.cur_section = self.tree.insert(
                    "section", parent="root",
                    props={"num": "", "level": 0, "title": "",
                           "anchor": "organized:pre"})
            self._seg_target = self.cur_section
            self.stream_fix = True
            self.stream_start = len(
                self.tree.nodes[self._seg_target].get("md") or "")

    def _close_stream_line(self):
        self._flush_segment()
        line = self.stream_line[:-1]   # 去行尾 \n
        if self.stream_fix and line:
            # 行末图片校正：与 _append_body 的行级图片处理逐字节对齐
            if not self.show_images and _is_img_line(line):
                md = self.tree.nodes[self._seg_target].get("md") or ""
                self.tree.set_md(self._seg_target, md[:self.stream_start])
            else:
                rw = _rewrite_img(line, self.files_base)
                if rw != line:
                    md = self.tree.nodes[self._seg_target].get("md") or ""
                    self.tree.set_md(self._seg_target,
                                     md[:self.stream_start] + rw + "\n")
        self.stream_line = ""
        self.stream_start = 0
        self.mode = MODE_NORMAL

    # ---------------- 行分发（语义与旧实现一致，勿动） ----------------
    def _line(self, line: str):
        s = line.strip()
        if self.in_fence:
            if FENCE_RE.match(line):
                self.in_fence = False
            self._append_body(line)
            return
        if FENCE_RE.match(line):
            self.in_fence = True
            self._append_body(line)
            return
        if PAGE_RE.match(s):
            # debug2 #1：页标记整行不再丢弃——转为零高页码锚点行，走 _append_body
            # 追加当前节（与 build.py 产物树 _markers_to_spans 同语义：span 行落入
            # 标记所在当前节）。生成中实时预览由此获得页锚点，双窗口同步滚动在
            # 生成中即可用。span 非图片行，_append_body 的 show_images 过滤天然跳过；
            # fence 内已在上方处理（原样入正文），不会到这里。
            pm = PAGE_RE.match(s)
            self._append_body(
                f'<span class="page-anchor" data-page="{pm.group(1)}"></span>')
            return
        if self.cap is not None:
            # debug3：@@title/@@digest 块内容捕获中（不发任何树事件）
            if atblock.AT_END_RE.match(s):
                self._cap_done()
                return
            self.cap_buf.append(line)
            return
        if self.box is not None or self.in_other_block:
            if atblock.AT_END_RE.match(s):
                self.box = None
                self.in_other_block = False
                self.on_recovery_point()   # 完整块闭合 = 可回滚的安全点
                return
            if self.box is not None:
                self.tree.append_md(self.box, line + "\n")
            return
        if atblock.AT_END_RE.match(s):
            return  # 孤立 @@end 丢弃
        m = atblock.AT_BLOCK_RE.match(s)
        if m:
            if m.group(1) in ("title", "digest") and not self.saw_content:
                self.cap = m.group(1)      # debug3：信息块捕获（仅首个内容前生效）
                self.cap_buf = []
            elif m.group(1) == "summary":
                props = {}
                if self.cur_section is not None:
                    num = self.tree.nodes[self.cur_section]["props"].get("num", "")
                    props = {"anchor": f"summary:{num}", "num": num}
                self.box = self.tree.insert("summary_box", parent=self.cur_section or "root",
                                            props=props)
            else:
                self.in_other_block = True   # 杂散块：丢弃内容
            return
        # 标题行
        for k in (2, 3, 4):
            hm = textutil.H_RE[k].match(line)
            if hm:
                self._heading(k, hm.group(1))
                return
        self._append_body(line)

    def _cap_done(self):
        """信息块闭合：@@title → 即时 update title 节点（上屏进度感）；
        @@digest 只捕获不显示（meta 落盘由引擎 finalize 承担）。"""
        name, buf = self.cap, self.cap_buf
        self.cap, self.cap_buf = None, []
        val = " ".join("\n".join(buf).split())
        if name == "title" and val:
            if self.title_id is None:
                # 防御：begin_pass1 未插节点（异常路径）——插入保底（正常流程不会走到）
                self.title_id = self.tree.insert("title", parent="root",
                                                 props={"title": val})
            else:
                self.tree.update(self.title_id, {"title": val})

    def _heading(self, level: int, raw_title: str):
        self.saw_content = True   # debug3：正文已开始——其后出现的 @@title/@@digest 一律按杂散块丢弃
        title = textutil.NUM_PREFIX_RE.sub(r"\2", raw_title).strip()
        if level == 2:
            self.c2 += 1
            self.c3 = self.c4 = 0
            num = f"{self.c2}"
        elif level == 3:
            self.c3 += 1
            self.c4 = 0
            num = f"{self.c2}.{self.c3}"
        else:
            self.c4 += 1
            num = f"{self.c2}.{self.c3}.{self.c4}"
        sid = self.tree.insert("section", parent="root",
                               props={"num": num, "level": level, "title": title,
                                      "anchor": f"organized:{num}"})
        self.cur_section = sid
        self.section_by_num[num] = sid
        if self.show_toc and self.toc_id:
            self.tree.insert("toc_entry", parent=self.toc_id,
                             props={"num": num, "title": title, "target": sid})

    def _append_body(self, line: str):
        self.saw_content = True   # debug3：正文已开始——其后出现的 @@title/@@digest 一律按杂散块丢弃
        if self.box is not None:
            self.tree.append_md(self.box, line + "\n")
            return
        if not self.show_images and _is_img_line(line):
            return
        if self.cur_section is None:
            # 前言（首个标题前的正文）
            sid = self.tree.insert("section", parent="root",
                                   props={"num": "", "level": 0, "title": "",
                                          "anchor": "organized:pre"})
            self.cur_section = sid
        line = _rewrite_img(line, self.files_base)
        self.tree.append_md(self.cur_section, line + "\n")


class Pass2StreamParser(_CharStreamParser):
    def __init__(self, tree, enabled_plugins: set[str], on_recovery_point=None):
        self.tree = tree
        self.enabled = set(enabled_plugins)
        self.on_recovery_point = on_recovery_point or (lambda: None)
        self.box: str | None = None
        self.cur_plugin = ""
        self.cur_num = ""
        self._seen: set[tuple[str, str]] = set()   # (plugin, num) 去重（保留首个）
        self._skip_block = False                    # 重复块：丢弃
        self.section_by_num: dict[str, str] = {}
        for nid, node in tree.nodes.items():
            if node["type"] == "section":
                num = node["props"].get("num") or ""
                if num:
                    self.section_by_num[num] = nid
        self._init_char_state()

    def state_snapshot(self):
        return {"box": self.box, "cur_plugin": self.cur_plugin,
                "cur_num": self.cur_num, "_seen": set(self._seen),
                "_skip_block": self._skip_block,
                "section_by_num": dict(self.section_by_num),
                # debug6：字符级状态机字段
                "mode": self.mode, "line_acc": self.line_acc,
                "line_buf": self.line_buf, "stream_line": self.stream_line,
                "stream_target": self._seg_target}

    def restore_state(self, st: dict):
        self.box = st["box"]
        self.cur_plugin = st["cur_plugin"]
        self.cur_num = st["cur_num"]
        self._seen = set(st["_seen"])
        self._skip_block = st["_skip_block"]
        self.section_by_num = dict(st["section_by_num"])
        # debug6：字符级状态机字段
        self.mode = st.get("mode", MODE_NORMAL)
        self.line_acc = st.get("line_acc", "")
        self.line_buf = st.get("line_buf", "")
        self.stream_line = st.get("stream_line", "")
        self._seg_target = st.get("stream_target")
        self._seg = []

    # ---------------- 行首判定（debug6） ----------------
    def _classify(self, acc: str) -> str:
        ws = _leading_ws(acc)
        rest = acc[ws:]
        if not rest:
            return "U"
        if self.box is None or self._skip_block:
            return "B"    # 块外/重复块：整行缓冲（@@ 行建框/置跳过，其余丢弃）
        return _verdict_at(rest)   # 框内仅 @@ 行需分发（@@end 闭合；其余字面入框）

    def _can_stream(self) -> bool:
        return self.box is not None   # 块外内容丢弃，无直通目标

    def _begin_stream(self, prefix: str):
        self.mode = MODE_STREAM
        self.stream_line = prefix
        self._seg = [prefix]
        self._seg_target = self.box

    def _close_stream_line(self):
        # pass2 框内容为字面 append（无图片处理），无需行末校正
        self._flush_segment()
        self.stream_line = ""
        self.mode = MODE_NORMAL

    # ---------------- 行分发（语义与旧实现一致，勿动） ----------------
    def _line(self, line: str):
        s = line.strip()
        if self.box is not None or self._skip_block:
            if atblock.AT_END_RE.match(s):
                self.box = None
                self._skip_block = False
                self.on_recovery_point()   # 完整块闭合 = 可回滚的安全点
                return
            if self.box is not None:
                self.tree.append_md(self.box, line + "\n")
            return
        if atblock.AT_END_RE.match(s):
            return
        m = atblock.AT_BLOCK_RE.match(s)
        if m:
            name, num = m.group(1), m.group(2) or ""
            if name not in self.enabled:
                self._skip_block = True          # 未知插件块：丢弃
                return
            if (name, num) in self._seen:
                self._skip_block = True          # 重复块：丢弃
                return
            self._seen.add((name, num))
            self.cur_plugin, self.cur_num = name, num
            parent = self.section_by_num.get(num, "root")
            self.box = self.tree.insert(
                "plugin_box", parent=parent,
                props={"plugin": name, "num": num,
                       "anchor": f"plugin:{name}:{num}"})
            return
        # 块外内容：丢弃（与 atblock 语义一致）
