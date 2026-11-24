"""Parsing source dates and classifying small-order and launch windows."""
from __future__ import annotations

from datetime import date, datetime, timedelta
import math
import re
from typing import Any

from openpyxl.utils.datetime import from_excel


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_date(value: Any) -> date | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)):
        try:
            converted = from_excel(value)
            # Excel serials below one can be time-only values, not dates.
            # Never let a datetime.time escape into calendar comparisons.
            if isinstance(converted, datetime):
                return converted.date()
            return converted if isinstance(converted, date) else None
        except (TypeError, ValueError, OverflowError):
            return None
    text = str(value or "").strip()
    normalized = (
        text.replace("年", "-")
        .replace("月", "-")
        .replace("日", "")
        .replace("/", "-")
        .replace(".", "-")
        .replace("\\", "-")
    )
    normalized = re.sub(
        r"(?<!\d)(\d{2})-(\d{1,2})-(\d{1,2})(?!\d)",
        lambda match: f"20{match.group(1)}-{match.group(2)}-{match.group(3)}",
        normalized,
        count=1,
    )
    try:
        return datetime.fromisoformat(normalized).date()
    except (TypeError, ValueError):
        match = re.search(r"(?<!\d)(20\d{2})-(\d{1,2})-(\d{1,2})(?!\d)", normalized)
        if not match:
            return None
        try:
            return date(*(int(part) for part in match.groups()))
        except ValueError:
            return None


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time())
    if isinstance(value, (int, float)):
        try:
            converted = from_excel(value)
            if isinstance(converted, datetime):
                return converted
            if isinstance(converted, date):
                return datetime.combine(converted, datetime.min.time())
        except (TypeError, ValueError, OverflowError):
            return None
    text = str(value or "").strip()
    if not text:
        return None
    normalized = (
        text.replace("年", "-")
        .replace("月", "-")
        .replace("日", " ")
        .replace("时", ":")
        .replace("分", ":")
        .replace("秒", "")
        .replace("/", "-")
        .replace(".", "-")
        .replace("\\", "-")
        .strip()
        .rstrip(":")
    )
    normalized = re.sub(
        r"(?<!\d)(\d{2})-(\d{1,2})-(\d{1,2})(?!\d)",
        lambda match: f"20{match.group(1)}-{match.group(2)}-{match.group(3)}",
        normalized,
        count=1,
    )
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        parsed_date = _as_date(value)
        if parsed_date is None:
            return None
        match = re.search(
            r"20\d{2}-\d{1,2}-\d{1,2}[ T]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?",
            normalized,
        )
        if not match:
            return datetime.combine(parsed_date, datetime.min.time())
        hour, minute, second = (int(part or 0) for part in match.groups())
        try:
            return datetime.combine(parsed_date, datetime.min.time()).replace(
                hour=hour, minute=minute, second=second
            )
        except ValueError:
            return None


def _iso(value: Any) -> str:
    parsed = _as_date(value)
    return parsed.isoformat() if parsed else ""


def _configured_forecast_date(value: Any) -> date | None:
    """Parse the optional manual as-of date used for lifecycle classification."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(value).strip()):
        raise ValueError("config.json 的 forecast_as_of_date 必须是 YYYY-MM-DD 或留空")
    parsed = _as_date(value)
    if parsed is None:
        raise ValueError("config.json 的 forecast_as_of_date 必须是 YYYY-MM-DD 或留空")
    return parsed


def _positive_day_count(value: Any) -> int:
    number = _number(value)
    return int(number) if not isinstance(value, bool) and math.isfinite(number) and number > 0 and number.is_integer() else 0


def _forecast_stage(launch_date: Any, end_date: Any = None, days: Any = None, today: date | None = None) -> dict[str, Any]:
    """Classify the launch window by absolute dates; D1 is the launch date itself."""
    current = today or date.today()
    start = _as_date(launch_date)
    explicit_end = _as_date(end_date)
    maintained_span = _positive_day_count(days)
    if start is None:
        return {"key": "unknown", "label": "时间缺失", "day": 0, "days": 0, "launch_date": "", "end_date": ""}
    if end_date not in (None, "") and explicit_end is None:
        return {"key": "unknown", "label": "首销结束日期无效", "day": 0, "days": 0,
                "launch_date": start.isoformat(), "end_date": ""}
    if explicit_end and explicit_end < start:
        return {
            "key": "unknown", "label": "首销窗口冲突", "day": 0, "days": 0,
            "launch_date": start.isoformat(), "end_date": explicit_end.isoformat(),
        }
    end = explicit_end
    if end is None and 0 < maintained_span <= (date.max - start).days + 1:
        end = start + timedelta(days=maintained_span - 1)
    if end is None:
        return {
            "key": "unknown", "label": "首销截止日期与天数缺失", "day": 0, "days": 0,
            "launch_date": start.isoformat(), "end_date": "",
        }
    span = (end - start).days + 1
    if current < start:
        key, label, day_number = "before", "首销期未开始", 0
    elif end and current > end:
        key, label, day_number = "ended", "首销期已结束", span
    else:
        key, label = "active", "首销期进行中"
        day_number = min(max((current - start).days + 1, 1), span)
    return {
        "key": key,
        "label": label,
        "day": day_number,
        "days": span,
        "launch_date": start.isoformat(),
        "end_date": end.isoformat() if end else "",
    }


def _small_order_stage(start_date: Any, end_date: Any = None, today: date | None = None) -> dict[str, Any]:
    """Classify the small-order window; D1 is kept separate for hourly forecasting."""
    current = today or date.today()
    start = _as_date(start_date)
    end = _as_date(end_date)
    if start is None:
        return {"key": "unknown", "label": "小订时间缺失", "day": 0, "start_date": "", "end_date": "", "days": 0}
    if end is None:
        return {
            "key": "unknown", "label": "小订结束日期缺失", "day": 0,
            "start_date": start.isoformat(), "end_date": "", "days": 0,
        }
    if end < start:
        return {
            "key": "unknown", "label": "小订窗口冲突", "day": 0,
            "start_date": start.isoformat(), "end_date": end.isoformat(), "days": 0,
        }
    span = (end - start).days + 1
    if current < start:
        key, label, day_number = "before", "小订D1未到", 0
    elif current == start:
        key, label, day_number = "d1", "小订D1进行中", 1
    elif current > end:
        key, label, day_number = "ended", "小订期已结束", span
    else:
        key, label = "active", "小订D1已过"
        day_number = min((current - start).days + 1, span)
    return {
        "key": key,
        "label": label,
        "day": day_number,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "days": span,
    }


def _weekday(value: Any) -> str:
    parsed = _as_date(value)
    return ("周一", "周二", "周三", "周四", "周五", "周六", "周日")[parsed.weekday()] if parsed else "未维护"
