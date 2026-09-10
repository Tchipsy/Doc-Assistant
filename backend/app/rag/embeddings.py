"""嵌入客户端：OpenAI 兼容 /embeddings。"""
import re
import threading

import httpx

from engine.config import log


class EmbeddingError(Exception):
    pass


class EmbeddingClient:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 120.0):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
            timeout=httpx.Timeout(timeout, connect=30.0),
            trust_env=False,
        )

    def embed(self, texts: list[str]) -> list[list[float]]:
        """调用 /embeddings；遇到"input limit exceeded: max N"类 400 错误时，
        自适应缩小批次重试（不同服务商单批上限不同：10/16/32/64/128 常见）。
        httpx.Client 线程安全，不加锁——多文档入库可并发调用同一 client。"""
        if not texts:
            return []
        resp = self._client.post("/embeddings",
                                 json={"model": self.model, "input": texts})
        if resp.status_code == 400:
            m = re.search(r"input limit exceeded: max (\d+)", resp.text) or \
                re.search(r"max (\d+) (?:items|inputs|texts)", resp.text, re.I)
            if m and len(texts) > 1:
                limit = max(1, int(m.group(1)))
                out: list[list[float]] = []
                for i in range(0, len(texts), limit):
                    out.extend(self._embed_once(texts[i:i + limit]))
                return out
        if resp.status_code != 200:
            raise EmbeddingError(
                f"embeddings 调用失败 {resp.status_code}: {resp.text[:300]}")
        return self._parse(resp, texts)

    def _embed_once(self, texts: list[str]) -> list[list[float]]:
        resp = self._client.post("/embeddings",
                                 json={"model": self.model, "input": texts})
        if resp.status_code != 200:
            raise EmbeddingError(
                f"embeddings 调用失败 {resp.status_code}: {resp.text[:300]}")
        return self._parse(resp, texts)

    @staticmethod
    def _parse(resp, texts) -> list[list[float]]:
        data = resp.json().get("data") or []
        data.sort(key=lambda d: d.get("index", 0))
        if len(data) != len(texts):
            raise EmbeddingError(f"embeddings 返回数量不匹配：{len(data)} != {len(texts)}")
        return [d["embedding"] for d in data]


_client_cache: dict[tuple, EmbeddingClient] = {}
_cache_lock = threading.Lock()


def get_client(base_url: str, api_key: str, model: str) -> EmbeddingClient:
    key = (base_url, api_key, model)
    with _cache_lock:
        c = _client_cache.get(key)
        if c is None:
            c = EmbeddingClient(base_url, api_key, model)
            _client_cache[key] = c
        return c


def embed_texts(texts: list[str], *, base_url: str, api_key: str, model: str,
                batch_size: int = 8, on_progress=None, gate=None) -> list[list[float]]:
    """分批嵌入；on_progress(done, total) 汇报进度；gate() 在每批边界调用
    （暂停闸门：阻塞到继续后从下一批继续）。"""
    client = get_client(base_url, api_key, model)
    out: list[list[float]] = []
    total = len(texts)
    for i in range(0, total, batch_size):
        if gate:
            gate()
        batch = texts[i:i + batch_size]
        out.extend(client.embed(batch))
        if on_progress:
            try:
                on_progress(min(i + len(batch), total), total)
            except Exception:  # noqa: BLE001
                pass
    log(f"[rag] 嵌入完成：{total} 条（model={model}）")
    return out
