"""检索器：embed 查询 -> 余弦 topK -> 重排（可选）-> 阈值过滤 -> topN。"""
from app.rag.embeddings import embed_texts
from app.rag.rerank import rerank_chunks
from app.rag import vectorstore
from app.services import index_service

TOP_K = 20       # 召回数
TOP_N = 6        # 最终上下文条数
MIN_SCORE = 0.25 # 相似度阈值（低于此视为不相关；对齐 AnythingLLM 默认 0.25）


def retrieve(query: str, kb_ids: list[str], *, embed_cfg: dict,
             rerank_cfg: dict | None = None, top_k: int = TOP_K,
             top_n: int = TOP_N, min_score: float = MIN_SCORE) -> list[dict]:
    """embed_cfg/rerank_cfg: {base_url, api_key, model}；rerank 未配置则跳过。
    软关闭（enabled=False）文档的向量保留在库，但检索时排除。"""
    if not query.strip():
        return []
    qvec = embed_texts([query], **embed_cfg)[0]
    hits = vectorstore.search(kb_ids, qvec, top_k=top_k,
                              exclude_doc_ids=index_service.disabled_doc_ids(kb_ids))
    if rerank_cfg and hits:
        hits = rerank_chunks(query, hits, rerank_cfg, top_n=top_k)
    hits = [h for h in hits if h.get("score", 0) >= min_score]
    return hits[:top_n]
