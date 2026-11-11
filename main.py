"""Compatibility entry point for static/main.py."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    entry = Path(__file__).resolve().parent / "static" / "main.py"
    runpy.run_path(str(entry), run_name="__main__")
