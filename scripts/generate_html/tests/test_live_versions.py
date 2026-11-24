"""Exercise dynamic version retention with real directories and process-visible locks."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from core.live_versions import LEASE, STATE, pin_version, previous_published_page, prune_published_versions
from core.renderer import FORECAST_PAGE_NAME


class VersionRetentionTests(TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.source = Path(self.temporary.name).resolve() / "source"

    def publish(self, index, *, managed=True, source=None):
        folder = (source or self.source) / f"{index:064x}"
        with ExitStack() as stack:
            if managed:
                stack.enter_context(pin_version(folder))
            else:
                folder.mkdir(parents=True)
            data = f"page-{index}".encode()
            (folder / FORECAST_PAGE_NAME).write_bytes(data)
            checkpoint = folder / STATE
            checkpoint.write_text(json.dumps({"schema_version": 1, "revision": hashlib.sha256(data).hexdigest()}))
            stamp = 1_700_000_000 + index
            os.utime(checkpoint, (stamp, stamp))
        return folder

    def test_keeps_current_two_verified_predecessors_and_live_instances(self):
        first, second, third, fourth, current = [self.publish(i) for i in range(1, 6)]
        with pin_version(current), pin_version(first), pin_version(first):
            prune_published_versions(current)
            self.assertFalse(second.exists())
            for folder in (first, third, fourth, current):
                self.assertTrue((folder / FORECAST_PAGE_NAME).is_file())
            self.assertEqual(previous_published_page(current), b"page-4")
        prune_published_versions(current)
        self.assertFalse(first.exists())

    def test_keeps_legacy_corrupt_unrecognized_and_other_source_directories(self):
        legacy = self.publish(1, managed=False)
        with pin_version(legacy):
            self.assertFalse((legacy / LEASE).exists())
        custom = self.publish(2)
        (custom / "my-notes.txt").write_text("private")
        corrupt = self.publish(3)
        (corrupt / FORECAST_PAGE_NAME).write_bytes(b"changed")
        other = self.publish(4, source=self.source.parent / "other")
        current = [self.publish(i) for i in range(5, 8)][-1]
        prune_published_versions(current)
        self.assertEqual((custom / "my-notes.txt").read_text(), "private")
        for folder in (legacy, custom, corrupt, other):
            self.assertTrue((folder / FORECAST_PAGE_NAME).exists())

    def test_unverified_current_version_cannot_trigger_pruning(self):
        oldest, _, _, current = [self.publish(i) for i in range(4)]
        (current / STATE).unlink()
        prune_published_versions(current)
        self.assertTrue(oldest.exists())

    def test_does_not_follow_version_directory_links(self):
        outside = self.publish(1, source=self.source.parent / "other")
        current = [self.publish(i) for i in range(2, 5)][-1]
        alias = self.source / ("f" * 64)
        try:
            alias.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            if os.name != "nt":
                self.skipTest(f"directory link unavailable: {error}")
            # Junctions work on Windows without symlink privileges.
            import _winapi
            _winapi.CreateJunction(str(outside), str(alias))
        prune_published_versions(current)
        self.assertEqual(alias.resolve(), outside)
        self.assertEqual((outside / FORECAST_PAGE_NAME).read_bytes(), b"page-1")


    def test_ready_callback_runs_once_only_after_publication(self):
        from unittest.mock import Mock
        from core.live_server import InputSnapshot, LiveMonitor

        now = [0]
        monitor = LiveMonitor(lambda: InputSnapshot("2026-11-24", ()), lambda: b"ready", clock=lambda: now[0])
        stop = Mock()
        stop.is_set.side_effect = [False, False, False, True]
        stop.wait.side_effect = lambda _: now.__setitem__(0, now[0] + 60)
        callback = Mock()
        monitor.run(stop, on_first_ready=callback)
        callback.assert_called_once_with()
        self.assertEqual(monitor.status()["state"], "ready")

    def test_startup_logs_resolved_local_paths(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        import server

        root = self.source.parent
        args = SimpleNamespace(data_dir=root / "run", input=root / "custom-orders", host="127.0.0.1",
                               port=0, public_prefix="/", no_open=True)
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"SHARED_DATA_ROOT":str(root / "shared"),
                                                        "PLANHUB_APP_LOG_DIR":str(root / "logs")}))
            stack.enter_context(patch.object(server, "parse_args", return_value=args))
            stack.enter_context(patch.object(server.LiveMonitor, "tick"))
            stack.enter_context(patch.object(server.ForecastServer, "serve_forever"))
            stack.enter_context(patch.object(server.signal, "signal"))
            stack.enter_context(patch.object(server.logging, "basicConfig"))
            stack.enter_context(patch.object(server.logging, "FileHandler"))
            with self.assertLogs(server.LOGGER, level="INFO") as logs:
                self.assertEqual(server.main(), 0)
        text = "\n".join(logs.output)
        for path in (args.input, root/"shared"/"订单汇总", root/"shared"/"车型信息",
                     args.data_dir/"dynamic", args.data_dir/".cache"/"excel", root/"logs"/"live_server.log"):
            self.assertIn(str(path), text)
        self.assertIn("external-imports.sqlite3", text)
        self.assertIn(FORECAST_PAGE_NAME, text)
