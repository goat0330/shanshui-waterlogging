#!/usr/bin/env python3
"""Fetch a real OSM road hierarchy for the Shanghai 3D visual-demo AOI.

Outputs frontend/public/data/scene/shanghai-demo-roads.geojson and keeps only
road classes useful at city/building scale. No inferred geometry is generated.
"""
from __future__ import annotations

import argparse
import json
import math
import tempfile
import time
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

DEFAULT_BBOX = (121.40, 31.17, 121.60, 31.31)  # west,south,east,north
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
HIGHWAY_REGEX = "^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|service|living_street)$"


def tile_bboxes(w: float, s: float, e: float, n: float, step: float):
    x = w
    while x < e - 1e-9:
        x2 = min(e, x + step)
        y = s
        while y < n - 1e-9:
            y2 = min(n, y + step)
            yield (x, y, x2, y2)
            y = y2
        x = x2


def overpass_query(w: float, s: float, e: float, n: float) -> str:
    return f'''[out:json][timeout:60];
way["highway"~"{HIGHWAY_REGEX}"]({s},{w},{n},{e});
out tags geom;'''


def fetch_tile(bbox: tuple[float, float, float, float], cache_dir: Path, retries: int = 4) -> dict:
    w, s, e, n = bbox
    cache_file = cache_dir / f"roads_{w:.4f}_{s:.4f}_{e:.4f}_{n:.4f}.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8"))

    query = overpass_query(w, s, e, n)
    payload = urllib.parse.urlencode({"data": query}).encode()
    last_error: Exception | None = None
    for attempt in range(retries):
        for endpoint in OVERPASS_ENDPOINTS:
            try:
                req = urllib.request.Request(endpoint, data=payload, headers={"User-Agent": "shanshui-waterlogging-style-demo/1.0"})
                with urllib.request.urlopen(req, timeout=90) as response:
                    data = json.loads(response.read().decode("utf-8"))
                cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
                return data
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
        time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"Overpass failed for {bbox}: {last_error}")


def normalize_bool(value: str | None):
    if value is None:
        return None
    v = value.strip().lower()
    if v in {"yes", "true", "1"}: return True
    if v in {"no", "false", "0"}: return False
    return value


def to_feature(element: dict) -> dict | None:
    geom = element.get("geometry") or []
    coords = [[p.get("lon"), p.get("lat")] for p in geom if p.get("lon") is not None and p.get("lat") is not None]
    if len(coords) < 2:
        return None
    tags = element.get("tags") or {}
    highway = tags.get("highway", "unclassified")
    return {
        "type": "Feature",
        "id": f"way/{element['id']}",
        "properties": {
            "fclass": highway,
            "roadClass": highway,
            "name": tags.get("name"),
            "ref": tags.get("ref"),
            "bridge": normalize_bool(tags.get("bridge")),
            "tunnel": normalize_bool(tags.get("tunnel")),
            "oneway": normalize_bool(tags.get("oneway")),
            "maxspeed": tags.get("maxspeed"),
            "osmId": element["id"],
            "source": "OpenStreetMap",
            "license": "ODbL",
        },
        "geometry": {"type": "LineString", "coordinates": coords},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bbox", nargs=4, type=float, default=DEFAULT_BBOX, metavar=("W", "S", "E", "N"))
    parser.add_argument("--tile-step", type=float, default=0.04)
    parser.add_argument("--out", type=Path, default=Path("frontend/public/data/scene/shanghai-demo-roads.geojson"))
    args = parser.parse_args()

    w, s, e, n = args.bbox
    cache_dir = Path(tempfile.gettempdir()) / "shanghai-style-demo-roads"
    cache_dir.mkdir(parents=True, exist_ok=True)

    by_id: dict[str, dict] = {}
    tiles = list(tile_bboxes(w, s, e, n, args.tile_step))
    for idx, bbox in enumerate(tiles, start=1):
        print(f"[{idx}/{len(tiles)}] roads {bbox}")
        data = fetch_tile(bbox, cache_dir)
        for element in data.get("elements", []):
            if element.get("type") != "way":
                continue
            feature = to_feature(element)
            if feature:
                by_id[feature["id"]] = feature

    features = list(by_id.values())
    counts: dict[str, int] = {}
    for feature in features:
        key = feature["properties"]["fclass"]
        counts[key] = counts.get(key, 0) + 1

    output = {
        "type": "FeatureCollection",
        "name": "Shanghai visual-demo roads · OSM",
        "properties": {
            "source": "OpenStreetMap via Overpass",
            "license": "ODbL",
            "bbox": [w, s, e, n],
            "classes": counts,
        },
        "features": features,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(features):,} real OSM road ways -> {args.out}")
    print(json.dumps(counts, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
