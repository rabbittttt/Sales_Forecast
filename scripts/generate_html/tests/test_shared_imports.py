"""Live imports are shared across HTTP clients, with durable optimistic writes."""
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest import TestCase

from core.live_server import ForecastServer, LiveMonitor
from core.external_imports import ImportStore


class SharedImportTests(TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = Path(temp.name) / "external-imports.sqlite3"
        self.server = ForecastServer(("127.0.0.1", 0), LiveMonitor(lambda: None, lambda: None),
                                     public_prefix="/forecast/", import_db=self.db)
        worker = Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01})
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.record = {"filename": "units.csv", "rows": [
            {"model": "车型", "source": "units.csv", "date": "2026-01-01",
             "metric": "gross", "stage": "launch", "quantity": 12.5}]}

    def request(self, body=None, query="model=A", prefix="/forecast", headers=None):
        conn = HTTPConnection(*self.server.server_address, timeout=5)
        try:
            conn.request("GET" if body is None else "POST", prefix + "/api/imports?" + query,
                         None if body is None else json.dumps(body),
                         headers if headers is not None else {"Content-Type": "application/json", "X-Forecast-Import": "1"})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_decimal_round_trip_conflict_clear_and_persistence(self):
        self.assertEqual(self.request()[1], {"record": None, "revision": 0})
        update = {"revision": 0, "record": self.record}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(self.request, [update, update]))
        self.assertEqual(sorted(r[0] for r in results), [200, 409])
        self.assertEqual(self.request(prefix="")[1]["record"], self.record)
        self.assertEqual(self.request(query="model=A&known=1")[1], {"revision": 1})
        self.assertIsNone(self.request(query="model=B")[1]["record"])
        self.assertEqual(ImportStore(self.db).read("A", -1)["record"], self.record)
        self.assertEqual(self.request({"revision": 1, "record": None})[1]["revision"], 2)
        self.assertIsNone(self.request()[1]["record"])
        self.assertEqual(self.request(update)[0], 409)

    def test_invalid_request_does_not_change_published_values(self):
        self.assertEqual(self.request({"revision": 0, "record": self.record})[0], 200)
        self.assertEqual(self.request({"revision": 1, "record": None}, headers={})[0], 415)
        for value in (-0.01, True, float("inf"), "2"):
            self.record["rows"][0]["quantity"] = value
            self.assertEqual(self.request({"revision": 1, "record": self.record})[0], 400)
        state = self.request()[1]
        self.assertEqual((state["revision"], state["record"]["rows"][0]["quantity"]), (1, 12.5))
