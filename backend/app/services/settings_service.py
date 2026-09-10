"""设置域：模型服务商/模型/默认模型/文档解析/预设（整理/生成位置/内容生成）CRUD。

预设存 SQLite（内容 sha 参与生成指纹；重命名只改 display_name，内部名 name
是 artifact 文件名/chunks.artifact/pass2 meta 键的稳定依据）；
common.md / organization/common.md / summary 为内置（backend/prompts/）。
"""
import hashlib
import re
import time
import uuid

import httpx

from app import db
from app import paths
from engine.config import log
from engine.promptkit import (BuiltinPrompts, cut_meta_keys, cut_section,
                              norm_ws, spec_from_text)

DEFAULT_KEYS = ["assistant", "organize", "contentGen", "assist", "embedding", "rerank"]
DEFAULT_LABELS = {
    "assistant": "默认助手模型", "organize": "文档整理模型",
    "contentGen": "内容生成模型", "assist": "辅助模型",
    "embedding": "嵌入模型", "rerank": "重排模型",
}

builtin = BuiltinPrompts(paths.PROMPTS_DIR)


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _uid():
    return uuid.uuid4().hex[:12]


# ============================ 服务商与模型 ============================

# 模型类型（9.5 步骤12）：''=未分类；来源见 _classify_endpoints/_classify_by_name
MODEL_TYPES = ("", "chat", "embedding", "rerank")
# 默认模型槽位的期望类型（步骤12 软校验；未列出的槽位期望 chat）
DEFAULT_KEY_TYPES = {"embedding": "embedding", "rerank": "rerank"}


def _classify_endpoints(endpoints) -> str | None:
    """supported_endpoint_types 数组 -> model_type（多类型并存优先级 chat > rerank > embedding）。
    返回 None=服务商未返回该字段（调用方回退按 id 关键词启发式）；
    返回 ''=字段存在但不含已知类型（如 image-generation）→ 未分类，可手动改。
    实测样例：
      ["openai"]→聊天、["embeddings"]→嵌入、["image-generation"]→未分类。
    """
    if not isinstance(endpoints, list) or not endpoints:
        return None
    eps = [str(e).lower() for e in endpoints]
    if any(e == "openai" or "chat" in e for e in eps):   # openai / chat / chat/completions
        return "chat"
    if any("rerank" in e for e in eps):
        return "rerank"
    if any("embed" in e for e in eps):
        return "embedding"
    return ""


def _classify_by_name(model_id: str) -> str:
    """id 关键词启发式（supported_endpoint_types 缺失时的回退；其余一律 chat）。"""
    mid = (model_id or "").lower()
    if "embed" in mid:
        return "embedding"
    if "rerank" in mid:
        return "rerank"
    return "chat"


def list_providers() -> list[dict]:
    conn = db.get()
    rows = conn.execute("SELECT * FROM providers ORDER BY created_at").fetchall()
    out = []
    for r in rows:
        models = conn.execute(
            "SELECT model_id, checked, model_type, image_input FROM models"
            " WHERE provider_id = ? ORDER BY model_id",
            (r["id"],)).fetchall()
        out.append({
            "id": r["id"], "name": r["name"], "baseUrl": r["base_url"],
            "apiKey": r["api_key"],
            "models": [{"modelId": m["model_id"], "checked": bool(m["checked"]),
                        "modelType": m["model_type"] or "",
                        "imageInput": bool(m["image_input"])}
                       for m in models],
        })
    return out


def create_provider(name: str, base_url: str, api_key: str = "") -> dict:
    pid = _uid()
    conn = db.get()
    conn.execute("INSERT INTO providers (id, name, base_url, api_key, created_at)"
                 " VALUES (?,?,?,?,?)", (pid, name, base_url, api_key, _now()))
    conn.commit()
    return {"id": pid, "name": name, "baseUrl": base_url, "apiKey": api_key, "models": []}


