"""The summary is shared while HTML, caches and original inputs stay isolated."""

import hashlib
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from openpyxl import Workbook

from core import data_paths
from core.excel import WorkbookStore, load_data_workbook
from core.forecast_summary import SUMMARY_NAME
from modules.sales_forecast import HISTORY_CANDIDATES, SalesForecastModule
from tools import refresh_sales_forecast_data as refresh


class ProjectPathIsolationTests(TestCase):
    def test_absent_shared_root_does_not_restore_old_project_inputs(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"SHARED_DATA_ROOT": ""}):
            project = Path(directory) / "销量预测"
            stale = project / "output_file"
            stale.mkdir(parents=True)
            (stale / "小订及首销数据整理.xlsx").write_bytes(b"stale input")
            shared = (project.parent / "共享数据").resolve()
            self.assertEqual(data_paths.shared_data_root(project), shared)
            self.assertEqual(data_paths.orders_input_directory(project), shared / "订单汇总")
            self.assertEqual(data_paths.forecast_reference_directory(project), shared / "订单汇总")
            self.assertEqual(data_paths.model_information_directory(project), shared / "车型信息")
            self.assertFalse(shared.exists())

    def test_relative_override_is_anchored_to_project_not_process_cwd(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"SHARED_DATA_ROOT": "../数据源"}):
            project = Path(directory) / "销量预测"
            self.assertEqual(data_paths.shared_data_root(project), (project.parent / "数据源").resolve())

    def test_summary_defaults_are_shared_and_history_uses_the_same_workbook(self):
        expected = data_paths.orders_input_directory() / SUMMARY_NAME
        self.assertEqual(data_paths.forecast_summary_path(), expected)
        self.assertEqual(refresh.DEFAULT_OUTPUT, expected)
        self.assertEqual(SalesForecastModule().summary_path, expected)
        self.assertEqual(HISTORY_CANDIDATES[0], expected)
        local = data_paths.project_output_directory() / SUMMARY_NAME
        self.assertNotIn(local, HISTORY_CANDIDATES)
        self.assertFalse(data_paths.excel_cache_directory().is_relative_to(data_paths.shared_data_root()))

    def test_static_and_dynamic_reports_share_only_the_private_output_root(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"SHARED_DATA_ROOT": ""}):
            project = Path(directory) / "销量预测"
            output = data_paths.project_output_directory(project)
            static = data_paths.static_output_directory(project)
            dynamic = data_paths.dynamic_output_directory(project)
            self.assertEqual(static, output / "static")
            self.assertEqual(dynamic, output / "dynamic")
            self.assertNotEqual(static, dynamic)
            self.assertFalse(static.is_relative_to(dynamic))
            self.assertFalse(dynamic.is_relative_to(static))
            self.assertEqual(data_paths.excel_cache_directory(project), output / ".cache" / "excel")
            self.assertFalse(output.exists())

    def test_only_the_shared_summary_can_be_written_and_caches_stay_private(self):
        with TemporaryDirectory() as directory:
            shared = (Path(directory) / "共享输入").resolve()
            output = shared / "订单汇总" / SUMMARY_NAME
            with patch.dict(os.environ, {"SHARED_DATA_ROOT": str(shared)}):
                self.assertEqual(data_paths.assert_summary_output(output), output)
                local = Path(directory) / "custom-summary.xlsx"
                self.assertEqual(data_paths.assert_summary_output(local), local.resolve())
                for forbidden in (shared / "订单汇总" / "小订及首销数据整理.xlsx",
                                  shared / "车型信息" / SUMMARY_NAME,
                                  shared / "订单汇总" / "other.xlsx"):
                    with self.subTest(path=forbidden), self.assertRaisesRegex(ValueError, "只读"):
                        refresh.build_secondary(Path("unused.xlsx"), forbidden, Path("mapping.xlsx"))
                with self.assertRaisesRegex(ValueError, "只读"):
                    data_paths.assert_output_is_private(output)
                with self.assertRaisesRegex(ValueError, "只读"):
                    WorkbookStore(shared, cache_dir=shared / ".cache")
                self.assertFalse(shared.exists())

    def test_cache_and_inputs_are_separate_during_real_excel_read(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            shared = root / "共享数据"
            inputs = shared / "订单汇总"
            inputs.mkdir(parents=True)
            source = inputs / "订单.xlsx"
            book = Workbook()
            book.active.append(["车型", "数量"])
            book.active.append(["测试车型", 7])
            book.save(source)
            book.close()
            before = hashlib.sha256(source.read_bytes()).digest()
            cache = root / "销量预测" / "output_file" / ".cache" / "excel"
            with patch.dict(os.environ, {"SHARED_DATA_ROOT": str(shared)}):
                store = WorkbookStore(inputs, cache_dir=cache)
                try:
                    store.load(data_only_view=True)
                    self.assertEqual(len(store.items), 1)
                    self.assertFalse(store.load_errors)
                    self.assertEqual(store.items[0].workbook.worksheets[0].cell(2, 2).value, 7)
                finally:
                    store.close()
                with self.assertRaisesRegex(ValueError, "只读"):
                    load_data_workbook(source, inputs / ".cache")
            self.assertTrue(list(cache.glob("*.jsonl.gz")))
            self.assertFalse((inputs / ".cache").exists())
            self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), before)

    def test_missing_mapping_is_reported_without_creating_an_input(self):
        with TemporaryDirectory() as directory:
            mapping = Path(directory) / "车型基本信息.xlsx"
            with self.assertRaisesRegex(FileNotFoundError, "不会自动创建"):
                refresh.ensure_mapping(mapping, Path("source.xlsx"))
            self.assertFalse(mapping.exists())

    def test_summary_cannot_replace_a_source_even_with_custom_cli_paths(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.xlsx"
            source.write_bytes(b"input")
            with self.assertRaisesRegex(ValueError, "不能覆盖来源文件"):
                refresh.build_secondary(source, source, source)
            self.assertEqual(source.read_bytes(), b"input")
