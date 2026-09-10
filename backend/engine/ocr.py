"""pdf2md 阶段：三种解析实现（PaddleOCR 云 / MinerU 云 / PyMuPDF 本地直抽）+ md 摄取。

布局（共享层）：产物写入 <docDir>/pdf2md.md 与 <docDir>/imgs/，
与整理预设无关——只解析一次。
"""
import json
import re
import shutil
import time
from pathlib import Path
from urllib.parse import quote, unquote

import requests

from engine.config import log, read_text_guess
from engine.errors import OCRError

PADDLE_MODELS = ["PaddleOCR-VL-1.6", "PP-StructureV3"]
POLL_INTERVAL = 5
POLL_TIMEOUT = 1800
PADDLE_PAYLOAD = {
    "useDocOrientationClassify": False,
    "useDocUnwarping": False,
    "useChartRecognition": False,
}

_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _sanitize(name: str) -> str:
    return _INVALID_CHARS.sub("_", name).strip() or "img"


def _session(api_key: str = "", auth: bool = True):
    s = requests.Session()
    s.trust_env = False
    if auth and api_key:
        s.headers["Authorization"] = f"bearer {api_key}"
    return s


# ============================================================
# PaddleOCR 云端异步任务
# ============================================================

def _extract_job_id(job):
    for path in (("data", "jobId"), ("jobId",), ("data", "id"), ("id",), ("data", "job_id")):
        v = job
        ok = True
        for k in path:
            if isinstance(v, dict):
                v = v.get(k)
            else:
                ok = False
                break
        if ok and v:
            return v
    return None


def _submit(job_url: str, api_key: str, model: str, pdf_path: Path):
    payload = {"model": model, "optionalPayload": json.dumps(PADDLE_PAYLOAD)}
    last_err = None
    for attempt in range(3):
        s = _session(api_key)
        try:
            with open(pdf_path, "rb") as f:
                resp = s.post(job_url,
                               files={"file": (pdf_path.name, f, "application/pdf")},
                               data=payload, timeout=600)
            resp.raise_for_status()
            job_id = _extract_job_id(resp.json())
            if not job_id:
                raise RuntimeError(
                    f"无法解析 jobId：{json.dumps(resp.json(), ensure_ascii=False)[:500]}")
            return job_id
        except Exception as e:  # noqa: BLE001
            last_err = e
            log(f"[ocr] 提交失败（尝试 {attempt + 1}/3）：{e}")
            time.sleep(10)
    raise OCRError(f"OCR 任务提交失败：{last_err}")


def _poll(job_url: str, api_key: str, job_id, name):
    s = _session(api_key)
    deadline = time.time() + POLL_TIMEOUT
    last_state, last_pages = "", None
    while time.time() < deadline:
        resp = s.get(f"{job_url}/{job_id}", timeout=60)
        resp.raise_for_status()
        data = resp.json().get("data") or {}
        state = data.get("state") or data.get("status") or ""
        if state != last_state:
            log(f"[ocr] {name}：state={state}")
            last_state = state
        if state == "done":
            ru = data.get("resultUrl") or {}
            url = (ru.get("jsonUrl") or ru.get("json")) if isinstance(ru, dict) else None
            if not url:
                raise OCRError(
                    f"done 但缺少 resultUrl.jsonUrl：{json.dumps(data, ensure_ascii=False)[:500]}")
            return url
        if state == "failed":
            raise OCRError(f"OCR 任务失败：{data.get('errorMsg') or data.get('message') or data}")
        time.sleep(POLL_INTERVAL)
    raise OCRError(f"OCR 轮询超时（{POLL_TIMEOUT}s）：{name}")


def _download(url: str) -> str:
    s = _session(auth=False)
    resp = s.get(url, timeout=600)
    resp.raise_for_status()
    return resp.text


def _parse_jsonl(text: str):
    pages = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        res = obj.get("result") or {}
        for el in res.get("layoutParsingResults") or []:
            pages.append(el)
    return pages


def _download_images(images: dict, out_dir: Path, stem: str):
    imgs_dir = out_dir / "imgs"
    imgs_dir.mkdir(parents=True, exist_ok=True)
    s = _session(auth=False)
    mapping = {}
    used = set()
    ok = 0
    for rel in sorted(images, key=len, reverse=True):
        url = images[rel]
        orig = Path(rel.replace("\\", "/")).name or "img"
        base = _sanitize(f"{stem}_{orig}")
        fname, k = base, 1
        while fname in used:
            k += 1
            fname = f"{base}_{k}"
        try:
            r = s.get(url, timeout=120)
            r.raise_for_status()
            (imgs_dir / fname).write_bytes(r.content)
            used.add(fname)
            mapping[rel] = f"imgs/{fname}"
            ok += 1
        except Exception as e:  # noqa: BLE001
            log(f"[ocr] ⚠️ 图片下载失败（保留远程引用）：{orig}：{e}")
    if images:
        log(f"[ocr] 图片下载 {ok}/{len(images)} 张 -> imgs/")
    return mapping


