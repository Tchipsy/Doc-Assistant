"""联网搜索封装（9.5 步骤4）：web_search / web_fetch 统一出口，按服务商分发。

服务商（settings_kv 键 `websearch` = {provider, apiUrl, apiKey}）：
- tavily:  POST {apiUrl}/search（body 带 api_key）+ /extract；
- exa:     POST {apiUrl}/search（header x-api-key，contents.text 截断）+ /contents；
- jina:    GET https://s.jina.ai/{query}（Bearer，返回 JSON/文本结果）+ GET {apiUrl}/{url}
           （r.jina.ai reader，天然返回 markdown）；
- examcp:  JSON-RPC over HTTP 直调 MCP Streamable HTTP（默认 https://mcp.exa.ai/mcp，免密钥，
           **手写协议、不引入 SDK**）：initialize 握手（响应头取 Mcp-Session-Id）→
           notifications/initialized → tools/list（缓存工具名映射，模糊匹配）→ tools/call。
           响应可能为 text/event-stream：按 Content-Type 分支，SSE 则逐 data: 帧读
           到 id 匹配的 result/error（2026-09-06 curl 实测 mcp.exa.ai 全程 SSE）。

统一约定：
- 15s 超时；不使用环境代理（trust_env=False，与项目其他 HTTP 客户端一致）；
- **异常一律降级**：返回 (结果, 错误文本) 而非抛异常——错误文本作为 tool 消息给模型
  （提示"联网不可用，请基于已有知识继续"），绝不炸聊天/生成流水线；
- MCP session id 与工具名映射进程内缓存（线程安全），握手失败/会话过期自动重握手一次。
"""
import json
import re
import threading
import urllib.parse

import httpx

TIMEOUT = 15.0
FETCH_MAX_CHARS = 6000          # web_fetch 返回给模型的正文上限
SEARCH_SNIPPET_CHARS = 1200     # 单条搜索摘要上限
JINA_SEARCH_URL = "https://s.jina.ai"

# 服务商默认 API 地址（设置页"选择服务商时预填"与此保持一致）
DEFAULT_API_URLS = {
    "tavily": "https://api.tavily.com",
    "exa": "https://api.exa.ai",
    "examcp": "https://mcp.exa.ai/mcp",
    "jina": "https://r.jina.ai",
}


def _error(provider: str, detail: str, action: str = "联网") -> str:
    """模型可见的降级消息：说明不可用 + 指示基于已有知识继续。"""
    return (f"{action}不可用（服务商 {provider}）：{detail}。"
            "请基于已有知识继续，不要虚构来源，也不要重复发起相同的网络请求。")


def _client() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(TIMEOUT, connect=10.0),
                        trust_env=False, follow_redirects=True)


def _cfg() -> dict:
    """读当前配置（避免循环导入，运行时导入 settings_service）。"""
    from app.services import settings_service
    return settings_service.websearch_runtime_cfg()


# ============================ 统一出口 ============================

def web_search(query: str, max_results: int = 5) -> tuple[str | None, list[dict]]:
    """联网搜索 -> (错误文本|None, [{title, url, snippet}])。

    返回顺序与 _rag_search 的 (err, hits) 惯例一致——错误文本在首位，
    调用方 `err, results = web_search(...)`。"""
    query = (query or "").strip()
    if not query:
        return "搜索词为空。", []
    try:
        max_results = max(1, min(int(max_results or 5), 8))
    except (TypeError, ValueError):
        max_results = 5
    cfg = _cfg()
    provider = cfg.get("provider") or "examcp"
    key = cfg.get("apiKey") or ""
    url = (cfg.get("apiUrl") or DEFAULT_API_URLS.get(provider, "")).rstrip("/")
    try:
        if provider == "tavily":
            return None, _tavily_search(url, key, query, max_results)
        if provider == "exa":
            return None, _exa_search(url, key, query, max_results)
        if provider == "jina":
            return None, _jina_search(key, query, max_results)
        if provider == "examcp":
            return None, _mcp_search(query, max_results)
        return _error(provider, "未知服务商"), []
    except Exception as e:  # noqa: BLE001  任何异常都降级为错误文本
        return _error(provider, f"{type(e).__name__}: {str(e)[:200]}"), []