def update_provider(pid: str, *, name=None, base_url=None, api_key=None):
    conn = db.get()
    if name is not None:
        conn.execute("UPDATE providers SET name = ? WHERE id = ?", (name, pid))
    if base_url is not None:
        conn.execute("UPDATE providers SET base_url = ? WHERE id = ?", (base_url, pid))
    if api_key is not None:
        conn.execute("UPDATE providers SET api_key = ? WHERE id = ?", (api_key, pid))
    conn.commit()


def delete_provider(pid: str):
    conn = db.get()
    conn.execute("DELETE FROM providers WHERE id = ?", (pid,))
    conn.commit()


def fetch_provider_models(pid: str) -> list[dict]:
    """拉取服务商模型列表（GET {baseUrl}/models），新模型以未勾选入库。

    步骤12 自动分类（主路径）：解析每个模型对象的 supported_endpoint_types；
    该字段缺失的服务商/模型回退 id 关键词启发式（结果标注可手动改）。
    只填空值——已分类（含手动设置）的行不覆盖。返回 [{modelId, modelType, imageInput}]。
    """
    conn = db.get()
    row = conn.execute("SELECT * FROM providers WHERE id = ?", (pid,)).fetchone()
    if row is None:
        raise KeyError(f"服务商不存在：{pid}")
    base = (row["base_url"] or "").rstrip("/")
    with httpx.Client(base_url=base,
                      headers={"Authorization": f"Bearer {row['api_key']}"} if row["api_key"] else {},
                      timeout=httpx.Timeout(30.0), trust_env=False) as client:
        resp = client.get("/models")
        resp.raise_for_status()
        data = resp.json().get("data") or []
    ids = sorted({m.get("id") for m in data if m.get("id")})
    types: dict[str, str] = {}
    heuristic = False
    for m in data:
        mid = m.get("id")
        if not mid:
            continue
        t = _classify_endpoints(m.get("supported_endpoint_types"))
        if t is None:   # 该模型对象无 supported_endpoint_types → 启发式回退
            t = _classify_by_name(mid)
            heuristic = True
        types[mid] = t
    for mid in ids:
        conn.execute(
            "INSERT OR IGNORE INTO models (provider_id, model_id, checked, model_type)"
            " VALUES (?,?,0,?)", (pid, mid, types[mid]))
    # 存量行只补空值（幂等，不覆盖手动设置）
    for mid in ids:
        conn.execute(
            "UPDATE models SET model_type = ? WHERE provider_id = ? AND model_id = ?"
            " AND model_type = ''", (types[mid], pid, mid))
    conn.commit()
    if heuristic:
        log(f"[settings] 服务商 {row['name']} 的 /models 返回体缺少 "
            f"supported_endpoint_types（或为空），已按 id 关键词推断模型类型，"
            "可在「模型服务」中手动修改")
    models = conn.execute(
        "SELECT model_id, model_type, image_input FROM models WHERE provider_id = ?"
        " ORDER BY model_id", (pid,)).fetchall()
    return [{"modelId": m["model_id"], "modelType": m["model_type"] or "",
             "imageInput": bool(m["image_input"])} for m in models]