def _rewrite_refs(text: str, mapping: dict, images: dict) -> str:
    for rel in sorted(mapping, key=len, reverse=True):
        local = mapping[rel]
        variants = {rel}
        for v in list(variants):
            try:
                variants.add(quote(v))
                variants.add(unquote(v))
            except Exception:  # noqa: BLE001
                pass
        for pat_src in sorted(variants, key=len, reverse=True):
            if not pat_src:
                continue
            pat = re.escape(pat_src)
            text = re.sub(rf"!\[[^\]]*\]\(\s*{pat}\s*\)", f"![]({local})", text)
            text = re.sub(rf'src=["\']{pat}["\']', f'src="{local}"', text)
        url = images.get(rel, "")
        if url:
            pat = re.escape(url)
            text = re.sub(rf"!\[[^\]]*\]\(\s*{pat}\s*\)", f"![]({local})", text)
            text = re.sub(rf'src=["\']{pat}["\']', f'src="{local}"', text)
    return text


def parse_paddleocr(pdf_path: Path, doc_dir: Path, *, job_url: str, api_key: str,
                    model: str) -> dict:
    doc_dir.mkdir(parents=True, exist_ok=True)
    target = doc_dir / "pdf2md.md"
    log(f"[ocr] 提交：{pdf_path.name}（{pdf_path.stat().st_size / 1e6:.1f} MB）")
    job_id = _submit(job_url, api_key, model, pdf_path)
    log(f"[ocr] jobId={job_id}，轮询中…")
    json_url = _poll(job_url, api_key, job_id, pdf_path.name)
    jsonl = _download(json_url)
    pages = _parse_jsonl(jsonl)
    if not pages:
        raise OCRError("结果 JSONL 中未找到 layoutParsingResults")

    parts, images = [], {}
    for idx, page in enumerate(pages, 1):
        md = page.get("markdown") or {}
        text = md.get("text") or ""
        for rel, url in (md.get("images") or {}).items():
            if url:
                images[rel] = url
        parts.append(f"<!-- page:{idx} -->\n{text}")

    mapping = _download_images(images, doc_dir, pdf_path.stem)
    full = _rewrite_refs("\n\n".join(parts), mapping, images)
    target.write_text(full, encoding="utf-8", newline="\n")
    log(f"[ocr] ✅ 已生成：{target}（{len(pages)} 页）")
    return {"pages": len(pages), "images": len(mapping)}


# ============================================================
# MinerU 云端（job 提交/轮询，接口形态与 PaddleOCR 类似，返回同构 JSONL）
# ============================================================

def parse_mineru(pdf_path: Path, doc_dir: Path, *, job_url: str, api_key: str,
                 model: str = "") -> dict:
    """MinerU 云 API：POST multipart（files + model）-> 轮询 -> full JSON。

    兼容两种响应形态：直接 JSON 数组（每页一项）或 {"pages": [...]}。
    落盘产物与 PaddleOCR 同构（<!-- page:N --> + imgs/ 重写）。
    """
    doc_dir.mkdir(parents=True, exist_ok=True)
    target = doc_dir / "pdf2md.md"
    s = _session(api_key)
    with open(pdf_path, "rb") as f:
        resp = s.post(job_url,
                      files={"file": (pdf_path.name, f, "application/pdf")},
                      data={"model": model} if model else {}, timeout=600)
    resp.raise_for_status()
    data = resp.json()

    # 同步返回形态
    pages = data if isinstance(data, list) else (
        data.get("pages") or (data.get("data") or {}).get("pages") or [])
    if not pages:
        raise OCRError(f"MinerU 返回无页面结果：{json.dumps(data, ensure_ascii=False)[:500]}")

    import base64
    parts, images, img_count = [], {}, 0
    imgs_dir = doc_dir / "imgs"
    for idx, page in enumerate(pages, 1):
        text = page.get("markdown") or page.get("content") or ""
        for img in page.get("images") or []:
            b64 = img.get("image_base64") or img.get("base64") or ""
            name = _sanitize(f"{pdf_path.stem}_p{idx}_{img.get('image_path', img_count + 1)}")
            if not name.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp")):
                name += ".png"
            try:
                (imgs_dir / name).parent.mkdir(parents=True, exist_ok=True)
                (imgs_dir / name).write_bytes(base64.b64decode(b64))
                text = re.sub(r'!\[[^\]]*\]\([^)]*\)', f"![](imgs/{name})", text, count=1)
                img_count += 1
            except Exception:  # noqa: BLE001
                continue
        parts.append(f"<!-- page:{idx} -->\n{text}")

    full = "\n\n".join(parts)
    target.write_text(full, encoding="utf-8", newline="\n")
    log(f"[ocr] ✅ MinerU 已生成：{target}（{len(pages)} 页，{img_count} 图）")
    return {"pages": len(pages), "images": img_count}


