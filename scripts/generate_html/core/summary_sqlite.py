"""Persist the public forecast worksheets as queryable SQLite tables."""
from __future__ import annotations

from collections import namedtuple
from contextlib import closing
from datetime import date, datetime, time, timedelta
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile

from openpyxl.compat.strings import safe_string
from openpyxl.utils.datetime import from_excel, to_excel


SCHEMA_VERSION = 1
Cell = namedtuple("Cell", "value")


class SummaryDatabaseError(ValueError):
    """An incomplete, incompatible or out-of-date forecast database."""


def _quote(name):
    return '"' + name.replace('"', '""') + '"'


def _digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _columns(headers):
    # Excel allows repeated and empty headers. Keep original headers for the
    # forecast reader and give SQL users a distinct column for each value.
    used = {"_excel_row", "_excel_types"}
    result = []
    for index, header in enumerate(headers, 1):
        base = str(header) if header is not None else f"列{index}"
        name = base
        suffix = 2
        while name.casefold() in used:
            name = f"{base}_{suffix}"
            suffix += 1
        used.add(name.casefold())
        result.append(name)
    return result


def _excel_value(cell, epoch):
    value = cell.value
    if cell.data_type == "f" or value is None or value == "":
        return None, None   # data_only=True on a newly saved workbook
    if isinstance(value, bool):
        return int(value), "bool"
    if isinstance(value, (datetime, date, time, timedelta)):
        # Mirror the XLSX date serial and millisecond precision. An Excel
        # date-only cell comes back as datetime at midnight from openpyxl.
        serial = float(safe_string(to_excel(value, epoch)))
        value = from_excel(serial, epoch, timedelta=isinstance(value, timedelta))
        if isinstance(value, datetime):
            return (value.date().isoformat() if value.time() == time() else value.isoformat()), "datetime"
        if isinstance(value, time):
            return value.isoformat(), "time"
        return value.total_seconds(), "timedelta"
    if isinstance(value, (float, int)):
        # XLSX writes numbers with 16 significant digits. The page should
        # match the saved edition even when a computed ratio has more digits.
        number = safe_string(value)
        if not number:
            return None, None
        return (float(number) if any(c in number for c in ".eE") else int(number)), None
    return value, None


def _pack(cells, epoch):
    values, tags = [], {}
    for index, cell in enumerate(cells):
        value, tag = _excel_value(cell, epoch)
        values.append(value)
        if tag:
            tags[index] = tag
    return values, json.dumps(tags) if tags else None


def _unpack(values, tags):
    if not tags:
        return tuple(values)
    values = list(values)
    for index, tag in json.loads(tags).items():
        i = int(index)
        value = values[i]
        if tag == "datetime":
            values[i] = datetime.fromisoformat(value)
        elif tag == "bool":
            values[i] = bool(value)
        elif tag == "time":
            values[i] = time.fromisoformat(value)
        elif tag == "timedelta":
            values[i] = timedelta(seconds=value)
        else:
            raise SummaryDatabaseError(f"销量汇总数据库字段类型无效：{tag}")
    return tuple(values)


def _write_sheet(db, sheet, epoch):
    rows = sheet.iter_rows()
    header_values, header_types = _pack(next(rows, ()), epoch)
    columns = _columns(header_values)
    table = _quote(sheet.title)
    fields = ["_excel_row INTEGER PRIMARY KEY", "_excel_types TEXT", *map(_quote, columns)]
    db.execute(f"CREATE TABLE {table} ({', '.join(fields)})")

    def records():
        for number, row in enumerate(rows, 2):
            values, tags = _pack(row, epoch)
            yield (number, tags, *values)

    placeholders = ", ".join("?" for _ in fields)
    db.executemany(f"INSERT INTO {table} VALUES ({placeholders})", records())
    db.execute("INSERT INTO _forecast_sheets VALUES (?, ?, ?, ?)",
               (sheet.title, json.dumps(header_values, ensure_ascii=False), header_types, sheet.max_row))
    identity = [name for name in ("代际名", "二级代际名", "日期", "小时", "周期") if name in columns]
    if identity and ("日期" in identity or "周期" in identity):
        index = _quote("_forecast_lookup_" + sheet.title)
        db.execute(f"CREATE INDEX {index} ON {table} ({', '.join(map(_quote, identity))})")


