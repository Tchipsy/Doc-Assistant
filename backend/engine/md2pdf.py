"""Markdown -> PDF（经 headless Chrome 打印）。

整合自独立脚本 md2pdf.py，行为保持一致：
    1. 提取 $...$ / $$...$$ 公式（防止 markdown 吞掉 _ * 等符号）
    2. python-markdown 转为 HTML
    3. Obsidian 风格 callout 转为彩色标注框
    4. 图片相对路径转为绝对 file:// URI（相对 .md 所在目录解析）
    5. 注入 MathJax 3 渲染公式 -> headless Chrome --print-to-pdf
       （纸张/边距/分栏由 CSS @page 控制）

对外的编程接口：`PdfOptions` + `markdown_to_pdf()`；
原 CLI 用法保留：`python -m document_assistant.md2pdf input.md [参数]`。
失败一律抛 `Md2PdfError`（不再 sys.exit）。
"""
import argparse
import html
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import markdown

from engine.errors import Md2PdfError

BROWSER_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]

PAPER_PT = {  # 宽x高(pt)
    "a4": (595.28, 841.89),
    "a5": (419.53, 595.28),
    "letter": (612, 792),
}

VIRTUAL_TIME_BUDGET = 90000  # MathJax 渲染等待上限（Chrome 虚拟时间 ms）


@dataclass(frozen=True)
class PdfOptions:
    paper: str = "a4"          # a4 | a5 | letter
    orientation: str = "portrait"  # portrait | landscape
    columns: int = 2           # 1=单栏；2/3=多栏
    margin: float = 4.0        # 页边距 mm（四边相同）
    gap: float = 3.0           # 栏间距 mm（仅多栏生效）
    font_pt: float = 9.0       # 正文字号 pt（标题/代码/标注框随其缩放）
    title: str | None = None   # 文档最前的居中大标题（跨所有栏）
    break_h2: bool = False     # 二级标题自动换页
    keep_html: bool = False    # 在输出旁保留中间 HTML（排版调试用）


def find_browser() -> str:
    for p in BROWSER_CANDIDATES:
        if os.path.exists(p):
            return p
    raise Md2PdfError("未找到 Chrome/Edge，请安装或修改 BROWSER_CANDIDATES")


def build_css(a: PdfOptions) -> str:
    w, h = PAPER_PT.get(a.paper, PAPER_PT["a4"])
    if a.orientation == "landscape":
        w, h = h, w
    paper = f"{w:.2f}pt {h:.2f}pt"
    cols = ""
    if a.columns >= 2:
        cols = ("column-count: %d; column-gap: %.1fmm; column-fill: auto;"
                % (a.columns, a.gap))
    h2_break = "page-break-before: always;" if a.break_h2 else ""
    return """
@page { size: %(paper)s; margin: %(margin).1fmm; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", Arial, sans-serif;
  font-size: %(font).1fpt; line-height: 1.5; color: #1a1a1a;
  overflow-wrap: break-word; word-wrap: break-word;
  %(cols)s
  orphans: 2; widows: 2;
}
h1.doc-title {
  font-size: %(title_pt).1fpt; text-align: center; margin: 2pt 0 8pt;
  column-span: all; border-bottom: 1.5pt solid #2c5f8a; padding-bottom: 4pt;
}
h1 { font-size: 13pt; margin: 8pt 0 5pt; color: #111; }
h2 { font-size: 11.5pt; color: #2c5f8a; border-bottom: 1.2pt solid #2c5f8a;
     padding-bottom: 2pt; margin: 10pt 0 5pt; %(h2_break)s break-after: avoid; }
h3 { font-size: 10.5pt; color: #2c5f8a; margin: 9pt 0 3pt; break-after: avoid; }
h4 { font-size: 9.5pt; color: #444; margin: 7pt 0 2pt; break-after: avoid; }
p { margin: 3pt 0; }
ul, ol { margin: 3pt 0; padding-left: 15pt; }
li { margin: 1.5pt 0; }
img { max-width: 100%%; height: auto; }
pre { background: #f5f5f5; border: 0.5pt solid #ddd; border-radius: 3pt;
      padding: 4pt 5pt; font-size: %(code_pt).1fpt; white-space: pre-wrap;
      word-break: break-all; break-inside: avoid; margin: 4pt 0; }
code { font-family: Consolas, "Courier New", monospace; font-size: 0.92em;
       background: #f2f2f2; padding: 0 2pt; border-radius: 2pt; }
pre code { background: none; padding: 0; font-size: 1em; }
blockquote { margin: 4pt 0; padding: 2pt 8pt; border-left: 2pt solid #ccc; color: #555; }
table { border-collapse: collapse; width: 100%%; margin: 4pt 0; break-inside: avoid; }
th, td { border: 0.5pt solid #999; padding: 3pt 5pt; text-align: left; vertical-align: top; }
th { background: #f2f2f2; font-weight: bold; }
.co { margin: 5pt 0; padding: 4pt 7pt; border-radius: 3pt; border: 0.5pt solid;
      border-left-width: 2.5pt; font-size: %(co_pt).1fpt; }
.co-t { font-weight: bold; margin-bottom: 2pt; }
.co p { margin: 2.5pt 0; }
.co ul, .co ol { margin: 2pt 0; }
.co-info     { background: #eaf3fb; border-color: #7db4d8; }
.co-info .co-t     { color: #1d5e8f; }
.co-tip      { background: #eef8ee; border-color: #86c78a; }
.co-tip .co-t      { color: #2c7a33; }
.co-abstract { background: #f0eef8; border-color: #a99fd6; }
.co-abstract .co-t { color: #5b4fa8; }
.co-example  { background: #fdf3e7; border-color: #dcb67a; }
.co-example .co-t  { color: #9a6b1f; }
hr { border: none; border-top: 0.5pt solid #bbb; margin: 6pt 0; }
strong { color: #000; }
a { color: #2c5f8a; text-decoration: none; }
mjx-container { max-width: 100%%; }
mjx-container[display="true"] { margin: 3pt 0 !important; font-size: 92%%; }
""" % {
        "paper": paper, "margin": a.margin, "font": a.font_pt,
        "cols": cols, "title_pt": a.font_pt + 4.5, "code_pt": a.font_pt - 1.2,
        "co_pt": a.font_pt - 0.2, "h2_break": h2_break,
    }