# ============================================================
# PyMuPDF 本地直抽（文本型 PDF）
# ============================================================

def parse_pymupdf(pdf_path: Path, doc_dir: Path) -> dict:
    try:
        import pymupdf as fitz  # PyMuPDF（新版导入名；fitz 为旧别名）
    except ImportError as e:
        raise OCRError("PyMuPDF 未安装（pip install pymupdf）") from e
    doc_dir.mkdir(parents=True, exist_ok=True)
    target = doc_dir / "pdf2md.md"
    imgs_dir = doc_dir / "imgs"
    doc = fitz.open(pdf_path)
    parts = []
    n_imgs = 0
    try:
        for idx, page in enumerate(doc, 1):
            text = page.get_text("text") or ""
            # 提取页面图片（跳过小图标：<10KB 或 <50px）
            for info in page.get_images(full=True):
                xref = info[0]
                try:
                    pix = fitz.Pixmap(doc, xref)
                    if pix.width < 50 or pix.height < 50:
                        continue
                    if pix.colorspace and pix.colorspace.n > 3:
                        pix = fitz.Pixmap(fitz.csRGB, pix)
                    name = _sanitize(f"{pdf_path.stem}_p{idx}_{n_imgs + 1}.png")
                    imgs_dir.mkdir(parents=True, exist_ok=True)
                    pix.save(imgs_dir / name)
                    text += f"\n\n![](imgs/{name})"
                    n_imgs += 1
                    pix = None
                except Exception:  # noqa: BLE001
                    continue
            parts.append(f"<!-- page:{idx} -->\n{text}")
    finally:
        doc.close()
    target.write_text("\n\n".join(parts), encoding="utf-8", newline="\n")
    log(f"[ocr] ✅ PyMuPDF 已生成：{target}（{idx} 页，{n_imgs} 图）")
    return {"pages": idx, "images": n_imgs}


# ============================================================
# 统一入口
# ============================================================

_MD_IMG_RE = re.compile(r'(!\[[^\]]*\]\()([^)\s]+)(\))')
_HTML_IMG_RE = re.compile(r'(<img\b[^>]*?\bsrc\s*=)(["\'])([^"\']*)(\2)', re.I)


def ingest_markdown(src_md: Path, doc_dir: Path) -> dict:
    """md 源摄取：复制为 pdf2md.md，本地图片复制进 imgs/ 并重写引用。"""
    doc_dir.mkdir(parents=True, exist_ok=True)
    target = doc_dir / "pdf2md.md"
    text = read_text_guess(src_md).replace("\r\n", "\n")

    imgs_dir = doc_dir / "imgs"
    copied: dict[str, str] = {}
    used = set()

    def _localize(ref: str) -> str:
        inner = ref.strip()
        if inner.startswith("<") and inner.endswith(">"):
            inner = inner[1:-1]
        low = inner.lower()
        if low.startswith(("http://", "https://", "data:", "ftp://", "#", "//")):
            return ref
        src_file = (src_md.parent / inner).resolve()
        if not src_file.is_file():
            return ref
        rel = copied.get(inner)
        if rel is None:
            base = _sanitize(src_file.name)
            fname, k = base, 1
            while fname in used:
                k += 1
                fname = f"{Path(base).stem}_{k}{Path(base).suffix}"
            imgs_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_file, imgs_dir / fname)
            used.add(fname)
            rel = f"imgs/{fname}"
            copied[inner] = rel
        return rel

    text = _MD_IMG_RE.sub(lambda m: m.group(1) + _localize(m.group(2)) + m.group(3), text)
    text = _HTML_IMG_RE.sub(
        lambda m: m.group(1) + m.group(2) + _localize(m.group(3)) + m.group(4), text)
    target.write_text(text, encoding="utf-8", newline="\n")
    if copied:
        log(f"[ocr] md 摄取：{src_md.name}，图片本地化 {len(copied)} 张 -> imgs/")
    return {"pages": 0, "images": len(copied)}


def parse_document(source: Path, doc_dir: Path, parser_cfg: dict) -> dict:
    """按解析配置分发。parser_cfg: {parser, api_url, api_key, model}。"""
    if source.suffix.lower() == ".md":
        return ingest_markdown(source, doc_dir)
    parser = parser_cfg.get("parser", "paddleocr")
    if parser == "paddleocr":
        return parse_paddleocr(source, doc_dir,
                                job_url=parser_cfg.get("api_url", ""),
                                api_key=parser_cfg.get("api_key", ""),
                                model=parser_cfg.get("model", "PP-StructureV3"))
    if parser == "mineru":
        return parse_mineru(source, doc_dir,
                             job_url=parser_cfg.get("api_url", ""),
                             api_key=parser_cfg.get("api_key", ""),
                             model=parser_cfg.get("model", ""))
    if parser == "local":
        return parse_pymupdf(source, doc_dir)
    raise OCRError(f"未知解析器：{parser}")