def publish_workbook(database, workbook, *, source_path, signature, metadata):
    """Publish one closed SQLite file; source_path is the same batch's saved XLSX."""
    database = Path(database)
    database.parent.mkdir(parents=True, exist_ok=True)
    source_hash = _digest(source_path)
    with tempfile.NamedTemporaryFile(dir=database.parent, prefix="." + database.name + ".",
                                     suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with closing(sqlite3.connect(temporary)) as db, db:
            db.execute("BEGIN")
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            db.execute("CREATE TABLE _forecast_edition "
                       "(source_sha256 TEXT, signature TEXT, metadata TEXT, metadata_sha256 TEXT)")
            payload = json.dumps(metadata, ensure_ascii=False, allow_nan=False)
            db.execute("INSERT INTO _forecast_edition VALUES (?, ?, ?, ?)",
                       (source_hash, signature, payload, hashlib.sha256(payload.encode()).hexdigest()))
            db.execute("CREATE TABLE _forecast_sheets (name TEXT PRIMARY KEY, headers TEXT, types TEXT, rows INTEGER)")
            for sheet in workbook.worksheets:
                _write_sheet(db, sheet, workbook.epoch)
        os.replace(temporary, database)
    finally:
        temporary.unlink(missing_ok=True)


class _Sheet:
    def __init__(self, db, name, headers, types, rows):
        self.title = name
        self._db = db
        self._headers = _unpack(json.loads(headers), types)
        self.max_row = rows
        self.max_column = len(self._headers)

    def iter_rows(self, min_row=1, max_row=None, values_only=False):
        end = self.max_row if max_row is None else min(self.max_row, max_row)
        if min_row <= 1 <= end:
            yield self._headers if values_only else tuple(map(Cell, self._headers))
        if end < max(min_row, 2):
            return
        query = f"SELECT * FROM {_quote(self.title)} WHERE _excel_row BETWEEN ? AND ? ORDER BY _excel_row"
        with closing(self._db.execute(query, (max(min_row, 2), end))) as cursor:
            for row in cursor:
                values = _unpack(row[2:], row[1])
                yield values if values_only else tuple(map(Cell, values))

    def __getitem__(self, row):
        return next(self.iter_rows(min_row=row, max_row=row), ())


class _Workbook:
    def __init__(self, db, metadata, signature):
        self._db = db
        self.metadata = metadata
        self.signature = signature
        self.worksheets = [_Sheet(db, *row) for row in db.execute(
            "SELECT name, headers, types, rows FROM _forecast_sheets ORDER BY rowid")]
        self._by_name = {sheet.title: sheet for sheet in self.worksheets}
        self.sheetnames = list(self._by_name)
        if not self.sheetnames or not isinstance(metadata, dict):
            raise SummaryDatabaseError("销量汇总数据库缺少表目录或元数据")
        for sheet in self.worksheets:
            # Validate table/column structure before allowing a cached page
            # build. SQL identifiers are quoted even when they came from Excel.
            table = _quote(sheet.title)
            columns = [column[1] for column in db.execute(f"PRAGMA table_info({table})")]
            count = db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            if (columns != ["_excel_row", "_excel_types", *_columns(sheet._headers)]
                    or count != max(0, sheet.max_row - 1)):
                raise SummaryDatabaseError(f"销量汇总数据库工作表不完整：{sheet.title}")

    def __getitem__(self, name):
        return self._by_name[name]

    def close(self):
        self._db.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def open_workbook(database, *, source_path, signature=None):
    """Open one verified batch without retaining a Windows file handle during rendering."""
    database = Path(database).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    db = sqlite3.connect(":memory:")
    try:
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as source:
            source.backup(db)
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
            raise SummaryDatabaseError("销量汇总数据库版本不兼容")
        if db.execute("PRAGMA quick_check(1)").fetchone() != ("ok",):
            raise SummaryDatabaseError("销量汇总数据库完整性校验失败")
        edition = db.execute("SELECT source_sha256, signature, metadata, metadata_sha256 "
                             "FROM _forecast_edition").fetchone()
        if not edition or edition[0] != _digest(source_path) or (signature is not None and edition[1] != signature):
            raise SummaryDatabaseError("销量汇总数据库与当前 Excel 或刷新批次不匹配")
        payload = edition[2]
        if not isinstance(payload, str) or hashlib.sha256(payload.encode()).hexdigest() != edition[3]:
            raise SummaryDatabaseError("销量汇总数据库的页面元数据校验失败")
        return _Workbook(db, json.loads(payload), edition[1])
    except SummaryDatabaseError:
        db.close()
        raise
    except (sqlite3.DatabaseError, TypeError, ValueError, KeyError, IndexError) as exc:
        db.close()
        raise SummaryDatabaseError(f"销量汇总数据库无法读取：{database}：{exc}") from exc
    except BaseException:
        db.close()
        raise
