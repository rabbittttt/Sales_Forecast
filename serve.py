"""Compatibility entry point for 动态网页/serve.py."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    entry = Path(__file__).resolve().parent / "动态网页" / "serve.py"
    runpy.run_path(str(entry), run_name="__main__")
