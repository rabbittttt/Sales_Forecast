"""Build an independent forecast service release; no business data is copied."""
from pathlib import Path
import argparse
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/generate_html"))
from core.release import build_release

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    destination = args.destination.absolute()
    result = build_release(ROOT, destination, args.version)
    print(f"Forecast release: {destination} ({len(result['files'])} files)")
