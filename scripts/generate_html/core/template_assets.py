"""Read the ordered source sections embedded into the single-file report."""
from pathlib import Path
import re

SECTION = re.compile(r"^/\* @include ([\w-]+\.(?:js|css)) \*/$", re.MULTILINE)


def template_parts(entry: Path) -> list[Path]:
    content = entry.read_text(encoding="utf-8")
    return [entry.with_name(name) for name in SECTION.findall(content)]


def read_template(entry: Path) -> str:
    content = entry.read_text(encoding="utf-8")
    return SECTION.sub(lambda match: entry.with_name(match[1]).read_text(encoding="utf-8").removesuffix("\n"), content)
