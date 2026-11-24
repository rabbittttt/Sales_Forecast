"""Forecast-owned immutable runtime inventory and release envelope."""
from __future__ import annotations

import ast
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


def _files_revision(source: Path, paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(path.relative_to(source).as_posix().encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def runtime_revision(source: Path) -> str:
    return _files_revision(source, runtime_files(source))


def page_revision(source: Path) -> str:
    """Inputs that produce the cached HTML. Service-only assets stay in the release hash."""
    root = source / "scripts/generate_html"
    # The registry imports the active business modules. Follow their local imports
    # as well, so adding a helper to a registered module invalidates the page.
    local_modules = {}
    for folder in ("core", "modules", "tools"):
        for file in (root / folder).rglob("*.py"):
            parts = file.relative_to(root).with_suffix("").parts
            name = ".".join(parts[:-1] if parts[-1] == "__init__" else parts)
            local_modules[name] = file
    pending = [root / "main.py", root / "tools/refresh_sales_forecast_data.py"]
    files = {source / "requirements.txt"}
    while pending:
        path = pending.pop()
        if path in files:
            continue
        files.add(path)
        for node in ast.walk(ast.parse(path.read_bytes(), filename=str(path))):
            if isinstance(node, ast.Import):
                names = [item.name for item in node.names]
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    parents = list(path.relative_to(root).parts[:-node.level])
                    base = ".".join([*parents, base] if base else parents)
                names = [base, *(f"{base}.{item.name}" for item in node.names)]
            else:
                continue
            for name in names:
                parts = name.split(".")
                for i in range(1, len(parts) + 1):
                    dependency = local_modules.get(".".join(parts[:i]))
                    if dependency and dependency not in files:
                        pending.append(dependency)
    # These are the embedded resources in core.renderer.render_dashboard.
    files.update(root / "templates" / name for name in (
        "dashboard.html", "dashboard.css", "dashboard.js", "forecast-icon.svg",
        "forecast-import.js", "forecast-math.js",
    ))
    return _files_revision(source, sorted(files))


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
