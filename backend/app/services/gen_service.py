"""生成域：生成配置应用（增量决策）+ pass1/pass2 执行 + 实时渲染接线。

增量决策（与指纹三态一致）：
- 新预设目录 / 预设内容修改 / organized 缺失 / force -> pass1 + 全部 pass2；
- 预设未变、仅新增（或内容修改）插件 -> 只跑受影响分组 pass2；
- 全部有效 -> 不生成，直接渲染产物。

debug3（3.7，#4 用户定案）：标题+简介不再由 pass1 前的独立小调用生成——
pass1 窗口1 输出最开头先输出 @@title/@@digest 信息块（提示词契约见
prompts/common.md ## pass1.output），引擎剥离后写 .meta.json 的 title/digest；
缺块回退现状逻辑（pdf2md 首个 `# `→文件名），不阻塞生成。
"""
import json
import os
import shutil
import threading
import time
from pathlib import Path

from app import db, paths, pauses, websearch
from app.events import bus, emit
from app.jobs import manager
from app.liveview import (build_tree_from_artifacts, get_or_create_session,
                          drop_session, live_sessions)
from app.services import kb_service, settings_service, snapshot_service
from engine import atblock, meta as meta_mod, textutil
from engine.config import (ORGANIZE_BATCH_TOKENS, PASS2_BATCH_TOKENS, log,
                           read_text_guess)
from engine.llm import LLMClient, PASS2_TOOLS_SPEC
from engine.pass1 import Pass1Engine
from engine.pass2 import Pass2Engine
from engine.promptkit import (plugin_groups, pass1_system, pass2_system,
                              spec_from_text)

_PASS1_FILES = ("organized.md", "summary.md", "toc.md")


def default_gen_config() -> dict:
    orgs = settings_service.list_presets("organization")
    return {
        "presetId": orgs[0]["id"] if orgs else "",
        "organizeModel": None,
        "contentModel": None,
        "components": {"toc": True, "summary": True, "images": True},
        "plugins": [],
        # 步骤3/4 生成工具：跨文档查询（本步启用）；联网搜索（步骤4 启用，仅占位）
        "tools": {"crossDocSearch": False, "webSearch": False},
    }


def _pass1_common_spec():
    """common.md 的 pass1 契约节 PromptSpec（pass1.input+pass1.output 拼接）。

    debug3：参与 pass1 指纹（meta.pass1_params common=）——契约改动使全部
    文档 pass1 指纹失效重跑一次（与系统提示词实际变化一致）。"""
    secs = settings_service.builtin.common_sections()
    return spec_from_text("common", "common", "\n\n".join(
        [secs.get("pass1.input", ""), secs.get("pass1.output", "")]))


# ---------------- 进程内产物缓存（KB 概况 / 工具读取，文件变更自动失效） ----------------
_TOOL_CACHE: dict[str, tuple[tuple, object]] = {}
_tool_cache_lock = threading.Lock()


def _cached_file_value(path: Path, builder):
    """按 (mtime_ns, size) 缓存 builder() 结果；pass1 产物重写后自动失效。"""
    key = str(path)
    try:
        st = Path(path).stat()
        sig = (st.st_mtime_ns, st.st_size)
    except OSError:
        return None
    with _tool_cache_lock:
        hit = _TOOL_CACHE.get(key)
        if hit is not None and hit[0] == sig:
            return hit[1]
    value = builder()
    with _tool_cache_lock:
        _TOOL_CACHE[key] = (sig, value)
    return value


def _doc_meta_brief(stage_dir: Path) -> tuple[str | None, str | None]:
    """(title, digest)——KB 概况数据源（步骤1 的 .meta.json title/digest）。"""
    def build():
        p = Path(stage_dir) / ".meta.json"
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return (None, None)
        return (data.get("title"), data.get("digest"))
    out = _cached_file_value(Path(stage_dir) / ".meta.json", build)
    return out if out is not None else (None, None)


def _section_titles(stage_dir: Path) -> dict[str, str]:
    """organized.md 编号 -> 节标题（kb_summary 拼装用）。"""
    def build():
        f = Path(stage_dir) / "organized.md"
        if not f.is_file():
            return {}
        text = read_text_guess(f).replace("\r\n", "\n")
        text, _ = textutil.strip_page_markers(text)
        _, headings = textutil.number_headings(text)
        return {h["num"]: h["title"] for h in headings if h.get("num")}
    return _cached_file_value(Path(stage_dir) / "organized.md", build) or {}


def _kb_summary_text(stage_dir: Path) -> str:
    """各节 summary 拼装（kb_summary 工具）：### <节标题>\n<摘要>，不含正文。"""
    def build():
        f = Path(stage_dir) / "summary.md"
        if not f.is_file():
            return ""
        _, blocks, _ = atblock.parse_at_blocks(read_text_guess(f))
        titles = _section_titles(stage_dir)
        out = []
        for b in blocks:
            if b["type"] != "summary" or not b["content"]:
                continue
            label = titles.get(b["target"], b["target"] or "（未编号节）")
            out.append(f"### {label}\n{b['content'].strip()}")
        return "\n\n".join(out)
    return _cached_file_value(Path(stage_dir) / "summary.md", build) or ""


