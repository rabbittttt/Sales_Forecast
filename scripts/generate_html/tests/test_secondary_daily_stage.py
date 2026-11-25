from datetime import date
from unittest import TestCase

from core.forecast_summary import DAILY_SHEET, GROSS_DAILY_SHEET, daily_stage_targets, daily_launch_stage, resolved_daily_rows, table_records
from tests import test_public_forecast_tables as public_tests
from tools.refresh_sales_forecast_data import normalize_public_names, write_rows


PARENT = "测试车型 2026款"
EARLY = PARENT + " 标准版"
LATE = PARENT + " 长续航版"


def campaign(name, start, end):
    return {"name": name, "primary_generation": PARENT, "secondary_generation": name,
            "launch_date": start, "end_date": end}


class SecondaryDailyStageTests(TestCase):
    def test_export_daily_history_and_parent_mix_use_their_own_window(self):
        early = campaign(EARLY, "2026-03-01", "2026-03-03")
        early.update(small_start_date="2026-03-01", small_end_date="2026-03-03")
        late = campaign(LATE, "2026-03-04", "2026-03-06")
        metadata = {"targets": [early, late]}

        def customize(data):
            data["targets"].extend([early, late])
            data["steady_targets"] = [{"name": PARENT, "launch_date": "2026-03-01", "end_date": "2026-03-06"}]
            data["history"].extend([
                {"model": EARLY, "generation": PARENT, "launch_date": "2026-03-01", "daily_orders": [3, 6, 9, 99]},
                {"model": LATE, "generation": PARENT, "launch_date": "2026-03-04", "daily_orders": [24]},
            ])
            data["small_order_history"].append({
                "model": EARLY, "generation": PARENT, "small_start_date": "2026-03-01", "small_end_date": "2026-03-03",
                "daily_actual": True, "dates": ["2026-03-01", "2026-03-02", "2026-03-03"], "daily_orders": [5, 2, 0]})
            data["mix_daily"] = {
                (PARENT, "2026-03-04", "gross"): (80, "大定选配比例.xlsx"),
                (EARLY, "2026-03-04", "gross"): (11, "大定选配比例.xlsx"),
            }

        book = public_tests.PublicForecastTablesTests().make_public(customize=customize, as_of=date(2026, 3, 31))
        self.addCleanup(book.close)

        def emit(name, headers, rows, percent_headers=None):
            del book[name]
            write_rows(book, name, headers, rows, "PublicEdition", percent_headers)

        normalize_public_names(book, metadata, emit)
        rows = [r for r in table_records(book, DAILY_SHEET) if r["代际名"] == PARENT]
        indexed = {(r["二级代际名"], r["日期"].date().day): r for r in rows}
        self.assertEqual(len(rows), len(indexed))
        last = indexed[EARLY, 3]
        self.assertEqual((last["订单阶段"], last["小订"], last["大定"]), ("小订/首销", 0, 9))
        for edition, stage, gross in ((EARLY, "平销", 11), (LATE, "首销", 24), (None, "首销", 80)):
            with self.subTest(edition=edition):
                row = indexed[edition, 4]
                self.assertEqual((row["订单阶段"], row["大定"]), (stage, gross))
        self.assertIn("大定选配比例.xlsx", indexed[EARLY, 4]["字段来源"])

    def test_profile_reference_cannot_relabel_parent_and_overwrite_an_edition(self):
        early = campaign(EARLY, "2026-03-01", "2026-03-03")
        data = {
            "targets": [early],
            "steady_targets": [
                {"name": PARENT, "launch_date": "2026-03-01", "end_date": "2026-03-12"},
                {"name": EARLY, "launch_date": "2026-03-01", "end_date": "2026-03-12"},
            ],
            "history": [{"model": EARLY, "generation": PARENT, "launch_date": "2026-03-01"}],
            "reference_daily": {GROSS_DAILY_SHEET: {EARLY: [10, 10, 10, 99]}},
            "mix_daily": {(EARLY, "2026-03-04", "net"): (7, "大定选配比例.xlsx")},
        }
        candidates = [{"订单分析代际名": PARENT, "历史传播名": EARLY, "日期": "2026-03-04",
                       "来源类型": "首销订单", "留存大定": 80}]
        rows = resolved_daily_rows(candidates, data, [], "整理表.xlsx", date(2026, 3, 31))
        by_model = {r["订单分析代际名"]: r for r in rows if r["日期"].date().day == 4}
        self.assertEqual(set(by_model), {EARLY, PARENT})
        self.assertEqual((by_model[PARENT]["历史传播名"], by_model[PARENT]["留存大定"]), (PARENT, 80))
        self.assertEqual((by_model[EARLY]["订单阶段"], by_model[EARLY]["留存大定"]), ("平销", 7))
        self.assertIsNone(by_model[EARLY].get("大定"))

    def test_parent_july_gap_uses_mix_and_all_launch_boundaries_stay_inclusive(self):
        parent = "样例车型 2024款"
        children = [{"name": parent + suffix, "primary_generation": parent, "secondary_generation": parent + suffix,
                     "launch_date": start, "end_date": end} for suffix, start, end in (
                         (" 舒享版", "2024-05-20", "2024-06-01"), (" 尊享版", "2024-08-01", "2024-08-15"))]
        target = {"name": parent, "aggregate": True, "launch_date": "2024-05-20", "end_date": "2024-08-15"}
        expected = {"2024-05-19": "首销前", "2024-05-20": "首销", "2024-06-01": "首销", "2024-06-02": "平销",
                    "2024-07-15": "平销", "2024-08-01": "首销", "2024-08-15": "首销", "2024-08-16": "平销"}
        data = {"targets": children, "steady_targets": [target],
                "mix_daily": {(parent, day, "net"): (10, "大定选配比例.xlsx") for day in expected}}
        candidates = [{"订单分析代际名": parent, "来源类型": "首销订单", "日期": "2024-07-15",
                       "留存大定": 99, "直接大定": 82}]
        rows = resolved_daily_rows(candidates, data, [], "整理表.xlsx", date(2024, 9, 1))
        self.assertEqual([(r["订单分析代际名"], r["日期"].date().isoformat(), r["订单阶段"]) for r in rows],
                         [(parent, day, stage) for day, stage in expected.items()])
        july = next(r for r in rows if r["日期"].month == 7)
        self.assertEqual(july["留存大定"], 10)
        self.assertIsNone(july.get("直接大定"))
        self.assertIn("大定选配比例", july["字段来源"])
        self.assertEqual(target["end_date"], "2024-08-15")

    def test_parent_independent_launch_and_incomplete_edition_windows(self):
        early = campaign(EARLY, "2026-03-01", "2026-03-03")
        late = campaign(LATE, "2026-03-10", "2026-03-12")
        aggregate = {"name": PARENT, "aggregate": True, "launch_date": "2026-03-01", "end_date": "2026-03-12"}
        own = {"name": PARENT, "primary_generation": PARENT, "launch_date": "2026-03-04", "end_date": "2026-03-08"}
        for primary_data in ({"targets": [early, late, own]},
                             {"targets": [early, late], "history": [{**own, "model": PARENT}]}):
            with self.subTest(primary_data=primary_data):
                target = daily_stage_targets({**primary_data, "steady_targets": [aggregate]})[PARENT]
                self.assertEqual(daily_launch_stage(target, date(2026, 3, 5)), "首销")
                self.assertEqual(daily_launch_stage(target, date(2026, 3, 9)), "平销")
        incomplete = daily_stage_targets({"targets": [early, {**late, "end_date": ""}], "steady_targets": [aggregate]})
        self.assertEqual(daily_launch_stage(incomplete[PARENT], "2026-03-07"), "阶段未知")
