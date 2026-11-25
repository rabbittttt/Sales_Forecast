from datetime import date
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from openpyxl import Workbook

from core.forecast_headers import workbook_header_index
from modules import sales_forecast as forecast
from tools.refresh_sales_forecast_data import read_summary


class SecondaryLaunchCutoffTests(TestCase):
    def test_explicit_child_cutoff_wins_in_either_column_order(self):
        explicit, legacy = "首销期结束日期", "小转大结束日期"
        for columns in [(explicit, legacy), (legacy, explicit)]:
            with self.subTest(columns=columns):
                book = Workbook()
                sheet = book.active
                sheet.title = "车型汇总"
                sheet.append(["代际名", "二级代际名", "首销开始日期", "首销期天数",
                              "总小订", "总小转大", "总大定", "总直接大定", *columns])
                start = date(2025, 8, 1)
                early, late = date(2025, 8, 2), date(2025, 8, 5)
                cases = [
                    ("甲车 Ultra版", early, late, 5),
                    ("甲车 Pro版", None, late, 3),
                    ("甲车 Max版", None, None, 3),
                ]
                for model, child_end, proxy_end, days in cases:
                    raw = {explicit: child_end, legacy: proxy_end}
                    sheet.append(["甲车", model, start, days, 10, 2, 3, 1,
                                  *(raw[name] for name in columns)])

                summary = read_summary(book, workbook_header_index(book))
                self.assertEqual([r["小转大结束日期"] for r in summary], [early, late, None])
                with patch.object(forecast, "input_path", return_value=Path(__file__)), \
                     patch.object(forecast, "open_input", return_value=book), \
                     patch.object(forecast, "_read_model_mapping", return_value={}):
                    _, windows = forecast._read_stage_windows()

                cutoffs = {r["secondary_generation"]: r["end_date"] for r in windows.values()}
                self.assertEqual(cutoffs, {"甲车 Ultra版": "2025-08-02",
                                           "甲车 Pro版": "2025-08-05",
                                           "甲车 Max版": "2025-08-03"})
