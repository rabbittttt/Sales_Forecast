"""Shared inputs and the published summary; private reports and caches."""

from __future__ import annotations

import os
from pathlib import Path


CODE_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ROOT = CODE_ROOT.parent if CODE_ROOT.name.lower() == "scripts" else CODE_ROOT
FORECAST_SUMMARY_NAME = "鸿蒙智行销量数据汇总.xlsx"


def shared_data_root(project_root: Path = PROJECT_ROOT) -> Path:
    """Resolve relative settings against the project, independent of shell cwd.

    A missing shared directory remains authoritative: never consume old project
    copies just because a source directory or workbook has not been supplied.
    """
    project_root = Path(project_root).resolve()
    configured = os.environ.get("SHARED_DATA_ROOT", "").strip()
    candidate = Path(configured).expanduser() if configured else Path("..") / "共享数据"
    return (candidate if candidate.is_absolute() else project_root / candidate).resolve()


def orders_input_directory(project_root: Path = PROJECT_ROOT) -> Path:
    return shared_data_root(project_root) / "订单汇总"


def forecast_summary_path(project_root: Path = PROJECT_ROOT) -> Path:
    """The shared derived workbook published by this forecast project."""
    return orders_input_directory(project_root) / FORECAST_SUMMARY_NAME


def forecast_reference_directory(project_root: Path = PROJECT_ROOT) -> Path:
    return orders_input_directory(project_root)


def model_information_directory(project_root: Path = PROJECT_ROOT) -> Path:
    return shared_data_root(project_root) / "车型信息"


def assert_output_is_private(path: Path, project_root: Path = PROJECT_ROOT) -> Path:
    """Reject writes into shared sources, including resolved directory links."""
    resolved = Path(path).expanduser().resolve()
    shared_roots = {
        shared_data_root(project_root),
        (Path(project_root).resolve().parent / "共享数据").resolve(),
    }
    if any(resolved.is_relative_to(root) for root in shared_roots):
        raise ValueError(f"共享数据目录只读，输出或缓存必须放在项目输出目录：{resolved}")
    return resolved


def assert_summary_output(path: Path, project_root: Path = PROJECT_ROOT) -> Path:
    """Allow the one published summary, while protecting all other shared files."""
    resolved = Path(path).expanduser().resolve()
    expected = forecast_summary_path(project_root)
    # Resolve directory links without treating a file link to another shared
    # workbook as permission to overwrite that source workbook.
    expected = expected.parent.resolve() / expected.name
    if resolved == expected:
        return resolved
    return assert_output_is_private(resolved, project_root)


def project_output_directory(project_root: Path = PROJECT_ROOT) -> Path:
    return assert_output_is_private(Path(project_root) / "output_file", project_root)


def static_output_directory(project_root: Path = PROJECT_ROOT) -> Path:
    return project_output_directory(project_root) / "static"


def dynamic_output_directory(project_root: Path = PROJECT_ROOT) -> Path:
    return project_output_directory(project_root) / "dynamic"


def excel_cache_directory(project_root: Path = PROJECT_ROOT) -> Path:
    return project_output_directory(project_root) / ".cache" / "excel"