def web_fetch(url: str) -> tuple[str | None, dict | None]:
    """读取网页 -> (错误文本|None, {title, url, content(markdown, 截 ~6000 字)})。"""
    url = (url or "").strip()
    if not re.match(r"^https?://", url):
        return "URL 无效（仅支持 http/https）。", None
    cfg = _cfg()
    provider = cfg.get("provider") or "examcp"
    key = cfg.get("apiKey") or ""
    base = (cfg.get("apiUrl") or DEFAULT_API_URLS.get(provider, "")).rstrip("/")
    try:
        if provider == "tavily":
            return None, _tavily_fetch(base, key, url)
        if provider == "exa":
            return None, _exa_fetch(base, key, url)
        if provider == "jina":
            return None, _jina_fetch(base, key, url)
        if provider == "examcp":
            return None, _mcp_fetch(url)
        return _error(provider, "未知服务商", action="读取网页"), None
    except Exception as e:  # noqa: BLE001
        return _error(provider, f"{type(e).__name__}: {str(e)[:200]}", action="读取网页"), None


# ============================ tavily ============================

def _tavily_search(base: str, key: str, query: str, max_results: int) -> list[dict]:
    if not key:
        raise RuntimeError("缺少 API 密钥（设置 → 网络搜索）")
    with _client() as http:
        r = http.post(f"{base}/search", json={
            "api_key": key, "query": query, "max_results": max_results,
            "include_answer": False})
        r.raise_for_status()
        data = r.json()
    out = []
    for it in (data.get("results") or [])[:max_results]:
        out.append({"title": (it.get("title") or "").strip(),
                    "url": it.get("url") or "",
                    "snippet": (it.get("content") or "")[:SEARCH_SNIPPET_CHARS]})
    return out


def _tavily_fetch(base: str, key: str, url: str) -> dict:
    if not key:
        raise RuntimeError("缺少 API 密钥（设置 → 网络搜索）")
    with _client() as http:
        r = http.post(f"{base}/extract", json={"api_key": key, "urls": [url]})
        r.raise_for_status()
        data = r.json()
    results = data.get("results") or []
    failed = data.get("failed_results") or []
    if not results:
        msg = failed[0].get("error") if failed and isinstance(failed[0], dict) else "页面提取为空"
        raise RuntimeError(f"extract 失败：{msg}")
    it = results[0]
    return {"title": (it.get("title") or url).strip(),
            "url": it.get("url") or url,
            "content": (it.get("raw_content") or "")[:FETCH_MAX_CHARS]}


# ============================ exa ============================

def _exa_search(base: str, key: str, query: str, max_results: int) -> list[dict]:
    if not key:
        raise RuntimeError("缺少 API 密钥（设置 → 网络搜索）")
    with _client() as http:
        r = http.post(f"{base}/search",
                      headers={"x-api-key": key},
                      json={"query": query, "numResults": max_results,
                            "contents": {"text": {"maxCharacters": 2000}}})
        r.raise_for_status()
        data = r.json()
    out = []
    for it in (data.get("results") or [])[:max_results]:
        out.append({"title": (it.get("title") or "").strip(),
                    "url": it.get("url") or "",
                    "snippet": (it.get("text") or "")[:SEARCH_SNIPPET_CHARS]})
    return out


def _exa_fetch(base: str, key: str, url: str) -> dict:
    if not key:
        raise RuntimeError("缺少 API 密钥（设置 → 网络搜索）")
    with _client() as http:
        r = http.post(f"{base}/contents",
                      headers={"x-api-key": key},
                      json={"ids": [url], "text": {"maxCharacters": FETCH_MAX_CHARS}})
        r.raise_for_status()
        data = r.json()
    results = data.get("results") or []
    if not results:
        raise RuntimeError("contents 返回为空")
    it = results[0]
    return {"title": (it.get("title") or url).strip(),
            "url": it.get("url") or url,
            "content": (it.get("text") or "")[:FETCH_MAX_CHARS]}


