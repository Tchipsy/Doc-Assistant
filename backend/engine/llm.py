"""LLM 客户端：按请求注入配置；流式调用带 on_delta 增量回调。

与老项目 llm.py 的差异：
- 配置（baseUrl/key/model/temperature）构造注入，不再读全局 env；
- stream_chat 额外接受 on_delta(content_delta, reasoning_delta)，把 OpenAI
  SSE 的 token 增量实时穿透出去（供实时渲染）；
- 其余语义（BadRequest 参数降级、退避重试、上下文溢出识别）保持一致。
"""
import time

import httpx
import openai

from engine.errors import LLMError

def _fn(name: str, description: str, props: dict, required: list[str]) -> dict:
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": props, "required": required},
    }}


# RAG / 聊天工具规格（automatic 模式下由 chat 服务注入）
TOOLS_SPEC = [
    {
        "type": "function",
        "function": {
            "name": "rag_search",
            "description": "在指定知识库中检索与问题相关的文档片段。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "检索关键词或问题"},
                    "kb_ids": {
                        "type": "array", "items": {"type": "string"},
                        "description": "要检索的知识库 id 列表（缺省为会话选中的全部）",
                    },
                },
                "required": ["query"],
            },
        },
    },
]

# Pass2 跨文档查询工具组（步骤3）：仅本知识库；doc_id 必须来自 system 注入的
# 知识库概况清单。executor 由 gen_service 注入（引擎不碰 DB）。
KB_TOC_SPEC = _fn(
    "kb_toc", "获取本知识库中某篇文档的完整目录（章节结构），用于了解该文档讲什么、结构如何。",
    {"doc_id": {"type": "string", "description": "知识库概况清单中的文档 doc_id"}},
    ["doc_id"])
KB_SUMMARY_SPEC = _fn(
    "kb_summary", "获取本知识库中某篇文档各节的摘要（不含正文），用于快速了解该文档各部分内容。",
    {"doc_id": {"type": "string", "description": "知识库概况清单中的文档 doc_id"}},
    ["doc_id"])
RAG_SEARCH_PASS2_SPEC = _fn(
    "rag_search", "在本知识库中检索与查询相关的文档片段，返回带编号 [N] 的片段列表（引用时写 [[c:N]]）。",
    {"query": {"type": "string", "description": "检索关键词或问题"}},
    ["query"])
PASS2_TOOLS_SPEC = [KB_TOC_SPEC, KB_SUMMARY_SPEC, RAG_SEARCH_PASS2_SPEC]

_OVERFLOW_PATTERNS = (
    "context length", "maximum context", "context window", "context_length",
    "too many tokens", "input too long", "reduce the length", "输入长度", "上下文长度",
)

RETRY_DELAYS = [10, 30, 60]


def is_context_overflow(msg: str) -> bool:
    low = msg.lower()
    return any(p in low for p in _OVERFLOW_PATTERNS)


class ContextOverflowError(Exception):
    """上下文溢出（API 侧拒绝），由引擎转为检查点恢复。"""


