"""Persistent, versioned external forecast imports for the live service."""
from contextlib import closing
from datetime import date
import json
from pathlib import Path
import sqlite3


class ImportConflict(Exception):
    pass


def valid_text(value, limit=256):
    return isinstance(value, str) and 0 < len(value.strip()) <= limit


def validate_import(record):
    if record is None:
        return
    if not isinstance(record, dict) or not valid_text(record.get("filename")):
        raise ValueError("无效的导入文件名")
    rows = record.get("rows")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 20000:
        raise ValueError("逐日记录应为 1 至 20000 条")
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not all(valid_text(row.get(k)) for k in ("model", "source")):
            raise ValueError("缺少车型或来源")
        day, metric, value = row.get("date"), row.get("metric"), row.get("quantity")
        if not isinstance(day, str) or date.fromisoformat(day).isoformat() != day:
            raise ValueError("日期无效")
        if metric not in ("small", "gross", "lock") or row.get("stage") not in ("small", "launch", "steady"):
            raise ValueError("预测指标或阶段无效")
        if type(value) not in (float, int) or not 0 <= value <= 2**53 - 1 or (day, metric) in seen:
            raise ValueError("数量无效或同指标同日重复")
        seen.add((day, metric))


class ImportStore:
    def __init__(self, path: Path):
        self.path = path

    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("CREATE TABLE IF NOT EXISTS imports (model TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT)")
        return db

    def read(self, model, known):
        with closing(self.connect()) as db:
            row = db.execute("SELECT revision, CASE WHEN revision != ? THEN record END FROM imports WHERE model=?",
                             (known, model)).fetchone()
        revision, record = row or (0, None)
        result = {"revision": revision}
        if revision != known:
            result["record"] = json.loads(record) if record else None
        return result

    def write(self, model, revision, record):
        if type(revision) is not int or revision < 0:
            raise ValueError("缺少当前版本")
        validate_import(record)
        payload = None if record is None else json.dumps(record, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT revision FROM imports WHERE model=?", (model,)).fetchone()
            if revision != (row[0] if row else 0):
                raise ImportConflict
            db.execute("INSERT OR REPLACE INTO imports VALUES (?, ?, ?)", (model, revision + 1, payload))
        return {"revision": revision + 1}