# ============================ jina ============================

def _jina_search(key: str, query: str, max_results: int) -> list[dict]:
    """s.jina.ai search（复用 r.jina.ai 同一 apiKey）。JSON 优先，失败按纯文本解析。"""
    if not key:
        raise RuntimeError("缺少 API 密钥（设置 → 网络搜索）")
    q = urllib.parse.quote(query, safe="")
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    with _client() as http:
        r = http.get(f"{JINA_SEARCH_URL}/{q}", headers=headers)
        r.raise_for_status()
        ct = r.headers.get("content-type", "")
        if "json" in ct:
            data = r.json().get("data") or []
            out = []
            for it in data[:max_results]:
                text = it.get("description") or it.get("content") or ""
                out.append({"title": (it.get("title") or "").strip(),
                            "url": it.get("url") or "",
                            "snippet": text[:SEARCH_SNIPPET_CHARS]})
            return out
    # 文本形态：按 reader 条目解析（Title:/URL Source:/Markdown Content:）
    return _parse_jina_reader_list(r.text)[:max_results]


def _parse_jina_reader_list(text: str) -> list[dict]:
    """s.jina.ai 纯文本形态：条目以 Title: 行开始，块间可能空行分隔。"""
    out, cur = [], None
    for line in text.splitlines():
        if line.startswith("Title: "):
            if cur:
                out.append(cur)
            cur = {"title": line[7:].strip(), "url": "", "snippet": ""}
        elif cur is not None:
            if line.startswith(("URL Source: ", "URL: ")) and not cur["url"]:
                cur["url"] = line.split(": ", 1)[-1].strip()
            elif line.strip() and cur["url"]:
                cur["snippet"] = (cur["snippet"] + line.strip() + " ")[:SEARCH_SNIPPET_CHARS]
    if cur:
        out.append(cur)
    return out


