"""Forecast-owned immutable runtime inventory and release envelope."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import stat
import subprocess

FILES = ("dynamic/serve.py", "requirements.txt", "scripts/generate_html/main.py",
         "scripts/generate_html/server.py", "scripts/generate_html/config.json")
FOLDERS = ("core", "modules", "tools", "templates")
EXTENSIONS = {".py", ".json", ".html", ".css", ".js", ".svg", ".png"}


def reject_link(path: Path) -> None:
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"发布路径不能包含链接：{item}")


def runtime_files(source: Path) -> list[Path]:
    reject_link(source)
    files = [source / name for name in FILES]
    for name in FOLDERS:
        directory = source / "scripts/generate_html" / name
        reject_link(directory)
        for path in sorted(directory.rglob("*")):
            # Caches may exist locally but never belong in a release.
            if "__pycache__" in path.parts:
                continue
            reject_link(path)
            if path.is_file():
                if path.suffix not in EXTENSIONS or path.name.startswith("."):
                    raise ValueError(f"Unexpected runtime asset: {path}")
                files.append(path)
    for path in files:
        reject_link(path)
        if not path.is_file():
            raise FileNotFoundError(path)
    return sorted(files)


def runtime_revision(source: Path) -> str:
    digest = hashlib.sha256()
    for path in runtime_files(source):
        digest.update(path.relative_to(source).as_posix().encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def build_release(source: Path, destination: Path, version: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", version) or version.endswith("."):
        raise ValueError("无效发布版本")
    files = runtime_files(source)
    if destination.exists():
        raise FileExistsError("发布目录已存在，请使用新版本")
    destination.parent.mkdir(parents=True, exist_ok=True)
    reject_link(destination.parent)
    destination.mkdir()
    revision = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"],
                              capture_output=True, text=True)
    content_revision = runtime_revision(source)
    manifest = {"schemaVersion": 1, "appId": "forecast", "version": version,
                "type": "service", "basePath": "/forecast/", "entryPoint": "dynamic/serve.py",
                "sourceRevision": (revision.stdout.strip() + ":" if revision.returncode == 0 else "") + content_revision,
                "dataMode": "external", "healthPath": "/healthz", "files": []}
    for path in files:
        relative = path.relative_to(source).as_posix()
        content = path.read_bytes()
        target = destination / "payload" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        manifest["files"].append({"path": relative, "bytes": len(content),
                                  "sha256": hashlib.sha256(content).hexdigest()})
    if runtime_revision(destination / "payload") != content_revision:
        raise ValueError("源码在构建期间变化，请重新构建新目录")
    (destination / "app-release.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest
