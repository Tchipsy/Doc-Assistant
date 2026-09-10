"""预览快照与导出预组装（9.5 步骤9，要求2-2）。

文档生成完成（或纯显示配置变化、无需重跑）后，把完成态预览树与导出 markdown
预组装落盘到 stage_dir/，快路径直接返回，省去每次打开文档的树重组与导出组装：

- `.preview.json`：{"genFp", "cfgHash", "builtAt", "tree": 与 GET /preview 的 tree 同构}
- `.export.md`   ：按当前显示配置 assemble_document 预组装的 markdown。先组装到
  exports/ 下的临时文件再原子顶替进 stage_dir——assemble_document 按 out_path
  所在目录重写图片相对路径，exports/ 基准保证内容与现场导出逐字节一致。

写入一律 `.tmp` → `os.replace` 原子顶替（同卷），失败只记日志不阻塞预览
（调用方回退现场重组）。cfgHash = sha(resolved gen_config)——步骤11 起 resolved
即配置继承解析（文档显式 → 知识库同类型默认 → 内置默认），库默认变化会
反映到 cfgHash 使快照自动重建。

触发：① doc.status→done（gen_service._pass2_part 收尾）② 保存 gen/index 配置且
指纹检查无新产物需生成（gen_service.generation_would_rerun）。会触发重跑的配置
变化不单独建快照，等生成完成后走 ①。快路径未命中也会入队（幂等补建）。
"""
import hashlib
import json
import os
import threading
import time
from pathlib import Path

from app import paths
from app.jobs import manager
from app.services import kb_service
from app.liveview.build import build_tree_from_artifacts
from engine.config import log

SNAPSHOT_PREVIEW = paths.SNAPSHOT_PREVIEW
SNAPSHOT_EXPORT = paths.SNAPSHOT_EXPORT

# 锚点逻辑版本（9.6 同步滚动修复）：随 .preview.json 元信息落盘，锚点生成规则
# 变化时 +1。旧快照缺字段/旧值 = 动态页锚点引入前构建 → 判 STALE 自动重建，
# 否则旧产物 0 页锚点的文档即使重建快照也永远拿不到锚点（genFp 未变被跳过）。
# debug3（3.5）升到 3：预览树新增 type='title' 节点（root 首子）——旧快照无该
# 节点，升版触发一次性重建，完成态预览与导出标题对齐。
ANCHOR_GEN = 3

# per-doc 防重：已入队未跑完的文档不重复入队
_enqueue_lock = threading.Lock()
_pending: set[str] = set()


def resolved_gen_config(d: dict) -> dict:
    """生效显示配置（步骤11 配置继承）：文档显式 → 知识库同类型默认 → 内置默认。
    解析唯一在 kb_service.resolve_effective_config；快照 cfgHash 因此随库配置变化。"""
    return kb_service.resolve_effective_config(d, "gen")


