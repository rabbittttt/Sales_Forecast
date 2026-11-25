from datetime import date, timedelta
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from tools.refresh_sales_forecast_data import forecast_weekly_orders


class SecondaryWeeklyStageTests(TestCase):
    def test_midweek_child_cutoffs_split_resolved_orders_even_with_same_name_steady_target(self):
        parent = "测试车型 2026款"
        early, late = parent + " 标准版", parent + " 长续航版"
        monday = date(2026, 3, 2)
        wednesday, friday, sunday = [monday + timedelta(days=i) for i in (2, 4, 6)]
        week = "26WK10"
        data = {
            "targets": [
                {"name": model, "primary_generation": parent, "secondary_generation": model,
                 "launch_date": monday.isoformat(), "end_date": finish.isoformat()}
                for model, finish in [(early, wednesday), (late, friday)]
            ],
            "steady_targets": [
                {"name": early, "launch_date": monday.isoformat(), "end_date": sunday.isoformat()}
            ],
            "mix_weekly": {
                (model, week, field): (9999, "整周合计")
                for model in (early, late) for field in ("gross", "net", "lock")
            },
        }
        resolved = [
            {"订单分析代际名": model, "日期": monday + timedelta(days=i),
             "订单阶段": "首销" if i < launch_days else "平销",
             "大定": 10 * (i + 1), "留存大定": 9 * (i + 1), "交车锁单": 2 * (i + 1)}
            for model, launch_days in ((early, 3), (late, 5)) for i in range(7)
        ]
        dashboard = SimpleNamespace(views={"week": {"pages": {"预测方案": {"workspace": {"data": data}}}}})
        with patch("modules.sales_forecast._read_model_mapping", return_value={}):
            rows = forecast_weekly_orders(None, dashboard, sunday + timedelta(days=1), resolved_daily=resolved)

        self.assertEqual(len(rows), 4)
        self.assertEqual({r[1] for r in rows}, {week})
        self.assertEqual(
            {(r[0], r[2]): (r[3].date(), r[4].date(), *r[5:8]) for r in rows},
            {
                (early, "首销"): (monday, wednesday, 60, 54, 12),
                (early, "平销"): (wednesday + timedelta(days=1), sunday, 220, 198, 44),
                (late, "首销"): (monday, friday, 150, 135, 30),
                (late, "平销"): (friday + timedelta(days=1), sunday, 130, 117, 26),
            },
        )

    def parent_weeks(self, model, campaigns, weeks):
        editions = [
            {"name": model + " " + name, "primary_generation": model,
             "secondary_generation": model + " " + name,
             "launch_date": start.isoformat(), "end_date": finish.isoformat()}
            for name, start, finish in campaigns
        ]
        data = {
            "targets": editions, "mix_weekly": {},
            "steady_targets": [{"name": model, "launch_date": editions[0]["launch_date"],
                                "end_date": editions[-1]["end_date"]}],
        }
        resolved = []
        for monday in weeks:
            for i in range(7):
                day = monday + timedelta(days=i)
                launch = any(start <= day <= end for _, start, end in campaigns)
                resolved.append({"订单分析代际名": model, "日期": day, "订单阶段": "首销" if launch else "平销",
                                 "大定": 10 * (i + 1), "留存大定": 9 * (i + 1), "交车锁单": 2 * (i + 1)})
        dashboard = SimpleNamespace(views={"week": {"pages": {"预测方案": {"workspace": {"data": data}}}}})
        with patch("modules.sales_forecast._read_model_mapping", return_value={}):
            rows = forecast_weekly_orders(None, dashboard, max(weeks) + timedelta(days=7),
                                          resolved_daily=resolved)
        return [(r[2], r[3].date(), r[4].date(), *r[5:8]) for r in rows]

    def test_parent_july_gap_and_august_relaunch(self):
        campaigns = [
            ("舒享版", date(2024, 5, 31), date(2024, 6, 30)),
            ("尊享版", date(2024, 8, 26), date(2024, 10, 8)),
        ]
        rows = self.parent_weeks("样例车型 2024款", campaigns,
                                 [date(2024, 7, 1), date(2024, 8, 26), date(2024, 10, 7)])
        self.assertCountEqual(rows, [
            ("平销", date(2024, 7, 1), date(2024, 7, 7), 280, 252, 56),
            ("首销", date(2024, 8, 26), date(2024, 9, 1), 280, 252, 56),
            ("首销", date(2024, 10, 7), date(2024, 10, 8), 30, 27, 6),
            ("平销", date(2024, 10, 9), date(2024, 10, 13), 250, 225, 50),
        ])

    def test_midweek_parent_relaunch_preserves_gap_days_in_same_week(self):
        campaigns = [
            ("标准版", date(2026, 2, 1), date(2026, 2, 15)),
            ("长续航版", date(2026, 3, 5), date(2026, 3, 31)),
        ]
        rows = self.parent_weeks("测试车型 2026款", campaigns, [date(2026, 3, 2)])
        self.assertCountEqual(rows, [
            ("平销", date(2026, 3, 2), date(2026, 3, 4), 60, 54, 12),
            ("首销", date(2026, 3, 5), date(2026, 3, 8), 220, 198, 44),
        ])
