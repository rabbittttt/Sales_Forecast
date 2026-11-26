"""Read a published Vehicle Config campaign edition as typed worksheet values."""
from contextlib import closing, contextmanager
from contextvars import ContextVar
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3

from openpyxl import Workbook, load_workbook

from core.data_paths import PROJECT_ROOT, orders_input_directory


LEGACY_NAME = "小订及首销数据整理.xlsx"
DATE_HEADERS = {"留资", "小订开始日期", "小订结束日期", "开始大定日期", "小转大结束日期", "首销结束日期"}
_active = ContextVar("campaign_edition", default=None)


def published_path(project_root=PROJECT_ROOT):
    root = Path(project_root).resolve()
    explicit = os.environ.get("VEHICLE_CONFIG_CAMPAIGN_SNAPSHOT", "").strip()
    if explicit:
        return (root / Path(explicit).expanduser()).resolve()
    data = os.environ.get("PLANHUB_DATA_ROOT", "").strip()
    base = (root / data).resolve() if data else root.parent / "工作台数据"
    return base / "database" / "vehicle-config" / "campaigns" / "published.json"


def preferred_source(path, project_root=PROJECT_ROOT):
    if path is None or Path(path) != orders_input_directory(project_root) / LEGACY_NAME:
        return path
    active = _active.get()
    if active is not None:
        return active[0]
    published = published_path(project_root)
    if published.is_file():
        return published
    if os.environ.get("VEHICLE_CONFIG_CAMPAIGN_SNAPSHOT", "").strip():
        raise FileNotFoundError(f"找不到指定的小订与首销发布快照：{published}")
    # After cutover the old workbook may still be present as a historical copy.
    database = published.with_name("campaigns.sqlite3")
    if database.is_file():
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
            migrated = db.execute("SELECT 1 FROM publications WHERE revision > 0 LIMIT 1").fetchone()
        if migrated:
            if published.is_file():
                return published
            raise FileNotFoundError(f"小订与首销已发布，缺失报表快照，请在车型配置重新载入以恢复：{published}")
    return path


def is_edition(path):
    return isinstance(path, (str, Path)) and Path(path).suffix.lower() == ".json"


def _read(path):
    path = Path(path).resolve()
    active = _active.get()
    if active is not None and active[0] == path:
        return active
    raw = path.read_bytes()
    payload = json.loads(raw)
    if (not isinstance(payload, dict) or payload.get("schemaVersion") != 1
            or type(payload.get("revision")) is not int or payload["revision"] < 1
            or not isinstance(payload.get("sheets"), list) or not payload["sheets"]
            or payload["sheets"][0].get("name") != "车型汇总"):
        raise ValueError(f"无效的小订与首销发布数据：{path}")
    return path, payload, hashlib.sha256(raw).hexdigest()


@contextmanager
def campaign_batch(path):
    """Multiple stages of one forecast must read exactly the same published revision."""
    if not is_edition(path):
        yield
        return
    token = _active.set(_read(path))
    try:
        yield
    finally:
        _active.reset(token)


def edition_signature(path):
    _, payload, digest = _read(path)
    return str(Path(path).resolve()), payload["revision"], digest


def open_source(path, **options):
    if not is_edition(path):
        return load_workbook(path, **options)
    _, payload, _ = _read(path)
    book = Workbook()
    book.remove(book.active)
    for sheet in payload["sheets"]:
        ws = book.create_sheet(sheet["name"])
        headers = set(sheet["headerRows"])
        block = 0
        head = []
        for r, row in enumerate(sheet["rows"], 1):
            is_header = r in headers
            if is_header:
                head = row
                block += 1
            for c, value in enumerate(row, 1):
                if value is None:
                    continue
                field = head[c - 1] if c <= len(head) else ""
                cell = ws.cell(r, c)
                if (isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)
                        and (field in DATE_HEADERS or (is_header and ws.title == "小订by天"))):
                    cell.value = datetime.fromisoformat(value)
                    cell.number_format = "yyyy-mm-dd"
                else:
                    cell.value = value
                    if isinstance(value, str):
                        cell.data_type = "s"
                    elif isinstance(field, str) and (field.endswith(("占比", "率"))
                            or (block > 1 and ws.title.endswith("进度") and re.fullmatch(r"D\d+", field))):
                        cell.number_format = "0.00%"
    return book
