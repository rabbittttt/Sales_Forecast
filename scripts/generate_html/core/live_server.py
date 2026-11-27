"""Stable-input monitoring and serving of the latest successful forecast."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import stat
import threading
import time
from typing import Callable
from urllib.parse import parse_qs, unquote, urlsplit

from core.live_versions import previous_published_page
from core.external_imports import ImportConflict, ImportStore, valid_text
from core.config import SUMMARY_REUSE_UNAVAILABLE, load_config
from core.campaign_source import CampaignNotPublished, LEGACY_NAME, edition_signature, published_path
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
    workbooks = {}
    for root in roots:
        # On Windows scandir already returns size/mtime for ordinary files.
        # Keep canonical identities for links, as earlier snapshots used resolved paths.
        with os.scandir(root) as entries:
            for entry in entries:
                name = entry.name
                if name.startswith(("~$", ".")) or name in {FORECAST_SUMMARY_NAME, LEGACY_NAME} or not name.lower().endswith(".xlsx"):
                    continue
                try:
                    info = entry.stat()
                except FileNotFoundError:
                    continue  # A broken link or a file removed during the scan.
                if not stat.S_ISREG(info.st_mode):
                    continue
                path = Path(entry.path)
                if entry.is_symlink() or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    path = path.resolve()
                workbooks[path] = (info.st_size, info.st_mtime_ns)
    edition = published_path(project_root)
    _, revision, digest = edition_signature(edition)
    workbooks[edition] = (revision, int(digest, 16))
    config_path = Path(project_root) / "scripts" / "generate_html" / "config.json"
    config = load_config(config_path)
    # The release directory/mtime can change on deployment with identical config.
    # The parsed settings are also the values used for the business-day decision.
    settings = json.dumps(config, sort_keys=True, ensure_ascii=False).encode("utf-8")
    facts = [("config.json", len(settings), int.from_bytes(hashlib.sha256(settings).digest(), "big"))]
    facts.extend((str(path), *workbooks[path]) for path in sorted(workbooks))
    return InputSnapshot(str(config.get("forecast_as_of_date") or date.today().isoformat()),
                         tuple(facts))


def _input_changes(old: InputSnapshot, new: InputSnapshot) -> tuple[str, bool]:
    """Return a public change description and whether only config changed."""
    before = {name: (size, stamp) for name, size, stamp in old.files}
    after = {name: (size, stamp) for name, size, stamp in new.files}
    changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
    reasons = []
    if old.day != new.day:
        reasons.append(f"业务日期由 {old.day} 变为 {new.day}")
    if any(Path(name).name == "config.json" for name in changed):
        reasons.append("预测配置变化")
    if any(Path(name).suffix.lower() in {".sqlite3", ".json"} and Path(name).name != "config.json" for name in changed):
        reasons.append("小订与首销发布数据变化")
    workbooks = [Path(name).stem for name in changed if Path(name).suffix.lower() == ".xlsx"]
    if workbooks:
        categories = ("首销期订单节奏", "小订退订分析", "小订选配比例", "锁单选配比例", "大定选配比例",
                      "销量数据整理", "小订及首销数据整理", "车型基本信息")
        public_types = [kind for kind in categories if any(kind in name for name in workbooks)]
        details = "（" + "、".join(public_types) + "）" if public_types else ""
        reasons.append(f"{len(workbooks)} 份输入工作簿变化{details}")
    config_only = bool(changed) and old.day == new.day and all(Path(name).name == "config.json" for name in changed)
    return "；".join(reasons), config_only


class LiveMonitor:
    def __init__(self, scan: Callable[[], InputSnapshot], build: Callable[[], bytes],
                 clock=time.monotonic, scan_interval=300, stable_seconds=60,
                 output_file: Path | None = None, cache_files: tuple[Path, ...] = (), *,
                 build_from_current_summary: Callable[[], bytes | None] | None = None,
                 service_version: str = "", page_version: str = ""):
        self.scan = scan
        self.build = build
        self.clock = clock
        self.scan_interval = scan_interval
        self.stable_seconds = stable_seconds
        self.output_file = output_file
        self.cache_files = cache_files
        self._build_from_current_summary = build_from_current_summary
        self._startup_summary_checked = False
        self._last_snapshot = None
        self._service_version = service_version
        self._page_version = page_version
        self._refresh_reason = "首次生成当前版本页面"
        self._last_success_at = ""
        self._restored = None
        self._lock = threading.Lock()
        self._tick_lock = threading.Lock()
        self._content = None
        self._revision = ""
        self._previous_result = False
        self._state = "starting"
        self._error = ""
        self._applied = None
        self._pending = None
        self._stable_since = 0.0
        self._next_scan = 0.0

    def seed(self, content: bytes, *, previous: bool = False, reason: str = "", published_at: str = "") -> None:
        with self._lock:
            self._content = content
            self._revision = hashlib.sha256(content).hexdigest()
            self._previous_result = previous
            if reason:
                self._refresh_reason = reason
            if published_at:
                self._state, self._error = "ready", ""
                self._last_success_at = published_at

    @property
    def checkpoint_file(self) -> Path | None:
        return self.output_file.with_name(self.output_file.name + ".state.json") if self.output_file else None

    def _cache_artifacts(self) -> list[list]:
        facts = []
        for path in self.cache_files:
            before = path.stat()
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise OSError(f"快速启动依赖正在变化：{path.name}")
            facts.append([str(path.resolve()), after.st_size, after.st_mtime_ns, digest])
        return facts

    def restore(self) -> bool:
        """Make the last page available; verify its inputs on the worker's first scan."""
        self._restored = None
        if self.output_file is None:
            return False
        try:
            content = self.output_file.read_bytes()
            if not content:
                return False
            self.seed(content, previous=True, reason="核验上次生成的页面")
            saved = json.loads(self.checkpoint_file.read_text(encoding="utf-8"))
            if saved.get("schema_version") != 1 or saved.get("revision") != self.page()[1]:
                return False
            source = saved["snapshot"]
            snapshot = InputSnapshot(source["day"], tuple(tuple(row) for row in source["files"]))
            if not isinstance(snapshot.day, str) or not all(
                len(row) == 3 and isinstance(row[0], str) and isinstance(row[1], int) and isinstance(row[2], int)
                for row in snapshot.files
            ):
                return False
            self._restored = (snapshot, saved["artifacts"])
            self._last_snapshot = snapshot
            self._last_success_at = saved.get("last_success_at", "")
            return True
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            # Missing checkpoints from older runs do not hide a usable same-version page.
            return False

    def _save_checkpoint(self, snapshot: InputSnapshot, content: bytes, published_at: str) -> None:
        if self.checkpoint_file is None:
            return
        try:
            saved = {"schema_version": 1, "snapshot": asdict(snapshot),
                     "revision": hashlib.sha256(content).hexdigest(),
                     "artifacts": self._cache_artifacts(), "last_success_at": published_at}
            _write_text_atomic(self.checkpoint_file, json.dumps(saved, ensure_ascii=False))
        except (OSError, ValueError, TypeError):
            # This optional optimization must not fail an already published report.
            LOGGER.warning("快速启动缓存保存失败，下次启动将重新检查并生成", exc_info=True)

    def page(self) -> tuple[bytes | None, str]:
        with self._lock:
            return self._content, self._revision

    def status(self) -> dict:
        with self._lock:
            return {"app": "sales-forecast-live", "state": self._state,
                    "revision": self._revision, "error": self._error,
                    "previous_result": self._previous_result,
                    "service_version": self._service_version, "page_version": self._page_version,
                    "refresh_reason": self._refresh_reason, "last_success_at": self._last_success_at}

    def _set_state(self, state: str, error: str = "", *, reason: str = "") -> None:
        with self._lock:
            self._state, self._error = state, error
            if reason:
                self._refresh_reason = reason
            self._previous_result = state != "ready" and self._content is not None

    def tick(self) -> None:
        if not self._tick_lock.acquire(blocking=False):
            return
        try:
            self._tick()
        except Exception as exc:
            self._pending = None
            self._next_scan = self.clock() + self.scan_interval
            if isinstance(exc, CampaignNotPublished):
                if self.status()["state"] != "awaiting_publication":
                    LOGGER.info(CampaignNotPublished.message)
                self._set_state("awaiting_publication", reason=CampaignNotPublished.message)
            else:
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
        reason, config_only = _input_changes(self._last_snapshot, current) if self._last_snapshot is not None else ("", False)
        if self._restored is not None:
            snapshot, artifacts = self._restored
            self._restored = None
            try:
                if current == snapshot and artifacts == self._cache_artifacts():
                    self._applied = current
                    reason = "输入、业务日期与汇总均未变化，复用上次页面"
                    LOGGER.info("输入、业务日期及汇总未变化，已恢复上次预测，无需等待或重新生成")
                elif current == snapshot:
                    reason = "共享销量汇总已变化"
            except OSError:
                reason = "共享销量汇总暂不可用"
                LOGGER.info("快速启动依赖不可用，按稳定检查流程重新生成")
        if current == self._applied:
            self._pending = None
            self._set_state("ready", reason=reason)
            return
        content = None
        if self._applied is None and self._build_from_current_summary is not None and not self._startup_summary_checked:
            self._startup_summary_checked = True
            self._set_state("building", reason=reason)
            LOGGER.info("检查现有销量汇总，尝试生成当前版本页面")
            content = self._build_from_current_summary()
        if content is None:
            if current != self._pending:
                self._pending = current
                self._stable_since = now
                self._set_state("waiting", reason=reason)
                LOGGER.info("需要从原始输入更新预测，等待连续 %s 秒稳定", self.stable_seconds)
                return
            if now - self._stable_since < self.stable_seconds:
                return
            self._set_state("building")
            LOGGER.info("输入已稳定，开始更新预测")
            if config_only and self._applied is not None and self._build_from_current_summary:
                content = self._build_from_current_summary()
            if content is None:
                content = self.build()
        if not content:
            raise ValueError("生成器未返回有效 HTML")
        after = self.scan()
        finished = self.clock()
        if after != current:
            self._pending = after
            self._stable_since = finished
            self._set_state("waiting", reason="生成期间：" + _input_changes(current, after)[0])
            LOGGER.info("生成期间输入再次变化，等待稳定后重新生成")
            return
        published_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        if self.output_file is not None:
            _write_text_atomic(self.output_file, content.decode("utf-8"))
            self._save_checkpoint(current, content, published_at)
        self.seed(content, published_at=published_at)
        self._applied = self._last_snapshot = current
        self._pending = None
        self._next_scan = finished + self.scan_interval
        LOGGER.info("动态预测已更新")

    def run(self, stop: threading.Event, on_first_ready: Callable[[], None] | None = None) -> None:
        while not stop.is_set():
            self.tick()
            if on_first_ready is not None and self.status()["state"] == "ready":
                on_first_ready()
                on_first_ready = None
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

    def __init__(self, address, monitor: LiveMonitor, asset_dir: Path | None = None, instance_id="", public_prefix="/", *, import_db=None):
        self.public_prefix = normalize_prefix(public_prefix)
        self.monitor = monitor
        self.instance_id = instance_id
        self.imports = ImportStore(import_db) if import_db is not None else None
        self.asset_dir = asset_dir
        super().__init__(address, ForecastHandler)


