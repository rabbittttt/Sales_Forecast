"""Local live forecast entry point; static generation stays in main.py."""
from __future__ import annotations

import argparse
import hashlib
import logging
import os
from pathlib import Path
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
import threading
from urllib.error import URLError
from urllib.request import urlopen
import json
import webbrowser

from core.data_paths import (
    PROJECT_ROOT, assert_output_is_private, orders_input_directory,
    dynamic_output_directory, dynamic_log_directory, excel_cache_directory, forecast_summary_path, forecast_database_path,
    forecast_reference_directory, model_information_directory,
)
from core.config import SUMMARY_REUSE_UNAVAILABLE
from core.live_server import (
    ForecastServer, LiveMonitor, normalize_prefix,
    previous_published_page, scan_inputs,
)
from core.live_versions import pin_version, prune_published_versions
from core.release import page_revision, runtime_revision
from core.renderer import FORECAST_PAGE_NAME


ROOT = Path(__file__).resolve().parent
LOGGER = logging.getLogger(__name__)


def build_page(input_dir: Path, live_dir: Path, *, reuse_summary_only: bool = False) -> bytes | None:
    live_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".build-", dir=live_dir) as temp_dir:
        staging = Path(temp_dir) / FORECAST_PAGE_NAME
        LOGGER.info("本次网页读取缓存=%s", staging.parent / ".cache" / "excel")
        refresh_mode = "--reuse-summary-only" if reuse_summary_only else "--force-refresh"
        command = [sys.executable, str(ROOT / "main.py"), "--no-open", refresh_mode,
                   "--input", str(input_dir), "--output", str(staging), "--log-dir", str(dynamic_log_directory(PROJECT_ROOT))]
        completed = subprocess.run(command, cwd=PROJECT_ROOT)
        if reuse_summary_only and completed.returncode == SUMMARY_REUSE_UNAVAILABLE:
            return None
        if completed.returncode:
            raise RuntimeError(f"生成器退出码 {completed.returncode}，详情见运行日志")
        return staging.read_bytes()


