"""Run the independent forecast from any working directory."""
from pathlib import Path
import runpy
import sys

if __name__ == "__main__":
    code = Path(__file__).resolve().parent / "scripts" / "generate_html"
    sys.path.insert(0, str(code))
    runpy.run_path(str(code / "main.py"), run_name="__main__")
