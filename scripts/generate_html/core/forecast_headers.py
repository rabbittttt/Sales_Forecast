"""Identify the summary and stage progress tables in an input workbook."""
from __future__ import annotations

import logging
import re
from typing import Any

from core.forecast_summary import GROSS_DAILY_SHEET


LOGGER = logging.getLogger("sales_forecast_refresh")

SUMMARY_HEADER_ALIASES = {
    "车型": {"传播名", "历史传播名", "车型", "车型名称", "历史车型", "车系车型", "代际名"},
    "留资": {"留资", "留资日期"},
    "小订开始日期": {"小订开始日期", "小订开始", "小订开启日期"},
    "小订结束日期": {"小订结束日期", "小订结束", "小订截止日期"},
    "开始大定日期": {"开始大定日期", "大定开始日期", "首销开始日期", "发布日", "上市日期"},
    "小转大结束日期": {"小转大结束日期", "首销截止", "首销结束日期", "首销期结束日期"},
    "小订天数": {"小订天数", "小订期天数"},
    "首销期天数": {"首销期天数", "首销天数", "首销周期天数"},
    "总小订": {"总小订", "小订总量", "累计小订", "总小订量"},
    "小订转大定量": {"小订转大定量", "小订转大定", "小转大", "总小转大", "小转大总量"},
    "小订转化率": {"小订转化率", "小转大率", "小订转大定率", "小转大转化率"},
    "大定量": {"大定量", "总大定", "大定总量", "首销期大定"},
    "直接大定量": {"直接大定量", "总直接大定", "直接大定", "直接大定总量"},
    "直接大定占比": {"直接大定占比", "大定直接占比", "直接大定比例"},
    "小订后退定": {"小订后退定", "小订后退订", "退订", "退订量", "总退订"},
    "小订后退定占比": {"小订后退定占比", "小订后退订占比", "退订率", "退订占比"},
    "首销期留存大定": {"首销期留存大定", "留存大定", "首销期净大定", "净大定"},
    "留存大定率": {"留存大定率", "首销期留存大定率", "净大定率", "首销期净大定率"},
    "首销期锁单": {"首销期锁单", "锁单量"},
    "锁单率": {"锁单率", "首销期锁单率"},
    "留存大定到锁单率": {"留存大定到锁单率"},
    "大定到锁单率": {"大定到锁单率"},
}

PROGRESS_SPECS = {
    "small": {"preferred": "小转大进度", "title_aliases": ("小转大", "小订转大定"), "forbidden": ()},
    "direct": {"preferred": "直接大定进度", "title_aliases": ("直接大定",), "forbidden": ()},
    "gross": {"preferred": GROSS_DAILY_SHEET, "title_aliases": ("大定当日数量", "大定进度", "总大定"), "forbidden": ("直接",)},
    "cancel": {"preferred": "首销期退订进度", "title_aliases": ("退订", "退定"), "forbidden": ("小订期",)},
    "small_cancel": {"preferred": "小订期退订进度", "title_aliases": ("小订期退订", "小订期退定"), "forbidden": ("首销",)},
}


class InputFormatError(ValueError):
    """Raised when a required logical table cannot be recognized from the source workbook."""


class MissingProgressSheet(InputFormatError):
    """An optional stage has no recognizable quantity table."""


def header_key(value: Any) -> str:
    text = str(value or "").strip().lower().replace("（", "(").replace("）", ")")
    return re.sub(r"[\s\r\n\t()（）:：/_\-]", "", text)


HEADER_LOOKUP = {
    header_key(alias): canonical
    for canonical, aliases in SUMMARY_HEADER_ALIASES.items()
    for alias in aliases
}


def canonical_header(value: Any) -> str:
    text = str(value or "").strip()
    return HEADER_LOOKUP.get(header_key(text), text)


def day_number(value: Any) -> int | None:
    key = header_key(value).replace("第", "").replace("天", "")
    match = re.fullmatch(r"d?0*(\d+)", key, re.I)
    if not match:
        return None
    number = int(match.group(1))
    return number if number > 0 else None


HeaderScan = list[tuple[int, list[str], list[tuple[int, int]]]]


def scan_header_rows(sheet, max_scan_rows: int = 40) -> HeaderScan:
    """Read a worksheet's header area in one forward XML pass.

    Calling ``iter_rows`` once per candidate row is particularly expensive for
    read-only workbooks because openpyxl restarts the worksheet XML stream each
    time.  This scan is shared by summary/progress sheet discovery.
    """
    limit = min(sheet.max_row or max_scan_rows, max_scan_rows)
    scanned: HeaderScan = []
    for row_number, values in enumerate(
        sheet.iter_rows(min_row=1, max_row=limit, values_only=True),
        1,
    ):
        headers = [canonical_header(value) for value in values]
        day_columns = sorted(
            ((index, number) for index, header in enumerate(headers) if (number := day_number(header)) is not None),
            key=lambda item: item[1],
        )
        scanned.append((row_number, headers, day_columns))
    return scanned


