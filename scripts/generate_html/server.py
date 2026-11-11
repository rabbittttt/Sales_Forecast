"""Local live forecast entry point; static generation stays in main.py."""
from __future__ import annotations

import argparse
import hashlib
import logging
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
from urllib.error import URLError
from urllib.request import urlopen
import json
import webbrowser

from core.data_paths import (
    PROJECT_ROOT, assert_output_is_private, orders_input_directory,
    dynamic_output_directory,
)
from core.live_server import ForecastServer, LiveMonitor, scan_inputs, normalize_prefix
from core.release import runtime_revision
from core.renderer import FORECAST_PAGE_NAME


ROOT = Path(__file__).resolve().parent
LOGGER = logging.getLogger(__name__)


def build_page(input_dir: Path, live_dir: Path) -> bytes:
    staging = live_dir / f".build-{os.getpid()}" / FORECAST_PAGE_NAME
    command = [sys.executable, str(ROOT / "main.py"), "--no-open", "--force-refresh",
               "--input", str(input_dir), "--output", str(staging)]
    completed = subprocess.run(command, cwd=PROJECT_ROOT)
    if completed.returncode:
        raise RuntimeError(f"生成器退出码 {completed.returncode}，详情见运行日志")
    content = staging.read_bytes()
    assets = staging.parent / "forecast_assets"
    if assets.exists():
        destination = live_dir / "forecast_assets"
        destination.mkdir(parents=True, exist_ok=True)
        for source in assets.glob("raw-*.js"):
            target = destination / source.name
            if not target.exists():
                shutil.copyfile(source, target)
    return content


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
    log_dir = output_root / "log"
    log_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s",
                        handlers=[logging.StreamHandler(),
                                  logging.FileHandler(log_dir / "live_server.log", encoding="utf-8")])
    input_dir = args.input.resolve()
    source_key = hashlib.sha256(f"{input_dir}|{orders_input_directory(PROJECT_ROOT).resolve()}".encode("utf-8")).hexdigest()[:16]
    revision = runtime_revision(PROJECT_ROOT)
    # External caches survive restart, but a new program version never serves old templates.
    live_dir = assert_output_is_private(output_root / source_key / revision)
    instance_id = hashlib.sha256(f"{PROJECT_ROOT}|{live_dir}|{args.public_prefix}".encode("utf-8")).hexdigest()
    monitor = LiveMonitor(lambda: scan_inputs(input_dir),
                          lambda: build_page(input_dir, live_dir),
                          output_file=live_dir / FORECAST_PAGE_NAME)
    previous_pages = [live_dir / FORECAST_PAGE_NAME]
    for previous in previous_pages:
        if previous.is_file():
            monitor.seed(previous.read_bytes())
            break
    try:
        server = ForecastServer((args.host, args.port), monitor, live_dir / "forecast_assets", instance_id, args.public_prefix)
    except OSError:
        # Reopening the launcher should open the existing local service.
        existing = f"http://{'127.0.0.1' if args.host == '0.0.0.0' else args.host}:{args.port}"
        try:
            with urlopen(existing + "/api/status", timeout=2) as response:
                status = json.load(response)
                same_app = status.get("app") == "sales-forecast-live" and status.get("instance") == instance_id
        except (OSError, URLError, ValueError):
            same_app = False
        if same_app:
            LOGGER.info("动态服务已运行：%s", existing)
            if not args.no_open:
                webbrowser.open(existing)
            return 0
        LOGGER.exception("无法启动服务，请检查地址或端口 %s", args.port)
        return 1
    address = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    url = f"http://{address}:{server.server_address[1]}"
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, signal.default_int_handler)
    stop = threading.Event()
    worker = threading.Thread(target=monitor.run, args=(stop,), name="forecast-monitor", daemon=True)
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
        server.server_close()
        worker.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