class ForecastHandler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self._respond(head=True)

    def do_GET(self):
        self._respond(head=False)

    def _import_api(self, head=False):
        def reply(body, status=200):
            self._send(json.dumps(body, ensure_ascii=False).encode(), "application/json; charset=utf-8", status, head)

        try:
            params = parse_qs(urlsplit(self.path).query)
            model = params.get("model", [""])[0]
            if not valid_text(model):
                raise ValueError("车型无效")
            if self.command == "POST":
                if self.headers.get_content_type() != "application/json" or self.headers.get("X-Forecast-Import") != "1":
                    return reply({"error": "请求格式不正确"}, 415)
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16 * 1024 * 1024:
                    return reply({"error": "请求大小不符合要求"}, 413)
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict) or "record" not in data:
                    raise ValueError("缺少导入记录")
                result = self.server.imports.write(model, data.get("revision"), data["record"])
            else:
                result = self.server.imports.read(model, int(params.get("known", ["-1"])[0]))
            reply(result)
        except ImportConflict:
            reply({"error": "其他人已更新该车型，请核对最新数据后重试"}, 409)
        except (ValueError, RecursionError, OverflowError):
            reply({"error": "导入数据格式或数量无效"}, 400)
        except (OSError, sqlite3.Error):
            LOGGER.exception("读写共享导入失败")
            reply({"error": "共享导入存储暂不可用"}, 503)

    def do_POST(self):
        path = urlsplit(self.path).path
        if self.server.imports and path in ("/api/imports", self.server.public_prefix + "api/imports"):
            self._import_api()
        else:
            self.send_error(404)

    def _send(self, content: bytes, content_type: str, status=200, head=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
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
            healthy = ready and state["state"] not in {"error", "awaiting_publication"}
            data = json.dumps({"ok": True, "app": "sales-forecast-live",
                               "ready": ready, "state": state["state"], "public_prefix": prefix}).encode("utf-8")
            self._send(data, "application/json; charset=utf-8",
                       status=200 if path == "/healthz" or healthy else 503, head=head)
        elif path == "/api/imports" and self.server.imports:
            self._import_api(head)
        elif path == "/api/status":
            status = self.server.monitor.status()
            if status["error"]:
                status["error"] = "后台读取或生成失败，详情见服务日志"
            data = json.dumps({**status, "instance": self.server.instance_id},
                              ensure_ascii=False).encode("utf-8")
            self._send(data, "application/json; charset=utf-8", head=head)
        elif path == "/__forecast_live.js":
            self._send(CLIENT_PATH.read_bytes(), "text/javascript; charset=utf-8", head=head)
        elif path in ("/", "/" + FORECAST_PAGE_NAME):
            content, revision = self.server.monitor.page()
            status = self.server.monitor.status()
            if content is None:
                message = {
                    "error": "销量预测生成失败，后台将自动重试。",
                    "awaiting_publication": CampaignNotPublished.message,
                }.get(status["state"], "正在生成销量预测…")
                waiting = (
                    '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
                    '<meta name="viewport" content="width=device-width, initial-scale=1">'
                    '<title>销量预测</title><body style="margin:24px;font:14px system-ui;color:#34435a">'
                    f'<main role="status">{message}</main>'
                    '<script>setTimeout(()=>location.reload(),5000)</script></body></html>'
                ).encode("utf-8")
                self._send(waiting, "text/html; charset=utf-8", status=200, head=head)
                return
            if self.server.imports:
                content = content.replace(b"</head>", b'<meta name="forecast-import-api" content="api/imports"></head>', 1)
            previous = ' data-previous-result="true"' if status["previous_result"] else ""
            client = (f'<script src="{prefix}__forecast_live.js" data-revision="{revision}"'
                      f'{previous} defer></script>').encode("utf-8")
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
