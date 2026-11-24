"""Release immutability, external paths, and startup from a relocated package."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from core.data_paths import PROJECT_ROOT, project_output_directory, dynamic_output_directory
from core.release import build_release, page_revision, runtime_revision


class ReleaseTests(TestCase):
    def test_release_is_complete_and_immutable_without_business_data(self):
        with TemporaryDirectory() as folder:
            destination = Path(folder) / "工作目录" / "forecast-v1"
            before = runtime_revision(PROJECT_ROOT)
            manifest = build_release(PROJECT_ROOT, destination, "v1")
            self.assertEqual(manifest["type"], "service")
            self.assertEqual(manifest["dataMode"], "external")
            self.assertEqual(runtime_revision(destination / "payload"), before)
            self.assertEqual(runtime_revision(PROJECT_ROOT), before)
            self.assertEqual(set(p.name for p in destination.iterdir()), {"payload", "app-release.json"})
            for entry in manifest["files"]:
                path = destination / "payload" / entry["path"]
                self.assertEqual(path.stat().st_size, entry["bytes"])
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), entry["sha256"])
                self.assertFalse(set(Path(entry["path"]).parts) & {"tests", "output_file", "__pycache__", ".git"})
            with self.assertRaises(FileExistsError):
                build_release(PROJECT_ROOT, destination, "v1")
            moved = Path(folder) / "另一电脑" / "release"
            moved.parent.mkdir()
            shutil.move(str(destination), moved)
            result = subprocess.run([sys.executable, "-B", str(moved / "payload/dynamic/serve.py"), "--help"],
                                    cwd=folder, capture_output=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(b"--data-dir", result.stdout)
            env = {**os.environ, "PYTHONIOENCODING": "utf-8", "SALES_FORECAST_DATA_DIR": "", "SHARED_DATA_ROOT": ""}
            rejected = subprocess.run([sys.executable, "-B", str(moved / "payload/dynamic/serve.py"), "--no-open"],
                                      cwd=folder, capture_output=True, env=env, timeout=10)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse((moved / "payload/output_file").exists())
            self.assertEqual(runtime_revision(moved / "payload"), before)
            template = moved / "payload/scripts/generate_html/templates/forecast-live.js"
            template.write_bytes(template.read_bytes() + b"\n// changed fixture")
            self.assertNotEqual(runtime_revision(moved / "payload"), before)

    def test_page_cache_tracks_generator_dependencies_independently_of_the_release(self):
        with TemporaryDirectory() as folder:
            release = Path(folder) / "release"
            build_release(PROJECT_ROOT, release, "v1")
            payload = release / "payload"
            root = payload / "scripts/generate_html"
            page = page_revision(PROJECT_ROOT)
            self.assertEqual(page_revision(payload), page)
            service = runtime_revision(payload)
            (root / "modules/unregistered_fixture.py").write_text("pass", encoding="utf-8")
            self.assertNotEqual(runtime_revision(payload), service)
            self.assertEqual(page_revision(payload), page)
            client = root / "templates/forecast-live.js"
            client.write_bytes(client.read_bytes() + b"\n// polling-only change")
            self.assertEqual(page_revision(payload), page)
            registry = root / "modules/registry.py"
            registry.write_bytes(registry.read_bytes() + b"\nfrom modules import unregistered_fixture")
            page_registered = page_revision(payload)
            self.assertNotEqual(page_registered, page)
            (root / "modules/unregistered_fixture.py").write_text("x = 2", encoding="utf-8")
            self.assertNotEqual(page_revision(payload), page_registered)
            before_css = page_revision(payload)
            css = root / "templates/dashboard.css"
            css.write_bytes(css.read_bytes() + b"\n/* header change */")
            self.assertNotEqual(page_revision(payload), before_css)
            for name in ("forecast-navigation.css", "launch-workspace.js"):
                with self.subTest(section=name):
                    before = page_revision(payload)
                    file = root / "templates" / name
                    file.write_bytes(file.read_bytes() + b"\n/* section edit */")
                    self.assertNotEqual(page_revision(payload), before)

    def test_external_output_paths_are_project_relative_and_never_shared(self):
        with TemporaryDirectory() as folder:
            project = Path(folder) / "app"
            with patch.dict(os.environ, {"SALES_FORECAST_DATA_DIR": "../persistent", "SHARED_DATA_ROOT": "../shared"}):
                expected = (project.parent / "persistent").resolve()
                self.assertEqual(project_output_directory(project), expected)
                self.assertEqual(dynamic_output_directory(project), expected / "dynamic")
                self.assertFalse(expected.exists())
            with patch.dict(os.environ, {"SALES_FORECAST_DATA_DIR": "../shared/cache", "SHARED_DATA_ROOT": "../shared"}):
                with self.assertRaises(ValueError):
                    project_output_directory(project)

    def test_release_rejects_invalid_version_before_creating_output(self):
        with TemporaryDirectory() as folder:
            target = Path(folder) / "release"
            for version in ("../escape", "v1.", "", "bad version"):
                with self.assertRaises(ValueError):
                    build_release(PROJECT_ROOT, target, version)
                self.assertFalse(target.exists())
