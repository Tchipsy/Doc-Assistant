"""链接导入抓取（9.5 步骤11）：GET 网页 → trafilatura 抽正文 → markdown。

- httpx 直连 + **trust_env=True**（跟随系统代理——本机经 FlClash 系统代理出网，
  直连外网会超时；未配置代理时该开关无副作用）、浏览器 UA、15s 超时、跟随重定向；
- 流式读取并限制 2MB，防大文件爆内存；非 2xx / 非 HTML 报错；
- trafilatura 主抽取（output_format='markdown'：表格转 md 表格、图片/链接保留
  远程 URL，2026-09-06 实测 docs.python.org / MDN / runoob 三页质量良好）；
- 抽取失败或正文过短且设置页选择了 jina 服务商时 fallback r.jina.ai/{url}
  reader（天然返回 markdown）；
- 异常一律转 (错误文本, None) 返回，由 kb_service.import_link 转 400 toast。
"""
import re

import httpx

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
TIMEOUT = 15.0
MAX_BYTES = 2 * 1024 * 1024
JINA_READER_URL = "https://r.jina.ai"
MIN_CONTENT_CHARS = 50     # 低于此长度视为未抽到正文（JS 挑战页/反爬拦截页）

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def _fallback_err(detail: str) -> str:
    return (f"网页抓取失败：{detail}（仅支持静态 HTML 页面；JS 渲染/反爬页面无法导入）")


def _strip_html_title(html: str) -> str:
    import html as html_mod
    m = _TITLE_RE.search(html)
    if not m:
        return ""
    return html_mod.unescape(re.sub(r"\s+", " ", m.group(1))).strip()


def _extract(html: str, url: str) -> str:
    """trafilatura 抽正文 → markdown（失败/异常返回空串，由调用方兜底）。"""
    import trafilatura
    try:
        return trafilatura.extract(
            html, output_format="markdown", include_images=True, include_links=True,
            include_tables=True, include_formatting=True, url=url) or ""
    except Exception:  # noqa: BLE001  抽取失败走 fallback/报错路径
        return ""


def _jina_reader(url: str, key: str) -> str:
    """r.jina.ai reader 兜底（返回 markdown；不截断——文档导入需要全文）。"""
    headers = {"User-Agent": UA, "Accept": "text/plain"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    with httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0), trust_env=True,
                      follow_redirects=True, headers=headers) as http:
        resp = http.get(f"{JINA_READER_URL}/{url}")
        resp.raise_for_status()
        return resp.text


def fetch_page(url: str) -> tuple[str | None, dict]:
    """抓取网页 → (错误文本|None, {url, title, markdown})。"""
    url = (url or "").strip()
    if not re.match(r"^https?://", url):
        return "URL 无效（仅支持 http/https）", None
    try:
        with httpx.Client(timeout=httpx.Timeout(TIMEOUT, connect=10.0),
                          trust_env=True, follow_redirects=True,
                          headers={"User-Agent": UA}) as http:
            with http.stream("GET", url) as r:
                if r.status_code >= 400:
                    return _fallback_err(f"HTTP {r.status_code}"), None
                ctype = (r.headers.get("content-type") or "").lower()
                if "text/html" not in ctype and "application/xhtml" not in ctype:
                    return (f"链接不是网页（Content-Type: "
                            f"{ctype.split(';')[0].strip() or '未知'}），仅支持 HTML"), None
                buf = bytearray()
                for chunk in r.iter_bytes():
                    buf.extend(chunk)
                    if len(buf) > MAX_BYTES:
                        return "网页过大（超过 2MB 上限）", None
                encoding = r.encoding or "utf-8"
                final_url = str(r.url)
        html = bytes(buf).decode(encoding, errors="replace")
    except httpx.HTTPError as e:
        return _fallback_err(f"{type(e).__name__}: {str(e)[:120]}"), None

    title = _strip_html_title(html)
    md = _extract(html, final_url)
    if len(md.strip()) < MIN_CONTENT_CHARS:
        # 可选增强（步骤11，不阻塞）：设置页选择了 jina 服务商时走 r.jina.ai 兜底
        from app.services import settings_service
        try:
            ws = settings_service.get_websearch_settings()
        except Exception:  # noqa: BLE001
            ws = {}
        if ws.get("provider") == "jina":
            try:
                md = _jina_reader(final_url, ws.get("apiKey") or "")
            except Exception:  # noqa: BLE001  兜底也失败 → 报错
                md = ""
    if len(md.strip()) < MIN_CONTENT_CHARS:
        return _fallback_err("未能抽取到正文（页面可能由 JS 渲染或有反爬拦截）"), None
    if not title:
        try:
            import trafilatura
            meta = trafilatura.extract_metadata(html)
            title = (meta.title if meta and meta.title else "") or ""
        except Exception:  # noqa: BLE001
            title = ""
    return None, {"url": final_url, "title": title.strip(), "markdown": md}
