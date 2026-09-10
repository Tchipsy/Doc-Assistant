"""提示词装配：PromptSpec（DB/内置文本）-> Pass1/Pass2 系统提示词。

与老项目 promptkit 的差异：预设与插件不再从 prompts/ 目录加载，而是由
调用方传入文本（来自 SQLite presets 表）；内置提示词仍从 backend/prompts/
读取（common.md、organization/common.md、summary/summary.md）。

提示词目录结构（2026-09 步骤1 重构后）：
  prompts/common.md                      # pass1.input/output、pass1.title、pass2.*
  prompts/organization/common.md         # 按源类型的公共节：## 文档 / ## 网页（内置，不入库）
  prompts/organization/文档/*.md         # 整理预设（播种 group='doc'）
  prompts/organization/网页/*.md         # 整理预设（播种 group='web'）
  prompts/gen_content/where/*.md         # 生成位置（kind='where'，可含 ## meta coverage: leaf）
  prompts/gen_content/presets/*.md       # 内容生成预设（kind='plugin'，## requirements）
  prompts/summary/summary.md             # 节摘要（内置，不入库）
  prompts/tools/web.md                   # 预留（步骤4 启用）

内容生成预设不再自带 `## where`（生成位置），而是通过 presets.where_id 引用
独立的 kind='where' 预设；pass2 按 where_id 分组合并 LLM 调用。
"""
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

from engine.errors import DocumentAssistantError


@dataclass(frozen=True)
class PromptSpec:
    kind: str                      # organization | organization_common | summary | plugin | where
    name: str
    sha: str
    text: str
    sections: dict = field(default_factory=dict)
    where_id: str | None = None    # plugin 专用：引用的 kind='where' 预设 id
    where_text: str | None = None  # plugin 专用：where 预设的 ## where 文本（组装/分组用）

    def section(self, name: str) -> str:
        if name not in self.sections:
            raise DocumentAssistantError(
                f"提示词 {self.kind}/{self.name} 缺少小节 ## {name}")
        return self.sections[name]

    def meta(self) -> dict:
        raw = self.sections.get("meta", "")
        out = {}
        for line in raw.splitlines():
            line = line.strip()
            if line and ":" in line and not line.startswith("#"):
                k, _, v = line.partition(":")
                out[k.strip()] = v.strip()
        return out


def _sha256_of(text: str) -> str:
    return hashlib.sha256(text.replace("\r\n", "\n").encode("utf-8")).hexdigest()


def norm_ws(text: str) -> str:
    """归一化文本用于对比：去全部空白（含全角空格）、小写。"""
    return re.sub(r"[\s\u3000]+", "", text.replace("\r\n", "\n")).lower()


def _parse_sections(text: str) -> dict:
    sections: dict[str, str] = {}
    cur_name, cur_lines = None, []
    for line in text.split("\n"):
        if line.startswith("## ") and not line.startswith("###"):
            if cur_name is not None:
                sections[cur_name] = "\n".join(cur_lines).strip()
            cur_name, cur_lines = line[3:].strip(), []
        elif cur_name is not None:
            cur_lines.append(line)
    if cur_name is not None:
        sections[cur_name] = "\n".join(cur_lines).strip()
    return sections


def spec_from_text(kind: str, name: str, text: str, with_sections=False,
                   where_id: str | None = None,
                   where_text: str | None = None) -> PromptSpec:
    text = text.replace("\r\n", "\n")
    return PromptSpec(kind=kind, name=name, sha=_sha256_of(text), text=text,
                      sections=_parse_sections(text) if with_sections else {},
                      where_id=where_id, where_text=where_text)


def cut_section(text: str, name: str) -> tuple[str, str | None]:
    """从文本中删除 `## name` 小节（到下一个顶层 `## ` 行为止），其余原样保留。

    返回 (新文本, 被删小节全文 or None)。用于迁移：把插件内容里的 ## where 剥离。
    """
    lines = text.replace("\r\n", "\n").split("\n")
    out, removed, cutting = [], [], False
    for line in lines:
        if line.strip() == f"## {name}":
            cutting = True
            removed.append(line)
            continue
        if cutting and line.startswith("## ") and not line.startswith("###"):
            cutting = False
            out.append(line)
            continue
        (removed if cutting else out).append(line)
    new_text = "\n".join(out).strip("\n")
    if new_text:
        new_text += "\n"
    return new_text, ("\n".join(removed).strip() or None)


def cut_meta_keys(text: str, keys: set[str]) -> str:
    """删除 ## meta 小节中指定 key 的行；meta 被删空时整节删除（含前后空行）。"""
    text = text.replace("\r\n", "\n")
    lines = text.split("\n")
    start = None
    for i, line in enumerate(lines):
        if line.strip() == "## meta":
            start = i
            break
    if start is None:
        return text
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("## ") and not lines[j].startswith("###"):
            end = j
            break
    body = lines[start + 1:end]
    kept = [l for l in body if not (
        l.strip() and ":" in l and not l.strip().startswith("#")
        and l.strip().partition(":")[0].strip() in keys)]
    if any(l.strip() for l in kept):
        new_lines = lines[:start + 1] + kept + lines[end:]
    else:
        s = start
        while s > 0 and not lines[s - 1].strip():
            s -= 1
        new_lines = lines[:s] + lines[end:]
    out = "\n".join(new_lines).strip("\n")
    return out + "\n" if out else out


