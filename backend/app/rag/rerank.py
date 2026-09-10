"""重排：通用 /rerank HTTP（SiliconFlow / Jina / Cohere 同构请求体）。"""
import httpx

from engine.config import log


def rerank_chunks(query: str, chunks: list[dict], cfg: dict,
                  top_n: int = 20) -> list[dict]:
    """cfg: {base_url, api_key, model}。失败时跳过重排（返回原序）。"""
    try:
        with httpx.Client(
                base_url=cfg["base_url"].rstrip("/"),
                headers={"Authorization": f"Bearer {cfg.get('api_key', '')}"},
                timeout=httpx.Timeout(60.0), trust_env=False) as client:
            resp = client.post("/rerank", json={
                "model": cfg["model"], "query": query,
                "documents": [c["text"] for c in chunks],
                "top_n": top_n,
            })
        if resp.status_code != 200:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:200]}")
        results = resp.json().get("results") or []
        out = []
        for r in results:
            idx = r.get("index")
            if idx is None or not (0 <= idx < len(chunks)):
                continue
            c = dict(chunks[idx])
            c["score"] = round(float(r.get("relevance_score", 0.0)), 4)
            out.append(c)
        if out:
            return out
        return chunks
    except Exception as e:  # noqa: BLE001
        log(f"[rag] ⚠️ 重排失败，跳过：{type(e).__name__}: {e}")
        return chunks
