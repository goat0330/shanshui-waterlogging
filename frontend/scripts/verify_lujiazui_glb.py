#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path


def read_glb_json(path: Path) -> dict:
    raw = path.read_bytes()
    if len(raw) < 20:
        raise SystemExit("GLB too small")
    magic, version, total_length = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF" or version != 2 or total_length != len(raw):
        raise SystemExit("Invalid GLB v2 header")
    chunk_length, chunk_type = struct.unpack_from("<II", raw, 12)
    if chunk_type != 0x4E4F534A:
        raise SystemExit("First GLB chunk is not JSON")
    return json.loads(raw[20 : 20 + chunk_length].decode("utf-8").rstrip(" \t\r\n\x00"))


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("glb")
    args = parser.parse_args()
    path = Path(args.glb).resolve()
    payload = read_glb_json(path)
    images = payload.get("images") or []
    stats = {
        "path": str(path),
        "sizeMB": round(path.stat().st_size / 1024 / 1024, 2),
        "meshes": len(payload.get("meshes") or []),
        "nodes": len(payload.get("nodes") or []),
        "materials": len(payload.get("materials") or []),
        "textures": len(payload.get("textures") or []),
        "images": len(images),
        "embeddedImages": sum(1 for image in images if isinstance(image, dict) and "bufferView" in image),
        "externalImages": sum(1 for image in images if isinstance(image, dict) and "uri" in image),
    }
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