def _jina_fetch(base: str, key: str, url: str) -> dict:
    """r.jina.ai reader：GET {apiUrl}/{url}，默认返回 markdown 文本（带 Title 头）。"""
    headers = {"Accept": "text/plain"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    with _client() as http:
        r = http.get(f"{base}/{url}", headers=headers)
        r.raise_for_status()
        ct = r.headers.get("content-type", "")
        if "json" in ct:
            it = (r.json().get("data") or {})
            return {"title": (it.get("title") or url).strip(),
                    "url": it.get("url") or url,
                    "content": (it.get("content") or "")[:FETCH_MAX_CHARS]}
        text = r.text
    title, body = url, text
    m = re.search(r"^Title:\s*(.+?)\s*$", text, re.M)
    if m:
        title = m.group(1)
    m = re.search(r"^Markdown Content:\s*\n?", text, re.M)
    if m:
        body = text[m.end():]
    return {"title": title.strip(), "url": url, "content": body[:FETCH_MAX_CHARS]}


# ============================ examcp（MCP JSON-RPC 直调，无 SDK） ============================
# 报文实测（2026-09-06，https://mcp.exa.ai/mcp，详见 测试记录与已知问题.md §0f）：
# - initialize / tools/list / tools/call 响应均为 text/event-stream（data: 帧含 JSON-RPC result）；
# - initialize 的 Mcp-Session-Id 在响应头；notifications/initialized 返回 202 空 body；
# - 工具名 web_search_exa（query/numResults）、web_fetch_exa（urls[]/maxCharacters），
#   以 tools/list 实际返回做模糊映射，不写死；
# - 搜索结果在 content[0].text 中以 "\n\n---\n\n" 分隔，块内 Title:/URL:/.../Highlights:。

_MCP_LOCK = threading.Lock()
_MCP_CACHE: dict = {"session": None, "tools": {}}   # tools: {"web_search": 真实名, "web_fetch": 真实名}


def _mcp_post(http: httpx.Client, url: str, payload: dict,
              session: str | None = None) -> tuple[dict | None, str | None]:
    """一次 JSON-RPC POST；按 Content-Type 分支解析（SSE / 纯 JSON / 202 空）。"""
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream"}
    if session:
        headers["Mcp-Session-Id"] = session
    r = http.post(url, json=payload, headers=headers)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    sid = r.headers.get("mcp-session-id")
    ct = r.headers.get("content-type", "")
    if r.status_code == 202 or not r.text.strip():
        return None, sid
    if "text/event-stream" in ct:
        return _parse_sse_response(r.text, payload.get("id")), sid
    return r.json(), sid


def _parse_sse_response(text: str, want_id) -> dict | None:
    """逐帧读 data: 直到拿到 id 匹配的 JSON-RPC 响应；退化取最后一个 data 帧。"""
    last = None
    for frame in text.split("\n\n"):
        for line in frame.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            try:
                obj = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            last = obj
            if isinstance(obj, dict) and obj.get("id") == want_id \
                    and ("result" in obj or "error" in obj):
                return obj
    if last is None:
        raise RuntimeError("MCP 响应缺少 data 帧")
    return last


def _norm_tool_key(name: str) -> str:
    return re.sub(r"[^a-z]", "", (name or "").lower())


def _mcp_handshake(http: httpx.Client, base: str) -> None:
    """initialize → notifications/initialized → tools/list（缓存 session 与工具名映射）。"""
    obj, sid = _mcp_post(http, base, {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                   "clientInfo": {"name": "doc-assistant", "version": "1.0"}}})
    if obj and obj.get("error"):
        raise RuntimeError(f"initialize 失败：{obj['error'].get('message', obj['error'])}")
    if not sid:
        raise RuntimeError("initialize 未返回 Mcp-Session-Id")
    _mcp_post(http, base, {"jsonrpc": "2.0", "method": "notifications/initialized"},
              session=sid)
    obj2, _ = _mcp_post(http, base, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                        session=sid)
    if obj2 and obj2.get("error"):
        raise RuntimeError(f"tools/list 失败：{obj2['error'].get('message', obj2['error'])}")
    mapping: dict = {}
    for t in ((obj2 or {}).get("result") or {}).get("tools") or []:
        real, n = t.get("name") or "", _norm_tool_key(t.get("name"))
        if "websearch" in n or n in ("search", "websearch"):
            mapping.setdefault("web_search", real)
        elif "webfetch" in n or n in ("fetch", "read", "crawl", "extract", "webread"):
            mapping.setdefault("web_fetch", real)
    if not mapping:
        raise RuntimeError("MCP 服务未提供 web_search/web_fetch 类工具："
                           f"{[t.get('name') for t in ((obj2 or {}).get('result') or {}).get('tools') or []]}")
    _MCP_CACHE["session"] = sid
    _MCP_CACHE["tools"] = mapping
    _MCP_CACHE["schemas"] = {
        (t.get("name") or ""): (t.get("inputSchema") or {})
        for t in ((obj2 or {}).get("result") or {}).get("tools") or []}


def _mcp_reset():
    _MCP_CACHE["session"] = None
    _MCP_CACHE["tools"] = {}
    _MCP_CACHE.pop("schemas", None)


def _mcp_call(name: str, kwargs: dict) -> dict | None:
    """tools/call（自动握手；会话失效重握手一次）。返回 result 对象。"""
    cfg = _cfg()
    base = (cfg.get("apiUrl") or DEFAULT_API_URLS["examcp"]).rstrip("/")
    with _client() as http, _MCP_LOCK:
        if not _MCP_CACHE.get("session") or not _MCP_CACHE.get("tools"):
            _mcp_handshake(http, base)
        real = _MCP_CACHE["tools"].get(name)
        if not real:
            raise RuntimeError(f"MCP 服务无 {name} 工具：{_MCP_CACHE['tools']}")
        args = _mcp_args(_MCP_CACHE.get("schemas", {}).get(real, {}), kwargs)
        payload = {"jsonrpc": "2.0", "id": 10, "method": "tools/call",
                   "params": {"name": real, "arguments": args}}
        obj, _ = _mcp_post(http, base, payload, session=_MCP_CACHE["session"])
        err = (obj or {}).get("error")
        if err and ("session" in str(err).lower() or "404" in str(err)):
            _mcp_reset()                      # 会话过期：重握手后重试一次
            _mcp_handshake(http, base)
            real = _MCP_CACHE["tools"].get(name)
            args = _mcp_args(_MCP_CACHE.get("schemas", {}).get(real, {}), kwargs)
            payload["params"] = {"name": real, "arguments": args}
            obj, _ = _mcp_post(http, base, payload, session=_MCP_CACHE["session"])
            err = (obj or {}).get("error")
        if err:
            raise RuntimeError(f"tools/call 失败：{str(err)[:200]}")
        return (obj or {}).get("result")


