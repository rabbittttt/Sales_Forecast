from __future__ import annotations

import base64
import gzip
import json
import logging
import math
import re
from time import perf_counter
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from core.discovery import aggregate_subject_aliases
from core.template_assets import read_template


FORECAST_PAGE_NAME = "鸿蒙智行销量预测.html"
FORECAST_PAGE_TITLE = "销量预测"


def forecast_manifest(manifest: dict[str, Any], *, forecast_disabled: bool = False) -> dict[str, Any]:
    """Build the private forecast page, without links or state shared with another app."""
    boards = {key: board for key, board in manifest.get("dashboards", {}).items()
              if key.rpartition("|")[2] == "sales_forecast" and not forecast_disabled}
    page = {
        **manifest,
        "app_mode": "forecast",
        "forecast_disabled": forecast_disabled,
        "forecast_subject_aliases": aggregate_subject_aliases(),
        "meta": {**manifest.get("meta", {}), "title": FORECAST_PAGE_TITLE},
        "config": {**manifest.get("config", {}), "title": FORECAST_PAGE_TITLE,
                   "module_order": ["sales_forecast"],
                   "module_labels": {key: label for key, label in manifest.get("config", {}).get("module_labels", {}).items()
                                     if key == "sales_forecast"}},
        "subjects": [{**subject, "modules": [module for module in subject.get("modules", [])
                                               if module == "sales_forecast"]}
                     for subject in manifest.get("subjects", [])],
        "dashboards": boards,
        "chart_assets": {},
        # Keep empty metadata keys for consumers of older forecast manifests.
        "raw_files": [],
        "raw_blocks": {},
        "raw_block_urls": {},
    }
    for key in ("forecast_page", "order_page", "forecast_legacy_page"):
        page.pop(key, None)
    return page


def _write_text_atomic(output_file: Path, text: str) -> None:
    """Write beside the destination, then replace only after the complete write."""
    output_file.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=output_file.parent, prefix=f".{output_file.name}.",
                            suffix=".tmp", delete=False) as staging:
        temporary = Path(staging.name)
    try:
        temporary.write_text(text, encoding="utf-8", newline="")
        temporary.replace(output_file)
    finally:
        temporary.unlink(missing_ok=True)


def b64gzip(text: str) -> str:
    """压缩 JSON 文本为 base64,供前端 DecompressionStream 解压。"""
    return base64.b64encode(gzip.compress(text.encode("utf-8"), compresslevel=6, mtime=0)).decode("ascii")


def pack_dashboard(board: dict[str, Any]) -> dict[str, Any]:
    """Encode shared containers once; do not merge distinct equal values."""
    counts, scanned, active = {}, set(), set()
    def count(value):
        if not isinstance(value, (dict, list)):
            return
        identity = id(value)
        if identity in active:
            raise ValueError("Circular dashboard data")
        counts[identity] = counts.get(identity, 0) + 1
        if identity in scanned:
            return
        scanned.add(identity)
        active.add(identity)
        for child in (value.values() if isinstance(value, dict) else value):
            count(child)
        active.remove(identity)
    count(board)
    pool, indexes = [], {}
    def body(value):
        if isinstance(value, list):
            return [encode(child) for child in value]
        if "$shared" in value or "$literal" in value:
            return {"$literal": [[key, encode(child)] for key, child in value.items()]}
        return {key: encode(child) for key, child in value.items()}
    def encode(value):
        if not isinstance(value, (dict, list)):
            # Keep diagnostics on the original board, but never send Python's
            # nonstandard NaN/Infinity tokens to the browser's JSON.parse.
            return None if isinstance(value, float) and not math.isfinite(value) else value
        identity = id(value)
        if counts[identity] > 1:
            if identity not in indexes:
                indexes[identity] = len(pool)
                pool.append(None)
                pool[indexes[identity]] = body(value)
            return {"$shared": indexes[identity]}
        return body(value)
    root = encode(board)
    return {"format": "shared-v1", "root": root, "pool": pool}


def render_dashboard(manifest: dict[str, Any], template_dir: Path, output_file: Path) -> None:
    started = perf_counter()
    html = (template_dir / "dashboard.html").read_text(encoding="utf-8")
    css = read_template(template_dir / "dashboard.css")
    forecast_math = (template_dir / "forecast-math.js").read_text(encoding="utf-8")
    forecast_import = (template_dir / "forecast-import.js").read_text(encoding="utf-8")
    javascript = f"{forecast_import}\n{forecast_math}\n{read_template(template_dir / 'dashboard.js')}"
    icon_data = base64.b64encode((template_dir / "forecast-icon.svg").read_bytes()).decode("ascii")
    icon_url = f"data:image/svg+xml;base64,{icon_data}"
    dashboard_blocks, sizes = {}, {}
    pack_seconds = serialize_seconds = compress_seconds = 0.0
    for key, board in manifest.get("dashboards", {}).items():
        tick = perf_counter()
        packed = pack_dashboard(board)
        pack_seconds += perf_counter() - tick
        tick = perf_counter()
        payload = json.dumps(packed, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        sizes[key] = len(payload.encode("utf-8"))
        serialize_seconds += perf_counter() - tick
        tick = perf_counter()
        dashboard_blocks[key] = b64gzip(payload)
        compress_seconds += perf_counter() - tick
    largest = max(sizes.items(), key=lambda item: item[1], default=("-", 0))
    logging.getLogger(__name__).info(
        "HTML载荷: 去重后看板JSON %.1fMB；最大看板=%s %.1fMB",
        sum(sizes.values()) / 1024**2,
        largest[0], largest[1] / 1024**2,
    )
    main_manifest = {
        key: value for key, value in manifest.items()
        if key not in ("raw_blocks", "dashboards")
    }
    # The forecast HTML never publishes legacy workbook exports, including
    # manifests passed directly to this renderer.
    main_manifest.update(raw_files=[], raw_block_urls={})
    main_payload = b64gzip(json.dumps(main_manifest, ensure_ascii=False, separators=(",", ":")))
    # Escape HTML tag openers in JSON keys as well as values inside script elements.
    board_payload = json.dumps(dashboard_blocks, separators=(",", ":")).replace("<", r"\u003c")
    title = FORECAST_PAGE_TITLE if manifest.get("app_mode") == "forecast" else "鸿蒙智行订单分析汇总"
    replacements = {
        "__DASHBOARD_TITLE__": title, "__DASHBOARD_CSS__": css, "__DASHBOARD_DATA__": main_payload,
        "__DASHBOARD_BLOCKS__": board_payload,
        "__DASHBOARD_JS__": javascript, "__BRAND_LOGO__": icon_url, "__FAVICON__": icon_url,
    }
    html = re.sub("|".join(replacements), lambda match: replacements[match[0]], html)
    # Write on the same volume, and close before replacing (Windows). A disk
    # write/replace failure must not truncate the previous usable dashboard.
    _write_text_atomic(output_file, html)

    logging.getLogger(__name__).info(
        "HTML输出明细: 公共数据打包 %.2fs | JSON序列化 %.2fs | 看板压缩 %.2fs | 其余输出 %.2fs",
        pack_seconds, serialize_seconds, compress_seconds,
        perf_counter() - started - pack_seconds - serialize_seconds - compress_seconds,
    )
