"""Stable-input monitoring and serving of the latest successful forecast."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
from pathlib import Path
import re
import threading
import time
from typing import Callable
from urllib.parse import unquote, urlsplit

from core.config import load_config
from core.data_paths import (
    FORECAST_SUMMARY_NAME, PROJECT_ROOT, forecast_reference_directory,
    model_information_directory,
)
from core.renderer import FORECAST_PAGE_NAME, _write_text_atomic


LOGGER = logging.getLogger(__name__)
CLIENT_PATH = Path(__file__).resolve().parents[1] / "templates" / "forecast-live.js"


@dataclass(frozen=True)
class InputSnapshot:
    day: str
    files: tuple[tuple[str, int, int], ...]


def scan_inputs(input_dir: Path, project_root: Path = PROJECT_ROOT) -> InputSnapshot:
    roots = {Path(input_dir).resolve(), forecast_reference_directory(project_root).resolve()}
    optional = model_information_directory(project_root)
    if optional.exists():
        roots.add(optional.resolve())
    paths = set()
    for root in roots:
        # iterdir raises on missing/unavailable source directories.
        for path in root.iterdir():
            if (path.suffix.lower() == ".xlsx" and path.is_file()
                    and not path.name.startswith(("~$", "."))
                    and path.name != FORECAST_SUMMARY_NAME):
                paths.add(path.resolve())
    config_path = Path(project_root) / "scripts" / "generate_html" / "config.json"
    config = load_config(config_path)
    paths.add(config_path.resolve())
    facts = []
    for path in sorted(paths):
        stat = path.stat()
        facts.append((str(path), stat.st_size, stat.st_mtime_ns))
    return InputSnapshot(str(config.get("forecast_as_of_date") or date.today().isoformat()),
                         tuple(facts))


class LiveMonitor:
    def __init__(self, scan: Callable[[], InputSnapshot], build: Callable[[], bytes],
                 clock=time.monotonic, scan_interval=300, stable_seconds=60,
                 output_file: Path | None = None):
        self.scan = scan
        self.build = build
        self.clock = clock
        self.scan_interval = scan_interval
        self.stable_seconds = stable_seconds
        self.output_file = output_file
        self._lock = threading.Lock()
        self._tick_lock = threading.Lock()
        self._content = None
        self._revision = ""
        self._state = "starting"
        self._error = ""
        self._applied = None
        self._pending = None
        self._stable_since = 0.0
        self._next_scan = 0.0

    def seed(self, content: bytes) -> None:
        with self._lock:
            self._content = content
            self._revision = hashlib.sha256(content).hexdigest()

    def page(self) -> tuple[bytes | None, str]:
        with self._lock:
            return self._content, self._revision

    def status(self) -> dict:
        with self._lock:
            return {"app": "sales-forecast-live", "state": self._state,
                    "revision": self._revision, "error": self._error}

    def _set_state(self, state: str, error: str = "") -> None:
        with self._lock:
            self._state, self._error = state, error

    def tick(self) -> None:
        if not self._tick_lock.acquire(blocking=False):
            return
        try:
            self._tick()
        except Exception as exc:
            self._pending = None
            self._next_scan = self.clock() + self.scan_interval
            self._set_state("error", str(exc))
            LOGGER.exception("动态更新失败，保留上次成功页面，下一轮重新检查")
        finally:
            self._tick_lock.release()

    def _tick(self) -> None:
        now = self.clock()
        if self._pending is None and now < self._next_scan:
            return
        current = self.scan()
        self._next_scan = now + self.scan_interval
        if current == self._applied:
            self._pending = None
            self._set_state("ready")
            return
        if current != self._pending:
            self._pending = current
            self._stable_since = now
            self._set_state("waiting")
            LOGGER.info("检测到输入或业务日期变化，等待连续 %s 秒稳定", self.stable_seconds)
            return
        if now - self._stable_since < self.stable_seconds:
            return
        self._set_state("building")
        LOGGER.info("输入已稳定，开始更新预测")
        content = self.build()
        if not content:
            raise ValueError("生成器未返回有效 HTML")
        after = self.scan()
        finished = self.clock()
        if after != current:
            self._pending = after
            self._stable_since = finished
            self._set_state("waiting")
            LOGGER.info("生成期间输入再次变化，等待稳定后重新生成")
            return
        if self.output_file is not None:
            _write_text_atomic(self.output_file, content.decode("utf-8"))
        self.seed(content)
        self._applied = current
        self._pending = None
        self._next_scan = finished + self.scan_interval
        self._set_state("ready")
        LOGGER.info("动态预测已更新")

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            self.tick()
            stop.wait(5)


def normalize_prefix(value: str) -> str:
    if value in ("", "/"):
        return "/"
    if not re.fullmatch(r"/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+/?", value):
        raise ValueError("公共前缀须为 /forecast/ 这样的本地路径")
    return value.rstrip("/") + "/"


class ForecastServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, monitor: LiveMonitor, asset_dir: Path | None = None, instance_id="", public_prefix="/"):
        self.public_prefix = normalize_prefix(public_prefix)
        self.monitor = monitor
        self.instance_id = instance_id
        self.asset_dir = asset_dir
        super().__init__(address, ForecastHandler)


class ForecastHandler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self._respond(head=True)

    def do_GET(self):
        self._respond(head=False)

    def _send(self, content: bytes, content_type: str, status=200, head=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Content-Security-Policy", "frame-ancestors 'self'")
        self.end_headers()
        if not head:
            self.wfile.write(content)

    def _respond(self, head=False):
        path = unquote(urlsplit(self.path).path)
        prefix = self.server.public_prefix
        # Accept both an intact public prefix and a prefix-stripping reverse proxy.
        if prefix != "/" and path == prefix.rstrip("/"):
            self.send_response(308)
            query = urlsplit(self.path).query
            self.send_header("Location", prefix + ("?" + query if query else ""))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if prefix != "/" and path.startswith(prefix):
            path = "/" + path[len(prefix):]
        if path in ("/healthz", "/readyz"):
            state = self.server.monitor.status()
            ready = bool(state["revision"])
            healthy = ready and state["state"] != "error"
            data = json.dumps({"ok": True, "app": "sales-forecast-live",
                               "ready": ready, "state": state["state"], "public_prefix": prefix}).encode("utf-8")
            self._send(data, "application/json; charset=utf-8",
                       status=200 if path == "/healthz" or healthy else 503, head=head)
        elif path == "/api/status":
            data = json.dumps({**self.server.monitor.status(), "instance": self.server.instance_id},
                              ensure_ascii=False).encode("utf-8")
            self._send(data, "application/json; charset=utf-8", head=head)
        elif path == "/__forecast_live.js":
            self._send(CLIENT_PATH.read_bytes(), "text/javascript; charset=utf-8", head=head)
        elif path in ("/", "/" + FORECAST_PAGE_NAME):
            content, revision = self.server.monitor.page()
            if content is None:
                waiting = ('<!doctype html><meta charset="utf-8"><title>销量预测</title>'
                           '<script>setTimeout(()=>location.reload(),5000)</script>').encode("utf-8")
                self._send(waiting, "text/html; charset=utf-8", status=200, head=head)
                return
            client = (f'<script src="{prefix}__forecast_live.js" data-revision="{revision}" defer></script>'
                      ).encode("utf-8")
            content = content.replace(b"</body>", client + b"</body>") if b"</body>" in content else content + client
            self._send(content, "text/html; charset=utf-8", head=head)
        elif self.server.asset_dir and re.fullmatch(r"/forecast_assets/raw-[0-9a-f]{64}\.js", path):
            asset = self.server.asset_dir / Path(path).name
            if asset.is_file():
                self._send(asset.read_bytes(), "text/javascript; charset=utf-8", head=head)
            else:
                self.send_error(404)
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        LOGGER.debug("HTTP %s", format % args)
