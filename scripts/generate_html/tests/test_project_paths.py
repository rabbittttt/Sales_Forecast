"""A forecast run reads shared inputs but owns its outputs and caches."""

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

    def test_summary_defaults_are_private_and_history_excludes_shared_derivatives(self):
        expected = data_paths.project_output_directory() / SUMMARY_NAME
        self.assertEqual(refresh.DEFAULT_OUTPUT, expected)
        self.assertEqual(SalesForecastModule().summary_path, expected)
        self.assertEqual(HISTORY_CANDIDATES[0], expected)
        shared = data_paths.shared_data_root()
        derived_names = {SUMMARY_NAME, "销量预测数据汇总.xlsx", "小订及首销预测二次处理.xlsx"}
        self.assertFalse(any(path.is_relative_to(shared) and path.name in derived_names for path in HISTORY_CANDIDATES))

    def test_shared_output_and_cache_are_rejected_before_writing(self):
        with TemporaryDirectory() as directory:
            shared = Path(directory) / "共享输入"
            output = shared / "订单汇总" / SUMMARY_NAME
            with patch.dict(os.environ, {"SHARED_DATA_ROOT": str(shared)}):
                with self.assertRaisesRegex(ValueError, "只读"):
                    refresh.build_secondary(Path("unused.xlsx"), output, Path("mapping.xlsx"))
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