def set_checked_models(pid: str, checked: list[str], attrs: dict | None = None):
    """设置勾选；attrs（步骤12）：{modelId: {modelType?, imageInput?}} 同步保存模型属性。
    先整体校验再写库：若在 UPDATE 开始后抛 ValueError，未提交事务会持有 WAL 写锁
    阻塞其他线程写（实测触发 database is locked）；异常时回滚兜底。"""
    conn = db.get()
    for mid, a in (attrs or {}).items():
        mt = a.get("modelType")
        if mt is not None and mt not in MODEL_TYPES:
            raise ValueError(f"非法模型类型：{mt}")
    try:
        conn.execute("UPDATE models SET checked = 0 WHERE provider_id = ?", (pid,))
        for mid in checked:
            conn.execute(
                "UPDATE models SET checked = 1 WHERE provider_id = ? AND model_id = ?",
                (pid, mid))
        for mid, a in (attrs or {}).items():
            mt = a.get("modelType")
            if mt is not None:
                conn.execute(
                    "UPDATE models SET model_type = ? WHERE provider_id = ? AND model_id = ?",
                    (mt, pid, mid))
            ii = a.get("imageInput")
            if ii is not None:
                conn.execute(
                    "UPDATE models SET image_input = ? WHERE provider_id = ? AND model_id = ?",
                    (1 if ii else 0, pid, mid))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def checked_models() -> list[dict]:
    """所有已勾选模型：[{providerId, providerName, modelId, modelType, value}]，value='pid/mid'。"""
    conn = db.get()
    rows = conn.execute(
        "SELECT m.provider_id, m.model_id, m.model_type, p.name FROM models m"
        " JOIN providers p ON p.id = m.provider_id WHERE m.checked = 1"
        " ORDER BY p.created_at, m.model_id").fetchall()
    return [{"providerId": r["provider_id"], "providerName": r["name"],
             "modelId": r["model_id"], "modelType": r["model_type"] or "",
             "value": f"{r['provider_id']}/{r['model_id']}"}
            for r in rows]


# ============================ 默认模型 ============================

def get_defaults() -> dict:
    d = db.kv_get("defaults", {}) or {}
    return {k: d.get(k) for k in DEFAULT_KEYS}


def set_defaults(values: dict):
    d = db.kv_get("defaults", {}) or {}
    for k in DEFAULT_KEYS:
        if k in values:
            d[k] = values[k] or None
    db.kv_set("defaults", d)
    return d


def resolve_model(value: str | None, default_key: str) -> dict:
    """'providerId/modelId' -> {base_url, api_key, model}；未配置抛 KeyError。
    步骤12 软校验：模型类型与槽位期望不符只记 warning 不阻断（兼容用户故意混用）。"""
    if not value:
        value = (db.kv_get("defaults", {}) or {}).get(default_key)
    if not value:
        raise KeyError(f"模型未配置：{default_key}")
    pid, _, mid = value.partition("/")
    conn = db.get()
    row = conn.execute("SELECT * FROM providers WHERE id = ?", (pid,)).fetchone()
    if row is None:
        raise KeyError(f"服务商不存在：{pid}")
    mrow = conn.execute(
        "SELECT model_type FROM models WHERE provider_id = ? AND model_id = ?",
        (pid, mid)).fetchone()
    mtype = (mrow["model_type"] if mrow else "") or ""
    expected = DEFAULT_KEY_TYPES.get(default_key, "chat")
    if mtype and mtype != expected:
        log(f"[settings] ⚠️ 模型类型可能不匹配：{value}（{mtype}）用于槽位 "
            f"{default_key}（期望 {expected}），继续执行")
    return {"base_url": row["base_url"], "api_key": row["api_key"], "model": mid}


# ============================ 文档解析 ============================

def get_parser_settings() -> dict:
    return db.kv_get("parser", {
        "parser": "paddleocr",
        "paddleocr": {"apiUrl": "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
                      "apiKey": "", "model": "PP-StructureV3"},
        "mineru": {"apiUrl": "", "apiKey": "", "model": ""},
        "local": {},
    })


def set_parser_settings(value: dict):
    cur = get_parser_settings()
    cur.update(value)
    db.kv_set("parser", cur)
    return cur


def parser_engine_cfg() -> dict:
    """engine.ocr.parse_document 所需配置形态。"""
    s = get_parser_settings()
    sub = s.get(s.get("parser", "paddleocr"), {}) or {}
    return {"parser": s.get("parser", "paddleocr"),
            "api_url": sub.get("apiUrl", ""), "api_key": sub.get("apiKey", ""),
            "model": sub.get("model", "")}


# ============================ 网络搜索（9.5 步骤4） ============================

