"""Archived raw workbook export used by order regression fixtures."""
from __future__ import annotations

import base64
import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from core.excel import WorkbookStore, format_excel_cell
from core.renderer import b64gzip, _write_text_atomic


LOGGER = logging.getLogger("sales_forecast")


def split_parallel_blocks(name: str, rows: list[list]) -> list[dict[str, Any]]:
    """Split side-by-side blocks (like SKU's 表格A/B/C) into separate tables."""
    if len(rows) < 2:
        return [{"name": name, "rows": rows}]
    title_cols = [col for col, value in enumerate(rows[0]) if value not in (None, "")]
    # 多区块:第一行有多个标题，且标题列之间至少隔一个空列，第二行在各标题列有表头
    if len(title_cols) < 2:
        return [{"name": name, "rows": rows}]
    if any(right - left < 2 for left, right in zip(title_cols, title_cols[1:])):
        return [{"name": name, "rows": rows}]
    second = rows[1]
    if not all(col < len(second) and second[col] not in (None, "") for col in title_cols):
        return [{"name": name, "rows": rows}]
    width = max(len(row) for row in rows)
    blocks = []
    for index, start in enumerate(title_cols):
        end = title_cols[index + 1] if index + 1 < len(title_cols) else width
        block_rows = []
        for row in rows:
            sliced = row[start:end]
            while sliced and sliced[-1] in (None, ""):
                sliced.pop()
            block_rows.append(sliced)
        if block_rows:
            block_width = max(len(row) for row in block_rows)
            keep = [col for col in range(block_width) if any(col < len(row) and row[col] not in (None, "") for row in block_rows)]
            block_rows = [[row[col] if col < len(row) else None for col in keep] for row in block_rows]
        blocks.append({"name": f"{name} · {rows[0][start]}", "rows": block_rows})
    return blocks


def raw_tables(store: WorkbookStore) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """按需加载的底表行块及原始 XLSX 快照；下载快照保留全部 Sheet 和格式。"""
    files = []
    blocks: dict[str, str] = {}
    for file_index, item in enumerate(store.items):
        sheets = []
        for sheet in item.workbook.worksheets:
            if getattr(sheet, "sheet_state", "visible") != "visible":
                continue
            rows_by_index, occupied = {}, set()
            # Normal Workbook cells already implement merged-cell semantics.
            # Do not materialize every blank cell in a sparse styled rectangle.
            for cell in sheet._cells.values():
                if cell.value is None:
                    continue
                value = format_excel_cell(cell)
                if value not in (None, ""):
                    rows_by_index.setdefault(cell.row, {})[cell.column] = value
                    occupied.add(cell.column)
            columns = sorted(occupied)
            rows = []
            for _, values in sorted(rows_by_index.items()):
                last_column = max(values)
                rows.append([
                    values.get(column, None if column > last_column else "")
                    for column in columns
                ])
            for block in split_parallel_blocks(sheet.title, rows):
                block_rows = block["rows"]
                # 首行是区块大标题（单值）、次行才是列名时，去掉冗余标题行让列名成为表头
                if (
                    len(block_rows) > 1
                    and sum(1 for value in block_rows[0] if value not in (None, "")) <= 1
                    and sum(1 for value in block_rows[1] if value not in (None, "")) > 1
                ):
                    block_rows = block_rows[1:]
                key = f"{file_index}|{len(sheets)}"
                blocks[key] = b64gzip(json.dumps({"rows": block_rows}, ensure_ascii=False, separators=(",", ":")))
                sheets.append({
                    "name": block["name"],
                    "total_rows": len(block_rows),
                    "total_cols": max((len(row) for row in block_rows), default=0),
                    "source_sheet": sheet.title,
                })
        file_info = {"name": item.path.name, "sheets": sheets}
        # Embed the original file once, not a CSV reconstruction of the split
        # display blocks. This also works when the HTML is copied elsewhere or
        # opened offline, and preserves formulas, merged cells and hidden tabs.
        try:
            workbook_bytes = item.path.read_bytes()
        except OSError as exc:
            LOGGER.warning("底表整表导出不可用: %s | %s", item.path.name, exc)
        else:
            workbook_key = f"{file_index}|xlsx"
            blocks[workbook_key] = base64.b64encode(workbook_bytes).decode("ascii")
            file_info["workbook_key"] = workbook_key
        files.append(file_info)
    return files, blocks


def write_raw_block_assets(raw_blocks: dict[str, str], output_file: Path) -> dict[str, str]:
    """Immutable script blocks work from both a static HTTP host and local file URLs."""
    urls = {}
    for key, value in raw_blocks.items():
        script = ("window.DASHBOARD_RAW_B64=window.DASHBOARD_RAW_B64||{};"
                  f"window.DASHBOARD_RAW_B64[{json.dumps(key)}]={json.dumps(value)};\n")
        content = script.encode("utf-8")
        digest = hashlib.sha256(content).hexdigest()
        relative = Path("forecast_assets") / f"raw-{digest}.js"
        destination = output_file.parent / relative
        if destination.exists():
            # Never replace a published hash URL with different bytes: a cached
            # old page must always resolve the exact snapshot it was built with.
            if destination.read_bytes() != content:
                raise ValueError(f"预测底表资源校验失败，请检查发布目录：{destination}")
        else:
            _write_text_atomic(destination, script)
        urls[key] = relative.as_posix()
    return urls
