"""Shared summaries stay raw-only; local stale copies are not read."""
import base64
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from openpyxl import Workbook

import main as generator
from core.forecast_summary import SUMMARY_NAME
from core.model_identity import FORECAST_SOURCE_PATH


class ForecastSourceLocationTests(TestCase):
    def write_book(self, path, sheet_name):
        book = Workbook()
        book.active.title = sheet_name
        book.active.append(['指标', '数量'])
        book.active.append(['留存大定', 3])
        book.save(path)
        book.close()

    def patch_build(self, stack):
        config = dict(title='测试', chart_render_mode='generated',
                      build_manifest_mode='off', module_order=['sales_forecast', 'raw'])
        stack.enter_context(patch.object(generator, 'load_config', return_value=config))
        stack.enter_context(patch.object(generator, 'refresh_sales_forecast_data'))
        stack.enter_context(patch.object(generator, 'forecast_target_names', return_value=[]))
        stack.enter_context(patch('core.discovery.generation_records', return_value=[]))
        stack.enter_context(patch.object(generator, 'validate_manifest', return_value=[]))
        stack.enter_context(patch.object(generator, 'render_dashboard',
                                        side_effect=lambda manifest, templates, output:
                                        output.write_text('generated', encoding='utf-8')))

    def test_shared_summary_is_exported_and_private_stale_copy_is_ignored(self):
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
                observed = []

                def observe(store, subject):
                    observed.append((subject.name, [item.path.name for item in store.items]))

                stack.enter_context(patch.object(generator, 'MODULES', [
                    SimpleNamespace(id='sales_forecast', label='销量预测', build=observe),
                ]))
                manifest, _ = generator.build(inputs, outputs / 'dashboard.html',
                                              disable_sales_forecast=disabled)
                self.assertEqual(observed, [] if disabled else [('鸿蒙智行', [ordinary.name])])
                self.assertEqual([s['name'] for s in manifest['subjects']], ['鸿蒙智行'])
                raw_files = manifest['raw_files']
                self.assertCountEqual([file['name'] for file in raw_files],
                                      [ordinary.name, source.name, private_summary.name])
                for source_path, sheet in ((source, '智界 R9 2027款'), (shared_summary, '问界 M1 2027款')):
                    raw = next(file for file in raw_files if file['name'] == source_path.name)
                    self.assertEqual([s['source_sheet'] for s in raw['sheets']], [sheet])
                    self.assertEqual(base64.b64decode(manifest['raw_blocks'][raw['workbook_key']]),
                                     original_bytes[source_path])
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
            with self.assertRaisesRegex(RuntimeError, '没有成功读取任何Excel'):
                generator.build(root, root / 'dashboard.html')