def cfg_hash(cfg: dict) -> str:
    """显示配置哈希（cfgHash）：cfgHash 变化即树与导出需按新配置重组。"""
    return hashlib.sha256(
        json.dumps(cfg, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


_PASS1_BASENAMES = ("organized.md", "summary.md", "toc.md")


def artifacts_fp(sdir: Path) -> str | None:
    """产物指纹（genFp）：参与预览树/导出组装的产物文件 (名, size, mtime_ns) 摘要。
    organized.md 缺失 → None（无完成态产物，不建快照）。快照文件自身不参与。"""
    sdir = Path(sdir)
    if not (sdir / "organized.md").is_file():
        return None
    names = {n for n in _PASS1_BASENAMES}
    names |= {p.name for p in sdir.glob("*.md")
              if not p.name.startswith(".") and p.name not in _PASS1_BASENAMES}
    names |= {p.name for p in sdir.glob("*.refs.json")}
    h = hashlib.sha256()
    for n in sorted(names):
        f = sdir / n
        if not f.is_file():
            continue
        st = f.stat()
        h.update(f"{n}\n{st.st_size}:{st.st_mtime_ns}\n".encode("utf-8"))
    return h.hexdigest()


def _preview_meta(sdir: Path) -> dict | None:
    try:
        data = json.loads((Path(sdir) / SNAPSHOT_PREVIEW).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("tree"), dict) else None


def snapshots_fresh(sdir: Path, cfg: dict) -> bool:
    """快照是否可用：.preview.json 元信息与当前 genFp/cfgHash 一致且 .export.md 存在
    （两个产物同批构建，元信息共用一份）。"""
    data = _preview_meta(sdir)
    if data is None or not (Path(sdir) / SNAPSHOT_EXPORT).is_file():
        return False
    fp = artifacts_fp(sdir)
    return bool(fp) and data.get("genFp") == fp and data.get("cfgHash") == cfg_hash(cfg)


# ---------------- 快路径读取 ----------------

def preview_tree_fresh(sdir: Path, cfg: dict) -> bool:
    """预览树快照新鲜度：genFp/cfgHash 一致、.export.md 存在，且 anchorGen 为
    当前锚点逻辑版本（缺字段/旧值 → STALE，走现场重组并入队重建——复用失效路径）。
    仅约束预览树（锚点只在预览渲染）；.export.md 快路径不受影响（导出剥离标记）。"""
    if not snapshots_fresh(sdir, cfg):
        return False
    return _preview_meta(sdir).get("anchorGen") == ANCHOR_GEN


def load_preview_tree(sdir: Path, cfg: dict) -> dict | None:
    """/preview 快路径：快照新鲜（genFp/cfgHash/anchorGen）→ tree（与现场重组结果
    同构）；否则 None（调用方现场重组并入队重建）。"""
    try:
        if not preview_tree_fresh(sdir, cfg):
            return None
        return _preview_meta(sdir).get("tree")
    except Exception:  # noqa: BLE001  快照任何异常都回退现场重组
        return None


def load_export_md(doc_id: str) -> str | None:
    """export-md / pdf_preview 快路径：快照新鲜 → .export.md 内容；否则 None。"""
    try:
        d = kb_service.raw_doc(doc_id)
        if d is None:
            return None
        cfg = resolved_gen_config(d)
        if not cfg.get("presetId"):
            return None
        sdir = paths.stage_dir(d["kb_id"], doc_id, cfg["presetId"])
        if not snapshots_fresh(sdir, cfg):
            return None
        return (sdir / SNAPSHOT_EXPORT).read_text(encoding="utf-8")
    except Exception:  # noqa: BLE001
        return None


# ---------------- 构建 ----------------

def _build_tree(doc_id: str, kb_id: str, cfg: dict, sdir: Path,
                doc_name: str | None = None) -> dict:
    """复用 liveview/build.py 的产物树构建（与现场重组同一实现）。"""
    from app.services.gen_service import _plugin_names
    tree = build_tree_from_artifacts(
        doc_id, sdir, paths.files_base(kb_id, doc_id), cfg["presetId"],
        show_toc=cfg.get("components", {}).get("toc", True),
        show_summary=cfg.get("components", {}).get("summary", True),
        show_images=cfg.get("components", {}).get("images", True),
        plugins=_plugin_names(cfg.get("plugins", [])),
        doc_name=doc_name)
    return tree.snapshot()


def _build_export(d: dict, cfg: dict) -> None:
    """导出预组装：先在 exports/ 组装（图片相对路径基准与现场导出一致），
    再原子顶替进 stage_dir/.export.md。"""
    from app.services import export_service
    tmp = paths.EXPORT_DIR / f".export_tmp_{d['id']}.md"
    paths.EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    export_service._assemble(d["id"], tmp)
    os.replace(tmp, Path(paths.stage_dir(d["kb_id"], d["id"], cfg["presetId"]))
               / SNAPSHOT_EXPORT)


def _atomic_write_text(path: Path, text: str):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def _snapshot_job(job, doc_id: str):
    try:
        d = kb_service.raw_doc(doc_id)
        if d is None:
            return
        if d["status"] == "generating":
            log(f"[snapshot] {doc_id} 生成中，跳过（生成完成后自动重建）")
            return
        cfg = resolved_gen_config(d)
        if not cfg.get("presetId"):
            return
        sdir = paths.stage_dir(d["kb_id"], doc_id, cfg["presetId"])
        if preview_tree_fresh(sdir, cfg):
            manager.progress(job, 100, "快照已最新")
            return
        gen_fp = artifacts_fp(sdir)
        if not gen_fp:
            return
        tree = _build_tree(doc_id, d["kb_id"], cfg, sdir, doc_name=d["name"])
        _atomic_write_text(sdir / SNAPSHOT_PREVIEW, json.dumps(
            {"genFp": gen_fp, "cfgHash": cfg_hash(cfg), "anchorGen": ANCHOR_GEN,
             "builtAt": time.strftime("%Y-%m-%d %H:%M:%S"), "tree": tree},
            ensure_ascii=False))
        _build_export(d, cfg)
        manager.progress(job, 100, "快照已重建")
        log(f"[snapshot] ✅ {doc_id} .preview.json + .export.md"
            f"（cfgHash {cfg_hash(cfg)[:8]}）")
    except Exception as e:  # noqa: BLE001  快照失败不影响预览（回退现场重组）
        log(f"[snapshot] ⚠️ {doc_id} 快照构建失败：{type(e).__name__}: {e}")
    finally:
        with _enqueue_lock:
            _pending.discard(doc_id)


def enqueue(doc_id: str) -> dict | None:
    """入队快照任务（jobs 新 kind `snapshot`，走编排池；per-doc 防重）。
    任务体内再做新鲜度检查（已最新则跳过），幂等。返回 job 或 None。"""
    with _enqueue_lock:
        if doc_id in _pending:
            return None
        _pending.add(doc_id)
    return manager.start("snapshot", lambda job: _snapshot_job(job, doc_id),
                         doc_id=doc_id)
