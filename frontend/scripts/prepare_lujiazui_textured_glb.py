"""Prepare the purchased Lujiazui OBJ/MTL/textures for Cesium.

Run with Blender in background mode, for example on Windows:

blender --background --python scripts/prepare_lujiazui_textured_glb.py -- ^
  --obj "D:\\...\\10-上海浦东陆家嘴群楼镜头\\A.obj" ^
  --out "D:\\...\\frontend\\public\\runtime\\lujiazui-camera-max\\lujiazui.glb" ^
  --blend-out "D:\\...\\data\\runtime\\lujiazui-camera-max\\lujiazui-material-pass.blend"

The script deliberately preserves object transforms/geometry. It only relinks and
packs source images, removes known helper objects, applies conservative PBR
roughness defaults, then exports a GLB. It does not georeference the city; WGS84
calibration is handled in Cesium so source geometry remains untouched.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bpy


HELPER_NAMES = {"Sphere01", "Plane01"}
GLASS_TOKENS = ("glass", "window", "curtain", "幕墙", "玻璃", "窗")
STONE_TOKENS = ("stone", "marble", "granite", "brick", "石", "砖")
METAL_TOKENS = ("metal", "aluminium", "aluminum", "steel", "铝", "钢", "金属")


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--obj", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--blend-out", default="")
    return parser.parse_args(argv)


def import_obj(path: Path) -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    try:
        bpy.ops.wm.obj_import(filepath=str(path), forward_axis="NEGATIVE_Z", up_axis="Y")
    except (AttributeError, TypeError):
        # Blender <= 3.x fallback.
        bpy.ops.import_scene.obj(filepath=str(path), axis_forward="-Z", axis_up="Y")


def index_texture_files(root: Path) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for candidate in root.rglob("*"):
        if candidate.is_file() and candidate.suffix.lower() in {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".gif"}:
            result.setdefault(candidate.name.lower(), candidate)
    return result


def relink_and_pack_images(root: Path) -> tuple[int, int]:
    indexed = index_texture_files(root)
    relinked = 0
    missing = 0
    for image in bpy.data.images:
        if image.source != "FILE":
            continue
        current = Path(bpy.path.abspath(image.filepath)) if image.filepath else None
        if current and current.exists():
            resolved = current
        else:
            basename = Path(image.filepath).name.lower() if image.filepath else image.name.lower()
            resolved = indexed.get(basename)
        if resolved is None:
            missing += 1
            print(f"[texture-missing] {image.name} filepath={image.filepath}")
            continue
        try:
            image.filepath = str(resolved)
            image.reload()
            if image.packed_file is None:
                image.pack()
            relinked += 1
        except Exception as exc:  # noqa: BLE001 - Blender data can be inconsistent
            missing += 1
            print(f"[texture-error] {image.name}: {exc}")
    return relinked, missing


def principled_node(material: bpy.types.Material):
    if not material.use_nodes:
        material.use_nodes = True
    nodes = material.node_tree.nodes if material.node_tree else []
    return next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)


def set_unlinked(node, name: str, value) -> None:
    socket = node.inputs.get(name)
    if socket is not None and not socket.is_linked:
        socket.default_value = value


def tune_materials() -> dict[str, int]:
    counts = {"glass": 0, "stone": 0, "metal": 0, "other": 0}
    for material in bpy.data.materials:
        node = principled_node(material)
        if node is None:
            continue
        name = material.name.lower()
        if any(token in name for token in GLASS_TOKENS):
            # City-scale curtain wall: reflective, not physically transparent.
            # This maps more reliably to Cesium/glTF than transmission glass.
            set_unlinked(node, "Roughness", 0.20)
            set_unlinked(node, "Metallic", 0.0)
            set_unlinked(node, "IOR", 1.45)
            set_unlinked(node, "Coat Weight", 0.35)
            set_unlinked(node, "Clearcoat", 0.35)  # Blender 3.x name
            counts["glass"] += 1
        elif any(token in name for token in METAL_TOKENS):
            set_unlinked(node, "Roughness", 0.36)
            set_unlinked(node, "Metallic", 0.72)
            counts["metal"] += 1
        elif any(token in name for token in STONE_TOKENS):
            set_unlinked(node, "Roughness", 0.72)
            set_unlinked(node, "Metallic", 0.0)
            counts["stone"] += 1
        else:
            # Do not flatten imported source materials. Only give completely
            # un-authored materials a neutral city-scale roughness.
            set_unlinked(node, "Roughness", 0.58)
            counts["other"] += 1
    return counts


def remove_helpers() -> list[str]:
    removed: list[str] = []
    for obj in list(bpy.data.objects):
        if obj.name in HELPER_NAMES:
            removed.append(obj.name)
            bpy.data.objects.remove(obj, do_unlink=True)
    return removed


def export_glb(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        export_apply=True,
        export_cameras=False,
        export_lights=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_yup=True,
    )


def main() -> None:
    args = parse_args()
    obj = Path(args.obj).resolve()
    out = Path(args.out).resolve()
    if not obj.exists():
        raise SystemExit(f"OBJ not found: {obj}")
    print(f"[input] {obj}")
    import_obj(obj)
    removed = remove_helpers()
    relinked, missing = relink_and_pack_images(obj.parent)
    counts = tune_materials()
    if args.blend_out:
        blend_out = Path(args.blend_out).resolve()
        blend_out.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(blend_out))
        print(f"[blend] {blend_out}")
    export_glb(out)
    print(f"[output] {out}")
    print(f"[summary] objects={len(bpy.data.objects)} materials={len(bpy.data.materials)} images={len(bpy.data.images)} relinked={relinked} missing={missing} helpers_removed={removed} material_groups={counts}")
    if missing:
        print("[warning] Some source images could not be relinked. Inspect the printed names before judging material quality.")


if __name__ == "__main__":
    main()
