#!/usr/bin/env python3
"""Extract 48 angled flower frames per species from Seedance 2.5 MP4s,
run Apple Vision neural matting, apply hole-filling + temporal stabilization +
dark-backdrop de-fringing + horizontal blossom alignment, compute headYRatio &
stemBottomRatio, export 512x512 RGBA WebPs, generate checkerboard|dark-canvas
QA sheets, convert bg-foliage to 1920x1080 WebP, and write public/species.json.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import glob
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
ASSETS_BUDS = ROOT / "assets" / "buds"
ASSETS_VIDEOS = ROOT / "assets" / "videos"
REVIEW_DIR = ROOT / "assets" / "review"
PUBLIC_SPRITES = ROOT / "public" / "sprites"
PUBLIC_BG = ROOT / "public" / "bg-foliage.webp"
SPECIES_JSON = ROOT / "public" / "species.json"
MATTE_BIN = ROOT / "scripts" / "matte_frames"

FRAME_SIZE = 512
TARGET_FRAMES = 48
DARK_BG_RGB = (22, 29, 23)  # #161D17

SPECIES = [
    {"id": "peony", "zhName": "粉牡丹", "enName": "Sarah Bernhardt Peony", "pollenColor": "#F2C5D0", "weight": 1.15},
    {"id": "crimson-rose", "zhName": "丝绒玫瑰", "enName": "Velvet Crimson Rose", "pollenColor": "#F2B8B8", "weight": 1.10},
    {"id": "amber-tulip", "zhName": "金杏郁金香", "enName": "Apricot Double Tulip", "pollenColor": "#F6D48F", "weight": 1.00},
    {"id": "iris", "zhName": "暮紫鸢尾", "enName": "Twilight Bearded Iris", "pollenColor": "#D5C4F2", "weight": 0.95},
    {"id": "camellia", "zhName": "白山茶", "enName": "Ivory Camellia", "pollenColor": "#F5EBD4", "weight": 1.00},
]


def probe_duration(video_path: Path) -> float:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        text=True,
    ).strip()
    dur = float(out)
    return dur if dur > 0 else 5.0


def extract_raw_pngs(video_path: Path, raw_dir: Path, duration: float) -> list[Path]:
    raw_dir.mkdir(parents=True, exist_ok=True)
    fps_expr = f"{TARGET_FRAMES + 0.4:.4f}/{duration:.6f}"
    vf = (
        f"fps={fps_expr},"
        f"scale={FRAME_SIZE}:{FRAME_SIZE}:force_original_aspect_ratio=decrease,"
        f"pad={FRAME_SIZE}:{FRAME_SIZE}:(ow-iw)/2:(oh-ih)/2:color=#161D17"
    )
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(video_path),
            "-vf",
            vf,
            "-frames:v",
            str(TARGET_FRAMES),
            "-start_number",
            "0",
            str(raw_dir / "frame_%03d.png"),
        ],
        check=True,
    )
    return sorted(raw_dir.glob("frame_*.png"))


def refine_and_align(raw_paths: list[Path], mask_dir: Path) -> tuple[np.ndarray, float, float]:
    """Refine Vision masks for dark chiaroscuro botanical stems, align horizontally,
    and return (rgba_stack, head_y_ratio, stem_bottom_ratio).
    """
    n = len(raw_paths)
    rgb_stack = np.zeros((n, FRAME_SIZE, FRAME_SIZE, 3), dtype=np.float32)
    alpha_stack = np.zeros((n, FRAME_SIZE, FRAME_SIZE), dtype=np.float32)

    for i, raw_path in enumerate(raw_paths):
        rgb_stack[i] = np.array(Image.open(raw_path).convert("RGB"), dtype=np.float32)
        mask_path = mask_dir / raw_path.name
        if mask_path.exists():
            m = np.array(Image.open(mask_path).convert("L"), dtype=np.float32) / 255.0
        else:
            m = np.zeros((FRAME_SIZE, FRAME_SIZE), dtype=np.float32)

        # Fill interior dark-shadow or pale-petal holes inside the flower/leaves.
        solid = m > 0.35
        filled = ndimage.binary_fill_holes(solid)
        interior_holes = filled & (~solid)
        if np.any(interior_holes):
            hole_blend = cv2.GaussianBlur(interior_holes.astype(np.float32), (0, 0), 1.0)
            m = np.maximum(m, np.clip(hole_blend * 1.15, 0.0, 1.0))

        # Remove stray dust islands while keeping petals/leaves >= 0.3% of main body.
        labeled, num = ndimage.label(m > 0.20)
        if num > 1:
            sizes = ndimage.sum(m > 0.20, labeled, range(1, num + 1))
            max_label = int(np.argmax(sizes)) + 1
            keep = labeled == max_label
            threshold_area = sizes[max_label - 1] * 0.003
            for lbl in range(1, num + 1):
                if sizes[lbl - 1] >= threshold_area:
                    keep |= labeled == lbl
            m = np.where(keep, m, 0.0)

        alpha_stack[i] = m

    # Temporal smoothing across adjacent frames (preserve first & last frames).
    if n >= 3:
        smoothed = alpha_stack.copy()
        for i in range(1, n - 1):
            smoothed[i] = 0.18 * alpha_stack[i - 1] + 0.64 * alpha_stack[i] + 0.18 * alpha_stack[i + 1]
        alpha_stack = smoothed

    # Estimate dark studio backdrop RGB from upper corners across frames.
    corner_samples = np.concatenate(
        [
            rgb_stack[:, :24, :24].reshape(-1, 3),
            rgb_stack[:, :24, -24:].reshape(-1, 3),
        ],
        axis=0,
    )
    bg_rgb = np.median(corner_samples, axis=0)

    rgba_stack = np.zeros((n, FRAME_SIZE, FRAME_SIZE, 4), dtype=np.uint8)
    for i in range(n):
        a = cv2.GaussianBlur(alpha_stack[i], (0, 0), 0.7)
        a = np.clip((a - 0.04) / 0.88, 0.0, 1.0)

        edge_band = (a > 0.02) & (a < 0.88)
        rgb = rgb_stack[i].copy()
        if np.any(edge_band):
            denom = np.maximum(a[..., None], 0.18)
            unmixed = np.clip((rgb - (1.0 - a[..., None]) * bg_rgb) / denom, 0.0, 255.0)
            mix = np.clip((0.88 - a) / 0.86, 0.0, 0.85)[..., None]
            rgb = np.where(edge_band[..., None], rgb * (1.0 - mix) + unmixed * mix, rgb)

        rgb = np.where((a > 0.004)[..., None], rgb, 0.0)
        rgba_stack[i, ..., :3] = np.clip(np.round(rgb), 0, 255).astype(np.uint8)
        rgba_stack[i, ..., 3] = np.clip(np.round(a * 255.0), 0, 255).astype(np.uint8)

    # Align blossom horizontally to center (x=256) without altering vertical stem grounding.
    final_alpha = rgba_stack[-1, ..., 3].astype(np.float32)
    upper_cut = int(FRAME_SIZE * 0.65)
    upper_alpha = final_alpha[:upper_cut, :]
    mass_upper = float(np.sum(upper_alpha))
    if mass_upper > 50.0:
        ys_u, xs_u = np.indices((upper_cut, FRAME_SIZE))
        cx = float(np.sum(xs_u * upper_alpha) / mass_upper)
        cy = float(np.sum(ys_u * upper_alpha) / mass_upper)

        union_mask = np.max(rgba_stack[..., 3], axis=0) > 12
        nz_y, nz_x = np.where(union_mask)
        if len(nz_x) > 0:
            min_x, max_x = int(nz_x.min()), int(nz_x.max())
            dx = int(round((FRAME_SIZE / 2.0) - cx))
            dx = max(2 - min_x, min((FRAME_SIZE - 3) - max_x, dx))
            if dx != 0:
                shifted = np.zeros_like(rgba_stack)
                src_x0 = max(0, -dx)
                src_x1 = min(FRAME_SIZE, FRAME_SIZE - dx)
                dst_x0 = max(0, dx)
                dst_x1 = min(FRAME_SIZE, FRAME_SIZE + dx)
                shifted[:, :, dst_x0:dst_x1, :] = rgba_stack[:, :, src_x0:src_x1, :]
                rgba_stack = shifted

        head_y_ratio = max(0.24, min(0.58, cy / FRAME_SIZE))
        stem_bottom_ratio = max(0.70, min(0.99, float(nz_y.max()) / FRAME_SIZE)) if len(nz_y) > 0 else 0.96
    else:
        head_y_ratio = 0.40
        stem_bottom_ratio = 0.96

    return rgba_stack, round(head_y_ratio, 3), round(stem_bottom_ratio, 3)


def save_webp_sprites(rgba_stack: np.ndarray, out_dir: Path) -> list[Path]:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    def write_one(idx: int) -> Path:
        dest = out_dir / f"frame_{idx:03d}.webp"
        Image.fromarray(rgba_stack[idx], mode="RGBA").save(dest, format="WEBP", quality=85, method=4)
        return dest

    with ThreadPoolExecutor(max_workers=8) as pool:
        return sorted(pool.map(write_one, range(len(rgba_stack))))


def make_split_qa_tile(rgba: np.ndarray, tile_size: int = 384) -> Image.Image:
    """Left half checkerboard, right half dark oil-painting backdrop (#161D17)."""
    sprite = Image.fromarray(rgba, mode="RGBA").resize((tile_size, tile_size), Image.Resampling.LANCZOS)
    bg = np.zeros((tile_size, tile_size, 3), dtype=np.uint8)
    half = tile_size // 2

    cell = 16
    yy, xx = np.indices((tile_size, half))
    checker = ((xx // cell) + (yy // cell)) % 2 == 0
    bg[:, :half] = np.where(checker[..., None], (224, 224, 224), (184, 184, 184))
    bg[:, half:] = DARK_BG_RGB

    canvas = Image.fromarray(bg, mode="RGB").convert("RGBA")
    canvas.alpha_composite(sprite)
    rgb_out = canvas.convert("RGB")
    draw = ImageDraw.Draw(rgb_out)
    draw.line([(half, 0), (half, tile_size)], fill=(120, 120, 120), width=1)
    return rgb_out


def build_oil_contact_sheet(rgba_stack: np.ndarray, output_jpg: Path) -> None:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    tile = 384
    sheet = Image.new("RGB", (tile * 3, tile * 2), DARK_BG_RGB)
    draw = ImageDraw.Draw(sheet)

    indices = [round(i * (len(rgba_stack) - 1) / 5) for i in range(6)]
    for pos, idx in enumerate(indices):
        col = pos % 3
        row = pos // 3
        x0, y0 = col * tile, row * tile
        sheet.paste(make_split_qa_tile(rgba_stack[idx], tile), (x0, y0))
        draw.rectangle([x0 + 10, y0 + 10, x0 + 68, y0 + 34], fill=(240, 236, 228))
        draw.text((x0 + 16, y0 + 16), f"f{idx:02d}", fill=(25, 25, 25))

    sheet.save(output_jpg, format="JPEG", quality=90)


def export_bg_foliage() -> None:
    candidates = sorted(glob.glob(str(ASSETS_BUDS / "bg-foliage" / "*" / "task-artifact-0.png")))
    if not candidates:
        fallback = ASSETS_BUDS / "bg-foliage.png"
        if fallback.exists():
            candidates = [str(fallback)]
    if not candidates:
        raise FileNotFoundError("Missing bg-foliage image under assets/buds/bg-foliage/")

    src = Path(candidates[-1])
    with Image.open(src) as im:
        resized = im.convert("RGB").resize((1920, 1080), Image.Resampling.LANCZOS)
        resized.save(PUBLIC_BG, format="WEBP", quality=86, method=4)
    print(f"[OK] Exported {PUBLIC_BG.relative_to(ROOT)} (1920x1080 WebP)")


def main() -> None:
    if not MATTE_BIN.exists():
        raise FileNotFoundError(f"Compiled matte binary missing: {MATTE_BIN}")

    export_bg_foliage()
    PUBLIC_SPRITES.mkdir(parents=True, exist_ok=True)
    manifest = []

    for spec in SPECIES:
        sid = spec["id"]
        video_path = ASSETS_VIDEOS / f"{sid}.mp4"
        if not video_path.exists():
            raise FileNotFoundError(f"Missing video: {video_path}")

        duration = probe_duration(video_path)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            raw_dir = tmp_path / "raw"
            mask_dir = tmp_path / "masks"
            raw_paths = extract_raw_pngs(video_path, raw_dir, duration)
            subprocess.run([str(MATTE_BIN), str(raw_dir), str(mask_dir)], check=True)
            rgba_stack, head_y_ratio, stem_bottom_ratio = refine_and_align(raw_paths, mask_dir)

        out_dir = PUBLIC_SPRITES / sid
        saved = save_webp_sprites(rgba_stack, out_dir)
        qa_path = REVIEW_DIR / f"{sid}_oil_sheet.jpg"
        build_oil_contact_sheet(rgba_stack, qa_path)

        manifest.append(
            {
                **spec,
                "frameDir": f"/sprites/{sid}",
                "frameCount": len(saved),
                "headYRatio": head_y_ratio,
                "stemBottomRatio": stem_bottom_ratio,
            }
        )
        print(
            f"[OK] {sid}: dur={duration:.2f}s sprites={len(saved)} "
            f"headY={head_y_ratio} stemBottom={stem_bottom_ratio} qa={qa_path.relative_to(ROOT)}"
        )

    SPECIES_JSON.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[OK] Wrote {SPECIES_JSON.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
