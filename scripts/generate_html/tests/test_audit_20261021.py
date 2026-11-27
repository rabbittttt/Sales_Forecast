"""A retired reservation curve cannot supply actual or forecast daily quantities."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from openpyxl import Workbook

from modules.sales_forecast import _read_small_order_history


class RetiredReservationCurveTests(TestCase):
    def raw_references(self, curve, total=100):
        with TemporaryDirectory() as folder:
            path = Path(folder) / 'source.xlsx'
            book = Workbook()
            book.active.title = '车型汇总'
            book.active.append(['代际名', '小订开始日期', '小订结束日期', '小订天数', '总小订'])
            book.active.append(['测试车', '2026-01-01', '2026-01-05', 5, total])
            sheet = book.create_sheet('小订进度')
            sheet.append(['代际名', *[f'D{i+1}' for i in range(len(curve))]])
            sheet.append(['测试车', *curve])
            book.save(path)
            book.close()
            with patch('modules.sales_forecast._read_model_mapping', return_value={}), \
                 patch('modules.sales_forecast._read_model_master', return_value={}):
                return _read_small_order_history(path)[1]

    def test_legacy_curve_is_ignored_but_maintained_total_survives(self):
        for curve in ([.2, .4, .6, .8, 1], [.2, None, .6, .8, 1], [0, .2, .6, .8, 1]):
            with self.subTest(curve=curve):
                item, = self.raw_references(curve)
                self.assertEqual(item['total'], 100)
                self.assertFalse(item['daily_actual'])
                self.assertEqual(item['daily_orders'], [])
                self.assertEqual(item['small_progress'], [])
                self.assertEqual(item['dates'], [])
                self.assertIsNone(item['d1_share'])
                self.assertNotIn('standard_progress', item)

    def test_zero_is_a_maintained_total_but_missing_and_invalid_are_unknown(self):
        curve = [.2, .4, .6, .8, 1]
        item, = self.raw_references(curve, total=0)
        self.assertEqual(item['total'], 0)
        self.assertIsNone(item['d1_share'])
        self.assertFalse(item['daily_actual'])
        self.assertEqual(item['daily_orders'], [])
        for value in (None, '未知', -1):
            with self.subTest(value=value):
                self.assertEqual(self.raw_references(curve, total=value), [])
