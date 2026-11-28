"""Forecasts use the shared summary and leave source workbooks untouched."""
import os
from contextlib import ExitStack, contextmanager, nullcontext
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from openpyxl import Workbook

import main as generator
from core.forecast_summary import SUMMARY_NAME
from core.model_identity import FORECAST_SOURCE_PATH
from core.models import Subject


class ForecastSourceLocationTests(TestCase):
    def test_page_cannot_overwrite_its_summary_database(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"SALES_FORECAST_DATA_DIR": directory}):
            database = generator.forecast_database_path()
            database.write_bytes(b"original")
            with patch.object(generator, "refresh_sales_forecast_data", side_effect=AssertionError("unexpected refresh")):
                with self.assertRaisesRegex(ValueError, "不能覆盖"):
                    generator._build(database.parent, database)
            self.assertEqual(database.read_bytes(), b"original")

    def write_book(self, path, sheet_name):
        book = Workbook()
        book.active.title = sheet_name
        book.active.append(['指标', '数量'])
        book.active.append(['留存大定', 3])
        book.save(path)
        book.close()

    def patch_build(self, stack):
        config = dict(title='测试', chart_render_mode='generated',
                      build_manifest_mode='off', module_order=['sales_forecast'])
        stack.enter_context(patch.object(generator, 'load_config', return_value=config))
        stack.enter_context(patch.object(generator, "campaign_batch", return_value=nullcontext(1)))
        stack.enter_context(patch.object(generator, 'refresh_sales_forecast_data'))
        stack.enter_context(patch.object(generator, 'forecast_target_names', return_value=[]))
        stack.enter_context(patch('core.discovery.generation_records', return_value=[]))
        stack.enter_context(patch.object(generator, 'validate_manifest', return_value=[]))
        stack.enter_context(patch.object(generator, 'render_dashboard',
                                        side_effect=lambda manifest, templates, output:
                                        output.write_text('generated', encoding='utf-8')))

    def test_shared_summary_is_used_without_packing_source_workbooks(self):
        for disabled in (False, True):
            with self.subTest(disabled=disabled), TemporaryDirectory() as folder, ExitStack() as stack:
                root = Path(folder)
                inputs, outputs = root / 'shared', root / 'private'
                inputs.mkdir(); outputs.mkdir()
                ordinary = inputs / '订单分析.xlsx'
                self.write_book(ordinary, '鸿蒙智行')
                source = inputs / FORECAST_SOURCE_PATH.name
                private_summary = outputs / SUMMARY_NAME
                self.write_book(source, '智界 R9 2027款')
                private_summary.write_bytes(b'stale local summary must never be read')
                shared_summary = inputs / SUMMARY_NAME
                self.write_book(shared_summary, '问界 M1 2027款')
                original_bytes = {p: p.read_bytes() for p in inputs.iterdir()}
                original_bytes[private_summary] = private_summary.read_bytes()
                self.patch_build(stack)
                stack.enter_context(patch.object(generator, 'forecast_summary_path', return_value=shared_summary))
                snapshot = stack.enter_context(patch.object(generator, 'current_forecast_snapshot', return_value=nullcontext({
                    'subjects': [Subject('group_1', '鸿蒙智行', 'group').to_dict()],
                    'load_errors': [], 'source_count': 1})))
                if not disabled:
                    stack.enter_context(patch.object(generator.WorkbookStore, 'load',
                        side_effect=AssertionError('已发布批次不能重读原始 Excel')))
                observed = []

                def observe(store, subject):
                    observed.append((subject.name, [item.path.name for item in store.items]))

                stack.enter_context(patch.object(generator, 'MODULES', [
                    SimpleNamespace(id='sales_forecast', label='销量预测', build=observe),
                ]))
                manifest, _ = generator.build(inputs, outputs / 'dashboard.html',
                                              disable_sales_forecast=disabled)
                self.assertEqual(observed, [] if disabled else [('鸿蒙智行', [])])
                self.assertEqual([s['name'] for s in manifest['subjects']], ['鸿蒙智行'])
                if disabled:
                    generator.forecast_target_names.assert_called_once_with(shared_summary)
                    snapshot.assert_not_called()
                else:
                    generator.forecast_target_names.assert_not_called()
                    snapshot.assert_called_once_with(inputs, shared_summary, '', reuse_only=False)
                self.assertEqual(generator.MODULES[0].summary_path, shared_summary)
                self.assertEqual(manifest['raw_files'], [])
                self.assertEqual(manifest['raw_blocks'], {})
                self.assertFalse((outputs / 'forecast_assets').exists())
                self.assertEqual({p: p.read_bytes() for p in inputs.iterdir()},
                                 {p: data for p, data in original_bytes.items() if p.parent == inputs})
                self.assertFalse((inputs / '.cache').exists())
                self.assertEqual(private_summary.read_bytes(), original_bytes[private_summary])

    def test_auxiliary_workbooks_alone_do_not_count_as_analysis_inputs(self):
        with TemporaryDirectory() as folder, ExitStack() as stack:
            root = Path(folder)
            self.write_book(root / FORECAST_SOURCE_PATH.name, '智界 R9 2027款')
            self.write_book(root / SUMMARY_NAME, '问界 M1 2027款')
            self.patch_build(stack)
            stack.enter_context(patch.object(generator, 'current_forecast_snapshot', return_value=nullcontext({
                'subjects': [], 'load_errors': [], 'source_count': 0})))
            with self.assertRaisesRegex(RuntimeError, '没有成功读取任何Excel'):
                generator.build(root, root / 'dashboard.html')

    def test_missing_database_in_reuse_mode_keeps_published_page(self):
        with TemporaryDirectory() as folder, ExitStack() as stack:
            root = Path(folder)
            output = root / 'dashboard.html'
            output.write_text('previous batch', encoding='utf-8')
            stack.enter_context(patch.object(generator, 'campaign_batch', return_value=nullcontext(1)))
            stack.enter_context(patch.object(generator, 'forecast_database_path', return_value=root / 'missing.sqlite3'))
            stack.enter_context(patch('tools.refresh_sales_forecast_data.resolve_source_path', return_value=root))
            stack.enter_context(patch('tools.refresh_sales_forecast_data.forecast_database_signature', return_value='batch'))
            with self.assertRaises(generator.ForecastSummaryNotCurrent):
                generator.build(root, output, reuse_summary_only=True)
            self.assertEqual(output.read_text(encoding='utf-8'), 'previous batch')

    def test_sqlite_snapshot_takes_publication_lock_only_while_acquiring_batch(self):
        events = []

        @contextmanager
        def publication_lock(path):
            events.append('lock')
            try:
                yield
            finally:
                events.append('unlock')

        def open_batch(*args, **kwargs):
            events.append('snapshot')
            return nullcontext(SimpleNamespace(metadata={'subjects': []}))

        with TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            prefix = 'tools.refresh_sales_forecast_data.'
            stack.enter_context(patch(prefix + 'publication_lock', publication_lock))
            stack.enter_context(patch(prefix + 'resolve_source_path', return_value=root))
            stack.enter_context(patch(prefix + 'forecast_database_signature',
                                      side_effect=lambda *args: events.append('signature') or 'batch'))
            stack.enter_context(patch.object(generator, 'open_workbook', side_effect=open_batch))
            stack.enter_context(patch.object(generator, 'summary_scope', return_value=nullcontext({'visible': True})))
            stack.enter_context(patch(prefix + 'audit_final_forecast', side_effect=lambda *args: events.append('audit')))
            with generator.current_forecast_snapshot(root, root / 'summary.xlsx', '', reuse_only=True):
                events.append('render')
        self.assertEqual(events, ['lock', 'signature', 'snapshot', 'unlock', 'audit', 'render'])