WEBSEARCH_PROVIDER_LABELS = {
    "tavily": "Tavily",
    "exa": "Exa",
    "examcp": "Exa MCP（免密钥）",
    "jina": "Jina AI",
}
# 服务商默认 API 地址（app.websearch.DEFAULT_API_URLS 的展示层副本，两处保持一致）
WEBSEARCH_DEFAULT_URLS = {
    "tavily": "https://api.tavily.com",
    "exa": "https://api.exa.ai",
    "examcp": "https://mcp.exa.ai/mcp",
    "jina": "https://r.jina.ai",
}


def get_websearch_settings() -> dict:
    s = db.kv_get("websearch", {}) or {}
    provider = s.get("provider") if s.get("provider") in WEBSEARCH_PROVIDER_LABELS else "examcp"
    return {"provider": provider,
            "apiUrl": (s.get("apiUrl") or WEBSEARCH_DEFAULT_URLS[provider]).strip(),
            "apiKey": s.get("apiKey") or ""}


def set_websearch_settings(value: dict) -> dict:
    """合并保存；apiKey 空值/打码回传 = 不修改（密钥不回传明文，前端展示打码值）。"""
    cur = get_websearch_settings()
    if value.get("provider") in WEBSEARCH_PROVIDER_LABELS:
        cur["provider"] = value["provider"]
    if value.get("apiUrl"):
        cur["apiUrl"] = str(value["apiUrl"]).strip()
    key = (value.get("apiKey") or "").strip()
    if key and "••" not in key:
        cur["apiKey"] = key
    db.kv_set("websearch", cur)
    return cur


def mask_websearch(s: dict) -> dict:
    """apiKey 打码为尾 4 位（空则空串）。"""
    key = s.get("apiKey") or ""
    return {**s, "apiKey": (f"••••{key[-4:]}" if key else "")}


def websearch_runtime_cfg() -> dict:
    """app.websearch 所需的运行时配置（含明文 key，仅供后端内部调用）。"""
    return get_websearch_settings()


# ============================ 预设与插件 ============================

# 旧版（2026-09 步骤1 重构前）内置整理预设内容 sha——迁移时识别"未改动过的
# 播种预设"，允许整体刷新为新版内容（公共部分已剥离进 organization/common.md）。
_LEGACY_BUNDLED_SHA = {
    ("organization", "题目"): "013aba8f5def40d25dee39e6e0cf6bbe3c873440e5b683dc2029b2ec9d37b054",
    ("organization", "ppt"): "c6ab5a6c869dbd5ea58e1b0c5d6e0325bc3598a67414b932ed9bedbc666d2c26",
}

_PRESET_COLS = 'id, kind, name, display_name, "group", where_id, content, updated_at'


def _preset_dict(r) -> dict:
    return {"id": r["id"], "kind": r["kind"], "name": r["name"],
            "displayName": r["display_name"] or r["name"],
            "group": r["group"], "whereId": r["where_id"],
            "content": r["content"], "updatedAt": r["updated_at"]}


def list_presets(kind: str | None = None) -> list[dict]:
    conn = db.get()
    if kind:
        rows = conn.execute(
            f"SELECT {_PRESET_COLS} FROM presets WHERE kind = ? ORDER BY updated_at",
            (kind,)).fetchall()
    else:
        rows = conn.execute(
            f"SELECT {_PRESET_COLS} FROM presets ORDER BY kind, updated_at").fetchall()
    return [_preset_dict(r) for r in rows]


def get_preset(pid: str) -> dict | None:
    row = db.get().execute(
        f"SELECT {_PRESET_COLS} FROM presets WHERE id = ?", (pid,)).fetchone()
    if row is None:
        return None
    return _preset_dict(row)