def row_headers(sheet, row_number: int) -> list[str]:
    """Compatibility helper for callers that need one explicit row."""
    for number, headers, _ in scan_header_rows(sheet, row_number):
        if number == row_number:
            return headers
    return []


def find_header_row(
    sheet,
    *,
    require_days: bool = False,
    max_scan_rows: int = 40,
    scanned_rows: HeaderScan | None = None,
) -> tuple[int, list[str], list[tuple[int, int]]]:
    best: tuple[int, int, list[str], list[tuple[int, int]]] | None = None
    rows = scanned_rows if scanned_rows is not None else scan_header_rows(sheet, max_scan_rows)
    for row_number, headers, day_columns in rows:
        score = int("车型" in headers) * 10 + len(set(headers) & set(SUMMARY_HEADER_ALIASES))
        if require_days:
            score += min(len(day_columns), 10) * 2
            if not day_columns:
                continue
        if "车型" not in headers:
            continue
        if require_days:
            # The first block is the raw quantity table. Later percentage
            # blocks may have more day columns while an event is in progress.
            return row_number, headers, day_columns
        candidate = (score, -row_number, headers, day_columns)
        if best is None or candidate[:2] > best[:2]:
            best = candidate
    if best is None:
        raise InputFormatError(
            f"Sheet“{sheet.title}”前{max_scan_rows}行未找到包含‘车型’"
            + ("和D1/D2…列" if require_days else "")
            + "的表头"
        )
    return -best[1], best[2], best[3]


def workbook_header_index(workbook, max_scan_rows: int = 40) -> dict[str, HeaderScan]:
    return {sheet.title: scan_header_rows(sheet, max_scan_rows) for sheet in workbook.worksheets}


def find_summary_sheet(workbook, header_index: dict[str, HeaderScan] | None = None) -> tuple[Any, int, list[str]]:
    candidates = []
    for sheet in workbook.worksheets:
        try:
            row_number, headers, _ = find_header_row(
                sheet,
                require_days=False,
                scanned_rows=(header_index or {}).get(sheet.title),
            )
        except InputFormatError:
            continue
        recognized = set(headers) & set(SUMMARY_HEADER_ALIASES)
        score = len(recognized) + (8 if "汇总" in sheet.title else 0) + (5 if sheet.title in {"传播名汇总", "车型汇总"} else 0)
        candidates.append((score, sheet, row_number, headers))
    if not candidates:
        raise InputFormatError(f"工作簿没有识别到传播名汇总表；现有Sheet：{'、'.join(workbook.sheetnames)}")
    score, sheet, row_number, headers = max(candidates, key=lambda item: item[0])
    required = {"车型", "总小订", "小订转大定量", "大定量", "直接大定量"}
    missing = sorted(required - set(headers))
    if missing:
        raise InputFormatError(
            f"识别到汇总表“{sheet.title}”第{row_number}行为表头，但缺少必要字段：{'、'.join(missing)}；"
            f"当前表头：{'、'.join(header for header in headers if header)}"
        )
    LOGGER.debug("识别传播名汇总：Sheet=%s，表头行=%d，识别字段=%d个", sheet.title, row_number, len(set(headers) & set(SUMMARY_HEADER_ALIASES)))
    return sheet, row_number, headers


def find_progress_sheet(
    workbook,
    role: str,
    header_index: dict[str, HeaderScan] | None = None,
) -> tuple[Any, int, list[str], list[tuple[int, int]]]:
    spec = PROGRESS_SPECS[role]
    candidates = []
    for sheet in workbook.worksheets:
        try:
            row_number, headers, day_columns = find_header_row(
                sheet,
                require_days=True,
                scanned_rows=(header_index or {}).get(sheet.title),
            )
        except InputFormatError:
            continue
        title_key = header_key(sheet.title)
        name_score = 20 if any(header_key(alias) in title_key for alias in spec["title_aliases"]) else 0
        if role in {"cancel", "small_cancel"} and (not name_score or any(
                header_key(term) in title_key for term in spec["forbidden"])):
            continue
        if any(header_key(term) in title_key for term in spec["forbidden"]):
            name_score -= 30
        if sheet.title == spec["preferred"]:
            name_score += 30
        candidates.append((name_score + min(len(day_columns), 10), sheet, row_number, headers, day_columns))
    if not candidates:
        raise MissingProgressSheet(
            f"未找到{spec['preferred']}对应的当日数量表；允许Sheet轻微改名，但表头必须含车型和D1/D2…列。"
            f"现有Sheet：{'、'.join(workbook.sheetnames)}"
        )
    candidates.sort(key=lambda item: item[0], reverse=True)
    score, sheet, row_number, headers, day_columns = candidates[0]
    if score <= 10:
        raise InputFormatError(
            f"无法可靠判断{spec['preferred']}对应哪个Sheet；候选Sheet“{sheet.title}”名称关联度过低。"
        )
    if len(candidates) > 1 and candidates[1][0] == score:
        raise InputFormatError(
            f"{spec['preferred']}识别到两个同分候选Sheet：{sheet.title}、{candidates[1][1].title}；"
            "请在其中一个Sheet名中保留对应指标关键词。"
        )
    return sheet, row_number, headers, day_columns
