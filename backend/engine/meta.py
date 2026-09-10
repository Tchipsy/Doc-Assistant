"""产物元数据 .meta.json 与参数指纹（存于 <docId>/<presetId>/.meta.json）。

指纹语义与老项目一致（dict 相等比较决定 skip / resume / fresh），
但模型由调用方传入（按请求配置），不再读全局 config。
"""
import hashlib
import json
import time
from pathlib import Path

META_NAME = ".meta.json"
_LOCK_TIMEOUT = 15.0


class _file_lock:
    """跨进程文件锁（Windows msvcrt；无 msvcrt 平台退化为无锁并告警一次）。"""

    warned = False

    def __init__(self, path: Path):
        self.path = Path(path)
        self._f = None
        self._msvcrt = None

    def __enter__(self):
        try:
            import msvcrt
            self._msvcrt = msvcrt
        except ImportError:  # noqa: BLE001  非 Windows：退化为无锁
            if not _file_lock.warned:
                print("[meta] ⚠️ 当前平台无 msvcrt，.meta.json 并发写入无锁保护")
                _file_lock.warned = True
            return self
        if not self.path.exists():
            self.path.write_bytes(b"0")
        self._f = open(self.path, "r+b")
        deadline = time.time() + _LOCK_TIMEOUT
        while True:
            try:
                self._f.seek(0)
                self._msvcrt.locking(self._f.fileno(), self._msvcrt.LK_NBLCK, 1)
                return self
            except OSError:
                if time.time() > deadline:
                    print("[meta] ⚠️ .meta.json 锁等待超时，无锁写入")
                    return self
                time.sleep(0.05)

    def __exit__(self, *exc):
        if self._f is not None and self._msvcrt is not None:
            try:
                self._f.seek(0)
                self._msvcrt.locking(self._f.fileno(), self._msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        if self._f is not None:
            self._f.close()
            self._f = None
        return False


def file_sha(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_fingerprint(path) -> str:
    st = Path(path).stat()
    return f"{st.st_mtime_ns}:{st.st_size}"


def ocr_params(source_path, model: str, payload: dict) -> dict:
    return {
        "source_fp": source_fingerprint(source_path),
        "model": model,
        "payload": hashlib.sha256(
            json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16],
    }


def pass1_params(pdf2md_path, org, summ, batch_tokens: int, model: str,
                 org_common=None, common=None) -> dict:
    """org/summ/org_common/common: PromptSpec（org_common 为按源类型的公共节；
    common 为 common.md 的 pass1.input+pass1.output 契约节——debug3 起参与指纹，
    契约改动（如新增 @@title/@@digest 块）会使全部文档 pass1 指纹失效重跑一次）。"""
    params = {
        "pdf2md_sha": file_sha(pdf2md_path),
        "organization": {"name": org.name, "sha": org.sha},
        "summary": {"name": summ.name, "sha": summ.sha},
        "batch_tokens": int(batch_tokens),
        "model": model,
    }
    if org_common is not None:
        params["org_common"] = {"name": org_common.name, "sha": org_common.sha}
    if common is not None:
        params["common"] = {"name": common.name, "sha": common.sha}
    return params


def pass2_params(organized_path, group, batch_tokens: int, model: str,
                 where=None, cross_doc: bool = False,
                 web_search: bool = False) -> dict:
    """group: list[PromptSpec]（同一次调用的一组插件）；where: 生成位置 PromptSpec。
    cross_doc（步骤3）/ web_search（步骤4）：工具开关——改变系统提示词，参与指纹
    使勾选变更触发重跑（与"提示词内容参与指纹"原则一致，仅 true 时写入键）。"""
    params = {
        "organized_sha": file_sha(organized_path),
        "group": [p.name for p in group],
        "plugins": {p.name: p.sha for p in group},
        "batch_tokens": int(batch_tokens),
        "model": model,
    }
    if where is not None:
        params["where"] = {"name": where.name, "sha": where.sha}
    if cross_doc:
        params["cross_doc"] = True
    if web_search:
        params["web_search"] = True
    return params


def stage_state_id(stage: str, params: dict) -> str:
    if stage == "pass2":
        return "pass2-" + "_".join(params["group"])
    return stage


class DocMeta:
    """<docId>/<presetId>/.meta.json 读写（结构化访问，锁内合并保存）。"""

    def __init__(self, stage_dir):
        self.dir = Path(stage_dir)
        self.path = self.dir / META_NAME
        self.data: dict = {"schema": 2}
        if self.path.exists():
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                self.data = {"schema": 2}

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_name(".meta.json.lock")
        with _file_lock(lock_path):
            disk: dict = {"schema": 2}
            if self.path.exists():
                try:
                    disk = json.loads(self.path.read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    disk = {"schema": 2}
            merged = {**disk, **self.data}
            merged["stages"] = {**(disk.get("stages") or {}),
                                **(self.data.get("stages") or {})}
            self.data = merged
            self.path.write_text(
                json.dumps(merged, ensure_ascii=False, indent=1, sort_keys=True),
                encoding="utf-8", newline="\n")

    # ---------- 文档级 ----------
    def set_doc(self, doc_id: str, title: str | None = None,
                digest: str | None = None) -> None:
        """title/digest 传 None 表示保持不变；digest 传空串视为清除。"""
        self.data.update({"doc_id": doc_id})
        if title:
            self.data["title"] = title
        if digest is not None:
            if digest:
                self.data["digest"] = digest
            else:
                self.data.pop("digest", None)
        self.save()

    @property
    def title(self) -> str | None:
        return self.data.get("title")

    @title.setter
    def title(self, value: str) -> None:
        self.data["title"] = value
        self.save()

    @property
    def digest(self) -> str | None:
        """一句话简介（pass1 前的小调用生成；步骤3 KB 概况的数据源）。"""
        return self.data.get("digest")

    # ---------- 阶段级 ----------
    def stage(self, key: str) -> dict | None:
        return self.data.get("stages", {}).get(key)

    def set_stage(self, key: str, *, params: dict, stats: dict | None = None,
                  done: bool, **extra) -> None:
        rec = {"done": bool(done), "finished_at": time.strftime("%Y-%m-%d %H:%M:%S"),
               "params": params}
        if stats is not None:
            rec["stats"] = stats
        rec.update(extra)
        self.data.setdefault("stages", {})[key] = rec
        self.save()

    def params_match(self, key: str, params: dict) -> bool:
        rec = self.stage(key)
        return bool(rec and rec.get("params") == params)

    def stage_ok(self, key: str, params: dict) -> bool:
        """产物有效 = 参数一致 且 上次运行为 done（partial 不算完成）。"""
        rec = self.stage(key)
        return bool(rec and rec.get("params") == params and rec.get("done"))
