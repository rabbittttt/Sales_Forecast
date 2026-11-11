"""Fast checks for stable-input publication and the local forecast HTTP service."""
from __future__ import annotations

import dataclasses
from datetime import date
import http.client
import json
import os
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
from unittest import TestCase, skipUnless
from unittest.mock import MagicMock, Mock, patch
from urllib.parse import quote

from core import live_server
from core.data_paths import FORECAST_SUMMARY_NAME
from core.live_server import ForecastServer, InputSnapshot, LiveMonitor, scan_inputs
from core.renderer import FORECAST_PAGE_NAME


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def snapshot(day="2026-11-11", files=(("orders.xlsx", 100, 10),)):
    return InputSnapshot(day=day, files=files)


class InputSnapshotTests(TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.project = self.root / "销量预测"
        self.orders = self.root / "自定义订单"
        self.references = self.root / "共享数据" / "订单汇总"
        self.models = self.root / "共享数据" / "车型信息"
        self.config = self.project / "scripts" / "generate_html" / "config.json"
        self.orders.mkdir(parents=True)
        self.references.mkdir(parents=True)
        self.models.mkdir(parents=True)
        self.config.parent.mkdir(parents=True)
        self.config.write_text("{}", encoding="utf-8")
        environment = patch.dict(os.environ, {"SHARED_DATA_ROOT": ""})
        environment.start()
        self.addCleanup(environment.stop)

    def scan(self, input_dir=None):
        return scan_inputs(input_dir or self.orders, project_root=self.project)

    def test_snapshot_is_frozen_and_covers_orders_references_models_and_config(self):
        for folder, name in ((self.orders, "订单.xlsx"),
                             (self.references, "小订及首销数据整理.xlsx"),
                             (self.models, "车型基本信息.xlsx")):
            (folder / name).write_bytes(b"stat-only fixture")
        result = self.scan()
        self.assertEqual(result.day, date.today().isoformat())
        self.assertIsInstance(result.files, tuple)
        self.assertEqual({Path(row[0]).name for row in result.files},
                         {"订单.xlsx", "小订及首销数据整理.xlsx", "车型基本信息.xlsx", "config.json"})
        self.assertTrue(all(isinstance(row, tuple) and len(row) == 3 for row in result.files))
        self.assertEqual(result, self.scan())
        with self.assertRaises(dataclasses.FrozenInstanceError):
            result.day = "2026-11-12"

    def test_added_deleted_and_changed_workbooks_change_the_snapshot(self):
        first = self.scan()
        source = self.orders / "订单.xlsx"
        source.write_bytes(b"before")
        added = self.scan()
        self.assertNotEqual(first, added)
        source.write_bytes(b"changed workbook bytes")
        modified = self.scan()
        self.assertNotEqual(added, modified)
        source.unlink()
        self.assertEqual(self.scan(), first)

    def test_mtime_change_with_equal_size_is_observed(self):
        source = self.orders / "订单.xlsx"
        source.write_bytes(b"same size")
        before = self.scan()
        previous = source.stat()
        os.utime(source, ns=(previous.st_atime_ns, previous.st_mtime_ns + 2_000_000_000))
        self.assertNotEqual(before, self.scan())

    def test_config_and_model_changes_are_observed(self):
        before = self.scan()
        self.config.write_text('{"forecast_as_of_date":"2026-11-12"}', encoding="utf-8")
        configured = self.scan()
        self.assertNotEqual(before, configured)
        self.assertEqual(configured.day, "2026-11-12")
        source = self.models / "车型基本信息.xlsx"
        source.write_bytes(b"model dates")
        self.assertNotEqual(configured, self.scan())

    def test_derived_locked_hidden_and_non_workbook_files_do_not_trigger(self):
        before = self.scan()
        for folder in (self.orders, self.references, self.models):
            for name in (FORECAST_SUMMARY_NAME, "~$订单.xlsx", ".订单.xlsx", "notes.txt", "temp.tmp"):
                (folder / name).write_bytes(b"ignored")
        self.assertEqual(before, self.scan())
        (self.references / FORECAST_SUMMARY_NAME).write_bytes(b"freshly generated summary")
        self.assertEqual(before, self.scan(), "publishing the summary must not cause a rebuild loop")

    def test_project_output_and_cache_files_are_not_inputs(self):
        before = self.scan()
        output = self.project / "output_file"
        cache = output / ".cache" / "excel"
        cache.mkdir(parents=True)
        (output / "export.xlsx").write_bytes(b"report")
        (output / FORECAST_PAGE_NAME).write_text("<html>old page</html>", encoding="utf-8")
        (cache / "cache.xlsx").write_bytes(b"cache")
        self.assertEqual(before, self.scan())

    def test_overlapping_default_order_and_reference_roots_are_deduplicated(self):
        source = self.references / "订单.xlsx"
        source.write_bytes(b"orders")
        result = self.scan(self.references)
        self.assertEqual(sum(Path(row[0]).name == source.name for row in result.files), 1)

    def test_missing_directories_are_not_created(self):
        project = self.root / "missing" / "销量预测"
        orders = self.root / "missing-orders"
        with self.assertRaises(FileNotFoundError):
            scan_inputs(orders, project_root=project)
        self.assertFalse(project.exists())
        self.assertFalse(orders.exists())
        self.assertFalse((project.parent / "共享数据").exists())

    def test_wall_day_rollover_respects_a_fixed_review_date(self):
        with patch.object(live_server, "date") as wall_date:
            wall_date.today.return_value = date(2026, 11, 11)
            first = self.scan()
            wall_date.today.return_value = date(2026, 11, 12)
            tomorrow = self.scan()
            self.assertEqual(first.files, tomorrow.files)
            self.assertNotEqual(first.day, tomorrow.day)
            self.config.write_text('{"forecast_as_of_date":"2026-11-09"}', encoding="utf-8")
            fixed = self.scan()
            wall_date.today.return_value = date(2026, 11, 13)
            self.assertEqual(self.scan(), fixed)
            self.assertEqual(fixed.day, "2026-11-09")


class LiveMonitorTests(TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.current = snapshot()
        self.scan = Mock(side_effect=lambda: self.current)
        self.build = Mock(return_value=b"<html>fresh</html>")
        self.monitor = LiveMonitor(self.scan, self.build, clock=self.clock,
                                   scan_interval=300, stable_seconds=60)

    def tick_after(self, seconds):
        self.clock.advance(seconds)
        self.monitor.tick()

    def publish_initial(self):
        self.monitor.tick()
        self.tick_after(60)
        self.assertEqual(self.build.call_count, 1)
        return self.monitor.page()

    def test_initial_build_also_waits_for_sixty_seconds_of_stability(self):
        self.monitor.tick()
        self.assertIsNone(self.monitor.page()[0])
        self.tick_after(59.9)
        self.build.assert_not_called()
        self.tick_after(.1)
        self.assertEqual(self.build.call_count, 1)
        body, revision = self.monitor.page()
        self.assertEqual(body, b"<html>fresh</html>")
        self.assertIsInstance(revision, str)
        self.assertTrue(revision)
        self.assertEqual(self.monitor.status()["revision"], revision)

    def test_change_during_stability_window_restarts_the_full_wait(self):
        self.monitor.tick()
        self.tick_after(55)
        self.current = snapshot(files=(("orders.xlsx", 200, 12),))
        self.monitor.tick()
        self.tick_after(59)
        self.build.assert_not_called()
        self.tick_after(1)
        self.assertEqual(self.build.call_count, 1)

    def test_idle_ticks_do_not_scan_or_rebuild_until_the_poll_interval(self):
        published = self.publish_initial()
        scans = self.scan.call_count
        self.tick_after(5)
        self.tick_after(50)
        self.assertEqual(self.scan.call_count, scans)
        self.assertEqual(self.build.call_count, 1)
        self.tick_after(300)
        self.assertGreater(self.scan.call_count, scans)
        self.assertEqual(self.build.call_count, 1)
        self.assertEqual(self.monitor.page(), published)

    def test_file_addition_deletion_and_modification_each_require_stability(self):
        variants = [snapshot(files=()),
                    snapshot(files=(("orders.xlsx", 101, 10),)),
                    snapshot(files=(("orders.xlsx", 100, 10), ("new.xlsx", 200, 4)))]
        for changed in variants:
            with self.subTest(files=changed.files):
                self.setUp()
                original = self.publish_initial()
                self.current = changed
                self.build.return_value = b"<html>changed</html>"
                self.tick_after(300)
                self.assertEqual(self.monitor.page(), original)
                self.tick_after(59)
                self.assertEqual(self.build.call_count, 1)
                self.tick_after(1)
                self.assertEqual(self.build.call_count, 2)
                body, revision = self.monitor.page()
                self.assertEqual(body, b"<html>changed</html>")
                self.assertNotEqual(revision, original[1])

    def test_calendar_day_change_rebuilds_without_file_changes(self):
        old = self.publish_initial()
        self.current = snapshot(day="2026-11-12")
        self.build.return_value = b"<html>next day</html>"
        self.tick_after(300)
        self.assertEqual(self.monitor.page(), old)
        self.tick_after(60)
        self.assertEqual(self.build.call_count, 2)
        self.assertEqual(self.monitor.page()[0], b"<html>next day</html>")

    def test_seed_is_available_while_initial_inputs_are_stabilizing(self):
        self.monitor.seed(b"<html>last good</html>")
        old = self.monitor.page()
        self.assertEqual(old[0], b"<html>last good</html>")
        self.monitor.tick()
        self.tick_after(59)
        self.build.assert_not_called()
        self.assertEqual(self.monitor.page(), old)
        self.tick_after(1)
        self.assertEqual(self.build.call_count, 1)
        self.assertNotEqual(self.monitor.page()[1], old[1])

    def test_build_failure_keeps_the_old_page_and_retries_after_scan_interval(self):
        self.monitor.seed(b"<html>last good</html>")
        old = self.monitor.page()
        self.build.side_effect = [RuntimeError("test build failed"), b"<html>recovered</html>"]
        self.monitor.tick()
        with self.assertLogs(live_server.LOGGER, level="ERROR"):
            self.tick_after(60)
        self.assertEqual(self.monitor.page(), old)
        self.assertIn("test build failed", self.monitor.status()["error"])
        self.tick_after(299)
        self.assertEqual(self.build.call_count, 1)
        self.tick_after(1)
        self.tick_after(60)
        self.assertEqual(self.build.call_count, 2)
        self.assertEqual(self.monitor.page()[0], b"<html>recovered</html>")
        self.assertNotEqual(self.monitor.page()[1], old[1])
        self.assertFalse(self.monitor.status()["error"])

    def test_scan_failure_keeps_the_old_page_and_retries(self):
        self.monitor.seed(b"<html>last good</html>")
        old = self.monitor.page()
        self.scan.side_effect = FileNotFoundError("shared inputs unavailable")
        with self.assertLogs(live_server.LOGGER, level="ERROR"):
            self.monitor.tick()
        self.assertEqual(self.monitor.page(), old)
        self.build.assert_not_called()
        self.assertIn("shared inputs unavailable", self.monitor.status()["error"])
        scans = self.scan.call_count
        self.tick_after(299)
        self.assertEqual(self.scan.call_count, scans)
        self.scan.side_effect = lambda: self.current
        self.tick_after(1)
        self.build.assert_not_called()
        self.tick_after(60)
        self.assertEqual(self.build.call_count, 1)
        self.assertEqual(self.monitor.page()[0], b"<html>fresh</html>")
        self.assertFalse(self.monitor.status()["error"])

    def test_failed_output_write_keeps_disk_page_and_revision(self):
        with TemporaryDirectory() as directory:
            output = Path(directory) / FORECAST_PAGE_NAME
            output.write_bytes(b"<html>last good</html>")
            monitor = LiveMonitor(self.scan, self.build, clock=self.clock,
                                  scan_interval=300, stable_seconds=60, output_file=output)
            monitor.seed(output.read_bytes())
            old = monitor.page()
            monitor.tick()
            self.clock.advance(60)
            with patch.object(live_server, "_write_text_atomic", side_effect=OSError("replace denied")), \
                 self.assertLogs(live_server.LOGGER, level="ERROR"):
                monitor.tick()
            self.assertEqual(output.read_bytes(), old[0])
            self.assertEqual(monitor.page(), old)
            self.assertIn("replace denied", monitor.status()["error"])
            self.clock.advance(300)
            monitor.tick()
            self.clock.advance(60)
            monitor.tick()
            self.assertEqual(output.read_bytes(), b"<html>fresh</html>")
            self.assertEqual(monitor.page()[0], output.read_bytes())
            self.assertNotEqual(monitor.page()[1], old[1])

    def test_inputs_changed_during_build_are_not_published(self):
        self.monitor.seed(b"<html>last good</html>")
        old = self.monitor.page()

        def build():
            self.current = snapshot(files=(("orders.xlsx", 200, 11),))
            return b"<html>built from mixed inputs</html>"

        self.build.side_effect = build
        self.monitor.tick()
        self.tick_after(60)
        self.assertEqual(self.monitor.page(), old)
        self.assertEqual(self.build.call_count, 1)
        self.build.side_effect = None
        self.build.return_value = b"<html>stable inputs</html>"
        self.tick_after(59)
        self.assertEqual(self.build.call_count, 1)
        self.tick_after(1)
        self.assertEqual(self.build.call_count, 2)
        self.assertEqual(self.monitor.page()[0], b"<html>stable inputs</html>")

    def test_old_page_remains_readable_while_build_is_running(self):
        self.monitor.seed(b"<html>last good</html>")
        old = self.monitor.page()
        entered, release, read_finished = threading.Event(), threading.Event(), threading.Event()
        observed = []

        def build():
            entered.set()
            if not release.wait(5):
                raise TimeoutError("test did not release build")
            return b"<html>finished</html>"

        def read():
            observed.append(self.monitor.page())
            read_finished.set()

        self.build.side_effect = build
        self.monitor.tick()
        self.clock.advance(60)
        worker = threading.Thread(target=self.monitor.tick)
        reader = threading.Thread(target=read)
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            reader.start()
            self.assertTrue(read_finished.wait(1), "HTTP readers must not wait for the generator")
            self.assertEqual(observed, [old])
        finally:
            release.set()
            worker.join(5)
            if reader.ident is not None:
                reader.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(self.monitor.page()[0], b"<html>finished</html>")


class ForecastHTTPTests(TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.build = Mock(return_value=b"<html>fresh page</html>")
        self.monitor = LiveMonitor(lambda: snapshot(), self.build, clock=self.clock,
                                   scan_interval=300, stable_seconds=60)
        self.server = ForecastServer(("127.0.0.1", 0), self.monitor)
        self.worker = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": .01}, daemon=True)
        self.worker.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(3)

    def get(self, target):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request("GET", target)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_root_and_encoded_forecast_route_serve_the_published_page(self):
        self.monitor.seed(b"<!doctype html><html><body>published forecast</body></html>")
        pages = []
        for target in ("/", "/" + quote(FORECAST_PAGE_NAME) + "?subject=test&forecastStage=launch"):
            with self.subTest(target=target):
                status, headers, body = self.get(target)
                self.assertEqual(status, 200)
                self.assertIn("text/html", headers.get("Content-Type", ""))
                self.assertIn(b"published forecast", body)
                self.assertEqual(body.count(b'src="/__forecast_live.js"'), 1)
                self.assertIn(('data-revision="' + self.monitor.page()[1] + '"').encode(), body)
                self.assertRegex(body, rb'<script[^>]*src="/__forecast_live.js"[^>]*\bdefer\b')
                self.assertEqual(headers.get("Cache-Control"), "no-store")
                pages.append(body)
        self.assertEqual(pages[0], pages[1])
        self.build.assert_not_called()

    def test_unbuilt_page_is_unavailable_while_status_api_still_works(self):
        self.assertEqual(self.get("/")[0], 503)
        status, headers, body = self.get("/api/status")
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        result = json.loads(body)
        for key in ("state", "revision", "error"):
            self.assertIn(key, result)
        self.assertEqual(result["revision"], self.monitor.page()[1])
        self.build.assert_not_called()

    def test_status_api_revision_changes_only_after_successful_publication(self):
        self.monitor.seed(b"<html>last good</html>")
        old = json.loads(self.get("/api/status")[2])["revision"]
        self.build.side_effect = RuntimeError("fixture failure")
        self.monitor.tick()
        self.clock.advance(60)
        with self.assertLogs(live_server.LOGGER, level="ERROR"):
            self.monitor.tick()
        failed = json.loads(self.get("/api/status")[2])
        self.assertEqual(failed["revision"], old)
        self.assertIn(b"last good", self.get("/")[2])
        self.build.side_effect = None
        self.clock.advance(300)
        self.monitor.tick()
        self.clock.advance(60)
        self.monitor.tick()
        self.assertNotEqual(json.loads(self.get("/api/status")[2])["revision"], old)
        self.assertIn(b"fresh page", self.get("/")[2])

    def test_live_client_is_served_as_javascript(self):
        status, headers, body = self.get("/__forecast_live.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", headers.get("Content-Type", ""))
        self.assertTrue(body.strip())
        self.build.assert_not_called()

    def test_unlisted_files_and_traversal_paths_are_not_served(self):
        self.monitor.seed(b"<html>page</html>")
        for target in ("/config.json", "/orders.xlsx", "/.git/config",
                       "/..%2fconfig.json", "/%2e%2e/%2e%2e/secret", "/unknown"):
            with self.subTest(target=target):
                self.assertEqual(self.get(target)[0], 404)


@skipUnless(shutil.which("node"), "Node.js required")
class LiveClientTests(TestCase):
    def run_client(self, scenario):
        harness = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[1], 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const reply = (revision, ok=true) => ({ok, json:async () => ({revision})});
function client(initial, hidden=false) {
  const queue = [initial], requests = [], handlers = new Map();
  const document = {hidden, currentScript:{dataset:{revision:'published'}},
    addEventListener:(name, callback) => handlers.set(name, callback)};
  let poll, interval, reloads=0, unexpected=0;
  vm.runInNewContext(source, {
    document,
    location:{reload:() => {reloads += 1}},
    setInterval:(callback, milliseconds) => {poll=callback;interval=milliseconds;return 1},
    fetch:async (url, options) => {
      requests.push({url, options});
      if (!queue.length) {unexpected += 1;throw Error('unexpected request')}
      const response = queue.shift();
      if (response instanceof Error) throw response;
      return response;
    }
  }, {filename:process.argv[1]});
  return {document, queue, requests, handlers,
    poll:() => poll(),
    get reloads() {return reloads},
    get interval() {return interval},
    verifyRequests() {
      assert.equal(unexpected,0);
      for (const request of requests) {
        assert.equal(request.url,'/api/status');
        assert.equal(request.options.cache,'no-store');
      }
    }
  };
}
"""
        script = harness + "\n(async () => {\n" + scenario + "\n})().catch(error => {console.error(error);process.exitCode=1});"
        result = subprocess.run([shutil.which("node"), "-e", script, str(live_server.CLIENT_PATH)],
                                capture_output=True, text=True, encoding="utf-8", timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_new_published_revision_reloads_the_page(self):
        self.run_client("""
const current = client(reply('published'));
await flush();
assert.equal(current.requests.length,1);
assert.equal(current.reloads,0);
current.queue.push(reply('new-publication'));
await current.poll();
assert.equal(current.reloads,1);
assert.equal(current.requests.length,2);
current.verifyRequests();
""")

    def test_same_or_empty_revision_keeps_the_current_page(self):
        self.run_client("""
const current = client(reply('published'));
await flush();
assert.equal(current.interval,10000);
for (const revision of ['published','',null]) {
  current.queue.push(reply(revision));
  await current.poll();
}
assert.equal(current.requests.length,4);
assert.equal(current.reloads,0);
current.verifyRequests();
""")

    def test_network_http_and_invalid_json_failures_keep_page_and_allow_retry(self):
        self.run_client("""
const current = client(new Error('local server temporarily unavailable'));
await flush();
assert.equal(current.reloads,0);
current.queue.push(reply('new-publication',false));
await current.poll();
assert.equal(current.reloads,0);
current.queue.push({ok:true,json:async () => {throw new SyntaxError('invalid status')}});
await current.poll();
assert.equal(current.reloads,0);
current.queue.push(reply('new-publication'));
await current.poll();
assert.equal(current.reloads,1);
assert.equal(current.requests.length,4);
current.verifyRequests();
""")

    def test_hidden_page_defers_polling_and_checks_on_becoming_visible(self):
        self.run_client("""
const current = client(reply('new-publication'),true);
await flush();
assert.equal(current.requests.length,0);
assert.equal(current.reloads,0);
await current.poll();
await current.handlers.get('visibilitychange')();
assert.equal(current.requests.length,0);
current.document.hidden=false;
await current.handlers.get('visibilitychange')();
assert.equal(current.requests.length,1);
assert.equal(current.reloads,1);
current.verifyRequests();
""")


class ForcedSummaryRefreshTests(TestCase):
    def test_force_refresh_flag_is_forwarded_to_the_summary_process(self):
        import main as generator

        with TemporaryDirectory() as directory:
            root = Path(directory)
            summary = root / FORECAST_SUMMARY_NAME
            for force in (False, True):
                with self.subTest(force=force), \
                     patch.object(generator, "forecast_summary_path", return_value=summary), \
                     patch.object(generator.subprocess, "Popen") as spawn:
                    process = MagicMock()
                    process.stdout = []
                    process.wait.return_value = 0
                    spawn.return_value.__enter__.return_value = process
                    generator.refresh_sales_forecast_data({
                        "refresh_sales_forecast_data_before_build": True,
                        "force_sales_forecast_data_refresh": force,
                    }, root / "inputs")
                    spawn.assert_called_once()
                    command = spawn.call_args.args[0]
                    self.assertEqual(command.count("--force"), int(force))
                    self.assertEqual(command[command.index("--orders") + 1], str((root / "inputs").resolve()))
                    self.assertEqual(command[command.index("--output") + 1], str(summary.resolve()))
