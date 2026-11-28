import os
from argparse import Namespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from openpyxl import Workbook

from core.campaign_source import campaign_batch
from core.data_paths import forecast_database_path, forecast_summary_path
from core.summary_sqlite import open_workbook
from tests import test_forecast_source_backfill_e2e as fixtures
from tools import refresh_sales_forecast_data as refresh


class DatabaseRefreshTests(TestCase):
    def setUp(self):
        root = Path(self.enterContext(TemporaryDirectory())).resolve()
        self.enterContext(patch.dict(os.environ, {"SALES_FORECAST_DATA_DIR": str(root / "private")}))
        output = root / "orders" / forecast_summary_path().name
        self.enterContext(patch.object(refresh, "forecast_summary_path", return_value=output))
        fixture = fixtures.SourceBackfillEndToEndTests()
        self.addCleanup(fixture.doCleanups)
        book = fixture.build()
        self.custom = book._test_path
        source = self.custom.parent / "小订及首销数据整理.xlsx"
        self.args = Namespace(source=source, mapping=source, output=output,
                              orders=source.parent / "orders", as_of_date="2026-09-05", force=False)
        self.database = forecast_database_path()
        self.enterContext(campaign_batch(source))

    def refresh(self):
        self.assertEqual(refresh.refresh_selected(self.args), 0)

    def test_custom_export_preserves_private_database_and_shared_build_reuses_both(self):
        self.assertFalse(self.database.exists())
        chart = Workbook()
        chart.active.title = "选配图表"
        chart.active.append(["问界 R123"])
        chart.save(self.args.orders / "其他订单.xlsx")
        chart.close()
        self.refresh()
        with open_workbook(self.database, source_path=self.args.output) as db:
            self.assertEqual(db.metadata["source_count"], 3)
            self.assertIn("问界 R123", [subject["name"] for subject in db.metadata["subjects"]])
        with patch.object(refresh, "load_workbook", side_effect=AssertionError("unnecessary XLSX parsing")), \
             patch.object(refresh, "build_secondary", side_effect=AssertionError("unnecessary refresh")):
            self.refresh()

    def test_index_only_changes_refresh_metadata_without_recalculating_workbook(self):
        self.refresh()
        excel = self.args.output.read_bytes()
        chart = Workbook()
        chart.active.title = "问界 R234by天"
        chart.save(self.args.orders / "SKU.xlsx")
        chart.close()
        with patch.object(refresh, "build_secondary", side_effect=AssertionError("order metrics unchanged")):
            self.refresh()
            self.database.unlink()
            self.refresh()
        self.assertEqual(self.args.output.read_bytes(), excel)
        with open_workbook(self.database, source_path=self.args.output) as db:
            self.assertIn("问界 R234", [subject["name"] for subject in db.metadata["subjects"]])

    def test_failed_second_rename_restores_previous_excel_and_database(self):
        self.refresh()
        excel = self.args.output.read_bytes()
        original = os.replace

        def replace(source, target):
            if target == self.database:
                raise PermissionError("模拟数据库占用")
            return original(source, target)

        self.args.force = True
        with patch.object(os, "replace", side_effect=replace), self.assertRaises(PermissionError):
            self.refresh()
        self.assertEqual(self.args.output.read_bytes(), excel)
        with open_workbook(self.database, source_path=self.args.output):
            pass
        self.assertEqual(list(self.args.output.parent.iterdir()), [self.args.output])

    def test_managed_database_cannot_share_a_source_or_excel_output_path(self):
        private = self.database
        private.parent.mkdir(parents=True, exist_ok=True)
        private.write_bytes(b"original")
        for selected in (dict(source=private), dict(mapping=private), dict(output=private)):
            values = vars(self.args) | selected
            args = Namespace(**values)
            with self.subTest(fields=list(selected)):
                with self.assertRaisesRegex(ValueError, "不能覆盖"):
                    refresh.reuse_summary(args)
                with self.assertRaisesRegex(ValueError, "不能覆盖"):
                    refresh.build_secondary(args.source, args.output, args.mapping, args.orders, args.as_of_date)
        self.assertEqual(private.read_bytes(), b"original")

    def test_database_audit_error_repairs_from_the_current_excel(self):
        self.refresh()
        audit = refresh.audit_final_forecast
        def audit_or_fail(book, day):
            if hasattr(book, "metadata"):
                raise ValueError("unreadable database cell")
            return audit(book, day)
        with patch.object(refresh, "audit_final_forecast", side_effect=audit_or_fail) as called, \
             patch.object(refresh, "build_secondary", side_effect=AssertionError("Excel is valid")):
            self.refresh()
        self.assertEqual(called.call_count, 2)
