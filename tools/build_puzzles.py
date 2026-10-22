"""Write site/data/puzzles.json from tools/puzzles.src.json.

Answers are base64-wrapped so a peek at the network tab doesn't spoil the day.
Song tiers and errors come from each song's meta.json (written by make_song.py).

Usage: .venv/bin/python -I tools/build_puzzles.py
"""
import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"


def wrap(obj):
    return base64.b64encode(json.dumps(obj).encode()).decode()


def main():
    src = json.loads((ROOT / "tools" / "puzzles.src.json").read_text())
    out = {"epoch": src["epoch"], "suggest": src["suggest"], "shape": [], "song": []}
    for p in src["shape"]:
        out["shape"].append({**p, "secret": wrap(p["secret"])})
    for p in src["song"]:
        meta = json.loads((SITE / p["dir"] / "meta.json").read_text())
        out["song"].append({**p, **meta, "secret": wrap(p["secret"])})
    (SITE / "data" / "puzzles.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(out['shape'])} shape, {len(out['song'])} song -> site/data/puzzles.json")


if __name__ == "__main__":
    main()
