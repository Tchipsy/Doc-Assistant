"""断点续传状态：work/<kb>/<doc>/.state/<stage_id>/。

- params 与本次运行完全一致 -> 恢复（parts / counters 载入，resumed=True）。
- 否则 wipe（断点失效即弃，不备份）。
- part_NNN.md 按产出顺序编号持久化；counters 存放 blocks_done / items_done 等。
- 成功结束后 cleanup()（--keep-state 保留）；残留 state 会在下次运行时被清理。
"""
import json
import time
from pathlib import Path


class StageState:
    def __init__(self, state_dir, params: dict):
        self.dir = Path(state_dir)
        self.params = dict(params)
        self.parts: list[str] = []
        self.counters: dict = {}
        self.resumed = False
        self.dir.mkdir(parents=True, exist_ok=True)
        meta_file = self.dir / "meta.json"
        loaded = False
        if meta_file.exists():
            try:
                saved = json.loads(meta_file.read_text(encoding="utf-8"))
                if saved.get("params") == self.params:
                    self.counters = saved.get("counters", {})
                    self.parts = [p.read_text(encoding="utf-8")
                                  for p in sorted(self.dir.glob("part_*.md"))]
                    loaded = self.resumed = True
            except Exception:  # noqa: BLE001
                loaded = False
        if not loaded:
            self.wipe()
        self.save()

    def wipe(self) -> None:
        for p in self.dir.glob("part_*.md"):
            p.unlink()
        self.parts, self.counters, self.resumed = [], {}, False

    def save(self) -> None:
        try:
            (self.dir / "meta.json").write_text(
                json.dumps({"params": self.params, "counters": self.counters},
                           ensure_ascii=False),
                encoding="utf-8", newline="\n")
        except OSError:
            pass

    def write_part(self, text: str) -> None:
        self.parts.append(text)
        (self.dir / f"part_{len(self.parts):03d}.md").write_text(
            text, encoding="utf-8", newline="\n")
        self.save()

    def cleanup(self, keep: bool = False) -> None:
        if keep:
            return
        for p in self.dir.iterdir():
            try:
                p.unlink()
            except OSError:
                pass
        # OneDrive 同步可能瞬时锁定目录：短暂重试后放弃（残留空目录无害）
        for attempt in range(3):
            try:
                self.dir.rmdir()
                if self.dir.parent.name == ".state":
                    try:
                        self.dir.parent.rmdir()
                    except OSError:
                        pass
                return
            except OSError:
                if attempt < 2:
                    time.sleep(1.0)


def state_matches(state_dir, params: dict) -> bool:
    """判断断点状态是否存在且参数匹配（不创建目录；供 pipeline 预判）。"""
    meta_file = Path(state_dir) / "meta.json"
    if not meta_file.is_file():
        return False
    try:
        saved = json.loads(meta_file.read_text(encoding="utf-8"))
        return saved.get("params") == dict(params)
    except Exception:  # noqa: BLE001
        return False


def clear_state(doc_dir, stage_ids=None) -> None:
    """清除（全部或指定 stage 的）断点状态目录。"""
    root = Path(doc_dir) / ".state"
    if not root.is_dir():
        return
    if stage_ids is None:
        for child in root.iterdir():
            _rm(child)
        try:
            root.rmdir()
        except OSError:
            pass
    else:
        for sid in stage_ids:
            _rm(root / sid)


def _rm(path: Path) -> None:
    import shutil
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    else:
        try:
            path.unlink()
        except OSError:
            pass