def _derive_name(conn, kind: str, display: str) -> str:
    """由显示名推导稳定的内部名（去空白与 @@块/文件名非法字符；同 kind 内唯一）。"""
    base = re.sub(r"[\s@\[\]{}#*`\"'<>|\\/:?]+", "", display or "").strip() or "preset"
    if kind == "plugin" and base.lower() == "summary":
        base = "gen" + base   # summary 是 pass1 摘要块的保留组件名
    name, i = base, 2
    while conn.execute("SELECT 1 FROM presets WHERE kind = ? AND name = ?",
                       (kind, name)).fetchone():
        name = f"{base}{i}"
        i += 1
    return name


def create_preset(kind: str, display_name: str, content: str = "",
                  group: str | None = None, where_id: str | None = None) -> dict:
    pid = _uid()
    conn = db.get()
    name = _derive_name(conn, kind, display_name)
    conn.execute(
        "INSERT INTO presets (id, kind, name, display_name, \"group\", where_id,"
        " content, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (pid, kind, name, display_name or name, group, where_id, content, _now()))
    conn.commit()
    return get_preset(pid)


_UNSET = object()


def update_preset(pid: str, *, display_name=_UNSET, content=_UNSET,
                  where_id=_UNSET, group=_UNSET):
    """改名只改 display_name（内部名 name 永不变更）；
    where_id 显式传 None = 解绑生成位置（区别于"不修改"）。"""
    conn = db.get()
    if display_name is not _UNSET:
        conn.execute("UPDATE presets SET display_name = ?, updated_at = ? WHERE id = ?",
                     (display_name, _now(), pid))
    if content is not _UNSET:
        conn.execute("UPDATE presets SET content = ?, updated_at = ? WHERE id = ?",
                     (content, _now(), pid))
    if where_id is not _UNSET:
        conn.execute("UPDATE presets SET where_id = ?, updated_at = ? WHERE id = ?",
                     (where_id or None, _now(), pid))
    if group is not _UNSET:
        conn.execute('UPDATE presets SET "group" = ?, updated_at = ? WHERE id = ?',
                     (group, _now(), pid))
    conn.commit()


def delete_preset(pid: str):
    conn = db.get()
    row = conn.execute("SELECT kind, display_name FROM presets WHERE id = ?",
                       (pid,)).fetchone()
    if row is None:
        return
    if row["kind"] == "where":
        n = conn.execute(
            "SELECT COUNT(*) c FROM presets WHERE kind = 'plugin' AND where_id = ?",
            (pid,)).fetchone()["c"]
        if n:
            raise ValueError(
                f"「{row['display_name'] or row['kind']}」被 {n} 个内容生成预设引用，"
                "请先在引用它的预设中改绑其他生成位置")
    conn.execute("DELETE FROM presets WHERE id = ?", (pid,))
    conn.commit()


def _sections_of(text: str) -> dict:
    return spec_from_text("x", "x", text or "", with_sections=True).sections


def preset_spec(pid: str, kind: str):
    """预设 id -> PromptSpec（plugin 附带 where 引用：where_id / where_text）。"""
    p = get_preset(pid)
    if p is None or p["kind"] != kind:
        raise KeyError(f"预设不存在或类型不符：{pid}（{kind}）")
    where_id, where_text = None, None
    if kind == "plugin":
        where_id = p.get("whereId")
        if where_id:
            w = get_preset(where_id)
            if w is not None and w["kind"] == "where":
                where_text = _sections_of(w["content"]).get("where", "")
            else:
                where_id = None
        if where_text is None:
            # 兜底：内容自带 ## where（未迁移的旧预设），否则为空（无位置要求）
            where_text = _sections_of(p["content"]).get("where", "")
    return spec_from_text(kind, p["name"], p["content"],
                          with_sections=(kind in ("plugin", "where")),
                          where_id=where_id, where_text=where_text)


def where_spec(pid: str):
    """生成位置预设 id -> PromptSpec（含 sections，供 coverage 与指纹）。"""
    p = get_preset(pid)
    if p is None or p["kind"] != "where":
        return None
    return spec_from_text("where", p["name"], p["content"], with_sections=True)


# ============================ 播种与迁移（启动时幂等） ============================

def _sha_of(text: str) -> str:
    return hashlib.sha256((text or "").replace("\r\n", "\n").encode("utf-8")).hexdigest()


def _dedup_text(content: str) -> str:
    """播种去重对比文本：归一化空白并剔除 ## meta 中的播种指令行（name/where）。"""
    return norm_ws(cut_meta_keys(content or "", {"name", "where"}))


def _seed_item(conn, item: dict):
    """播种单个内置预设（幂等）：
    - 同 (kind, name) 已存在：未改动过的旧版整理预设（sha 命中迁移表）刷新为新版内容；
    - 同 kind 下存在归一化内容完全一致的预设：视为旧文件名的同一预设
      （explain->详细讲解 等；对比时忽略 ## meta 中的 name/where 播种指令行），跳过；
    - 否则插入（display_name=文件名，group 按目录）。
    """
    kind, name = item["kind"], item["name"]
    row = conn.execute("SELECT id, content FROM presets WHERE kind = ? AND name = ?",
                       (kind, name)).fetchone()
    if row is not None:
        legacy = _LEGACY_BUNDLED_SHA.get((kind, name))
        if legacy and _sha_of(row["content"]) == legacy:
            conn.execute("UPDATE presets SET content = ?, updated_at = ? WHERE id = ?",
                         (item["content"], _now(), row["id"]))
            log(f"[seed] 已刷新内置预设「{name}」为新版内容（公共部分剥离）")
        return
    for r in conn.execute("SELECT content FROM presets WHERE kind = ?",
                          (kind,)).fetchall():
        if (_dedup_text(r["content"]) == _dedup_text(item["content"])):
            return
    conn.execute(
        "INSERT INTO presets (id, kind, name, display_name, \"group\", where_id,"
        " content, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (_uid(), kind, name, item["display_name"], item["group"], None,
         item["content"], _now()))
    log(f"[seed] 播种预设 {kind}/{name}")


