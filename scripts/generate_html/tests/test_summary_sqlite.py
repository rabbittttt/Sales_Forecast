import sqlite3
from contextlib import closing
from datetime import date, datetime, time, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from openpyxl import Workbook, load_workbook

from core.summary_sqlite import open_workbook, publish_workbook, SummaryDatabaseError


class SummarySqliteTests(TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.source = Path(directory.name) / "汇总.xlsx"
        self.database = Path(directory.name) / "私有" / "sales-summary.sqlite3"
        self.book = Workbook()
        self.addCleanup(self.book.close)
        self.daily = self.book.active
        self.daily.title = '小订"逐日'
        self.daily.append(["代际名", "日期", "小订", "转化率", "已知", "混合", "D1", "D1"])
        self.daily.append(["甲", date(2026, 9, 1), 0, 1 / 3, True, time(12, 30), None, 10])
        self.daily.append(["乙", datetime(2026, 9, 2, 12), None, None, False, "字符串", 20, 0])
        self.daily.append(["丙", "2026-09-03", 3, 1, None, timedelta(days=2, seconds=333), "", "=1+2"])
        other = self.book.create_sheet("说明与来源")
        other.append(["类型", "项目"])
        self.book.save(self.source)
        self.metadata = {"subjects": [{"name": "测试车型"}], "source_count": 2}
        self.publish()

    def publish(self):
        publish_workbook(self.database, self.book, source_path=self.source,
                         signature="输入签名", metadata=self.metadata)

    def open(self):
        return open_workbook(self.database, source_path=self.source, signature="输入签名")

    def test_tables_are_queryable_and_equal_to_data_only_excel(self):
        with closing(load_workbook(self.source, data_only=True)) as excel, self.open() as sql:
            self.assertEqual(sql.metadata, self.metadata)
            self.assertEqual(sql.sheetnames, excel.sheetnames)
            for name in excel.sheetnames:
                expected = list(excel[name].values)
                actual = list(sql[name].iter_rows(values_only=True))
                self.assertEqual(actual, expected)
                for left, right in zip(actual, expected):
                    self.assertEqual(list(map(type, left)), list(map(type, right)))
                self.assertEqual([cell.value for cell in sql[name][1]], list(expected[0]))
        with closing(sqlite3.connect(self.database)) as db:
            rows = db.execute('SELECT 日期, 小订, D1, D1_2 FROM "小订""逐日" WHERE 代际名=?', ("甲",)).fetchall()
            self.assertEqual(rows, [("2026-09-01", 0, None, 10)])

    def test_pinned_reader_retains_its_batch_during_publish(self):
        with self.open() as previous:
            self.daily["C2"] = 77
            self.book.save(self.source)
            self.publish()
            self.assertEqual(previous[self.daily.title][2][2].value, 0)
            with self.open() as current:
                self.assertEqual(current[self.daily.title][2][2].value, 77)

    def test_failed_publication_preserves_existing_queryable_database(self):
        with patch("core.summary_sqlite.os.replace", side_effect=PermissionError):
            with self.assertRaises(PermissionError):
                self.publish()
        self.assertEqual(list(self.database.parent.iterdir()), [self.database])
        with self.open() as sql:
            self.assertEqual(sql.metadata, self.metadata)

    def test_rejects_wrong_input_signature_and_changed_excel(self):
        with self.assertRaises(SummaryDatabaseError):
            open_workbook(self.database, source_path=self.source, signature="另一个输入目录")
        self.daily["C2"] = 77
        self.book.save(self.source)
        with self.assertRaises(SummaryDatabaseError):
            self.open()

    def test_corrupt_or_partially_missing_database_is_rejected(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DROP TABLE 说明与来源")
        with self.assertRaises(SummaryDatabaseError):
            self.open()

    def test_changed_metadata_is_rejected_even_when_still_valid_json(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE _forecast_edition SET metadata='{}'")
        with self.assertRaises(SummaryDatabaseError):
            self.open()
        self.database.write_bytes(b"corrupt!")
        with self.assertRaises(SummaryDatabaseError):
            self.open()
