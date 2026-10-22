"""Build the Africa one-line outline puzzle from Natural Earth country polygons.

Usage: .venv/bin/python -I tools/make_africa.py raw/geo/ne_50m_countries.geojson site/data/draw/africa.json
"""
import json
import sys

import numpy as np
from shapely.geometry import shape
from shapely.ops import unary_union

N_POINTS = 1024


def mainland_outline(geojson_path):
    with open(geojson_path) as f:
        features = json.load(f)["features"]
    polys = [shape(ft["geometry"]) for ft in features if ft["properties"].get("CONTINENT") == "Africa"]
    # Close the hairline gaps between neighbouring countries before taking the outline.
    land = unary_union([p.buffer(0.08) for p in polys]).buffer(-0.08)
    mainland = max(getattr(land, "geoms", [land]), key=lambda g: g.area)
    return np.asarray(mainland.simplify(0.05).exterior.coords)


def resample(xy, n):
    """n points equally spaced by arc length around the closed curve."""
    seg = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    t = np.linspace(0, s[-1], n, endpoint=False)
    return np.stack([np.interp(t, s, xy[:, 0]), np.interp(t, s, xy[:, 1])], axis=1)


def main(src, dst):
    lonlat = mainland_outline(src)
    # Equirectangular is close enough for a continent that straddles the equator; flip y for screen space.
    xy = np.stack([lonlat[:, 0], -lonlat[:, 1]], axis=1)
    xy = resample(xy, N_POINTS)
    xy -= xy.mean(axis=0)
    xy /= np.abs(xy).max()
    # Start the pen at the Horn of Africa so the first stroke is not a giveaway edge.
    xy = np.roll(xy, -int(np.argmax(xy[:, 0])), axis=0)
    with open(dst, "w") as f:
        json.dump({"points": np.round(xy, 4).tolist()}, f, separators=(",", ":"))
    print(f"{len(xy)} points -> {dst}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
