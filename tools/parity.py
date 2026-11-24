"""Shrink the shared fixture with the Python port and dump the result.

Companion to ``tools/parity.mjs``, which does the same with the JavaScript
implementation. Each side reads ``test/fixtures/wire-payloads.json`` itself and
writes its own output; the Node script then compares the two files as text, so a
difference in key order, in a truncated word, or in which tools were reported is
a failure rather than a shrug.

Usage: ``python tools/parity.py <output.json>``
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "adapters" / "hermes"))

from toolscode import toolscode_core as core  # noqa: E402

CONFIG = {
    "descriptionCap": 60,
    "nestedDescriptionCap": 40,
    "minChars": 0,
    "exclude": ["secret_*"],
    "systemSections": {"Personality": ""},
}


def main() -> int:
    fixture = json.loads((REPO / "test" / "fixtures" / "wire-payloads.json").read_text(encoding="utf-8"))
    out = {}
    for name, payload in fixture["payloads"].items():
        result = core.shrink_wire_payload(payload, CONFIG)
        out[name] = {"payload": result["payload"], "shape": result["shape"], "report": result["report"]}
    destination = Path(sys.argv[1])
    # newline="\n" because the comparison next to it is a Node file written with
    # "\n": Windows translating this file to CRLF would look like every line
    # differing, which is a bad way to discover that the two agree.
    destination.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