class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str,
                 temperature: float = 0.3, max_tokens: int = 131072,
                 timeout: float = 1800.0):
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._client = openai.OpenAI(
            base_url=base_url,
            api_key=api_key or "EMPTY",
            max_retries=0,
            http_client=httpx.Client(
                trust_env=False,
                timeout=httpx.Timeout(timeout, connect=30.0),
            ),
        )

    def stream_chat(self, messages, tools=None, max_tokens=None,
                    on_delta=None) -> dict:
        """流式调用，手动累积 content / tool_calls / reasoning。

        on_delta(content_delta: str, reasoning_delta: str) 实时收到 token 增量。
        返回 dict：{content, tool_calls, finish_reason, usage, reasoning_chars}。
        """
        max_tokens = max_tokens or self.max_tokens
        base = dict(
            model=self.model,
            messages=messages,
            temperature=self.temperature,
            max_tokens=max_tokens,
            stream=True,
        )
        if tools:
            base["tools"] = tools

        for _retry in range(3):
            kwargs = dict(base)
            if _retry == 0:
                kwargs["stream_options"] = {"include_usage": True}
            try:
                return self._consume(kwargs, on_delta)
            except openai.BadRequestError as e:
                msg = str(e)
                if "stream_options" in msg and "stream_options" in kwargs:
                    base.pop("stream_options", None)
                    kwargs.pop("stream_options", None)
                    continue
                if "temperature" in msg and "temperature" in kwargs:
                    base.pop("temperature", None)
                    kwargs.pop("temperature", None)
                    continue
                raise

    def _consume(self, kwargs, on_delta=None) -> dict:
        content_parts, tool_acc = [], {}
        reasoning_parts, finish, usage = [], None, None
        last_report, chars = time.time(), 0
        stream = self._client.chat.completions.create(**kwargs)
        try:
            for ev in stream:
                if getattr(ev, "usage", None):
                    usage = ev.usage
                if not ev.choices:
                    continue
                ch = ev.choices[0]
                d = ch.delta
                if d is not None:
                    if d.content:
                        content_parts.append(d.content)
                        chars += len(d.content)
                        if on_delta:
                            try:
                                on_delta(d.content, "")
                            except Exception:  # noqa: BLE001
                                pass
                        now = time.time()
                        if now - last_report > 30:
                            last_report = now
                    rc = getattr(d, "reasoning_content", None)
                    if rc:
                        reasoning_parts.append(rc)
                        if on_delta:
                            try:
                                on_delta("", rc)
                            except Exception:  # noqa: BLE001
                                pass
                    if d.tool_calls:
                        for tc in d.tool_calls:
                            idx = tc.index or 0
                            slot = tool_acc.setdefault(
                                idx, {"id": "", "type": "function",
                                      "function": {"name": "", "arguments": ""}})
                            if tc.id:
                                slot["id"] = tc.id
                            if tc.function:
                                if tc.function.name:
                                    slot["function"]["name"] += tc.function.name
                                if tc.function.arguments:
                                    slot["function"]["arguments"] += tc.function.arguments
                if ch.finish_reason:
                    finish = ch.finish_reason
        finally:
            # 中止（客户端断开）或异常时立即释放与 LLM 服务商的连接
            try:
                close = getattr(stream, "close", None)
                if close:
                    close()
            except Exception:  # noqa: BLE001
                pass
        tool_calls = [tool_acc[i] for i in sorted(tool_acc)]
        for i, tc in enumerate(tool_calls):
            if not tc["id"]:
                tc["id"] = f"call_{i}"
        return {
            "content": "".join(content_parts),
            "tool_calls": tool_calls,
            "finish_reason": finish,
            "usage": usage,
            "reasoning_chars": len("".join(reasoning_parts)),
        }

    def chat_with_retry(self, messages, tools=None, max_tokens=None,
                        on_delta=None) -> dict:
        """退避重试：网络类错误重试 3 次；上下文溢出转 ContextOverflowError；
        客户端 4xx（除 408/429）不重试。"""
        attempt = 0
        while True:
            try:
                return self.stream_chat(messages, tools, max_tokens=max_tokens,
                                         on_delta=on_delta)
            except openai.BadRequestError as e:
                if is_context_overflow(str(e)):
                    raise ContextOverflowError(str(e)[:300]) from e
                raise
            except (openai.APIConnectionError, openai.APITimeoutError,
                    openai.RateLimitError, openai.InternalServerError,
                    openai.APIStatusError, httpx.HTTPError) as e:
                code = getattr(e, "status_code", None)
                if (isinstance(e, openai.APIStatusError) and code
                        and 400 <= code < 500 and code not in (408, 429)):
                    raise LLMError(f"LLM 客户端错误 {code}: {str(e)[:300]}") from e
                if attempt >= len(RETRY_DELAYS):
                    raise LLMError(
                        f"LLM 调用最终失败：{type(e).__name__}: {str(e)[:300]}") from e
                wait = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                time.sleep(wait)
                attempt += 1
