"""Renamed groups retain identity and their maintained forecast eligibility."""
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from openpyxl import Workbook

from core.discovery import discover_subjects, is_valid_subject_name, subject_id
from core.excel import (
    WorkbookItem, WorkbookStore, is_aggregate_generation, sheet_subject, subject_type,
)
from core.model_identity import model_key, resolve_stage_identity
from core.renderer import forecast_manifest
from modules.sales_forecast import (
    _forecast_event_sheets, _is_aggregate_forecast_model, _read_actual_profiles,
    _read_model_mapping_file, _read_steady_history,
)
from tools.refresh_sales_forecast_data import mapping_record_for


RENAMES = (
    ("问界 F2N 2026款汇总", "问界 M9&M9U 2026款", ("问界 M9 2026款", "问界 M9U 2026款")),
    ("尊界 X6M 2026款汇总", "尊界 V680&V800 2026款", ("尊界 V680 2026款", "尊界 V800 2026款")),
    ("尚界 SHB 2026款汇总", "尚界 Z7&Z7T 2026款", ("尚界 Z7 2026款", "尚界 Z7T 2026款")),
    ("享界 X4 2026款汇总", "享界 S9&S9T 2026款", ("享界 S9 2026款", "享界 S9T 2026款")),
)
LEGACY_SUBJECT_IDS = (
    "generation_86181b71b8", "generation_89fbdd58ba",
    "generation_cbc953bb53", "generation_51a45df10f",
)
PRE_ALIAS_SUBJECT_IDS = (
    ("generation_ee5f5d00b4", "generation_adb941ab76"),
    ("generation_4461c5bf5a", "generation_daaad37d5b"),
    ("generation_db7e4993b1", "generation_5c7a8e0f7b"),
    ("generation_728f80736f", "generation_146c04d57c"),
)
BROWSER_ALIAS_KEYS = (
    ("问界f2n2026", "问界m9m9u2026"),
    ("尊界x6m2026", "尊界v680v8002026"),
    ("尚界shb2026", "尚界z7z7t2026"),
    ("享界x42026", "享界s9s9t2026"),
)


def maintained_record(name):
    return {"代际名": name, "二级代际名": "", "历史传播名": name,
            "订单分析代际名": name, "品牌": name.split()[0]}


