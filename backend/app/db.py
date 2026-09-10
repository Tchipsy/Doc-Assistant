"""SQLite 数据库（app.db）：设置/注册表/预设/会话/消息/chunks/jobs。"""
import json
import sqlite3
import threading
from pathlib import Path

DB_PATH = None
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS kbs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
    sort_order REAL NOT NULL DEFAULT 0,
    gen_config TEXT, index_config TEXT
);
CREATE TABLE IF NOT EXISTS docs (
    id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES kbs(id) ON DELETE CASCADE,
    name TEXT NOT NULL, source_kind TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
    doc_type TEXT NOT NULL DEFAULT 'doc',
    status TEXT NOT NULL DEFAULT 'pending',
    parse_config TEXT NOT NULL DEFAULT '{}',
    gen_config TEXT NOT NULL DEFAULT '{}',
    index_config TEXT NOT NULL DEFAULT '{}',
    indexed_at TEXT, index_fp TEXT, index_state TEXT,
    created_at TEXT NOT NULL,
    sort_order REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS models (
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0,
    model_type TEXT NOT NULL DEFAULT '',
    image_input INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider_id, model_id)
);
CREATE TABLE IF NOT EXISTS settings_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS presets (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
    display_name TEXT, "group" TEXT, where_id TEXT,
    content TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新会话',
    mode TEXT NOT NULL DEFAULT 'chat', model TEXT, kb_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
    reasoning TEXT NOT NULL DEFAULT '', tool_calls TEXT NOT NULL DEFAULT '[]',
    citations TEXT NOT NULL DEFAULT '[]', kb_ids TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'chat',
    segments TEXT NOT NULL DEFAULT '[]', stopped INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY, kb_id TEXT NOT NULL, doc_id TEXT NOT NULL,
    preset_id TEXT NOT NULL DEFAULT '', artifact TEXT NOT NULL,
    section_num TEXT NOT NULL DEFAULT '', anchor TEXT NOT NULL DEFAULT '',
    line_start INTEGER, line_end INTEGER, breadcrumb TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'section',
    embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_chunks_kb ON chunks(kb_id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_docs_kb ON docs(kb_id);
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, kind TEXT NOT NULL,
    path TEXT NOT NULL, created_at TEXT NOT NULL
);
"""


def init(db_path: str | Path):
    global DB_PATH
    DB_PATH = str(Path(db_path).resolve())
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with get() as conn:
        conn.executescript(SCHEMA)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(docs)")}
        if "index_state" not in cols:
            conn.execute("ALTER TABLE docs ADD COLUMN index_state TEXT")
            conn.commit()

        # 9.5 步骤11 迁移（幂等）：文档类型 doc|web（链接导入 → web）
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(docs)")}
        if "doc_type" not in cols:
            conn.execute("ALTER TABLE docs ADD COLUMN doc_type TEXT NOT NULL DEFAULT 'doc'")
        # 知识库级默认配置（JSON，{"doc": {...}, "web": {...}} 双份；NULL=未设置）
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(kbs)")}
        if "gen_config" not in cols:
            conn.execute("ALTER TABLE kbs ADD COLUMN gen_config TEXT")
        if "index_config" not in cols:
            conn.execute("ALTER TABLE kbs ADD COLUMN index_config TEXT")
        conn.commit()

        # models 表迁移（9.5 步骤12）：模型类型（''/chat/embedding/rerank）与图片输入能力标记（幂等）
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(models)")}
        if "model_type" not in cols:
            conn.execute("ALTER TABLE models ADD COLUMN model_type TEXT NOT NULL DEFAULT ''")
        if "image_input" not in cols:
            conn.execute("ALTER TABLE models ADD COLUMN image_input INTEGER NOT NULL DEFAULT 0")
        conn.commit()

        # presets 表迁移（2026-09 步骤1）：display_name / group / where_id（幂等）
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(presets)")}
        for col, ddl in (("display_name", "ALTER TABLE presets ADD COLUMN display_name TEXT"),
                         ("group", 'ALTER TABLE presets ADD COLUMN "group" TEXT'),
                         ("where_id", "ALTER TABLE presets ADD COLUMN where_id TEXT")):
            if col not in cols:
                conn.execute(ddl)
        # sessions 表迁移（9.5 步骤2）：每会话独立的 mode/model/kb_ids（幂等）
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
        for col, ddl in (
                ("mode", "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'"),
                ("model", "ALTER TABLE sessions ADD COLUMN model TEXT"),
                ("kb_ids", "ALTER TABLE sessions ADD COLUMN kb_ids TEXT NOT NULL DEFAULT '[]'")):
            if col not in cols:
                conn.execute(ddl)
        # sessions 表迁移（9.5 步骤4）：会话级联网开关
        # （二选一定案：单布尔字段用独立列而非 chat_settings JSON——与既有列风格一致、
        #  PATCH 部分更新最简单；若后续布尔开关增多再迁移 JSON）
        if "web_search" not in cols:
            conn.execute("ALTER TABLE sessions ADD COLUMN web_search INTEGER NOT NULL DEFAULT 0")
        # messages 表迁移（9.5 步骤2）：分段模型 + 停止标记（幂等）
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(messages)")}
        for col, ddl in (
                ("segments", "ALTER TABLE messages ADD COLUMN segments TEXT NOT NULL DEFAULT '[]'"),
                ("stopped", "ALTER TABLE messages ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0")):
            if col not in cols:
                conn.execute(ddl)
        # sort_order 迁移（9.5 步骤10）：手动排序（REAL，分数定位法）。幂等 ALTER；
        # 旧数据迁移值=按迁移时刻的现有显示顺序赋 1000, 2000, …（知识库 created_at 升序；
        # 文档按旧前端的 statusSortKey 分组 + created_at 降序，保留用户当前看到的顺序）
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(kbs)")}
        if "sort_order" not in cols:
            conn.execute("ALTER TABLE kbs ADD COLUMN sort_order REAL NOT NULL DEFAULT 0")
            conn.execute("""
                UPDATE kbs SET sort_order = 1000.0 * (1 + (
                    SELECT COUNT(*) FROM kbs k2
                    WHERE k2.created_at < kbs.created_at
                       OR (k2.created_at = kbs.created_at AND k2.id < kbs.id)))
            """)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(docs)")}
        if "sort_order" not in cols:
            conn.execute("ALTER TABLE docs ADD COLUMN sort_order REAL NOT NULL DEFAULT 0")
            conn.execute("""
                UPDATE docs SET sort_order = 1000.0 * (1 + (
                    SELECT COUNT(*) FROM docs d2
                    WHERE d2.kb_id = docs.kb_id AND (
                        (CASE d2.status WHEN 'parsing' THEN 0 WHEN 'generating' THEN 0
                                        WHEN 'pending' THEN 1 WHEN 'ready' THEN 2
                                        WHEN 'done' THEN 3 ELSE 4 END)
                          < (CASE docs.status WHEN 'parsing' THEN 0 WHEN 'generating' THEN 0
                                              WHEN 'pending' THEN 1 WHEN 'ready' THEN 2
                                              WHEN 'done' THEN 3 ELSE 4 END)
                     OR (d2.status = docs.status AND d2.created_at > docs.created_at)
                     OR (d2.status = docs.status AND d2.created_at = docs.created_at
                         AND d2.id < docs.id))))
            """)
        conn.commit()


def get() -> sqlite3.Connection:
    """每线程一个连接（sqlite3 检查同线程使用）。"""
    conn = getattr(_local, "conn", None)
    if conn is None or getattr(_local, "path", None) != DB_PATH:
        if conn is not None:
            conn.close()
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        _local.conn = conn
        _local.path = DB_PATH
    return conn


def kv_get(key: str, default=None):
    row = get().execute("SELECT value FROM settings_kv WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    return json.loads(row["value"])


def kv_set(key: str, value):
    get().execute(
        "INSERT INTO settings_kv (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value, ensure_ascii=False)))
    # 必须提交：Python sqlite3 隐式事务下，不 commit 会在线程池连接上留下未提交的
    # 写事务（持有 WAL 写锁），阻塞其他线程的全部写操作直至 busy timeout
    # （步骤4 实测触发：PUT /settings/websearch 后 POST /chat 报 database is locked）
    get().commit()
