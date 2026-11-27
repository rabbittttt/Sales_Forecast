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
            database = root / "database/vehicle-config/campaigns/campaigns.sqlite3"
            self.assertEqual(preferred_source(old, root), database)
            with self.assertRaises(FileNotFoundError):
                open_source(database)
            self.assertFalse(database.exists())
            with patch.dict(os.environ, {"VEHICLE_CONFIG_CAMPAIGN_DB": "custom/campaigns.sqlite3"}):
                self.assertEqual(preferred_source(old, root), root / "custom/campaigns.sqlite3")
            database.parent.mkdir(parents=True)
            source = {"schemaVersion": 1, "revision": 1, "sheets": [{
                "name": "车型汇总", "headerRows": [1],
                "rows": [["代际名", "二级代际名", "开始大定日期", "小订转化率"],
                         ["测试 2026款", "版本二", "2026-03-04", 0.25]],
            }]}
            def publish(db, revision):
                db.execute("INSERT INTO publications VALUES (?,?)", (revision, json.dumps(source)))
                db.execute("UPDATE draft SET published_revision=?", (revision,))
                db.commit()
            with closing(sqlite3.connect(database)) as db:
                db.execute("CREATE TABLE draft (id INTEGER PRIMARY KEY, published_revision INTEGER, data TEXT)")
                db.execute("CREATE TABLE publications (revision INTEGER PRIMARY KEY, data TEXT)")
                db.execute("INSERT INTO draft VALUES (1,0,'unpublished')")
                db.commit()
                with self.assertRaisesRegex(ValueError, "尚未发布"):
                    open_source(database)
                publish(db, 1)
            snap = database.with_name("published.json")
            snap.write_text(json.dumps(source), "utf-8")
            self.assertEqual(preferred_source(old, root), database)
            with patch.dict(os.environ, {"VEHICLE_CONFIG_CAMPAIGN_SNAPSHOT": str(snap)}):
                self.assertEqual(preferred_source(old, root), snap)
                self.assertEqual(edition_signature(snap)[1], 1)
            custom = root / "fixture.xlsx"
            self.assertEqual(preferred_source(custom, root), custom)
            with campaign_batch(database):
                first = edition_signature(database)
                source["sheets"][0]["rows"][1][1] = "新版本"
                with closing(sqlite3.connect(database)) as db:
                    publish(db, 2)
                self.assertEqual(edition_signature(database), first)
                self.assertEqual(stage_records(database)[0]["历史传播名"], "版本二")
                book = open_source(database)
                self.assertEqual(book.active["C2"].value, datetime(2026, 3, 4))
                self.assertEqual(book.active["D2"].number_format, "0.00%")
                book.close()
            self.assertNotEqual(edition_signature(database), first)
            self.assertEqual(stage_records(database)[0]["历史传播名"], "新版本")
            with campaign_batch(database, 1):
                self.assertEqual(stage_records(database)[0]["历史传播名"], "版本二")
            with campaign_batch(custom):
                self.assertEqual(preferred_source(old, root), custom)
