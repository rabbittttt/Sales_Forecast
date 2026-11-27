"""Explicit Dn headers keep their calendar positions in forecast references."""
from unittest import TestCase

from openpyxl import Workbook

from modules import sales_forecast as forecast


class ProgressColumnCalendarTests(TestCase):
    def book(self, headers, values):
        book = Workbook()
        sheet = book.active
        sheet.title = "progress"
        sheet.append(["model", *headers])
        sheet.append(["test", *values])
        self.addCleanup(book.close)
        return book, sheet

    def read(self, headers, values):
        book, sheet = self.book(headers, values)
        return forecast._progress_rows(book, sheet.title)["test"]

    def test_missing_physical_columns_keep_unknown_day_slots(self):
        self.assertEqual(self.read(["D1", "D3", "D5"], [.2, .6, 1]),
                         [.2, None, .6, None, 1])

    def test_leading_missing_days_do_not_move_first_observation_to_d1(self):
        self.assertEqual(self.read(["D3", "D5"], [.6, 1]),
                         [None, None, .6, None, 1])

    def test_unordered_columns_follow_explicit_day_numbers(self):
        self.assertEqual(self.read(["D3", "D1", "D2"], [1, .2, .6]),
                         [.2, .6, 1])

    def test_sparse_unordered_columns_keep_all_calendar_gaps(self):
        self.assertEqual(self.read(["D5", "D1", "D3"], [1, .2, .6]),
                         [.2, None, .6, None, 1])

    def test_dense_curves_and_real_zero_are_unchanged(self):
        self.assertEqual(self.read(["D1", "D2", "D3"], [0, .6, 1]),
                         [0, .6, 1])
        self.assertEqual(self.read(["D1", "D2", "D3"], [.2, None, 1]),
                         [.2, None, 1])

    def test_duplicate_day_columns_leave_that_day_unknown(self):
        self.assertEqual(self.read(["D1", "D1", "D2"], [.2, .8, 1]),
                         [None, 1])

    def test_alias_duplicate_day_columns_leave_that_day_unknown(self):
        self.assertEqual(self.read(["D1", "D01", "D2"], [.2, .8, 1]),
                         [None, 1])
