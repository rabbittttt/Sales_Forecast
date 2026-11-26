import json
import os
import sqlite3
from contextlib import closing
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from core.campaign_source import campaign_batch, edition_signature, open_source, preferred_source
from core.model_identity import stage_records
from core.data_paths import orders_input_directory


class CampaignSourceTests(unittest.TestCase):
    def test_web_edition_outranks_legacy_and_keeps_batch_stable(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"PLANHUB_DATA_ROOT": directory}):
            root = Path(directory).resolve()
            old = orders_input_directory(root) / "小订及首销数据整理.xlsx"
            self.assertEqual(preferred_source(old, root), old)
            snap = root / "database/vehicle-config/campaigns/published.json"
            snap.parent.mkdir(parents=True)
            source = {"schemaVersion": 1, "revision": 1, "sheets": [{
                "name": "车型汇总", "headerRows": [1],
                "rows": [["代际名", "二级代际名", "开始大定日期", "小订转化率"],
                         ["测试 2026款", "版本二", "2026-03-04", 0.25]],
            }]}
            snap.write_text(json.dumps(source), "utf-8")
            self.assertEqual(preferred_source(old, root), snap)
            custom = root / "fixture.xlsx"
            self.assertEqual(preferred_source(custom, root), custom)
            with campaign_batch(snap):
                first = edition_signature(snap)
                source["revision"] = 2
                source["sheets"][0]["rows"][1][1] = "新版本"
                snap.write_text(json.dumps(source), "utf-8")
                self.assertEqual(edition_signature(snap), first)
                self.assertEqual(stage_records(snap)[0]["历史传播名"], "版本二")
                book = open_source(snap)
                self.assertEqual(book.active["C2"].value, datetime(2026, 3, 4))
                self.assertEqual(book.active["D2"].number_format, "0.00%")
                book.close()
            self.assertNotEqual(edition_signature(snap), first)
            self.assertEqual(stage_records(snap)[0]["历史传播名"], "新版本")
            snap.unlink()
            with closing(sqlite3.connect(snap.with_name("campaigns.sqlite3"))) as db, db:
                db.execute("CREATE TABLE publications (revision INTEGER PRIMARY KEY)")
                db.execute("INSERT INTO publications VALUES (2)")
            with self.assertRaisesRegex(FileNotFoundError, "快照"):
                preferred_source(old, root)
