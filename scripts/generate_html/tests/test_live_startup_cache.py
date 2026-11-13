"""Restarting a current forecast reuses only a verified successful publication."""
from __future__ import annotations

from dataclasses import asdict, replace
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock, patch

from core import live_server
from core.live_server import InputSnapshot, LiveMonitor


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class LiveStartupCacheTests(TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / "same-runtime-version" / "预测.html"
        self.summary = self.root / "共享汇总.xlsx"
        self.summary.write_bytes(b"known summary bytes")
        self.current = InputSnapshot("2026-11-13", (
            ("orders.xlsx", 100, 10), ("config.json", 20, 11),
        ))

    @property
    def state_file(self):
        return self.output.with_name(self.output.name + ".state.json")

    def monitor(self, *, cache_files=None, output=None):
        clock = FakeClock()
        scan = Mock(side_effect=lambda: self.current)
        build = Mock(return_value=b"<html><body>successful forecast</body></html>")
        monitor = LiveMonitor(scan, build, clock=clock,
                              output_file=output or self.output,
                              cache_files=(self.summary,) if cache_files is None else cache_files)
        return monitor, clock, scan, build

    def publish(self, *, cache_files=None):
        monitor, clock, scan, build = self.monitor(cache_files=cache_files)
        monitor.tick()
        self.assertEqual(monitor.status()["state"], "waiting")
        build.assert_not_called()
        clock.advance(60)
        monitor.tick()
        self.assertEqual(monitor.status()["state"], "ready")
        self.assertEqual(build.call_count, 1)
        return monitor, clock, scan, build

    def test_successful_publication_saves_matching_page_snapshot_and_revision(self):
        monitor, _, _, build = self.publish()
        self.assertEqual(self.output.read_bytes(), build.return_value)
        saved = json.loads(self.state_file.read_text(encoding="utf-8"))
        self.assertEqual(saved["schema_version"], 1)
        self.assertEqual(saved["snapshot"], json.loads(json.dumps(asdict(self.current))))
        self.assertEqual(saved["revision"], hashlib.sha256(build.return_value).hexdigest())
        self.assertEqual(saved["revision"], monitor.page()[1])
        self.assertEqual(len(saved["artifacts"]), 1)

    def test_same_inputs_and_summary_resume_without_a_wait_or_rebuild(self):
        original, _, _, _ = self.publish()
        restarted, clock, scan, build = self.monitor()
        self.assertTrue(restarted.restore())
        self.assertEqual(restarted.page(), original.page())
        scan.assert_not_called()
        build.assert_not_called()
        self.assertNotEqual(restarted.status()["state"], "ready",
                            "a checkpoint is only a candidate until real inputs are scanned")
        restarted.tick()
        self.assertEqual(restarted.status()["state"], "ready")
        self.assertEqual(scan.call_count, 1)
        build.assert_not_called()
        clock.advance(299)
        restarted.tick()
        self.assertEqual(scan.call_count, 1)
        clock.advance(1)
        restarted.tick()
        self.assertEqual(scan.call_count, 2)
        build.assert_not_called()

    def test_old_page_without_checkpoint_remains_available_during_normal_first_wait(self):
        self.output.parent.mkdir(parents=True)
        old = b"<html>previous page without checkpoint</html>"
        self.output.write_bytes(old)
        monitor, clock, _, build = self.monitor()
        self.assertFalse(monitor.restore())
        self.assertEqual(monitor.page()[0], old)
        monitor.tick()
        clock.advance(59)
        monitor.tick()
        self.assertEqual(monitor.page()[0], old)
        build.assert_not_called()
        clock.advance(1)
        monitor.tick()
        self.assertEqual(build.call_count, 1)
        self.assertEqual(monitor.status()["state"], "ready")
        self.assertTrue(self.state_file.exists())

    def test_malformed_or_unsupported_checkpoint_never_skips_stability(self):
        self.publish()
        good = json.loads(self.state_file.read_text(encoding="utf-8"))
        broken = ["not json", "[]", "{}",
                  json.dumps({**good, "schema_version": 2}),
                  json.dumps({**good, "revision": "0" * 64}),
                  json.dumps({**good, "snapshot": {"day": "2026-11-13"}})]
        for payload in broken:
            with self.subTest(payload=payload[:80]):
                self.state_file.write_text(payload, encoding="utf-8")
                monitor, clock, _, build = self.monitor()
                self.assertFalse(monitor.restore())
                monitor.tick()
                self.assertEqual(monitor.status()["state"], "waiting")
                clock.advance(59)
                monitor.tick()
                build.assert_not_called()

    def test_modified_html_invalidates_the_checkpoint_even_if_inputs_match(self):
        self.publish()
        self.output.write_bytes(b"<html>different page bytes</html>")
        monitor, _, _, build = self.monitor()
        self.assertFalse(monitor.restore())
        monitor.tick()
        self.assertEqual(monitor.status()["state"], "waiting")
        build.assert_not_called()

    def test_input_file_changes_config_changes_and_day_rollover_require_a_new_stable_build(self):
        original = self.current
        cases = {
            "addition": replace(original, files=original.files + (("new.xlsx", 20, 2),)),
            "deletion": replace(original, files=original.files[1:]),
            "size": replace(original, files=(("orders.xlsx", 101, 10), original.files[1])),
            "mtime": replace(original, files=(("orders.xlsx", 100, 12), original.files[1])),
            "config": replace(original, files=(original.files[0], ("config.json", 20, 12))),
            "day": replace(original, day="2026-11-14"),
        }
        for label, changed in cases.items():
            with self.subTest(change=label):
                self.current = original
                previous, _, _, _ = self.publish()
                self.current = changed
                restarted, clock, _, build = self.monitor()
                self.assertTrue(restarted.restore())
                restarted.tick()
                self.assertEqual(restarted.status()["state"], "waiting")
                self.assertEqual(restarted.page(), previous.page())
                clock.advance(59)
                restarted.tick()
                build.assert_not_called()
                clock.advance(1)
                restarted.tick()
                self.assertEqual(build.call_count, 1)

    def test_unavailable_inputs_do_not_become_ready_from_checkpoint_alone(self):
        previous, _, _, _ = self.publish()
        restarted, _, scan, build = self.monitor()
        self.assertTrue(restarted.restore())
        scan.side_effect = FileNotFoundError("shared inputs unavailable")
        with self.assertLogs(live_server.LOGGER, level="ERROR"):
            restarted.tick()
        self.assertEqual(restarted.status()["state"], "error")
        self.assertEqual(restarted.page(), previous.page())
        build.assert_not_called()

    def test_missing_summary_disables_fast_resume_so_restart_can_repair_it(self):
        previous, _, _, _ = self.publish()
        self.summary.unlink()
        monitor, _, _, build = self.monitor()
        self.assertTrue(monitor.restore())
        monitor.tick()
        self.assertEqual(monitor.status()["state"], "waiting")
        self.assertEqual(monitor.page(), previous.page())
        build.assert_not_called()

    def test_summary_content_change_is_seen_even_with_identical_size_and_mtime(self):
        self.publish()
        before = self.summary.stat()
        self.summary.write_bytes(b"other summary bytes")
        self.assertEqual(self.summary.stat().st_size, before.st_size)
        os.utime(self.summary, ns=(before.st_atime_ns, before.st_mtime_ns))
        monitor, _, _, build = self.monitor()
        self.assertTrue(monitor.restore())
        monitor.tick()
        self.assertEqual(monitor.status()["state"], "waiting")
        build.assert_not_called()

    def test_different_summary_path_does_not_reuse_another_environment_publication(self):
        self.publish()
        another = self.root / "different-shared-root" / "共享汇总.xlsx"
        another.parent.mkdir()
        another.write_bytes(self.summary.read_bytes())
        restarted, _, _, build = self.monitor(cache_files=(another,))
        self.assertTrue(restarted.restore())
        restarted.tick()
        self.assertEqual(restarted.status()["state"], "waiting")
        build.assert_not_called()

    def test_new_runtime_directory_does_not_serve_a_page_from_a_previous_version(self):
        self.publish()
        new_output = self.root / "new-runtime-version" / "预测.html"
        restarted, _, _, build = self.monitor(output=new_output)
        self.assertFalse(restarted.restore())
        self.assertIsNone(restarted.page()[0])
        self.assertFalse(new_output.parent.exists())
        restarted.tick()
        self.assertEqual(restarted.status()["state"], "waiting")
        build.assert_not_called()

    def test_input_change_during_build_does_not_replace_page_or_checkpoint(self):
        monitor, clock, _, build = self.publish()
        old_page = monitor.page()
        old_checkpoint = self.state_file.read_bytes()
        self.current = replace(self.current, day="2026-11-14")
        clock.advance(300)
        monitor.tick()
        def changing_build():
            self.current = replace(self.current, day="2026-11-15")
            return b"<html>not a stable publication</html>"
        build.side_effect = changing_build
        clock.advance(60)
        monitor.tick()
        self.assertEqual(monitor.status()["state"], "waiting")
        self.assertEqual(monitor.page(), old_page)
        self.assertEqual(self.output.read_bytes(), old_page[0])
        self.assertEqual(self.state_file.read_bytes(), old_checkpoint)

    def test_page_write_failure_does_not_save_a_success_checkpoint(self):
        monitor, clock, _, build = self.publish()
        old_page = monitor.page()
        old_checkpoint = self.state_file.read_bytes()
        self.current = replace(self.current, day="2026-11-14")
        clock.advance(300)
        monitor.tick()
        clock.advance(60)
        build.return_value = b"<html>new page</html>"
        with patch.object(live_server, "_write_text_atomic", side_effect=OSError("output unavailable")), \
             self.assertLogs(live_server.LOGGER, level="ERROR"):
            monitor.tick()
        self.assertEqual(monitor.status()["state"], "error")
        self.assertEqual(monitor.page(), old_page)
        self.assertEqual(self.state_file.read_bytes(), old_checkpoint)

    def test_checkpoint_failure_does_not_fail_a_successful_page_publication(self):
        monitor, clock, _, build = self.publish()
        self.current = replace(self.current, day="2026-11-14")
        clock.advance(300)
        monitor.tick()
        build.return_value = b"<html>new page with unavailable checkpoint</html>"
        write_atomic = live_server._write_text_atomic
        def failing_checkpoint(path, text):
            if Path(path) == self.state_file:
                raise OSError("checkpoint storage unavailable")
            return write_atomic(path, text)
        clock.advance(60)
        with patch.object(live_server, "_write_text_atomic", side_effect=failing_checkpoint), \
             self.assertLogs(live_server.LOGGER, level="WARNING"):
            monitor.tick()
        self.assertEqual(monitor.status()["state"], "ready")
        self.assertFalse(monitor.status()["error"])
        self.assertEqual(monitor.page()[0], build.return_value)
        self.assertEqual(self.output.read_bytes(), build.return_value)
        restarted, _, _, retry = self.monitor()
        self.assertFalse(restarted.restore())
        restarted.tick()
        self.assertEqual(restarted.status()["state"], "waiting")
        retry.assert_not_called()

    def test_optional_artifacts_default_does_not_read_any_shared_workbook(self):
        monitor, clock, scan, build = self.monitor(cache_files=())
        self.summary.unlink()
        monitor.tick()
        clock.advance(60)
        monitor.tick()
        self.assertEqual(monitor.status()["state"], "ready")
        restarted, _, _, retry = self.monitor(cache_files=())
        self.assertTrue(restarted.restore())
        restarted.tick()
        self.assertEqual(restarted.status()["state"], "ready")
        retry.assert_not_called()
