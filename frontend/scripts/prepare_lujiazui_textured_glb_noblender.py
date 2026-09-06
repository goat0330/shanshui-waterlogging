#!/usr/bin/env python3
"""Stage the purchased OBJ/MTL asset and convert it to a verified GLB.

The source MTL contains Windows/Chinese paths to missing TGA files. This script
keeps only resolvable source images, adds material-name matches only when an
image has the exact asset stem, and refuses to call zero-texture output
successful when usable texture maps were found.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tif", ".tiff", ".webp"}
MAP_KEYS = {
    "map_ka", "map_kd", "map_ks", "map_ns", "map_d", "map_bump", "bump",
    "disp", "decal", "refl", "norm", "map_pr", "map_pm", "map_ps", "map_ke",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--obj", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--stage", required=True)
    parser.add_argument("--obj2gltf-version", default="3.2.0")
    return parser.parse_args()


def normalized(value: str) -> str:
    return value.strip().strip("\"'").replace("\\", "/").casefold()


def texture_index(root: Path) -> tuple[dict[str, list[Path]], dict[str, Path]]:
    by_name: dict[str, list[Path]] = {}
    by_stem: dict[str, Path] = {}
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.casefold() not in IMAGE_EXTENSIONS:
            continue
        by_name.setdefault(path.name.casefold(), []).append(path)
        by_stem.setdefault(path.stem.casefold(), path)
    return by_name, by_stem


def resolve_reference(reference: str, root: Path, by_name: dict[str, list[Path]]) -> Path | None:
    clean = normalized(reference)
    if not clean:
        return None
    direct = root / reference.strip().strip("\"'").replace("\\", "/")
    if direct.is_file():
        return direct
    candidates = by_name.get(Path(clean).name.casefold(), [])
    return sorted(candidates, key=lambda path: (len(path.parts), str(path).casefold()))[0] if candidates else None


def material_texture(material: str, by_stem: dict[str, Path]) -> Path | None:
    return by_stem.get(material.casefold())


def stage_asset(obj: Path, stage: Path) -> tuple[Path, int, int, list[str]]:
    mtl = obj.with_suffix(".mtl")
    if not obj.is_file() or not mtl.is_file():
        raise SystemExit(f"OBJ/MTL not found: {obj}")
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True, exist_ok=True)
    by_name, by_stem = texture_index(obj.parent)
    copied: dict[Path, str] = {}
    missing: list[str] = []
    output_mtl: list[str] = []
    current_material = ""
    has_diffuse = False
    map_count = 0

    def staged_name(path: Path) -> str:
        if path not in copied:
            digest = hashlib.sha1(str(path).encode("utf-8", errors="ignore")).hexdigest()[:8]
            copied[path] = f"tex_{len(copied) + 1:03d}_{digest}{path.suffix.lower()}"
            shutil.copy2(path, stage / copied[path])
        return copied[path]

    for line in mtl.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("newmtl "):
            current_material = stripped[7:].strip()
            has_diffuse = False
            output_mtl.append(line)
            fallback = material_texture(current_material, by_stem)
            if fallback:
                output_mtl.append(f"map_Kd {staged_name(fallback)}")
                has_diffuse = True
            continue
        if not stripped or stripped.startswith("#"):
            output_mtl.append(line)
            continue
        parts = stripped.split(maxsplit=1)
        key = parts[0]
        rest = parts[1] if len(parts) > 1 else ""
        if key.casefold() not in MAP_KEYS:
            output_mtl.append(line)
            continue
        map_count += 1
        resolved = resolve_reference(rest.split()[-1], obj.parent, by_name)
        if resolved:
            output_mtl.append(f"{key} {staged_name(resolved)}")
            has_diffuse = has_diffuse or key.casefold() == "map_kd"
        else:
            missing.append(f"{key} {rest}".strip())
            if not has_diffuse:
                fallback = material_texture(current_material, by_stem)
                if fallback:
                    output_mtl.append(f"map_Kd {staged_name(fallback)}")
                    has_diffuse = True

    staged_mtl = stage / "lujiazui.mtl"
    staged_mtl.write_text("\n".join(output_mtl) + "\n", encoding="utf-8")
    output_obj: list[str] = []
    mtl_written = False
    for line in obj.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        if line.lstrip().casefold().startswith("mtllib "):
            if not mtl_written:
                output_obj.append("mtllib lujiazui.mtl")
                mtl_written = True
            continue
        output_obj.append(line)
    if not mtl_written:
        output_obj.insert(0, "mtllib lujiazui.mtl")
    staged_obj = stage / "lujiazui.obj"
    staged_obj.write_text("\n".join(output_obj) + "\n", encoding="utf-8")
    return staged_obj, map_count, len(copied), missing


def read_glb_json(path: Path) -> dict:
    raw = path.read_bytes()
    magic, version, total_length = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF" or version != 2 or total_length != len(raw):
        raise ValueError("Invalid GLB v2 header")
    chunk_length, chunk_type = struct.unpack_from("<II", raw, 12)
    if chunk_type != 0x4E4F534A:
        raise ValueError("First GLB chunk is not JSON")
    return json.loads(raw[20 : 20 + chunk_length].decode("utf-8").rstrip(" \t\r\n\x00"))


def verify_glb(path: Path) -> dict[str, int]:
    payload = read_glb_json(path)
    images = payload.get("images") or []
    return {
        "images": len(images),
        "textures": len(payload.get("textures") or []),
        "materials": len(payload.get("materials") or []),
        "embeddedImages": sum(1 for image in images if isinstance(image, dict) and "bufferView" in image),
        "externalImages": sum(1 for image in images if isinstance(image, dict) and "uri" in image),
    }


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    obj = Path(args.obj).resolve()
    out = Path(args.out).resolve()
    stage = Path(args.stage).resolve()
    if not obj.is_file():
        candidates = list(Path.cwd().glob("data/source/obj/lujiazui-camera-max/*/A.obj"))
        if len(candidates) == 1:
            obj = candidates[0].resolve()
    if not out.parent.is_dir():
        out = (Path.cwd() / "frontend/public/runtime/lujiazui-camera-max/lujiazui.glb").resolve()
    staged_obj, map_count, copied, missing = stage_asset(obj, stage)
    print(f"[stage] obj={staged_obj} mapDirectives={map_count} copiedTextures={copied} unresolved={len(missing)}")
    for item in missing[:20]:
        print(f"[texture-unresolved] {item}")
    out.parent.mkdir(parents=True, exist_ok=True)
    npx = "npx.cmd" if sys.platform == "win32" else "npx"
    command = [npx, "--yes", f"obj2gltf@{args.obj2gltf_version}", "-i", str(staged_obj), "-o", str(out)]
    print("[convert] " + " ".join(command))
    result = subprocess.run(command, cwd=stage, check=False)
    if result.returncode:
        raise SystemExit(f"obj2gltf failed with exit code {result.returncode}")
    stats = verify_glb(out)
    print("[verify] " + " ".join(f"{key}={value}" for key, value in stats.items()))
    if copied and (stats["textures"] == 0 or stats["embeddedImages"] == 0):
        raise SystemExit("Conversion produced no embedded GLB textures for staged source images.")
    if stats["externalImages"]:
        raise SystemExit("GLB still references external images; expected a self-contained GLB.")
    if missing:
        print(f"[warning] unresolved MTL maps={len(missing)}; matched source image assets were embedded.")
    shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    main()