class BuiltinPrompts:
    """内置公共提示词（common.md / organization/common.md）与节摘要提示词。"""

    def __init__(self, prompts_dir):
        self.dir = Path(prompts_dir)

    def common_sections(self) -> dict:
        text = (self.dir / "common.md").read_text(encoding="utf-8")
        return _parse_sections(text.replace("\r\n", "\n"))

    def organization_common_sections(self) -> dict:
        """organization/common.md 的按源类型公共节：{'文档': ..., '网页': ...}。"""
        text = (self.dir / "organization" / "common.md").read_text(encoding="utf-8")
        return _parse_sections(text.replace("\r\n", "\n"))

    def summary_spec(self) -> PromptSpec:
        path = self.dir / "summary" / "summary.md"
        return spec_from_text("summary", "summary", path.read_text(encoding="utf-8"))

    def seed_presets(self) -> list[dict]:
        """启动播种清单（来自 prompts/ 目录，幂等由 settings_service.seed 保证）。

        返回项：{kind, group, name, display_name, content, seed_meta}。
        plugin 文件的 ## meta 可带 `name:`（内部名覆盖，如论文解析->paper）与
        `where:`（生成位置预设名）。`_test` 文件跳过。
        """
        out: list[dict] = []

        def scan(kind: str, group: str | None, sub: str):
            d = self.dir / sub
            if not d.is_dir():
                return
            for p in sorted(d.glob("*.md")):
                if "_test" in p.stem:
                    continue
                content = p.read_text(encoding="utf-8")
                item = {"kind": kind, "group": group, "name": p.stem,
                        "display_name": p.stem, "content": content, "seed_meta": {}}
                if kind == "plugin":
                    secs = _parse_sections(content.replace("\r\n", "\n"))
                    meta = {}
                    for line in secs.get("meta", "").splitlines():
                        s = line.strip()
                        if s and ":" in s and not s.startswith("#"):
                            k, _, v = s.partition(":")
                            meta[k.strip()] = v.strip()
                    item["seed_meta"] = meta
                    if meta.get("name"):
                        item["name"] = meta["name"].strip()
                out.append(item)

        scan("where", None, "gen_content/where")
        scan("organization", "doc", "organization/文档")
        scan("organization", "web", "organization/网页")
        scan("plugin", None, "gen_content/presets")
        return out


def plugin_groups(specs: list[PromptSpec]) -> list[tuple[str, list[PromptSpec]]]:
    """按生成位置分组（同组共享一次 LLM 调用）；保持首次出现顺序。

    优先按 where_id（重构后的引用方式）；无 where_id 的插件回退按自身
    ## where 小节文本归一化对比（兼容未迁移/自建预设）。
    """
    groups: list[tuple[str, list[PromptSpec]]] = []
    index: dict[str, int] = {}
    for p in specs:
        if p.where_text is not None and p.where_id:
            key, wtext = f"id:{p.where_id}", p.where_text
        else:
            try:
                wtext = p.section("where")
            except DocumentAssistantError:
                wtext = p.where_text or ""
            key = "own:" + norm_ws(wtext)
        if key in index:
            groups[index[key]][1].append(p)
        else:
            index[key] = len(groups)
            groups.append((wtext, [p]))
    return groups


def requirements_text(p: PromptSpec) -> str:
    """插件的内容要求文本：## requirements 小节，缺失时退化为整篇。"""
    try:
        return p.section("requirements").strip()
    except DocumentAssistantError:
        return p.text.strip()


def pass1_system(common: dict, org_common_text: str, org: PromptSpec,
                 summ: PromptSpec) -> str:
    """Pass1 系统提示词：公共输入/输出契约 + 按源类型的公共节 + 整理预设 + 摘要。"""
    return "\n\n".join([
        common["pass1.input"].strip(),
        common["pass1.output"].strip(),
        org_common_text.strip(),
        "以下内容在整理讲义正文时需遵循：\n" + org.text.strip(),
        "以下内容在每个二级标题（##）节闭合、生成节摘要时需遵循：\n" + summ.text.strip(),
    ])


def pass2_system(common: dict, where_text: str, group: list[PromptSpec],
                 cross_doc_text: str | None = None,
                 web_text: str | None = None) -> str:
    """Pass2 系统提示词：persona + 输入/输出契约 + 生成位置要求 + 各插件内容要求。

    cross_doc_text（步骤3）：跨文档查询协议文本（common.md ## pass2.tools.crossDoc
    小节 + 概况清单已替换组装好），非 None 时追加在尾部并意味着启用工具循环。
    web_text（步骤4）：联网搜索协议文本（common.md ## pass2.tools.web 小节），
    与 cross_doc 可同时启用。
    """
    names = "、".join(f"@@{p.name}" for p in group)
    req_blocks = [f"（组件 @@{p.name}）\n{requirements_text(p)}" for p in group]
    parts = [
        common["pass2.persona"].strip(),
        common["pass2.input"].strip(),
        (common["pass2.output"].strip()
         + f"\n6. 本次启用的组件：{names}；只允许输出这些类型的块。"),
        "生成位置要求：\n" + (where_text or "").strip(),
        "各组件的内容要求：\n\n" + "\n\n".join(req_blocks),
    ]
    if cross_doc_text:
        parts.append(cross_doc_text.strip())
    if web_text:
        parts.append(web_text.strip())
    return "\n\n".join(parts)
