"""Compatibility entry point for dynamic/serve.py."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    entry = Path(__file__).resolve().parent / "dynamic" / "serve.py"
    runpy.run_path(str(entry), run_name="__main__")