def convert_md_to_html(md_path, a: PdfOptions) -> str:
    md_path = Path(md_path)
    text = md_path.read_text(encoding="utf-8")

    # callout 标题独占一段（标题行后插入空引用行）
    text = re.sub(r"(?m)^(> \[!\w+\]-?[^\n]*)$", r"\1\n>", text)

    # 先提取数学公式，防止 markdown 吞掉 _ * 等符号
    mathstore: list[str] = []

    def stash(m):
        mathstore.append(m.group(0))
        return "MATHZZ%dZZEND" % (len(mathstore) - 1)

    text = re.sub(r"\$\$.+?\$\$", stash, text, flags=re.S)
    text = re.sub(r"\$[^$\n]+?\$", stash, text)

    body = markdown.markdown(text, extensions=["extra", "sane_lists"])

    # blockquote -> callout 盒子。注意：python-markdown 会把"空行分隔的连续
    # blockquote"合并为单个 <blockquote>（非 CommonMark 行为），因此这里按
    # callout 头分段切开，一段头一个盒子（嵌套感知地配对开合标签）。
    body = _replace_blockquotes(body)

    # 还原公式（HTML 转义后交给 MathJax）
    def restore(m):
        return html.escape(mathstore[int(m.group(1))], quote=False)

    body = re.sub(r"MATHZZ(\d+)ZZEND", restore, body)

    # 图片相对路径 -> 绝对 file:// URI（远程 URL 与 data: 保持原样）
    base = md_path.parent.resolve()

    def img_repl(m):
        ref = m.group(1)
        if ref.lower().startswith(("http://", "https://", "data:", "file:", "//")):
            return m.group(0)
        p = os.path.normpath(os.path.join(str(base), ref))
        return 'src="file:///%s"' % quote(p.replace("\\", "/"))

    body = re.sub(r'src="([^"]+)"', img_repl, body)

    title_html = ""
    if a.title:
        title_html = '<h1 class="doc-title">%s</h1>' % html.escape(a.title)

    return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>%s</title>
