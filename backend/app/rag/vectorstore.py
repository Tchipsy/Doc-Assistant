"""向量存储：嵌入存 SQLite BLOB，NumPy 余弦检索（单机个人规模）。"""
import struct
import uuid

import numpy as np

from app import db

# 单条片段文本上限（超长截断，防止嵌入失败）
MAX_TEXT_CHARS = 8000


def _vec_to_blob(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def _blob_to_vec(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


def insert_chunks(rows: list[dict]):
    """rows: {kb_id, doc_id, preset_id, artifact, section_num, anchor,
    line_start, line_end, breadcrumb, text, kind, embedding}"""
    conn = db.get()
    for r in rows:
        text = (r["text"] or "")[:MAX_TEXT_CHARS]
        conn.execute(
            "INSERT INTO chunks (id, kb_id, doc_id, preset_id, artifact, section_num,"
            " anchor, line_start, line_end, breadcrumb, text, kind, embedding)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (uuid.uuid4().hex[:16], r["kb_id"], r["doc_id"], r.get("preset_id", ""),
             r["artifact"], r.get("section_num", ""), r.get("anchor", ""),
             r.get("line_start"), r.get("line_end"), r.get("breadcrumb", ""),
             text, r.get("kind", "section"),
             _vec_to_blob(r["embedding"]) if r.get("embedding") is not None else None))
    conn.commit()


def delete_chunks(doc_id: str, artifact: str | None = None):
    """删除片段。artifact 为空删整个文档，否则只删该产物（插件增量增删用）。"""
    conn = db.get()
    if artifact is None:
        conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
    else:
        conn.execute("DELETE FROM chunks WHERE doc_id = ? AND artifact = ?",
                     (doc_id, artifact))
    conn.commit()


def delete_doc_chunks(doc_id: str):
    delete_chunks(doc_id)


def count_doc(doc_id: str) -> int:
    return db.get().execute(
        "SELECT COUNT(*) c FROM chunks WHERE doc_id = ?", (doc_id,)).fetchone()["c"]


def search(kb_ids: list[str], query_vec: list[float], top_k: int = 20,
           exclude_doc_ids: list[str] | None = None) -> list[dict]:
    """余弦相似度检索。kb_ids 为空则检索全部；exclude_doc_ids 用于软关闭
    （向量保留在库、检索时排除）。返回按相似度降序的片段记录。"""
    conn = db.get()
    cond, params = ["embedding IS NOT NULL"], []
    if kb_ids:
        cond.append(f"kb_id IN ({','.join('?' * len(kb_ids))})")
        params += list(kb_ids)
    if exclude_doc_ids:
        cond.append(f"doc_id NOT IN ({','.join('?' * len(exclude_doc_ids))})")
        params += list(exclude_doc_ids)
    rows = conn.execute(f"SELECT * FROM chunks WHERE {' AND '.join(cond)}",
                        params).fetchall()
    if not rows:
        return []
    q = np.asarray(query_vec, dtype=np.float32)
    qn = np.linalg.norm(q)
    if qn == 0:
        return []
    q = q / qn
    scored = []
    for row in rows:
        v = _blob_to_vec(row["embedding"])
        vn = np.linalg.norm(v)
        if vn == 0:
            continue
        sim = float(np.dot(q, v) / vn)
        scored.append((sim, row))
    scored.sort(key=lambda x: -x[0])
    out = []
    for sim, row in scored[:top_k]:
        d = dict(row)
        d.pop("embedding", None)
        d["score"] = round(sim, 4)
        out.append(d)
    return out


def count_by_kb(kb_ids: list[str] | None = None) -> int:
    conn = db.get()
    if kb_ids:
        marks = ",".join("?" * len(kb_ids))
        return conn.execute(
            f"SELECT COUNT(*) c FROM chunks WHERE kb_id IN ({marks})", kb_ids).fetchone()["c"]
    return conn.execute("SELECT COUNT(*) c FROM chunks").fetchone()["c"]