def _backup_clear(stage_dir: Path, names: list[str]):
    backup = stage_dir / ".backup" / f"{time.strftime('%Y%m%d-%H%M%S')}-p{os.getpid()}"
    for n in names:
        f = stage_dir / n
        if f.exists():
            backup.mkdir(parents=True, exist_ok=True)
            shutil.move(str(f), str(backup / n))


def _plugin_names(plugin_ids: list[str]) -> list[str]:
    names = []
    for pid in plugin_ids:
        p = settings_service.get_preset(pid)
        if p is not None:
            names.append(p["name"])
    return names


class GenService:

    # ---------------- 配置应用入口 ----------------
    def save_gen_config(self, doc_ids: list[str], cfg_patch: dict) -> None:
        """只保存配置，不启动任务（执行由 /documents/generate 触发）。
        步骤9：保存后做指纹判定——无新产物需生成（纯显示配置变化）→ 立即重建快照；
        会触发重跑 → 不单独建快照，等生成完成后走 done 触发。"""
        for did in doc_ids:
            cur = (kb_service.get_doc(did) or {}).get("genConfig") or {}
            merged = {**default_gen_config(), **cur, **(cfg_patch or {})}
            kb_service.save_gen_config(did, merged)
            self._maybe_snapshot(did)

    def _maybe_snapshot(self, doc_id: str) -> None:
        """保存配置后的快照触发（步骤9）：generation_would_rerun()==False 时入队。
        判定失败/需重跑均不入队——快路径 miss 也会兜底补建。"""
        try:
            if self.generation_would_rerun(doc_id) is False:
                snapshot_service.enqueue(doc_id)
        except Exception as e:  # noqa: BLE001  触发失败不影响配置保存
            log(f"[snapshot] ⚠️ {doc_id} 配置保存后快照触发失败：{type(e).__name__}: {e}")

    def generation_would_rerun(self, doc_id: str) -> bool | None:
        """当前已保存配置下再执行生成是否会重跑 pass1/pass2（步骤9 触发判定，
        只读无副作用；指纹口径与 _prepare/_pass2_part 一致）。

        True=有新产物要生成（等生成完成后重建快照）；False=纯显示配置变化
        （产物不变，可立即重建快照）；None=无法判定（文档/预设/pdf2md 缺失）。"""
        d = kb_service.raw_doc(doc_id)
        if d is None:
            return None
        # 步骤11 配置继承：按生效配置判定（继承中的文档按库默认的 presetId 找产物）
        cfg = kb_service.resolve_effective_config(d, "gen")
        if not cfg.get("presetId"):
            return None
        sdir = paths.stage_dir(d["kb_id"], doc_id, cfg["presetId"])
        pdf2md = paths.doc_dir(d["kb_id"], doc_id) / "pdf2md.md"
        if not pdf2md.is_file():
            return None
        try:
            org_spec = settings_service.preset_spec(cfg["presetId"], "organization")
            summ_spec = settings_service.builtin.summary_spec()
            org_group = "doc" if (settings_service.get_preset(cfg["presetId"]) or {}
                                  ).get("group") != "web" else "web"
            org_common_text = settings_service.builtin.organization_common_sections().get(
                "文档" if org_group == "doc" else "网页", "")
            org_common_spec = spec_from_text("organization_common", org_group,
                                             org_common_text)
            org_model = settings_service.resolve_model(cfg.get("organizeModel"),
                                                       "organize")
            dm = meta_mod.DocMeta(sdir)
            p1_params = meta_mod.pass1_params(pdf2md, org_spec, summ_spec,
                                              ORGANIZE_BATCH_TOKENS,
                                              org_model["model"],
                                              org_common=org_common_spec,
                                              common=_pass1_common_spec())
            if not (dm.stage_ok("pass1", p1_params)
                    and all((sdir / f).is_file() for f in _PASS1_FILES)):
                return True
            # pass2 分组（显示 ∪ 入库启用插件），与 _pass2_part 同一指纹判定
            plugin_ids = list(cfg.get("plugins", []))
            # 步骤11：入库配置按生效配置解析（继承中的文档=库默认对应类型）
            idx_cfg = kb_service.resolve_effective_config(d, "index")
            from app.services import index_service
            if index_service.index_enabled(idx_cfg):
                for p in idx_cfg.get("plugins", []):
                    if p not in plugin_ids:
                        plugin_ids.append(p)
            specs = []
            for pid in plugin_ids:
                try:
                    specs.append(settings_service.preset_spec(pid, "plugin"))
                except KeyError:
                    continue
            gen_model = settings_service.resolve_model(cfg.get("contentModel"),
                                                       "contentGen")
            cross = bool((cfg.get("tools") or {}).get("crossDocSearch"))
            web = bool((cfg.get("tools") or {}).get("webSearch"))
            for _where_text, group in plugin_groups(specs):
                wspec = settings_service.where_spec(group[0].where_id) \
                    if group[0].where_id else None
                g_params = meta_mod.pass2_params(sdir / "organized.md", group,
                                                 PASS2_BATCH_TOKENS,
                                                 gen_model["model"], where=wspec,
                                                 cross_doc=cross, web_search=web)
                for n in (s.name for s in group):
                    f = sdir / f"{n}.md"
                    if not (dm.stage_ok(f"pass2:{n}", g_params)
                            and f.is_file() and f.stat().st_size > 0):
                        return True
            return False
        except Exception as e:  # noqa: BLE001  判定失败按"需重跑"处理（保守）
            log(f"[snapshot] ⚠️ {doc_id} 指纹判定失败（视为需重跑）："
                f"{type(e).__name__}: {e}")
            return True

    def start_generation(self, doc_ids: list[str], force: bool = False) -> dict:
        # debug3 3.1（#6）：持久"排队中"——提交即置 status='queued' 并广播
        # doc.status（解析中的文档也统一归 queued；_prepare 的 wait_parse_done
        # 不受影响，解析完成路径见 kb_service._parse_job 对 queued 的保留）。
        # 任务真正开跑时由 _pass1_part 置 generating。
        for did in doc_ids:
            d = kb_service.raw_doc(did)
            if d is not None and d["status"] != "queued":
                kb_service.set_status(did, "queued")
        job = manager.start(
            "gen", lambda job: self._run(job, doc_ids, force), payload={
                "docIds": doc_ids, "force": force})
        return job

    def retry(self, doc_id: str) -> dict:
        return self.start_generation([doc_id], force=True)

    def _run(self, job, doc_ids: list[str], force: bool):
        """批次编排：每篇文档 pass1→pass2→入库 链式流转三个阶段池（跨文档并行，
        同文档内串行）。编排线程只在此等待全部完成；三个阶段池互不等待、
        submit 永不阻塞（无界队列），无死锁。"""
        from app.jobs import index_pool, pass1_pool, pass2_pool
        total = len(doc_ids)
        state = {"done": 0}
        lock = threading.Lock()
        finished = threading.Semaphore(0)

        def _finish():
            with lock:
                state["done"] += 1
                n = state["done"]
            manager.progress(job, int(n / total * 100), f"{n}/{total} 篇完成")
            finished.release()

        def _idx(ctx: dict):
            did = ctx["doc_id"]
            try:
                pauses.wait(did)   # 阶段间闸门
                from app.services import index_service
                index_service.auto_reindex(did, pass1_rerun=ctx["pass1_needed"])
            except Exception as e:  # noqa: BLE001
                log(f"[gen] ⚠️ {did} 自动入库失败（不影响生成）：{e}")
            finally:
                pauses.finish(did)
                _finish()

        def _p2(ctx: dict):
            did = ctx["doc_id"]
            try:
                pauses.wait(did)   # 阶段间闸门
                self._pass2_part(ctx)
                index_pool.submit(_idx, ctx)
            except Exception as e:  # noqa: BLE001
                log(f"[gen] ❌ {did}：{type(e).__name__}: {e}")
                import traceback
                traceback.print_exc()
                kb_service.set_status(did, "failed")
                emit("doc.error", docId=did, detail=str(e))
                pauses.finish(did)
                _finish()

        def _p1(did: str):
            try:
                ctx = self._prepare(did, force=force)
                self._pass1_part(ctx)
                pass2_pool.submit(_p2, ctx)
            except Exception as e:  # noqa: BLE001
                log(f"[gen] ❌ {did}：{type(e).__name__}: {e}")
                import traceback
                traceback.print_exc()
                kb_service.set_status(did, "failed")
                emit("doc.error", docId=did, detail=str(e))
                pauses.finish(did)
                _finish()

        for did in doc_ids:
            pass1_pool.submit(_p1, did)
        for _ in doc_ids:
            finished.acquire()

    # ---------------- 单文档生成（三阶段拆分，供并行链式与同步调用共用） ----------------
    def _prepare(self, doc_id: str, *, force: bool = False,
                 extra_plugins: list[str] | None = None) -> dict:
        """读取配置/预设/模型、建 LLM 客户端、目录/meta、实时会话、pass1 判定。
        返回贯穿 pass1/pass2 阶段的 ctx（跨线程传递，只含不可变数据与独占对象）。

        步骤10 排队生成：提交生成时文档仍在解析（status=parsing）→ 在此挂起等待
        per-doc 解析完成事件（jobs.wait_parse_done，30min 超时防泄漏）；解析完成后
        正常走 pass1/pass2/入库，解析失败 → 该 gen 项报「解析失败：{原因}」。"""
        d = kb_service.raw_doc(doc_id)
        if d is None:
            raise KeyError(doc_id)
        if d["status"] == "parsing":
            from app.jobs import wait_parse_done
            log(f"[gen] {doc_id} 仍在解析中，生成排队等待…")
            ok, reason = wait_parse_done(doc_id)
            if not ok:
                raise RuntimeError(reason)
            d = kb_service.raw_doc(doc_id)   # 状态已翻转（ready/failed），重读
            if d is None:
                raise KeyError(doc_id)
            log(f"[gen] {doc_id} 解析完成，排队生成继续执行")
        kb_id = d["kb_id"]
        # 步骤11 配置继承：显式 → 库默认（按 doc_type）→ 内置默认（唯一解析点在 kb_service）
        cfg = kb_service.resolve_effective_config(d, "gen")
        inherited = kb_service.is_inherited(d, "gen")
        if not cfg.get("presetId"):
            raise ValueError("未选择文档整理预设")

        org_spec = settings_service.preset_spec(cfg["presetId"], "organization")
        summ_spec = settings_service.builtin.summary_spec()
        common = settings_service.builtin.common_sections()

        # 按整理预设的源类型分组（doc|web）挂载 organization/common.md 对应公共节
        org_group = "doc" if (settings_service.get_preset(cfg["presetId"]) or {}
                              ).get("group") != "web" else "web"
        org_common_secs = settings_service.builtin.organization_common_sections()
        org_common_text = org_common_secs.get("文档" if org_group == "doc" else "网页", "")
        if not org_common_text:
            log(f"[gen] ⚠️ organization/common.md 缺少"
                f"{'文档' if org_group == 'doc' else '网页'}公共节")
        org_common_spec = spec_from_text("organization_common", org_group, org_common_text)

        org_model = settings_service.resolve_model(cfg.get("organizeModel"), "organize")
        gen_model = settings_service.resolve_model(cfg.get("contentModel"), "contentGen")
        log(f"[gen] {doc_id} 生效配置（{'继承知识库默认' if inherited else '文档显式'}）："
            f"presetId={cfg['presetId']} 整理模型={org_model['model']} "
            f"生成模型={gen_model['model']}")

        ddir = paths.doc_dir(kb_id, doc_id)
        sdir = paths.stage_dir(kb_id, doc_id, cfg["presetId"])
        sdir.mkdir(parents=True, exist_ok=True)
        fbase = paths.files_base(kb_id, doc_id)
        dm = meta_mod.DocMeta(sdir)
        pdf2md = ddir / "pdf2md.md"
        if not pdf2md.is_file():
            raise FileNotFoundError("pdf2md.md 缺失（请先解析文档）")

        p1_params = meta_mod.pass1_params(pdf2md, org_spec, summ_spec,
                                          ORGANIZE_BATCH_TOKENS, org_model["model"],
                                          org_common=org_common_spec,
                                          common=_pass1_common_spec())
        pass1_needed = force or not (
            dm.stage_ok("pass1", p1_params)
            and all((sdir / f).is_file() for f in _PASS1_FILES))

        session = get_or_create_session(doc_id, cfg["presetId"])
        return {
            "doc_id": doc_id, "kb_id": kb_id, "d": d, "cfg": cfg,
            "org_spec": org_spec, "org_group": org_group,
            "org_common_text": org_common_text, "org_common_spec": org_common_spec,
            "summ_spec": summ_spec, "common": common,
            "org_model": org_model, "gen_model": gen_model,
            "llm_org": LLMClient(**org_model), "llm_gen": LLMClient(**gen_model),
            "ddir": ddir, "sdir": sdir, "fbase": fbase, "dm": dm,
            "pdf2md": pdf2md, "p1_params": p1_params,
            "pass1_needed": pass1_needed, "session": session,
            "comps": cfg.get("components", {}), "extra_plugins": extra_plugins,
            "force": force,
            # 首次登记暂停闸门（嵌套补跑时 False，避免提前清掉外层闸门）
            "pauses_top": pauses.start(doc_id),
        }

    def _pass1_part(self, ctx: dict):
        doc_id, sdir = ctx["doc_id"], ctx["sdir"]
        kb_service.set_status(doc_id, "generating")
        if not ctx["pass1_needed"]:
            return
        session, comps = ctx["session"], ctx["comps"]
        emit("doc.stage", docId=doc_id, stage="pass1", state="start")
        _backup_clear(sdir, [*_PASS1_FILES,
                             *[f"{n}.md" for n in self._existing_plugins(sdir)],
                             *[f"{n}.refs.json" for n in self._existing_plugins(sdir)]])
        # debug3 3.5：begin_pass1 先插 type='title' 节点（props.title=旧 meta 标题
        # 或文档名占位）；pass1 流式 @@title 块闭合时由解析器 update（第一屏即见标题）
        session.begin_pass1(ctx["fbase"], show_toc=comps.get("toc", True),
                            show_images=comps.get("images", True),
                            doc_title=(ctx["dm"].title or ctx["d"]["name"]))
        system_prompt = pass1_system(ctx["common"], ctx["org_common_text"],
                                     ctx["org_spec"], ctx["summ_spec"])
        log(f"[gen] {doc_id} pass1 系统提示词：{len(system_prompt)} 字符"
            f"（预设 {ctx['org_spec'].name}/{ctx['org_group']}，"
            f"公共节 {len(ctx['org_common_text'])} 字符）")
        engine = Pass1Engine(
            ctx["llm_org"], system_prompt,
            emit=lambda **ev: emit("doc.stage", docId=doc_id, **ev),
            on_delta=lambda text, wi: session.p1.feed(text),
            on_reset=lambda wi: session.rollback(),
            on_window_start=lambda wi: session.checkpoint(),
            gate=lambda: pauses.wait(doc_id),
            common_spec=_pass1_common_spec())
        engine.set_org_pair(ctx["org_spec"], ctx["summ_spec"])
        stats = engine.run(sdir, ctx["pdf2md"])
        session.p1.flush()   # debug6：落掉字符级状态机扣留中的尾行/字符（先于 pass2 喂流，防错序）
        # debug3 3.7：title/digest 由 pass1 输出的 @@title/@@digest 块承担
        #（引擎 harvest 后随 stats 返回；缺块回退 pdf2md 首个 `# `/文件名，
        # digest 缺块时保持旧值不变）
        ctx["dm"].set_doc(doc_id, stats.get("title"), digest=stats.get("digest"))
        ctx["dm"].set_stage("pass1", params=ctx["p1_params"],
                            stats={k: v for k, v in stats.items() if k != "params"},
                            done=not stats["partial"],
                            organized_sha=meta_mod.file_sha(sdir / "organized.md"))
        emit("doc.stage", docId=doc_id, stage="pass1", state="done",
             partial=stats["partial"])

    # ---------------- pass2 跨文档查询（步骤3）：概况 + 工具 executor ----------------
    @staticmethod
    def _kb_overview(kb_id: str, doc_id: str, doc_name: str, dm: meta_mod.DocMeta,
                     current_sdir: Path) -> tuple[str, dict[str, Path]]:
        """知识库概况（渐进披露第一层）：同库其他文档一行概况，排除软关闭文档；
        当前文档单列一行标注（本文档）。返回 (概况文本, {docId: stage_dir} 工具白名单)。
        title/digest 带进程内缓存（_doc_meta_brief）。"""
        lines: list[str] = []
        allowed: dict[str, Path] = {}
        rows = db.get().execute(
            "SELECT id, name, doc_type, gen_config, index_config FROM docs"
            " WHERE kb_id = ? ORDER BY created_at", (kb_id,)).fetchall()
        for r in (x for x in rows if x["id"] != doc_id):
            drow = dict(r)
            # 步骤11：按生效配置判断（继承中的文档用库默认的 presetId 找产物）
            idx_cfg = kb_service.resolve_effective_config(drow, "index")
            if idx_cfg.get("enabled") is False:      # 软关闭：检索与概况都排除
                continue
            gcfg = kb_service.resolve_effective_config(drow, "gen")
            preset_id = gcfg.get("presetId")
            if not preset_id:
                continue                              # 未配置整理预设：无产物可查
            sdir = paths.stage_dir(kb_id, r["id"], preset_id)
            if not (sdir / "organized.md").is_file():
                continue                              # 尚未 pass1：无目录/摘要可查
            title, digest = _doc_meta_brief(sdir)
            parts = [f"《{r['name']}》"]
            if title and title != r["name"]:
                parts.append(f"（{title}）")
            if digest:
                parts.append(f"：{digest}")
            parts.append(f" ｜ doc_id={r['id']}")
            lines.append("- " + "".join(parts))
            allowed[r["id"]] = sdir
        # 当前文档（title/digest 取自本次生成的 DocMeta，最新鲜）
        cur_parts = [f"《{doc_name}》"]
        if dm.title and dm.title != doc_name:
            cur_parts.append(f"（{dm.title}）")
        if dm.digest:
            cur_parts.append(f"：{dm.digest}")
        cur_parts.append(f" ｜ doc_id={doc_id}（本文档）")
        lines.append("- " + "".join(cur_parts))
        allowed[doc_id] = current_sdir
        return "\n".join(lines), allowed

    @staticmethod
    def _make_pass2_executor(kb_id: str, allowed: dict[str, Path]):
        """pass2 工具 executor（闭包持有 kb_id 与文档白名单，引擎不碰 DB）。

        返回 exec_tool(name, args, start_n) -> (result_text, fragments|None)。
        doc_id 不在白名单 -> 错误 tool 消息；rag_search 仅限本知识库；
        web_search/web_fetch（步骤4）按 GenConfig.tools.webSearch 勾选与否进 spec，
        executor 无条件支持（web 片段 kind='web'，anchor 存 URL）。"""
        from app.rag.retriever import retrieve
        from app import websearch

        def _web_frag(n: int, title: str, url: str, text: str) -> dict:
            return {"n": n, "chunkId": "", "kbId": "", "docId": "",
                    "docName": (title or url or "（无标题）").strip(),
                    "anchor": url, "breadcrumb": "网页", "sectionNum": "",
                    "text": (text or "")[:200], "kind": "web"}

        def exec_tool(name: str, args: dict, start_n: int = 1):
            if name == "kb_toc":
                did = str(args.get("doc_id") or "")
                sdir = allowed.get(did)
                if sdir is None:
                    return (f"错误：doc_id {did!r} 不在知识库文档清单中，"
                            "请从概况清单中逐字符复制 doc_id。"), None
                f = Path(sdir) / "toc.md"
                text = read_text_guess(f).strip() if f.is_file() else ""
                if not text:
                    return "该文档暂无目录。", None
                return text[:8000], None
            if name == "kb_summary":
                did = str(args.get("doc_id") or "")
                sdir = allowed.get(did)
                if sdir is None:
                    return (f"错误：doc_id {did!r} 不在知识库文档清单中，"
                            "请从概况清单中逐字符复制 doc_id。"), None
                text = _kb_summary_text(Path(sdir))
                if not text.strip():
                    return "该文档暂无节摘要。", None
                return text[:12000], None
            if name == "rag_search":
                q = str(args.get("query") or "").strip()
                if not q:
                    return "查询为空。", []
                embed_cfg = settings_service.resolve_model(None, "embedding")
                hits = retrieve(q, [kb_id], embed_cfg=embed_cfg, top_n=6)
                if not hits:
                    return "未检索到相关内容。", []
                names = {r["id"]: r["name"] for r in db.get().execute(
                    "SELECT id, name FROM docs").fetchall()}
                out, frags = [], []
                n = start_n
                for h in hits:
                    head = h.get("breadcrumb") or h.get("section_num") or ""
                    out.append(f"[{n}] 《{names.get(h['doc_id'], '文档')}》 {head}\n"
                               f"{(h['text'] or '')[:200]}")
                    frags.append({
                        "n": n, "chunkId": h.get("id", ""),
                        "kbId": h.get("kb_id", kb_id), "docId": h["doc_id"],
                        "docName": names.get(h["doc_id"], h["doc_id"]),
                        "anchor": h.get("anchor", ""),
                        "breadcrumb": h.get("breadcrumb", ""),
                        "sectionNum": h.get("section_num", ""),
                        "text": (h["text"] or "")[:200],
                    })
                    n += 1
                return "\n\n".join(out), frags
            if name == "web_search":
                q = str(args.get("query") or "").strip()
                if not q:
                    return "查询为空。", []
                try:
                    max_r = max(1, min(int(args.get("max_results") or 5), 8))
                except (TypeError, ValueError):
                    max_r = 5
                err, results = websearch.web_search(q, max_r)
                if err:
                    return err, None
                if not results:
                    return "未搜索到相关网页。", []
                out, frags = [], []
                n = start_n
                for r in results:
                    out.append(f"[{n}] 【{r.get('title') or r.get('url')}】\n"
                               f"URL: {r.get('url') or ''}\n{(r.get('snippet') or '')[:300]}")
                    frags.append(_web_frag(n, r.get("title"), r.get("url"),
                                           r.get("snippet")))
                    n += 1
                return "\n\n".join(out), frags
            if name == "web_fetch":
                url = str(args.get("url") or "").strip()
                if not url:
                    return "URL 为空。", []
                err, page = websearch.web_fetch(url)
                if err:
                    return err, None
                content = (page.get("content") or "")[:websearch.FETCH_MAX_CHARS]
                frag = _web_frag(start_n, page.get("title"),
                                 page.get("url") or url, content)
                return (f"[{start_n}] 【{frag['docName']}】\nURL: {frag['anchor']}\n{content}",
                        [frag])
            return f"未知工具：{name}", None

        return exec_tool

    def _pass2_part(self, ctx: dict):
        doc_id, sdir, d = ctx["doc_id"], ctx["sdir"], ctx["d"]
        cfg, session, dm = ctx["cfg"], ctx["session"], ctx["dm"]
        from app.services import index_service
        # 插件并集：文档显示配置 + 入库配置（启用时）中启用的所有插件；
        # 显示树仍只用显示配置的插件（入库-only 插件只产产物，不上屏）
        plugin_ids = list(cfg.get("plugins", []))
        # 入库配置按生效配置解析（步骤11 继承；doc.index_config='{}' 时=库默认对应类型）
        idx_cfg = kb_service.resolve_effective_config(d, "index")
        if index_service.index_enabled(idx_cfg):
            for p in idx_cfg.get("plugins", []):
                if p not in plugin_ids:
                    plugin_ids.append(p)
        extra = ctx["extra_plugins"]
        if extra:
            plugin_ids += [p for p in extra if p not in plugin_ids]
        specs = []
        for pid in plugin_ids:
            try:
                specs.append(settings_service.preset_spec(pid, "plugin"))
            except KeyError:
                log(f"[gen] ⚠️ 插件预设不存在，跳过：{pid}")
        groups = plugin_groups(specs)   # 按 where_id（生成位置）分组
        force = ctx["force"]
        # 步骤3 跨文档查询 + 步骤4 联网搜索：勾选时注入工具协议与 executor（可同时启用）
        cross = bool((cfg.get("tools") or {}).get("crossDocSearch"))
        web = bool((cfg.get("tools") or {}).get("webSearch"))
        allowed: dict[str, Path] = {}
        cross_doc_text = web_text = None
        tools_spec: list | None = None
        executor = None
        if cross:
            overview, allowed = self._kb_overview(ctx["kb_id"], doc_id,
                                                  d["name"], dm, sdir)
            section = ctx["common"].get("pass2.tools.crossDoc")
            if section:
                cross_doc_text = section.strip().replace("{KB_OVERVIEW}", overview)
                tools_spec = list(PASS2_TOOLS_SPEC)
                log(f"[gen] {doc_id} 跨文档查询已启用：概况 {len(allowed)} 篇文档"
                    f"（含本文档）")
            else:
                log(f"[gen] ⚠️ common.md 缺少 ## pass2.tools.crossDoc 小节，"
                    f"跨文档查询未启用")
        if web:
            wsec = ctx["common"].get("pass2.tools.web")
            if wsec:
                web_text = wsec.strip()
                tools_spec = (tools_spec or []) + list(websearch.WEB_TOOLS_SPEC)
                log(f"[gen] {doc_id} 联网搜索已启用"
                    f"（服务商 {settings_service.get_websearch_settings()['provider']}）")
            else:
                log(f"[gen] ⚠️ common.md 缺少 ## pass2.tools.web 小节，联网搜索未启用")
        if tools_spec:
            executor = self._make_pass2_executor(ctx["kb_id"], allowed)
        if groups:
            session.begin_pass2(self._artifact_nodes(doc_id, ctx["kb_id"], cfg,
                                                     doc_name=d["name"]),
                                ctx["fbase"], {s.name for s in specs})
        for where_text, group in groups:
            names = [s.name for s in group]
            wspec = settings_service.where_spec(group[0].where_id) \
                if group[0].where_id else None
            g_params = meta_mod.pass2_params(sdir / "organized.md", group,
                                             PASS2_BATCH_TOKENS,
                                             ctx["gen_model"]["model"], where=wspec,
                                             cross_doc=cross, web_search=web)
            done = (not force) and all(
                dm.stage_ok(f"pass2:{n}", g_params)
                and (sdir / f"{n}.md").is_file()
                and (sdir / f"{n}.md").stat().st_size > 0
                for n in names)
            if done:
                continue
            emit("doc.stage", docId=doc_id, stage="pass2:" + "+".join(names),
                 state="start")
            if ctx["pass1_needed"]:
                pass  # pass1 重跑时产物已备份清除
            else:
                _backup_clear(sdir, [x for n in names for x in (f"{n}.md",
                                                                f"{n}.refs.json")])
            engine = Pass2Engine(
                ctx["llm_gen"], group,
                pass2_system(ctx["common"], where_text, group, cross_doc_text,
                             web_text),
                where=wspec,
                emit=lambda **ev: emit("doc.stage", docId=doc_id, **ev),
                on_delta=lambda text, wi: session.p2.feed(text),
                on_reset=lambda wi: session.rollback(),
                on_window_start=lambda wi: session.checkpoint(),
                gate=lambda: pauses.wait(doc_id),
                tools_spec=tools_spec, executor=executor)
            stats = engine.run(sdir, sdir / "organized.md",
                               dm.title or d["name"], toc_path=sdir / "toc.md")
            session.p2.flush()   # debug6：组边界落地扣留字符（防 A 组尾行与 B 组 @@ 头并行）
            clean = {k: v for k, v in stats.items() if k not in ("params", "refs")}
            for n in names:
                dm.set_stage(f"pass2:{n}", params=g_params, stats=clean,
                             done=not stats["partial"])
            # 实时树块级 refs 推送（render.op update 带出；完成后产物树同样带 refs）
            refs_map = stats.get("refs") or {}
            if isinstance(refs_map, dict) and any(refs_map.values()):
                for nid, node in session.tree.snapshot_nodes().items():
                    if node["type"] != "plugin_box":
                        continue
                    refs = (refs_map.get(node["props"].get("plugin") or "") or {}) \
                        .get(node["props"].get("num") or "")
                    if refs:
                        session.tree.update(nid, {"refs": refs})
            emit("doc.stage", docId=doc_id, stage="pass2:" + "+".join(names),
                 state="done", partial=stats["partial"])

        # 生成收尾：p2.flush 落掉字符级状态机扣留中的尾行/字符（debug6）；flush 实时
        # 树（append 直通后为空操作保险）——必须先于 done/doc.generated 事件，保证
        # 尾部内容在客户端完成态 reload（重设水位线）之前投递，否则尾串 append 晚于
        # 水位线到达、目标节点缺失又触发一次 reload。
        session.p2.flush()
        session.tree.flush_pending()
        kb_service.set_status(doc_id, "done")
        emit("doc.generated", docId=doc_id)
        snapshot_service.enqueue(doc_id)   # 步骤9：生成完成 → 预览/导出快照

    def generate_doc(self, doc_id: str, *, force: bool = False,
                     extra_plugins: list[str] | None = None,
                     auto_index: bool = True):
        """同步执行单篇文档流水线（外部签名与行为不变）。
        批量并行走 _run 的链式提交；这里供单篇重试与入库缺产物补跑使用
        （补跑发生在调用方线程，如 index 线程，可接受）。"""
        ctx = self._prepare(doc_id, force=force, extra_plugins=extra_plugins)
        try:
            self._pass1_part(ctx)
            self._pass2_part(ctx)
            if auto_index:
                try:
                    from app.services import index_service
                    index_service.auto_reindex(doc_id, pass1_rerun=ctx["pass1_needed"])
                except Exception as e:  # noqa: BLE001
                    log(f"[gen] ⚠️ 自动入库失败（不影响生成）：{e}")
        finally:
            if ctx.get("pauses_top"):
                pauses.finish(doc_id)

    @staticmethod
    def _existing_plugins(sdir: Path) -> list[str]:
        known = {"pdf2md.md", *_PASS1_FILES}
        return sorted(p.stem for p in sdir.glob("*.md") if p.name not in known)

    def _artifact_nodes(self, doc_id: str, kb_id: str, cfg: dict,
                        doc_name: str | None = None) -> dict:
        sdir = paths.stage_dir(kb_id, doc_id, cfg["presetId"])
        tree = build_tree_from_artifacts(
            doc_id, sdir, paths.files_base(kb_id, doc_id), cfg["presetId"],
            show_toc=cfg.get("components", {}).get("toc", True),
            show_summary=cfg.get("components", {}).get("summary", True),
            show_images=cfg.get("components", {}).get("images", True),
            plugins=_plugin_names(cfg.get("plugins", [])),
            doc_name=doc_name)
        return tree.snapshot_nodes()

    # ---------------- 预览 ----------------
    def get_preview(self, doc_id: str) -> dict | None:
        d = kb_service.raw_doc(doc_id)
        if d is None:
            return None
        # 步骤11：返回生效配置（继承中的文档=库默认），前端回显据此标注"继承自知识库"
        cfg = kb_service.resolve_effective_config(d, "gen")
        if not cfg.get("presetId"):
            return {"status": d["status"], "tree": None, "genConfig": cfg,
                    "lastId": bus.current_id()}
        # 生成中：优先返回实时树。快照与水位线必须原子获取（tree.snapshot_
        # and_watermark：树锁内 flush_pending → snapshot → current_id）——
        # 旧实现先快照后取 current_id，两步之间发布的 append 既不在快照里、
        # 又被前端按 _id <= lastId 丢弃 → 字符级永久空洞（水位线竞态）。
        session = live_sessions.get(doc_id)
        if session is not None and session.tree.preset_id == cfg["presetId"] \
                and d["status"] == "generating":
            snap, last_id = session.tree.snapshot_and_watermark()
            return {"status": "generating", "tree": snap,
                    "genConfig": cfg, "lastId": last_id}
        sdir = paths.stage_dir(d["kb_id"], doc_id, cfg["presetId"])
        if not (sdir / "organized.md").is_file():
            return {"status": d["status"], "tree": None, "genConfig": cfg,
                    "lastId": bus.current_id()}
        # 步骤9 快路径：命中落盘快照直接返回（毫秒级）；未命中现场重组并入队快照
        snap_tree = snapshot_service.load_preview_tree(sdir, cfg)
        if snap_tree is not None:
            return {"status": d["status"], "tree": snap_tree, "genConfig": cfg,
                    "lastId": bus.current_id()}
        tree = build_tree_from_artifacts(
            doc_id, sdir, paths.files_base(d["kb_id"], doc_id), cfg["presetId"],
            show_toc=cfg.get("components", {}).get("toc", True),
            show_summary=cfg.get("components", {}).get("summary", True),
            show_images=cfg.get("components", {}).get("images", True),
            plugins=_plugin_names(cfg.get("plugins", [])),
            doc_name=d["name"])
        snapshot_service.enqueue(doc_id)
        return {"status": d["status"], "tree": tree.snapshot(), "genConfig": cfg,
                "lastId": bus.current_id()}


service = GenService()