<style>%s</style>
<script>
window.MathJax = {
  tex: { inlineMath: [['$','$'],['\\\\(','\\\\)']], displayMath: [['$$','$$'],['\\\\[','\\\\]']] },
  chtml: { scale: 0.95, matchFontHeight: false },
  options: { enableMenu: false }
};
</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>
</head><body>
%s
%s
</body></html>""" % (
        html.escape(a.title or md_path.stem),
        build_css(a), title_html, body)


def _print_pdf(html_text: str, pdf_path: Path, title: str) -> None:
    """写临时 HTML -> Chrome headless 打印 -> 校验产物存在且更新。"""
    exe = find_browser()
    tmp_html = Path(tempfile.gettempdir()) / f"md2pdf_{os.getpid()}_{abs(hash(title)) % 99999}.html"
    tmp_html.write_text(html_text, encoding="utf-8")
    try:
        mtime0 = pdf_path.stat().st_mtime if pdf_path.exists() else 0
        cmd = [exe, "--headless", "--disable-gpu", "--disable-extensions",
               "--no-pdf-header-footer", f"--virtual-time-budget={VIRTUAL_TIME_BUDGET}",
               "--print-to-pdf=" + str(pdf_path),
               "file:///" + str(tmp_html).replace("\\", "/")]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if not pdf_path.exists() or pdf_path.stat().st_mtime == mtime0:
            raise Md2PdfError("PDF 写入失败（文件被占用或浏览器出错）:\n" + (r.stderr or ""))
    finally:
        try:
            tmp_html.unlink()
        except OSError:
            pass


_BQ_OPEN, _BQ_CLOSE = "<blockquote>", "</blockquote>"
_CO_HEAD_RE = re.compile(r"<p>\[!(\w+)\]-?\s*(.*?)</p>", re.S)


def _build_callout_divs(inner: str) -> str:
    """blockquote 内部按 callout 头分段（合并的连续 callout 切成多个盒子）；
    无头的普通引用保持原样。"""
    heads = list(_CO_HEAD_RE.finditer(inner))
    if not heads:
        return _BQ_OPEN + inner + _BQ_CLOSE
    parts = []
    pre = inner[: heads[0].start()]
    if pre.strip():
        parts.append(_BQ_OPEN + pre + _BQ_CLOSE)
    for i, h in enumerate(heads):
        seg_end = heads[i + 1].start() if i + 1 < len(heads) else len(inner)
        parts.append(
            '<div class="co co-%s"><div class="co-t">%s</div>'
            '<div class="co-b">%s</div></div>'
            % (h.group(1).lower(), h.group(2).strip(), inner[h.end():seg_end]))
    return "\n".join(parts)


def _replace_blockquotes(body: str) -> str:
    """嵌套感知地逐个替换 <blockquote>（原正则会被嵌套/合并引用截断）。"""
    out, pos = [], 0
    while True:
        start = body.find(_BQ_OPEN, pos)
        if start < 0:
            out.append(body[pos:])
            return "".join(out)
        depth, end = 0, -1
        for m in re.finditer(r"</?blockquote>", body[start:]):
            depth += 1 if m.group(0) == _BQ_OPEN else -1
            if depth == 0:
                end = start + m.end()
                break
        if end < 0:  # 未配对（异常 HTML），保留原样
            out.append(body[pos:])
            return "".join(out)
        inner = body[start + len(_BQ_OPEN):end - len(_BQ_CLOSE)]
        out.append(body[pos:start])
        out.append(_build_callout_divs(inner))
        pos = end


def verify(pdf_path) -> tuple[int, list[str]]:
    data = Path(pdf_path).read_bytes()
    boxes = set(re.findall(rb"/MediaBox\s*\[([^\]]+)\]", data))
    pages = len(re.findall(rb"/Type\s*/Page[^s]", data))
    return pages, [b.decode() for b in boxes]


def markdown_to_pdf(md_path, output=None, options: PdfOptions | None = None) -> dict:
    """单文件转换。返回 {"pdf", "pages", "mediabox", "size_mb", "html"(可选)}。"""
    a = options or PdfOptions()
    md_path = Path(md_path)
    if not md_path.is_file():
        raise Md2PdfError(f"输入不存在：{md_path}")
    pdf_path = Path(output) if output else md_path.with_suffix(".pdf")
    pdf_path.parent.mkdir(parents=True, exist_ok=True)

    html_text = convert_md_to_html(md_path, a)
    _print_pdf(html_text, pdf_path, a.title or md_path.stem)
    pages, boxes = verify(pdf_path)

    result = {"pdf": str(pdf_path), "pages": pages, "mediabox": boxes,
              "size_mb": round(pdf_path.stat().st_size / 1048576, 2)}
    if a.keep_html:
        keep = pdf_path.with_suffix(".html")
        keep.write_text(html_text, encoding="utf-8", newline="\n")
        result["html"] = str(keep)
    return result


def _main(argv=None):
    ap = argparse.ArgumentParser(description="Markdown -> PDF (Chrome headless)")
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    ap.add_argument("--paper", default="a4", choices=["a4", "a5", "letter"])
    ap.add_argument("--columns", type=int, default=2)
    ap.add_argument("--margin", type=float, default=4.0, help="页边距 mm")
    ap.add_argument("--gap", type=float, default=3.0, help="栏间距 mm")
    ap.add_argument("--font-pt", type=float, default=9.0, help="正文字号 pt")
    ap.add_argument("--title", default=None, help="文档最前的一级标题")
    ap.add_argument("--break-h2", action="store_true", help="二级标题自动换页")
    ap.add_argument("--keep-html", action="store_true", help="保留中间 HTML")
    a = ap.parse_args(argv)
    opts = PdfOptions(paper=a.paper, columns=a.columns, margin=a.margin,
                      gap=a.gap, font_pt=a.font_pt, title=a.title,
                      break_h2=a.break_h2, keep_html=a.keep_html)
    r = markdown_to_pdf(a.input, a.output, opts)
    print("PDF: %s (%.2f MB)" % (r["pdf"], r["size_mb"]))
    print("页数: %d  MediaBox: %s" % (r["pages"], ", ".join(r["mediabox"])))


if __name__ == "__main__":
    _main()