def _migrate_plugin_where(conn, items: list[dict]):
    """既有 plugin 预设：剥离 ## where -> where_id（按归一化文本匹配生成位置；
    匹配不到则新建隐藏生成位置兜底，绝不允许丢 where）。幂等：无 ## where 即跳过。"""
    where_names: dict[str, str] = {}   # norm(## where 文本) -> 生成位置预设名
    for r in conn.execute("SELECT name, content FROM presets WHERE kind = 'where'").fetchall():
        w = _sections_of(r["content"]).get("where")
        if w:
            where_names.setdefault(norm_ws(w), r["name"])
    for item in items:
        if item["kind"] == "where":
            w = _sections_of(item["content"]).get("where")
            if w:
                where_names.setdefault(norm_ws(w), item["name"])

    rows = conn.execute(
        "SELECT id, name, display_name, content FROM presets WHERE kind = 'plugin'").fetchall()
    for row in rows:
        content = row["content"] or ""
        if "## where" not in content:
            continue
        wtext = _sections_of(content).get("where")
        if not wtext:
            continue
        where_name = where_names.get(norm_ws(wtext))
        if where_name is None:
            base, i = f"{row['name']}_where", 2
            where_name = base
            while conn.execute("SELECT 1 FROM presets WHERE kind = 'where' AND name = ?",
                               (where_name,)).fetchone():
                where_name = f"{base}{i}"
                i += 1
            conn.execute(
                "INSERT INTO presets (id, kind, name, display_name, \"group\", where_id,"
                " content, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (_uid(), "where", where_name,
                 f"{row['display_name'] or row['name']}位置", None, None,
                 f"## where\n\n{wtext.strip()}\n", _now()))
            log(f"[seed] 插件「{row['name']}」的生成位置无法匹配，已兜底新建：{where_name}")
            where_names.setdefault(norm_ws(wtext), where_name)
        wid = conn.execute("SELECT id FROM presets WHERE kind = 'where' AND name = ?",
                           (where_name,)).fetchone()["id"]
        new_content, _ = cut_section(content, "where")
        new_content = cut_meta_keys(new_content, {"coverage"})   # 归属 where 的 meta 键
        conn.execute("UPDATE presets SET content = ?, where_id = ?, updated_at = ?"
                     " WHERE id = ?", (new_content, wid, _now(), row["id"]))
        log(f"[seed] 插件「{row['name']}」已剥离 ## where -> 生成位置「{where_name}」")