class AggregateGenerationIdentityTests(TestCase):
    def test_four_renames_share_identity(self):
        for old, new, _ in RENAMES:
            with self.subTest(old=old, new=new):
                self.assertEqual(model_key(old), model_key(new))
        self.assertEqual(len({model_key(new) for _, new, _ in RENAMES}), 4)

    def test_subject_ids_keep_existing_drafts_after_rename(self):
        for (old, new, _), existing_id in zip(RENAMES, LEGACY_SUBJECT_IDS):
            with self.subTest(old=old, new=new):
                self.assertEqual(subject_id(old, "generation"), existing_id)
                self.assertEqual(subject_id(new, "generation"), existing_id)
                self.assertEqual(subject_id(old.removesuffix("汇总"), "generation"), existing_id)

    def test_manifest_migrates_pre_alias_plain_and_new_name_subject_ids(self):
        aliases = forecast_manifest({})["forecast_subject_aliases"]
        for (old, new, _), previous_ids in zip(RENAMES, PRE_ALIAS_SUBJECT_IDS):
            for current_name in (old.removesuffix("汇总"), new):
                with self.subTest(current=current_name):
                    for previous_id in previous_ids:
                        self.assertEqual(aliases[previous_id], subject_id(current_name, "generation"))

    def test_aliases_do_not_merge_members_other_years_or_brands(self):
        for old, new, members in RENAMES:
            others = (*members, new.replace("2026", "2025"), new.replace("2026", "2027"),
                      new.replace(new.split()[0], "智界", 1))
            for other in others:
                with self.subTest(aggregate=new, other=other):
                    self.assertNotEqual(model_key(old), model_key(other))
                    self.assertNotEqual(model_key(new), model_key(other))
            self.assertNotEqual(model_key(members[0]), model_key(members[1]))

    def test_stage_identity_accepts_either_maintenance_transition_direction(self):
        for old, new, _ in RENAMES:
            for source_name, maintained_name in ((old, new), (new, old)):
                with self.subTest(source=source_name, maintained=maintained_name):
                    record = maintained_record(maintained_name)
                    self.assertEqual(resolve_stage_identity(source_name, [record]), maintained_name)

    def test_stage_identity_does_not_borrow_member_or_unrelated_campaign(self):
        for _, new, members in RENAMES:
            record = maintained_record(new)
            for other in (*members, new.replace("2026", "2027"),
                          new.replace(new.split()[0], "智界", 1)):
                with self.subTest(aggregate=new, other=other):
                    self.assertIsNone(resolve_stage_identity(other, [record]))
                    self.assertIsNone(resolve_stage_identity(new, [maintained_record(other)]))

    def test_refresh_mapping_accepts_old_and_new_summary_names(self):
        for old, new, _ in RENAMES:
            for source_name, maintained_name in ((old, new), (new, old)):
                record = maintained_record(maintained_name)
                # Both the primary-key and generation-name fallback are used by
                # historical summary formats during a maintenance transition.
                for mapping in ({model_key(maintained_name): record}, {"历史传播记录": record}):
                    with self.subTest(source=source_name, maintained=maintained_name, keys=list(mapping)):
                        self.assertIs(mapping_record_for(source_name, mapping), record)

    def test_sheet_suffixes_keep_new_names_and_aggregate_classification(self):
        suffixes = ("", "by天", "by周", "by时", "by月", "by天第1期", "by周第12期",
                    "by时第 2 期图表", "净大定by天图表", "_SKU", "_组合")
        for old, new, members in RENAMES:
            self.assertTrue(is_aggregate_generation(old))
            self.assertTrue(is_aggregate_generation(old.removesuffix("汇总")))
            for suffix in suffixes:
                with self.subTest(name=new, suffix=suffix):
                    name = sheet_subject(new + suffix)
                    self.assertEqual(name, new)
                    self.assertEqual(subject_type(name), "generation")
                    self.assertTrue(is_valid_subject_name(name))
                    self.assertTrue(is_aggregate_generation(name))
            for other in (*members, new.replace("2026", "2027"),
                          new.replace(new.split()[0], "智界", 1)):
                self.assertFalse(is_aggregate_generation(other), other)
        self.assertFalse(is_aggregate_generation("问界 M7&M8 2026款"))

    def test_forecast_filter_preserves_explicitly_maintained_plain_names(self):
        for old, new, _ in RENAMES:
            plain = old.removesuffix("汇总")
            for source in (old, plain, new):
                with self.subTest(source=source):
                    self.assertTrue(_is_aggregate_forecast_model(source, {}))
                    for maintained in (plain, new):
                        self.assertFalse(_is_aggregate_forecast_model(
                            source, {model_key(maintained): maintained}))
                    for maintained in (old, new + "汇总", new + "总计"):
                        self.assertTrue(_is_aggregate_forecast_model(
                            source, {model_key(maintained): maintained}))

    def test_real_modern_and_legacy_mapping_export_both_browser_alias_keys(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "车型维护.xlsx"
            for (old, new, _), keys in zip(RENAMES, BROWSER_ALIAS_KEYS):
                for name in (old, new):
                    for modern in (True, False):
                        with self.subTest(name=name, modern=modern):
                            book = Workbook()
                            if modern:
                                book.active.title = "车型汇总"
                                book.active.append(["代际名", "二级代际名", "开始大定日期"])
                                book.active.append([name, "", date(2026, 9, 1)])
                            else:
                                book.active.title = "传播名代际映射"
                                book.active.append(["历史传播名", "订单分析代际名"])
                                book.active.append([name, name])
                            book.save(path)
                            book.close()
                            # Bypass the file cache because this fixture overwrites
                            # one temporary path; exercise the real workbook readers.
                            mapping = _read_model_mapping_file.__wrapped__(path)
                            for key in keys:
                                self.assertEqual(mapping.get(key), name, key)


class AggregateGenerationSourceTests(TestCase):
    def setUp(self):
        diagnostics = patch("core.excel._CONFLICT_CHECKS", set())
        diagnostics.start()
        self.addCleanup(diagnostics.stop)
        for target, value in (
            ("modules.sales_forecast._read_model_mapping", {}),
            ("modules.sales_forecast._read_model_master", {}),
            ("modules.sales_forecast.generation_records", []),
            ("core.discovery.generation_records", []),
        ):
            mocked = patch(target, return_value=value)
            mocked.start()
            self.addCleanup(mocked.stop)

    def workbook(self):
        book = Workbook()
        book.remove(book.active)
        self.addCleanup(book.close)
        return book

    def store(self, filename, book):
        store = WorkbookStore(Path("."))
        store.items = [WorkbookItem(Path(filename), book)]
        return store

    def launch_sheet(self, book, title, quantities):
        sheet = book.create_sheet(title)
        sheet.append(["周期", "D1", "D2", "D3"])
        sheet.append(["时间", date(2026, 9, 1), date(2026, 9, 2), date(2026, 9, 3)])
        sheet.append(["当日大定数量", *quantities])
        return sheet

    def test_discovery_accepts_new_sheet_names_and_keeps_members_distinct(self):
        book = self.workbook()
        expected = {name for _, new, members in RENAMES for name in (new, *members)}
        for name in sorted(expected):
            book.create_sheet(name + "by周")
        subjects = discover_subjects(self.store("鸿蒙智行大定选配比例分析.xlsx", book))
        self.assertEqual({s.name for s in subjects if s.type == "generation"}, expected)
        self.assertEqual(len({s.id for s in subjects if s.type == "generation"}), len(expected))

    def test_discovery_deduplicates_aliases_and_prefers_maintained_target_name(self):
        for old, new, members in RENAMES:
            for maintained in (old.removesuffix("汇总"), new):
                with self.subTest(maintained=maintained):
                    book = self.workbook()
                    for name in (old, old.removesuffix("汇总"), new, members[0]):
                        book.create_sheet(name + "by天")
                    store = self.store("鸿蒙智行大定选配比例分析.xlsx", book)
                    subjects = discover_subjects(store, forecast_targets=[maintained])
                    generations = [s for s in subjects if s.type == "generation"]
                    self.assertEqual({s.name for s in generations}, {maintained, members[0]})
                    self.assertEqual(len(generations), 2)
                    self.assertEqual(next(s.id for s in generations if s.name == maintained),
                                     subject_id(old, "generation"))

    def test_plain_name_maintenance_and_source_renames_keep_actuals_and_steady_history(self):
        for old, new, _ in RENAMES:
            plain = old.removesuffix("汇总")
            for maintained in (plain, new):
                for source in (old, new, plain):
                    with self.subTest(maintained=maintained, source=source):
                        small_book = self.workbook()
                        small = small_book.create_sheet(source + "by天")
                        small.append(["指标", "统计类型", "分类", date(2026, 9, 28)])
                        small.append(["小订", "数量", "数量", 17])
                        lock_book = self.workbook()
                        for suffix, period in (("by周", "26WK40"), ("by天", date(2026, 9, 28))):
                            lock = lock_book.create_sheet(source + suffix)
                            lock.append(["指标", "统计类型", "分类", period])
                            lock.append(["交车锁单", "数量", "数量", 17])
                        store = self.store("鸿蒙智行小订选配比例分析.xlsx", small_book)
                        store.items.append(WorkbookItem(Path("鸿蒙智行锁单选配比例分析.xlsx"), lock_book))
                        mapping = {model_key(maintained): maintained}
                        windows = {model_key(maintained): {
                            "generation": maintained, "end_date": "2026-09-27"}}
                        with patch("modules.sales_forecast._read_model_mapping", return_value=mapping):
                            actuals, _ = _read_actual_profiles(store, today=date(2026, 9, 28))
                            steady, _ = _read_steady_history(store, windows, today=date(2026, 10, 5))
                        self.assertEqual([p["model"] for p in actuals], [maintained])
                        self.assertEqual(actuals[0]["small_daily_days"], [
                            {"date": "2026-09-28", "orders": 17}])
                        self.assertEqual([p["model"] for p in steady], [maintained])
                        self.assertEqual([week["lock"] for week in steady[0]["weeks"]], [17])
                        self.assertEqual(steady[0]["daily"], [
                            {"date": "2026-09-28", "lock": 17, "complete": True}])

    def test_alias_sheets_merge_without_a_maintained_mapping(self):
        for old, new, _ in RENAMES:
            with self.subTest(name=new):
                book = self.workbook()
                self.launch_sheet(book, old + "by天", [0, 20, None])
                self.launch_sheet(book, new + "by天", [None, 20, 30])
                item = WorkbookItem(Path("鸿蒙智行首销期订单节奏.xlsx"), book)
                sheets = list(_forecast_event_sheets(item, {}))
                self.assertEqual(len(sheets), 1)
                self.assertEqual([cell.value for cell in sheets[0][3][1:]], [0, 20, 30])

    def test_mix_candidates_and_small_daily_still_exclude_aggregate_views(self):
        members = {member for _, _, pair in RENAMES for member in pair}
        for keyword, metric in (("锁单选配比例", "交车锁单"), ("小订选配比例", "小订")):
            with self.subTest(source=keyword):
                book = self.workbook()
                for old, new, pair in RENAMES:
                    for name in (old, new, *pair):
                        sheet = book.create_sheet(name + "by天")
                        sheet.append(["指标", "统计类型", "分类", date(2026, 9, 1)])
                        sheet.append([metric, "数量", "数量", 999 if name in (old, new) else 17])
                profiles, _ = _read_actual_profiles(
                    self.store("鸿蒙智行" + keyword + "分析.xlsx", book), today=date(2026, 9, 1))
                self.assertEqual({p["model"] for p in profiles}, members)
                if metric == "小订":
                    self.assertTrue(all(p["small_daily_days"] == [
                        {"date": "2026-09-01", "orders": 17}] for p in profiles))

    def test_steady_lock_history_does_not_count_aggregate_alongside_members(self):
        book = self.workbook()
        windows, members = {}, set()
        for old, new, pair in RENAMES:
            members.update(pair)
            for name in (old, new, *pair):
                sheet = book.create_sheet(name + "by周")
                sheet.append(["指标", "统计类型", "分类", "26WK40"])
                sheet.append(["交车锁单", "数量", "数量", 999 if name in (old, new) else 17])
                windows[model_key(name)] = {"generation": name, "end_date": "2026-09-27"}
        profiles, _ = _read_steady_history(
            self.store("鸿蒙智行锁单选配比例分析.xlsx", book), windows, today=date(2026, 10, 5))
        self.assertEqual({p["model"] for p in profiles}, members)
        self.assertEqual(len(profiles), len(members))
        self.assertTrue(all([week["lock"] for week in p["weeks"]] == [17] for p in profiles))

    def test_alias_launch_sheets_keep_one_curve_zero_and_blank_backfill(self):
        for old, new, members in RENAMES:
            for first, second in ((old, new), (new, old)):
                with self.subTest(first=first, second=second):
                    book = self.workbook()
                    self.launch_sheet(book, first + "by天", [0, 20, None])
                    self.launch_sheet(book, second + "by天", [99, 20, 30])
                    self.launch_sheet(book, members[0] + "by天", [7, 8, 9])
                    store = self.store("鸿蒙智行首销期订单节奏.xlsx", book)
                    mapping = {model_key(new): new, model_key(members[0]): members[0]}
                    with patch("modules.sales_forecast._read_model_mapping", return_value=mapping):
                        profiles, _ = _read_actual_profiles(store, today=date(2026, 9, 4))
                    by_model = {p["model"]: p for p in profiles}
                    self.assertEqual(set(by_model), {new, members[0]})
                    self.assertEqual(len(profiles), 2)
                    self.assertEqual([r["gross"] for r in by_model[new]["days"]], [0, 20, 30])
                    self.assertEqual([r["gross"] for r in by_model[members[0]]["days"]], [7, 8, 9])
                    self.assertEqual(sum(r["gross"] for r in by_model[new]["days"]), 50)

    def test_alias_merge_preserves_distinct_launch_periods(self):
        old, new, members = RENAMES[0]
        book = self.workbook()
        for period in (1, 2):
            self.launch_sheet(book, old + f"by天第{period}期", [0, 20, None])
            self.launch_sheet(book, new + f"by天第{period}期", [None, 20, 30])
        self.launch_sheet(book, members[0] + "by天", [7, 8, 9])
        item = WorkbookItem(Path("鸿蒙智行首销期订单节奏.xlsx"), book)
        sheets = list(_forecast_event_sheets(item, {model_key(new): new}))
        self.assertEqual(len(sheets), 3)
        self.assertEqual(sum("第1期" in s.title for s in sheets), 1)
        self.assertEqual(sum("第2期" in s.title for s in sheets), 1)
        self.assertEqual(sum(sheet_subject(s.title) == members[0] for s in sheets), 1)