def _mcp_args(schema: dict, kwargs: dict) -> dict:
    """按目标工具 inputSchema 过滤/补齐参数（不写死服务商私有形状）。"""
    props = (schema or {}).get("properties") or {}
    out = {k: v for k, v in kwargs.items() if k in props}
    for req in (schema or {}).get("required", []):
        if req in out:
            continue
        if req == "query":
            out["query"] = kwargs.get("query", "")
        elif req == "urls":
            out["urls"] = [kwargs["url"]] if kwargs.get("url") else []
        elif req == "url":
            out["url"] = kwargs.get("url", "")
        elif req == "numResults":
            out["numResults"] = kwargs.get("numResults", 5)
        elif req == "maxCharacters":
            out["maxCharacters"] = FETCH_MAX_CHARS
    return out


def _mcp_content_text(result: dict) -> str:
    """tools/call result -> content[0].text（isError 亦视为错误文本）。"""
    content = (result or {}).get("content") or []
    text = "\n".join(c.get("text") or "" for c in content
                     if isinstance(c, dict) and c.get("type") == "text").strip()
    if (result or {}).get("isError"):
        raise RuntimeError(f"工具返回错误：{text[:200] or '未知错误'}")
    if not text:
        raise RuntimeError("工具结果为空")
    return text


def _parse_exa_blob(text: str) -> list[dict]:
    """examcp 搜索结果解析：条目以 Title: 行开始、\n\n---\n\n 分隔。"""
    out = []
    for chunk in re.split(r"\n\s*---+\s*\n", text):
        chunk = chunk.strip()
        if not chunk:
            continue
        mt = re.search(r"^Title:\s*(.+?)\s*$", chunk, re.M)
        mu = re.search(r"^(?:URL|URL Source):\s*(\S+)\s*$", chunk, re.M)
        mh = re.search(r"^Highlights:\s*\n?", chunk, re.M)
        title = (mt.group(1) if mt else "").strip()
        url = (mu.group(1) if mu else "").strip()
        body = chunk[mh.end():] if mh else chunk
        if not url and not title:
            continue
        out.append({"title": title or url,
                    "url": url,
                    "snippet": body.strip()[:SEARCH_SNIPPET_CHARS]})
    return out


def _mcp_search(query: str, max_results: int) -> list[dict]:
    result = _mcp_call("web_search", {"query": query, "numResults": max_results})
    results = _parse_exa_blob(_mcp_content_text(result))
    return results[:max_results]


def _mcp_fetch(url: str) -> dict:
    result = _mcp_call("web_fetch", {"urls": [url], "maxCharacters": FETCH_MAX_CHARS})
    text = _mcp_content_text(result)
    title = url
    mt = re.search(r"^#\s+(.+?)\s*$", text, re.M) or re.search(r"^Title:\s*(.+?)\s*$", text, re.M)
    if mt:
        title = mt.group(1).strip()
    return {"title": title, "url": url, "content": text[:FETCH_MAX_CHARS]}


# ============================ OpenAI 工具规格（chat / pass2 共用） ============================

WEB_TOOLS_SPEC = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "联网搜索：在互联网上检索与查询相关的网页，返回带编号 [N] 的标题/URL/摘要列表（引用时写 [[c:N]]）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词或问题"},
                    "max_results": {"type": "integer", "description": "结果条数（默认 5，最多 8）"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "读取网页：获取指定 URL 的正文（markdown，截断），用于阅读搜索结果中的某个页面。",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "要读取的网页 URL（http/https）"},
                },
                "required": ["url"],
            },
        },
    },
]
