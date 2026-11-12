"""Independent forecast entry point and legacy source asset helpers."""
from __future__ import annotations

import base64
import copy
import gzip
import json
import re
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock, patch

import main as generator
from core.models import Dashboard, Subject
from core.renderer import (
    FORECAST_PAGE_NAME, b64gzip, render_dashboard, forecast_manifest,
    write_raw_block_assets,
)


def embedded(output):
    text = output.read_text(encoding="utf-8")
    bootstrap = re.search(r'window.DASHBOARD_DATA_B64="([^"]+)"', text)[1]
    manifest = json.loads(gzip.decompress(base64.b64decode(bootstrap)))
    boards = json.loads(re.search(r'window.DASHBOARD_BLOCKS_B64=(.*?);</script>', text)[1])
    raw = json.loads(re.search(r'window.DASHBOARD_RAW_B64=(.*?);</script>', text)[1])
    return manifest, boards, raw


class StandaloneForecastTests(TestCase):
    def fixture(self):
        actual = {"model": "智界 R7", "days": [{"gross": 0}, {"gross": None}]}
        prediction = {"subject_id": "group", "module_id": "sales_forecast",
                      "views": {}, "actuals": [actual], "shared_actual": actual,
                      "targets": [{"name": "智界 R7"}, {"name": "问界 M9"}],
                      "history": [{"model": "历史参考", "conversion": .2}]}
        raw = {"0|0": b64gzip(json.dumps({"rows": [["数量"], [0], [None]]})),
               "0|xlsx": base64.b64encode(b"original XLSX bytes\x00\xff").decode()}
        return {
            "meta": {"title": "订单分析", "generated_at": "2026-11-03T05:20:00"},
            "config": {"module_order": ["overview", "sales_forecast", "raw"],
                       "module_labels": {"overview": "订单总览", "sales_forecast": "销量预测", "raw": "底表中心"}},
            "subjects": [{"id": "group", "type": "group", "modules": ["overview", "sales_forecast", "raw"]},
                         {"id": "r7", "type": "generation", "modules": ["overview", "raw"]}],
            "dashboards": {"group|sales_forecast": prediction, "r7|overview": {"views": {}}},
            "raw_files": [{"name": "原始数据.xlsx", "workbook_key": "0|xlsx",
                           "sheets": [{"name": "展示块", "source_sheet": "原Sheet"}]}],
            "raw_blocks": raw,
            "chart_assets": {"order-only-chart": "asset"},
        }

    def test_manifest_preserves_business_identity_without_order_links_or_mutation(self):
        original = self.fixture()
        original.update(order_page="分析.html", forecast_page=FORECAST_PAGE_NAME,
                        forecast_legacy_page="分析.html")
        before = copy.deepcopy(original)
        forecast = forecast_manifest(original)
        self.assertEqual(original, before)
        self.assertEqual(forecast["app_mode"], "forecast")
        self.assertIs(forecast["dashboards"]["group|sales_forecast"], original["dashboards"]["group|sales_forecast"])
        self.assertEqual(list(forecast["dashboards"]), ["group|sales_forecast"])
        self.assertEqual(forecast["subjects"][0]["modules"], ["sales_forecast"])
        self.assertEqual(forecast["subjects"][1]["modules"], [])
        self.assertEqual(forecast["config"]["module_order"], ["sales_forecast"])
        for key in ("order_page", "forecast_legacy_page", "forecast_page"):
            self.assertNotIn(key, forecast)
        self.assertEqual(forecast["meta"]["generated_at"], original["meta"]["generated_at"])
        self.assertEqual(forecast["chart_assets"], {})
        self.assertEqual(forecast["raw_blocks"], {})
        self.assertEqual(forecast["raw_files"], [])

    def test_emitted_payloads_preserve_prediction_without_raw_assets(self):
        original = self.fixture()
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / FORECAST_PAGE_NAME
            forecast = forecast_manifest(original)
            render_dashboard(forecast, generator.ROOT / "templates", output)
            html = output.read_text(encoding="utf-8")
            expected_icon = "data:image/svg+xml;base64," + base64.b64encode(
                (generator.ROOT / "templates" / "forecast-icon.svg").read_bytes()).decode("ascii")
            header_icon = re.search(r'class="brand-mark" src="([^"]+)"', html)[1]
            tab_icon = re.search(r'<link rel="icon"[^>]+href="([^"]+)"', html)[1]
            self.assertEqual(header_icon, expected_icon)
            self.assertEqual(tab_icon, expected_icon)
            meta, boards, raw = embedded(output)
            self.assertEqual(set(boards), {"group|sales_forecast"})
            self.assertEqual(raw, {})
            self.assertEqual(meta["raw_files"], [])
            self.assertEqual(meta["raw_block_urls"], {})
            self.assertFalse((root / "forecast_assets").exists())
            self.assertFalse((root / "分析.html").exists())
            for key in ("order_page", "forecast_legacy_page", "forecast_page"):
                self.assertNotIn(key, meta)

    def test_resources_are_immutable_and_new_build_does_not_invalidate_old_page(self):
        with TemporaryDirectory() as directory:
            output = Path(directory) / FORECAST_PAGE_NAME
            first = write_raw_block_assets({"0|0": "old value", "0|xlsx": "snapshot"}, output)
            old_paths = {key: (output.parent / url) for key, url in first.items()}
            old_bytes = {key: path.read_bytes() for key, path in old_paths.items()}
            with patch.object(Path, "write_text", side_effect=AssertionError("existing hash was rewritten")):
                self.assertEqual(write_raw_block_assets({"0|0": "old value", "0|xlsx": "snapshot"}, output), first)
            second = write_raw_block_assets({"0|0": "new value", "0|xlsx": "snapshot"}, output)
            self.assertNotEqual(first["0|0"], second["0|0"])
            self.assertEqual(first["0|xlsx"], second["0|xlsx"])
            self.assertEqual({key: path.read_bytes() for key, path in old_paths.items()}, old_bytes)

    def test_corrupt_hash_resource_is_reported_and_never_silently_overwritten(self):
        with TemporaryDirectory() as directory:
            output = Path(directory) / FORECAST_PAGE_NAME
            urls = write_raw_block_assets({"0|0": "data"}, output)
            path = output.parent / urls["0|0"]
            path.write_bytes(b"damaged")
            with self.assertRaisesRegex(ValueError, "资源校验失败"):
                write_raw_block_assets({"0|0": "data"}, output)
            self.assertEqual(path.read_bytes(), b"damaged")

    def test_disabled_or_unavailable_prediction_does_not_link_stale_page(self):
        for disabled, absent in [(True, False), (False, True)]:
            with self.subTest(disabled=disabled, absent=absent):
                original = self.fixture()
                if absent:
                    del original["dashboards"]["group|sales_forecast"]
                forecast = forecast_manifest(original, forecast_disabled=disabled)
                self.assertEqual(forecast["forecast_disabled"], disabled)
                self.assertEqual(forecast["dashboards"], {})
                self.assertEqual(forecast["raw_files"], [])
                self.assertEqual(forecast["raw_block_urls"], {})

    def test_main_build_emits_only_private_forecast_and_disables_cleanly(self):
        for disabled in (False, True):
            with self.subTest(disabled=disabled), TemporaryDirectory() as directory, ExitStack() as stack:
                root = Path(directory)
                subjects = [Subject("group", "鸿蒙智行", "group"), Subject("model", "智界 R7", "generation")]
                config = {"title": "订单分析", "chart_render_mode": "generated", "build_manifest_mode": "off",
                          "refresh_sales_forecast_data_before_build": True,
                          "module_order": ["sales_forecast", "raw"]}
                store = Mock(items=[Mock()], load_errors=[], multi_source_groups={}, chart_assets={})
                store.resolve_dashboard_sources.side_effect = lambda board: board
                modules = [Mock(id=name, label=name) for name in ("sales_forecast",)]
                for module in modules:
                    module.build.side_effect = lambda store, subject, mid=module.id: (
                        Dashboard(mid, subject.id, {}) if subject.type == "group" else None)
                stack.enter_context(patch.object(generator, "load_config", side_effect=lambda _: dict(config)))
                refresh = stack.enter_context(patch.object(generator, "refresh_sales_forecast_data"))
                stack.enter_context(patch.object(generator, "WorkbookStore", return_value=store))
                stack.enter_context(patch.object(generator, "discover_subjects", return_value=subjects))
                stack.enter_context(patch.object(generator, "forecast_target_names", return_value=[]))
                stack.enter_context(patch.object(generator, "MODULES", modules))
                stack.enter_context(patch.object(generator, "raw_tables", side_effect=AssertionError("forecast must not pack raw workbooks")))
                stack.enter_context(patch.object(generator, "add_kpi_comparisons"))
                stack.enter_context(patch.object(generator, "validate_manifest", return_value=[]))
                shared_summary = root / "shared" / generator.SUMMARY_NAME
                stack.enter_context(patch.object(generator, "forecast_summary_path", return_value=shared_summary))
                output = root / FORECAST_PAGE_NAME
                (root / FORECAST_PAGE_NAME).write_text("stale previous forecast", encoding="utf-8")
                manifest, _ = generator.build(root, output, disable_sales_forecast=disabled)
                self.assertEqual(refresh.call_count, 1)
                self.assertEqual(refresh.call_args.args[0]["refresh_sales_forecast_data_before_build"], not disabled)
                self.assertEqual(refresh.call_args.args[1], root)
                self.assertEqual(modules[0].summary_path, shared_summary)
                self.assertEqual(modules[0].build.call_count, 0 if disabled else len(subjects))
                forecast_meta, forecast_boards, forecast_raw = embedded(output)
                self.assertEqual(forecast_meta["app_mode"], "forecast")
                self.assertEqual(bool(forecast_boards), not disabled)
                self.assertEqual(forecast_raw, {})
                self.assertEqual(forecast_meta["forecast_disabled"], disabled)
                self.assertFalse((root / "forecast_assets").exists())
                self.assertEqual("group|sales_forecast" in manifest["dashboards"], not disabled)
                self.assertEqual(list(root.glob("*.html")), [output])
                self.assertNotIn("order_page", forecast_meta)
                self.assertNotIn("forecast_legacy_page", forecast_meta)
