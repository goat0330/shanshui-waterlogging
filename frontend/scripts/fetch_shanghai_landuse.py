#!/usr/bin/env python3
"""Fetch real OSM land-use polygons for the Shanghai visual-demo AOI.

No third-party Python packages are required. The script queries Overpass in small
bbox tiles, keeps only polygon ways, normalizes them into the five Style Demo
classes, and writes frontend/public/data/scene/shanghai-landuse.geojson.

Relations/multipolygons are intentionally excluded in this lean first pass; the
script never invents geometry. Missing relation-only parcels remain unstyled and
can be added later with a PBF/GeoPackage pipeline if the visual gap is material.
"""

from __future__ import annotations
import argparse
import json
import math
import time
import tempfile
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

DEFAULT_BBOX = (121.40, 31.17, 121.60, 31.31)  # west,south,east,north
OVERPASS = "https://overpass-api.de/api/interpreter"


def classify(tags: dict[str, str]) -> str | None:
    landuse = tags.get("landuse", "")
    leisure = tags.get("leisure", "")
    amenity = tags.get("amenity", "")
    natural = tags.get("natural", "")
    if landuse == "residential": return "residential"
    if landuse in {"commercial", "retail"}: return "commercial"
    if landuse in {"industrial", "construction", "railway"}: return "industrial"
    if amenity in {"school", "university", "college", "hospital", "clinic", "government", "townhall"}: return "civic"
    if leisure in {"park", "garden", "recreation_ground", "pitch"}: return "green"
    if landuse in {"grass", "forest", "meadow", "recreation_ground", "village_green"}: return "green"
    if natural in {"wood", "grassland", "scrub"}: return "green"
    return None


def query_bbox(w: float, s: float, e: float, n: float, endpoint: str = OVERPASS) -> dict:
    # Resume successful tiles after observed Overpass 504 errors.
    cache = Path(tempfile.gettempdir()) / "shanghai-style-landuse"
    cache.mkdir(exist_ok=True)
    cached = cache / f"{w:.4f}_{s:.4f}_{e:.4f}_{n:.4f}.json"
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    selectors = [
        'way["landuse"~"^(residential|commercial|retail|industrial|construction|railway|grass|forest|meadow|recreation_ground|village_green)$"]',
        'way["leisure"~"^(park|garden|recreation_ground|pitch)$"]',
        'way["amenity"~"^(school|university|college|hospital|clinic|government|townhall)$"]',
        'way["natural"~"^(wood|grassland|scrub)$"]',
    ]
    body = "".join(f"{sel}({s},{w},{n},{e});" for sel in selectors)
    q = f"[out:json][timeout:50];({body});out geom;"
    req = urllib.request.Request(
        endpoint,
        data=urllib.parse.urlencode({"data": q}).encode("utf-8"),
        headers={"User-Agent": "shanshui-waterlogging-style-demo/1.0"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=70) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            if result.get("remark"):
                raise RuntimeError(result["remark"])
            cached.write_text(json.dumps(result), encoding="utf-8")
            return result
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                if e - w <= 0.011: raise
                midx, midy = (w + e) / 2, (s + n) / 2
                print("Subdividing timed-out OSM tile", flush=True)
                elements = []
                for bounds in [(w, s, midx, midy), (midx, s, e, midy), (w, midy, midx, n), (midx, midy, e, n)]:
                    elements.extend(query_bbox(*bounds, endpoint)["elements"])
                result = {"elements": elements}
                cached.write_text(json.dumps(result), encoding="utf-8")
                return result
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("Overpass request failed")


def closed_ring(geometry: list[dict]) -> list[list[float]] | None:
    coords = [[p["lon"], p["lat"]] for p in geometry if "lon" in p and "lat" in p]
    if len(coords) < 4: return None
    if coords[0] != coords[-1]: return None
    return coords


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"), default=DEFAULT_BBOX)
    ap.add_argument("--step", type=float, default=0.04, help="query tile size in degrees")
    ap.add_argument("--sleep", type=float, default=1.2)
    ap.add_argument("--endpoint", default=OVERPASS)
    ap.add_argument("--output", default="frontend/public/data/scene/shanghai-landuse.geojson")
    args = ap.parse_args()

    west, south, east, north = args.bbox
    features: dict[str, dict] = {}
    cols = math.ceil((east - west) / args.step)
    rows = math.ceil((north - south) / args.step)

    for row in range(rows):
        s = south + row * args.step
        n = min(north, s + args.step)
        for col in range(cols):
            w = west + col * args.step
            e = min(east, w + args.step)
            print(f"OSM landuse tile {row * cols + col + 1}/{rows * cols}: {w:.4f},{s:.4f},{e:.4f},{n:.4f}")
            data = query_bbox(w, s, e, n, args.endpoint)
            for el in data.get("elements", []):
                if el.get("type") != "way": continue
                tags = el.get("tags") or {}
                cls = classify(tags)
                ring = closed_ring(el.get("geometry") or [])
                if not cls or not ring: continue
                fid = f"way/{el['id']}"
                features[fid] = {
                    "type": "Feature",
                    "id": fid,
                    "properties": {
                        "class": cls,
                        "osmType": "way",
                        "osmId": el["id"],
                        "landuse": tags.get("landuse"),
                        "leisure": tags.get("leisure"),
                        "amenity": tags.get("amenity"),
                        "natural": tags.get("natural"),
                        "name": tags.get("name"),
                        "source": "OpenStreetMap",
                        "license": "ODbL",
                    },
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                }
            time.sleep(args.sleep)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    fc = {
        "type": "FeatureCollection",
        "name": "Shanghai style-demo landuse · OSM ways",
        "properties": {
            "source": "OpenStreetMap via Overpass",
            "license": "ODbL",
            "bbox": [west, south, east, north],
            "note": "Lean visual-demo layer; relation-only multipolygons are not fabricated and are intentionally absent.",
        },
        "features": list(features.values()),
    }
    output.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(features)} polygons -> {output}")


if __name__ == "__main__":
    main()