def _bind_plugin_where_ids(conn):
    """播种插件文件 ## meta 的 `where: <生成位置名>` -> where_id（仅补空，幂等）。"""
    rows = conn.execute(
        "SELECT id, content, where_id FROM presets WHERE kind = 'plugin'").fetchall()
    for row in rows:
        if row["where_id"]:
            continue
        meta = {}
        for line in _sections_of(row["content"]).get("meta", "").splitlines():
            s = line.strip()
            if s and ":" in s and not s.startswith("#"):
                k, _, v = s.partition(":")
                meta[k.strip()] = v.strip()
        wname = (meta.get("where") or "").strip()
        if not wname:
            continue
        w = conn.execute("SELECT id FROM presets WHERE kind = 'where' AND name = ?",
                         (wname,)).fetchone()
        if w:
            conn.execute("UPDATE presets SET where_id = ? WHERE id = ?",
                         (w["id"], row["id"]))
            log(f"[seed] 插件「{row['id']}」生成位置 -> {wname}")


def migrate_model_types():
    """步骤12 存量迁移（幂等，只填空值）：对 model_type='' 的行按 id 关键词启发式分类。
    不覆盖手动/自动分类过的行；服务商 /models 返回体可精确分类（fetch_provider_models）。
    选启发式而非启动时逐服务商拉取一次：启动保持离线快速、服务商不可达也不阻塞。"""
    conn = db.get()
    rows = conn.execute(
        "SELECT provider_id, model_id FROM models WHERE model_type = ''").fetchall()
    for r in rows:
        conn.execute(
            "UPDATE models SET model_type = ? WHERE provider_id = ? AND model_id = ?",
            (_classify_by_name(r["model_id"]), r["provider_id"], r["model_id"]))
    if rows:
        log(f"[seed] 模型类型迁移：按名称启发式分类 {len(rows)} 个未分类模型"
            "（可手动修改；拉取模型列表会按 supported_endpoint_types 精确分类）")
    conn.commit()


def seed():
    """启动迁移与播种（幂等，每次启动执行）：
    1. 旧库回填 display_name（=name）与 organization 分组（默认 doc）；
    2. 播种生成位置（kind='where'，后续迁移的匹配目标）；
    3. 既有插件剥离 ## where -> where_id；
    4. 播种整理预设（group=doc|web）与内容生成预设（同名/同内容跳过）；
    5. 插件 ## meta 的 where: 名 -> where_id；
    6. （步骤12）模型类型迁移：model_type='' 的行按 id 关键词启发式分类（幂等只填空值）。
    """
    conn = db.get()
    conn.execute("UPDATE presets SET display_name = name"
                 " WHERE display_name IS NULL OR display_name = ''")
    conn.execute("UPDATE presets SET \"group\" = 'doc' WHERE kind = 'organization'"
                 " AND (\"group\" IS NULL OR \"group\" = '')")
    conn.commit()

    items = builtin.seed_presets()

    for item in items:
        if item["kind"] == "where":
            _seed_item(conn, item)
    conn.commit()

    _migrate_plugin_where(conn, items)
    conn.commit()

    for item in items:
        if item["kind"] != "where":
            _seed_item(conn, item)

    _bind_plugin_where_ids(conn)
    conn.commit()

    migrate_model_types()


# ============================ 汇总 ============================

def get_settings() -> dict:
    return {
        "providers": list_providers(),
        "defaults": get_defaults(),
        "parser": get_parser_settings(),
        "websearch": mask_websearch(get_websearch_settings()),
    }
