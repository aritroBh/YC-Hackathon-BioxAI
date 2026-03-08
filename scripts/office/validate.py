from __future__ import annotations

import sys
import zipfile
from pathlib import Path


REQUIRED_ENTRIES = {
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate.py <report.docx>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    if not path.exists():
        print(f"missing file: {path}", file=sys.stderr)
        return 1

    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
    except zipfile.BadZipFile:
        print("invalid docx zip container", file=sys.stderr)
        return 1

    missing = sorted(REQUIRED_ENTRIES - names)
    if missing:
        print(f"missing required docx parts: {', '.join(missing)}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