def parse_args():
    parser = argparse.ArgumentParser(description="运行动态销量预测网页")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--input", type=Path, default=orders_input_directory(PROJECT_ROOT))
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--data-dir", type=Path, help="外置运行目录；相对路径按项目根解析")
    parser.add_argument("--public-prefix", type=normalize_prefix,
                        default=os.environ.get("SALES_FORECAST_PUBLIC_PREFIX", "/"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.data_dir is not None:
        os.environ["SALES_FORECAST_DATA_DIR"] = str(args.data_dir)
    output_root = dynamic_output_directory(PROJECT_ROOT)
    if (PROJECT_ROOT.parent / "app-release.json").is_file():
        if not os.environ.get("SALES_FORECAST_DATA_DIR", "").strip() or output_root.is_relative_to(PROJECT_ROOT):
            raise ValueError("发布运行必须通过 --data-dir 或 SALES_FORECAST_DATA_DIR 指定版本目录外的运行根")
        if not os.environ.get("SHARED_DATA_ROOT", "").strip():
            raise ValueError("发布运行必须显式配置 SHARED_DATA_ROOT")
    log_dir = dynamic_log_directory(PROJECT_ROOT)
    log_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s",
                        handlers=[logging.StreamHandler(),
                                  logging.FileHandler(log_dir / "live_server.log", encoding="utf-8")])
    input_dir = args.input.resolve()
    source_key = hashlib.sha256(f"{input_dir}|{orders_input_directory(PROJECT_ROOT).resolve()}".encode("utf-8")).hexdigest()[:16]
    service_version = runtime_revision(PROJECT_ROOT)
    page_version = page_revision(PROJECT_ROOT)
    requested = output_root.parent.resolve() / output_root.name / source_key / page_version
    live_dir = assert_output_is_private(requested)
    if live_dir != requested:
        raise ValueError("动态版本目录不能指向其他路径")
    import_db = live_dir.parent / "external-imports.sqlite3"
    instance_id = hashlib.sha256(f"{PROJECT_ROOT}|{live_dir}|{service_version}|{args.public_prefix}".encode("utf-8")).hexdigest()
    monitor = LiveMonitor(lambda: scan_inputs(input_dir),
                          lambda: build_page(input_dir, live_dir),
                          output_file=live_dir / FORECAST_PAGE_NAME,
                          service_version=service_version, page_version=page_version,
                          cache_files=(forecast_summary_path(PROJECT_ROOT), forecast_database_path(PROJECT_ROOT)),
                          build_from_current_summary=lambda: build_page(input_dir, live_dir, reuse_summary_only=True))
    try:
        server = ForecastServer((args.host, args.port), monitor, live_dir / "forecast_assets", instance_id, args.public_prefix,
                                import_db=import_db)
    except OSError:
        # Reopening the launcher should open the existing local service.
        existing = f"http://{'127.0.0.1' if args.host == '0.0.0.0' else args.host}:{args.port}"
        status = {}
        try:
            with urlopen(existing + "/api/status", timeout=2) as response:
                response_status = json.load(response)
                if isinstance(response_status, dict):
                    status = response_status
        except (OSError, URLError, ValueError):
            pass
        if status.get("app") == "sales-forecast-live":
            if status.get("instance") == instance_id:
                LOGGER.info("动态服务已运行：%s", existing)
                if not args.no_open:
                    webbrowser.open(existing)
                return 0
            LOGGER.error(
                "端口 %s 已有销量预测服务运行，但版本或运行配置不同。"
                "先在旧服务窗口按 Ctrl+C 正常退出，再启动当前版本。",
                args.port,
            )
            return 1
        LOGGER.exception("无法启动服务，请检查地址或端口 %s", args.port)
        return 1
    with server, pin_version(live_dir):
        LOGGER.info("订单输入=%s；参考整理表目录=%s；车型资料目录=%s", input_dir,
                    forecast_reference_directory(PROJECT_ROOT), model_information_directory(PROJECT_ROOT))
        LOGGER.info("共享汇总=%s；动态网页=%s；共享导入库=%s", forecast_summary_path(PROJECT_ROOT),
                    live_dir / FORECAST_PAGE_NAME, import_db)
        LOGGER.info("销量汇总数据库=%s", forecast_database_path(PROJECT_ROOT))
        LOGGER.info("汇总刷新缓存=%s；服务日志=%s", excel_cache_directory(PROJECT_ROOT), log_dir / "live_server.log")
        monitor.restore()
        if monitor.page()[0] is None:
            previous_page = previous_published_page(live_dir)
            if previous_page is not None:
                monitor.seed(previous_page, previous=True, reason="页面生成代码或模板版本变化")
                LOGGER.info("已载入上次成功生成的页面，当前版本将在后台生成")
        address = "127.0.0.1" if args.host == "0.0.0.0" else args.host
        url = f"http://{address}:{server.server_address[1]}"
        if hasattr(signal, "SIGBREAK"):
            signal.signal(signal.SIGBREAK, signal.default_int_handler)
        stop = threading.Event()
        worker = threading.Thread(target=monitor.run, args=(stop, lambda: prune_published_versions(live_dir)),
                                  name="forecast-monitor", daemon=True)
        worker.start()
        LOGGER.info("动态销量预测：%s；每 300 秒扫描，连续稳定 60 秒后更新；Ctrl+C 退出", url)
        if not args.no_open:
            try:
                webbrowser.open(url)
            except OSError:
                LOGGER.exception("浏览器未能自动打开，请访问 %s", url)
        try:
            server.serve_forever(poll_interval=0.5)
        except KeyboardInterrupt:
            LOGGER.info("正在停止动态服务")
        finally:
            stop.set()
            worker.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
