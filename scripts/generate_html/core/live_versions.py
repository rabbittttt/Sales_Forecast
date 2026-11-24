"""Hold live versions in use and retain two verified rollback pages per input source."""
from contextlib import closing, contextmanager
import hashlib
import json
import logging
from pathlib import Path
import re
import sqlite3
import stat

from core.renderer import FORECAST_PAGE_NAME


LOGGER = logging.getLogger(__name__)
STATE = FORECAST_PAGE_NAME + ".state.json"
LEASE = ".forecast-readers.sqlite3"
VERSION = re.compile(r"[0-9a-f]{64}")


def _local(path: Path) -> bool:
    if path.resolve() != path:
        return False
    info = path.lstat()
    return not (stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400)


def _versions(current):
    """Newest first by the timestamp of the published checkpoint."""
    candidates = []
    for version in current.parent.iterdir():
        if version == current or not VERSION.fullmatch(version.name):
            continue
        try:
            state = version / STATE
            if _local(version) and version.is_dir() and _local(state) and state.is_file():
                candidates.append((state.stat().st_mtime_ns, version))
        except (OSError, RuntimeError):
            continue
    return [v for _, v in sorted(candidates, reverse=True)]


def _verified(version):
    try:
        state, page = version / STATE, version / FORECAST_PAGE_NAME
        if not (_local(version) and _local(state) and _local(page) and state.is_file() and page.is_file()):
            return None
        saved = json.loads(state.read_text(encoding="utf-8"))
        if not isinstance(saved, dict) or saved.get("schema_version") != 1:
            return None
        content = page.read_bytes()
        if content and saved.get("revision") == hashlib.sha256(content).hexdigest():
            return content
    except (OSError, RuntimeError, ValueError):
        pass
    return None


def previous_published_page(live_dir: Path) -> bytes | None:
    try:
        for version in _versions(live_dir):
            content = _verified(version)
            if content is not None:
                return content
    except OSError:
        pass
    return None


@contextmanager
def _registration(source: Path):
    # Serialize opening a lease with removing its directory, even on POSIX where
    # unlinking an open database would separate old and new lock holders.
    path = source / ".forecast-versions.sqlite3"
    if path.resolve() != path or (path.exists() and not _local(path)):
        raise OSError("版本管理文件不是本目录的普通文件")
    with closing(sqlite3.connect(path, timeout=30)) as gate:
        gate.execute("BEGIN IMMEDIATE")
        yield


@contextmanager
def pin_version(current: Path):
    """A shared read transaction survives until all requests and the worker stop."""
    source = current.parent
    source.mkdir(parents=True, exist_ok=True)
    lease = current / LEASE
    reader = None
    try:
        with _registration(source):
            new = not current.exists()
            current.mkdir(exist_ok=True)
            if not _local(current):
                raise OSError("动态版本目录不能是链接")
            # Old binaries do not register readers; keep their caches unmanaged.
            if new or lease.exists():
                if not new and (not _local(lease) or not lease.is_file()):
                    raise OSError("版本使用标记不是本目录的普通文件")
                reader = sqlite3.connect(lease)
                reader.execute("BEGIN")
                reader.execute("SELECT count(*) FROM sqlite_master").fetchone()
        yield
    finally:
        if reader is not None:
            reader.close()


def prune_published_versions(current: Path):
    """After a successful publication retain current and the two newest valid predecessors."""
    try:
        if _verified(current) is None:
            return
        with _registration(current.parent):
            kept = 0
            for version in _versions(current):
                if _verified(version) is None:
                    continue
                if kept < 2:
                    kept += 1
                    continue
                # Only newly managed standalone reports have exactly these files.
                # Leave legacy assets, user additions, links and active readers intact.
                entries = list(version.iterdir())
                if {p.name for p in entries} != {LEASE, STATE, FORECAST_PAGE_NAME}:
                    continue
                if not all(_local(p) and p.is_file() for p in entries):
                    continue
                if (version / LEASE).stat().st_size != 0:
                    continue  # The empty lease is used exclusively for OS-backed locks.
                try:
                    with closing(sqlite3.connect(version / LEASE, timeout=0)) as claim:
                        claim.execute("BEGIN EXCLUSIVE")
                except sqlite3.Error:
                    continue
                # The source gate still prevents any new reader from opening the lease.
                for entry in entries:
                    entry.unlink()
                version.rmdir()
                LOGGER.info("已清理旧预测页面版本 %s", version.name[:12])
    except (OSError, RuntimeError, sqlite3.Error):
        LOGGER.warning("旧预测页面版本清理未完成，已保留当前发布结果", exc_info=True)
