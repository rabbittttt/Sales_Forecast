"""Compatibility entry point for 静态网页/main.py."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    entry = Path(__file__).resolve().parent / "静态网页" / "main.py"
    runpy.run_path(str(entry), run_name="__main__")
