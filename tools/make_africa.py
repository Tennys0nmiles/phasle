"""Build the Africa puzzle: one closed line through the coastline and every country border.

The borders form a planar graph whose junctions mostly have degree 3, so no single
closed walk can cover each edge exactly once. We pair the odd junctions by minimum
total distance (Chinese postman), retrace the shortest paths between each pair, and
walk the resulting Eulerian circuit. Mainland only: islands and Lesotho (an enclave
whose border touches nothing else) would need pen lifts.

Usage: .venv/bin/python -I tools/make_africa.py raw/geo/ne_50m_countries.geojson site/data/draw/d001.json
"""
import json
import sys

import networkx as nx
import numpy as np
from shapely.geometry import shape
from shapely.ops import linemerge, unary_union

N_POINTS = 4096  # power of two for the in-browser FFT
SIMPLIFY = 0.04  # degrees


def border_graph(geojson_path):
    with open(geojson_path) as f:
        features = [ft for ft in json.load(f)["features"] if ft["properties"].get("CONTINENT") == "Africa"]
    countries = {ft["properties"]["ADMIN"]: shape(ft["geometry"]) for ft in features}
    # Standard political maps draw Somalia whole.
    countries["Somalia"] = countries["Somalia"].union(countries.pop("Somaliland"))
    chains = linemerge(unary_union([g.boundary for g in countries.values()]))

    G = nx.MultiGraph()
    node = lambda pt: (round(pt[0], 5), round(pt[1], 5))
    for chain in chains.geoms:
        coords = np.asarray(chain.simplify(SIMPLIFY).coords)
        u, v = node(coords[0]), node(coords[-1])
        G.add_edge(u, v, coords=coords, start=u, length=float(np.linalg.norm(np.diff(coords, axis=0), axis=1).sum()))
    biggest = max(nx.connected_components(G), key=lambda c: G.subgraph(c).size(weight="length"))
    return G.subgraph(biggest).copy()


def eulerize(G):
    """Duplicate the cheapest set of paths that makes every degree even."""
    odd = [n for n, d in G.degree() if d % 2]
    simple = nx.Graph()
    for u, v, data in G.edges(data=True):
        if not simple.has_edge(u, v) or data["length"] < simple[u][v]["length"]:
            simple.add_edge(u, v, length=data["length"])
    dist, paths = {}, {}
    for s in odd:
        d, p = nx.single_source_dijkstra(simple, s, weight="length")
        dist[s], paths[s] = d, p
    K = nx.Graph()
    for i, a in enumerate(odd):
        for b in odd[i + 1:]:
            K.add_edge(a, b, weight=dist[a][b])
    extra = 0.0
    for a, b in nx.min_weight_matching(K):
        path = paths[a][b]
        for u, v in zip(path, path[1:]):
            key = min(G[u][v], key=lambda k: G[u][v][k]["length"])
            G.add_edge(u, v, **G[u][v][key])
            extra += G[u][v][key]["length"]
    return extra


def circuit_coords(G):
    start = max(G.nodes, key=lambda n: n[0])  # easternmost junction
    pts = []
    for u, v, k in nx.eulerian_circuit(G, source=start, keys=True):
        data = G[u][v][k]
        coords = data["coords"] if data["start"] == u else data["coords"][::-1]
        pts.append(coords[:-1])
    pts.append(pts[0][:1])
    return np.concatenate(pts)


def resample(xy, n):
    """n points equally spaced by arc length around the closed curve."""
    seg = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    t = np.linspace(0, s[-1], n, endpoint=False)
    return np.stack([np.interp(t, s, xy[:, 0]), np.interp(t, s, xy[:, 1])], axis=1)


def main(src, dst):
    G = border_graph(src)
    total = G.size(weight="length")
    extra = eulerize(G)
    lonlat = circuit_coords(G)
    # Equirectangular is close enough for a continent that straddles the equator; flip y for screen space.
    xy = resample(np.stack([lonlat[:, 0], -lonlat[:, 1]], axis=1), N_POINTS)
    xy -= xy.mean(axis=0)
    xy /= np.abs(xy).max()
    with open(dst, "w") as f:
        json.dump({"points": np.round(xy, 4).tolist()}, f, separators=(",", ":"))
    print(f"{G.number_of_nodes()} junctions, borders {total:.0f} deg + {extra:.0f} deg retraced -> {len(xy)} points -> {dst}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
