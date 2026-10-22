"""Write site/data/puzzles.json from tools/puzzles.src.json.

Answers are base64-wrapped so a peek at the network tab doesn't spoil the day.
Every tier is defined by a target % error ("targets"); a shape's term counts are the
fewest biggest circles that reach each target, and a song's come from its meta.json
(written by make_song.py with the same targets).

Usage: .venv/bin/python -I tools/build_puzzles.py
"""
import base64
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"


def wrap(obj):
    return base64.b64encode(json.dumps(obj).encode()).decode()


def shape_tiers(points, targets):
    """Same ranking as the browser: biggest |c_k| first, DC excluded, error by Parseval."""
    z = np.asarray(points) @ np.array([1, 1j])
    c = np.fft.fft(z)[1:]
    e = np.sort(np.abs(c) ** 2)[::-1]
    left = 100 * np.sqrt(np.maximum(0, 1 - np.cumsum(e) / e.sum()))
    tiers = [int(np.argmax(left <= t)) + 1 for t in targets]
    return tiers, [round(float(left[n - 1]), 2) for n in tiers]


def main():
    src = json.loads((ROOT / "tools" / "puzzles.src.json").read_text())
    targets = src["targets"]
    out = {"epoch": src["epoch"], "targets": targets, "suggest": src["suggest"], "shape": [], "song": []}
    for p in src["shape"]:
        points = json.loads((SITE / p["file"]).read_text())["points"]
        tiers, errors = shape_tiers(points, targets)
        out["shape"].append({**p, "tiers": tiers, "secret": wrap(p["secret"])})
        print(f"shape {p['id']}: tiers {tiers}, errors {errors}")
    for p in src["song"]:
        meta = json.loads((SITE / p["dir"] / "meta.json").read_text())
        out["song"].append({**p, **meta, "secret": wrap(p["secret"])})
        print(f"song  {p['id']}: tiers {meta['tiers']}, errors {meta['errors']}")
    (SITE / "data" / "puzzles.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"-> site/data/puzzles.json")


if __name__ == "__main__":
    main()
