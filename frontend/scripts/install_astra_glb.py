#!/usr/bin/env python3
"""Install and fingerprint the final Astra GLB for GitHub/Render deployment.

Run from repository root:
  python frontend/scripts/install_astra_glb.py

The script auto-detects ../lujiazui-astra/export/lujiazui_astra_web.glb,
verifies basic GLB structure, copies it to the runtime path if it is below the
GitHub regular-file limit, and writes a committed cache-version module + JSON
manifest. If the asset exceeds the limit, use external object storage and set
VITE_LUJIAZUI_GLB_URL in Render instead of committing the binary.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
from pathlib import Path

GITHUB_REGULAR_FILE_LIMIT = 100 * 1024 * 1024
KNOWN_OLD_REMOTE_SIZE = 97_315_476


def find_repo_root(start: Path) -> Path:
    p = start.resolve()
    for candidate in [p, *p.parents]:
        if (candidate / "frontend" / "src" / "CesiumScene.tsx").exists():
            return candidate
    raise SystemExit("Could not locate repository root containing frontend/src/CesiumScene.tsx")


def inspect_glb(path: Path) -> dict:
    with path.open("rb") as f:
        header = f.read(12)
        if len(header) != 12:
            raise SystemExit(f"Invalid GLB header: {path}")
        magic, version, total_length = struct.unpack("<4sII", header)
        if magic != b"glTF" or version != 2:
            raise SystemExit(f"Expected glTF 2.0 GLB: {path}")
        chunk_header = f.read(8)
        if len(chunk_header) != 8:
            raise SystemExit("Missing GLB JSON chunk")
        chunk_length, chunk_type = struct.unpack("<II", chunk_header)
        if chunk_type != 0x4E4F534A:  # JSON
            raise SystemExit("First GLB chunk is not JSON")
        document = json.loads(f.read(chunk_length).decode("utf-8").rstrip("\x00 \t\r\n"))
    actual_size = path.stat().st_size
    if total_length != actual_size:
        raise SystemExit(f"GLB length mismatch: header={total_length}, file={actual_size}")
    return {
        "size": actual_size,
        "materials": len(document.get("materials") or []),
        "images": len(document.get("images") or []),
        "textures": len(document.get("textures") or []),
        "meshes": len(document.get("meshes") or []),
        "nodes": len(document.get("nodes") or []),
    }


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def default_source(repo: Path) -> Path | None:
    candidates = [
        repo.parent / "lujiazui-astra" / "export" / "lujiazui_astra_web.glb",
        repo / "lujiazui-astra" / "export" / "lujiazui_astra_web.glb",
        repo.parent / "lujiazui_astra_web.glb",
    ]
    return next((p for p in candidates if p.exists()), None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--source", type=Path)
    parser.add_argument("--allow-old", action="store_true", help="Allow installing the known 97,315,476-byte baseline asset")
    args = parser.parse_args()

    repo = find_repo_root(args.repo)
    source = args.source.resolve() if args.source else default_source(repo)
    if source is None or not source.exists():
        raise SystemExit(
            "Final Astra GLB not found. Pass --source PATH or place it at "
            f"{repo.parent / 'lujiazui-astra/export/lujiazui_astra_web.glb'}"
        )

    meta = inspect_glb(source)
    if meta["size"] == KNOWN_OLD_REMOTE_SIZE and not args.allow_old:
        raise SystemExit("Refusing to install the known old remote GLB. Use the final lujiazui_astra_web.glb instead.")
    if meta["images"] < 1:
        raise SystemExit("Astra GLB has no embedded images; refusing deployment asset install.")

    digest = sha256(source)
    version = f"astra-{digest[:12]}"
    destination = repo / "frontend/public/runtime/lujiazui-camera-max/lujiazui.glb"
    manifest = repo / "frontend/public/runtime/lujiazui-camera-max/lujiazui.asset.json"
    version_module = repo / "frontend/src/scene/lujiazuiAssetVersion.ts"

    print(f"Source: {source}")
    print(f"Size: {meta['size']:,} bytes ({meta['size'] / 1024 / 1024:.2f} MiB)")
    print(f"materials={meta['materials']} images={meta['images']} textures={meta['textures']} meshes={meta['meshes']}")
    print(f"sha256={digest}")

    if meta["size"] > GITHUB_REGULAR_FILE_LIMIT:
        raise SystemExit(
            "Final GLB exceeds GitHub's 100 MiB regular-file limit. Do not commit it as normal Git. "
            "Host it externally and set VITE_LUJIAZUI_GLB_URL in Render, or compress it below 100 MiB first."
        )

    destination.parent.mkdir(parents=True, exist_ok=True)
    if source != destination.resolve():
        shutil.copy2(source, destination)
    installed_digest = sha256(destination)
    if installed_digest != digest:
        raise SystemExit("Copied GLB hash mismatch")

    manifest.write_text(json.dumps({
        "version": version,
        "sha256": digest,
        **meta,
        "sourceName": source.name,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    version_module.write_text(
        "// Generated by frontend/scripts/install_astra_glb.py. Commit with the runtime GLB.\n"
        f"export const LUJIAZUI_ASSET_VERSION = '{version}'\n",
        encoding="utf-8",
    )

    print(f"Installed: {destination}")
    print(f"Manifest:  {manifest}")
    print(f"Version:   {version_module} -> {version}")
    print("Next: git add the GLB, manifest, and lujiazuiAssetVersion.ts together, then run npm run verify:visual-demo.")


if __name__ == "__main__":
    main()
