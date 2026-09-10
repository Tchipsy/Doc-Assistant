"""@@ 块协议（纯函数）：解析 / 序列化 / 检查点截断 / 编号覆盖。

块格式（正文外的一切产物交换格式）：
    @@<组件名> [目标编号]
    （内容）
    @@end

组件名 = 插件名（pass2）或 summary（pass1）；目标编号 = 章节编号
（pass1 的 @@summary 无编号，由脚本按位置归属后补上）。
"""
import re

AT_END_RE = re.compile(r"^@@\s*end$", re.I)
AT_BLOCK_RE = re.compile(r"^@@([^\s@]+)(?:\s+(\S+))?\s*$")
NUM_RE = re.compile(r"\d+(?:\.\d+)*")


def parse_at_blocks(text: str):
    """解析 @@ 块。

    返回 (去除块后的残留文本, [ {type, target, content} ], 是否有未闭合块)。
    孤立的 @@end 丢弃；未闭合块的残内容归入残留文本。
    """
    lines = text.split("\n")
    out, blocks, cur = [], [], None
    for line in lines:
        s = line.strip()
        if cur is None:
            if AT_END_RE.match(s):
                continue  # 孤立 @@end，丢弃
            m = AT_BLOCK_RE.match(s)
            if m:
                cur = {"type": m.group(1), "target": m.group(2) or "", "buf": []}
                continue
            out.append(line)
        else:
            if AT_END_RE.match(s):
                blocks.append({"type": cur["type"], "target": cur["target"],
                               "content": "\n".join(cur["buf"]).strip()})
                cur = None
            else:
                # 块内又出现新块起始行：视为未闭合防护，继续按块内容收集
                cur["buf"].append(line)
    if cur is not None:
        out.append("@@" + cur["type"] + (f" {cur['target']}" if cur["target"] else ""))
        out.extend(cur["buf"])
    return "\n".join(out), blocks, cur is not None


def serialize_blocks(blocks) -> str:
    """块列表 -> @@ 文本（断点部件保留完整块用）。"""
    out = []
    for b in blocks:
        tag = f"@@{b['type']}" + (f" {b['target']}" if b.get("target") else "")
        out.append(f"{tag}\n{b['content']}\n@@end")
    return "\n\n".join(out)


def last_complete_block_cut(text: str, block_type: str) -> str | None:
    """截到最后一个完整闭合的指定类型块结束处（含该块）；无则 None。

    供 Pass1/Pass2 检查点定位"最后完整部分"。
    """
    lines = text.split("\n")
    last, inside = -1, False
    for i, l in enumerate(lines):
        s = l.strip()
        m = AT_BLOCK_RE.match(s)
        if inside and AT_END_RE.match(s):
            last, inside = i, False
        elif not inside and m:
            inside = m.group(1) == block_type
        elif inside and m:  # 块内嵌套块起始（异常输出）：切换判定
            inside = m.group(1) == block_type
    if last < 0:
        return None
    return "\n".join(lines[: last + 1])


def num_covered(num: str, done_keys) -> bool:
    """编号 num 是否已被覆盖：精确命中，或其任一祖先编号已整体完成。

    子编号（如 2.1.1）不能覆盖父节项（如 2）——父节其余子节仍未完成；
    反之父编号（如 2）整体完成后其子节项（2.1）视为已覆盖。
    """
    if num in done_keys:
        return True
    parts = num.split(".")
    return any(".".join(parts[:i]) in done_keys for i in range(1, len(parts)))


def valid_target(target: str) -> bool:
    """目标是否为合法章节编号（如 2、2.1、2.1.3）。"""
    return bool(re.fullmatch(r"\d+(?:\.\d+)*", target or ""))
