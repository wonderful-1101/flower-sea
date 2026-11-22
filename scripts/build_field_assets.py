#!/usr/bin/env python3
"""Extract 54 overhead flower frames per species, run Apple Vision neural matting,
apply temporal stabilization + hole filling + de-fringing + center-of-mass alignment,
save 512x512 RGBA WebP sprites, build checkerboard QA contact sheets, and write public/species.json.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
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
ASSETS_VIDEOS = ROOT / "assets" / "videos"
REVIEW_DIR = ROOT / "assets" / "review"
PUBLIC_SPRITES = ROOT / "public" / "sprites"
SPECIES_JSON = ROOT / "public" / "species.json"
MATTE_BIN = ROOT / "scripts" / "matte_frames"

FRAME_SIZE = 512
TARGET_FRAMES = 54
PAPER_RGB = (244, 241, 234)  # #F4F1EA

SPECIES = [
    {"id": "peony", "zhName": "牡丹", "enName": "Peony", "pollenColor": "#E8B0BA", "weight": 1.15},
    {"id": "camellia", "zhName": "山茶", "enName": "Camellia", "pollenColor": "#EAE0C8", "weight": 1.0},
    {"id": "ranunculus", "zhName": "洋牡丹", "enName": "Ranunculus", "pollenColor": "#F0B694", "weight": 1.1},
    {"id": "anemone", "zhName": "银莲花", "enName": "Anemone", "pollenColor": "#BFAEE0", "weight": 0.95},
]


def probe_duration(video_path: Path) -> float:
    """Return video duration in seconds via ffprobe."""
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
    """Extract TARGET_FRAMES evenly spaced 512x512 PNGs into raw_dir."""
    raw_dir.mkdir(parents=True, exist_ok=True)
    fps_expr = f"{TARGET_FRAMES + 0.4:.4f}/{duration:.6f}"
    vf = (
        f"fps={fps_expr},"
        f"scale={FRAME_SIZE}:{FRAME_SIZE}:force_original_aspect_ratio=decrease,"
        f"pad={FRAME_SIZE}:{FRAME_SIZE}:(ow-iw)/2:(oh-ih)/2:color=#F4F1EA"
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


def refine_and_align(raw_paths: list[Path], mask_dir: Path) -> np.ndarray:
    """Load RGB + Vision masks, fill holes, smooth temporally, defringe, and align center-of-mass."""
    n = len(raw_paths)
    rgb_stack = np.zeros((n, FRAME_SIZE, FRAME_SIZE, 3), dtype=np.float32)
    alpha_stack = np.zeros((n, FRAME_SIZE, FRAME_SIZE), dtype=np.float32)

    for i, raw_path in enumerate(raw_paths):
        rgb = np.array(Image.open(raw_path).convert("RGB"), dtype=np.float32)
        rgb_stack[i] = rgb

        mask_path = mask_dir / raw_path.name
        if mask_path.exists():
            m = np.array(Image.open(mask_path).convert("L"), dtype=np.float32) / 255.0
        else:
            m = np.zeros((FRAME_SIZE, FRAME_SIZE), dtype=np.float32)

        # Fill interior holes inside solid petals (e.g., bright ivory camellia centers).
        solid = m > 0.35
        filled = ndimage.binary_fill_holes(solid)
        interior_holes = filled & (~solid)
        if np.any(interior_holes):
            # Dilate slightly so hole boundary transitions cleanly.
            hole_blend = cv2.GaussianBlur(interior_holes.astype(np.float32), (0, 0), 1.0)
            m = np.maximum(m, np.clip(hole_blend * 1.15, 0.0, 1.0))

        # Remove tiny isolated speckle islands far from the main flower body.
        labeled, num = ndimage.label(m > 0.20)
        if num > 1:
            sizes = ndimage.sum(m > 0.20, labeled, range(1, num + 1))
            max_label = int(np.argmax(sizes)) + 1
            keep = labeled == max_label
            # Also keep minor nearby petal tips/leaves >= 0.4% of main component.
            threshold_area = sizes[max_label - 1] * 0.004
            for lbl in range(1, num + 1):
                if sizes[lbl - 1] >= threshold_area:
                    keep |= labeled == lbl
            m = np.where(keep, m, 0.0)

        alpha_stack[i] = m

    # Temporal stabilization across adjacent frames (keep endpoints crisp).
    if n >= 3:
        smoothed = alpha_stack.copy()
        for i in range(1, n - 1):
            smoothed[i] = 0.18 * alpha_stack[i - 1] + 0.64 * alpha_stack[i] + 0.18 * alpha_stack[i + 1]
        alpha_stack = smoothed

    # Estimate studio background RGB from outer 24x24 corners across frames.
    corner_samples = np.concatenate(
        [
            rgb_stack[:, :24, :24].reshape(-1, 3),
            rgb_stack[:, :24, -24:].reshape(-1, 3),
            rgb_stack[:, -24:, :24].reshape(-1, 3),
            rgb_stack[:, -24:, -24:].reshape(-1, 3),
        ],
        axis=0,
    )
    bg_rgb = np.median(corner_samples, axis=0)

    rgba_stack = np.zeros((n, FRAME_SIZE, FRAME_SIZE, 4), dtype=np.uint8)
    for i in range(n):
        a = alpha_stack[i]
        # Subtle anti-alias & gentle contrast boost so core petals remain 100% opaque.
        a = cv2.GaussianBlur(a, (0, 0), 0.7)
        a = np.clip((a - 0.04) / 0.88, 0.0, 1.0)

        # Color de-fringing on outer semi-transparent boundary pixels to prevent cream halos.
        edge_band = (a > 0.02) & (a < 0.88)
        rgb = rgb_stack[i].copy()
        if np.any(edge_band):
            denom = np.maximum(a[..., None], 0.18)
            unmixed = np.clip((rgb - (1.0 - a[..., None]) * bg_rgb) / denom, 0.0, 255.0)
            mix = np.clip((0.88 - a) / 0.86, 0.0, 0.85)[..., None]
            rgb = np.where(edge_band[..., None], rgb * (1.0 - mix) + unmixed * mix, rgb)

        # Clean zero RGB in completely transparent pixels for better WebP compression.
        rgb = np.where((a > 0.004)[..., None], rgb, 0.0)

        rgba_stack[i, ..., :3] = np.clip(np.round(rgb), 0, 255).astype(np.uint8)
        rgba_stack[i, ..., 3] = np.clip(np.round(a * 255.0), 0, 255).astype(np.uint8)

    # Compute center-of-mass from the final full-bloom frame and shift uniformly without clipping.
    final_alpha = rgba_stack[-1, ..., 3].astype(np.float32)
    total_mass = float(np.sum(final_alpha))
    if total_mass > 100.0:
        ys, xs = np.indices((FRAME_SIZE, FRAME_SIZE))
        cx = float(np.sum(xs * final_alpha) / total_mass)
        cy = float(np.sum(ys * final_alpha) / total_mass)

        union_mask = np.max(rgba_stack[..., 3], axis=0) > 12
        nz_y, nz_x = np.where(union_mask)
        if len(nz_x) > 0:
            min_x, max_x = int(nz_x.min()), int(nz_x.max())
            min_y, max_y = int(nz_y.min()), int(nz_y.max())
            dx = int(round((FRAME_SIZE / 2.0) - cx))
            dy = int(round((FRAME_SIZE / 2.0) - cy))
            # Clamp shift to preserve every foreground pixel inside [2, FRAME_SIZE - 3].
            dx = max(2 - min_x, min((FRAME_SIZE - 3) - max_x, dx))
            dy = max(2 - min_y, min((FRAME_SIZE - 3) - max_y, dy))

            if dx != 0 or dy != 0:
                shifted = np.zeros_like(rgba_stack)
                src_x0 = max(0, -dx)
                src_x1 = min(FRAME_SIZE, FRAME_SIZE - dx)
                dst_x0 = max(0, dx)
                dst_x1 = min(FRAME_SIZE, FRAME_SIZE + dx)

                src_y0 = max(0, -dy)
                src_y1 = min(FRAME_SIZE, FRAME_SIZE - dy)
                dst_y0 = max(0, dy)
                dst_y1 = min(FRAME_SIZE, FRAME_SIZE + dy)

                shifted[:, dst_y0:dst_y1, dst_x0:dst_x1, :] = rgba_stack[:, src_y0:src_y1, src_x0:src_x1, :]
                rgba_stack = shifted

    return rgba_stack


def save_webp_sprites(rgba_stack: np.ndarray, out_dir: Path) -> list[Path]:
    """Save 512x512 RGBA WebP frames into out_dir."""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    def write_one(idx: int) -> Path:
        dest = out_dir / f"frame_{idx:03d}.webp"
        Image.fromarray(rgba_stack[idx], mode="RGBA").save(dest, format="WEBP", quality=85, method=4)
        return dest

    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = list(pool.map(write_one, range(len(rgba_stack))))
    return sorted(paths)


def make_split_qa_tile(rgba: np.ndarray, tile_size: int = 384) -> Image.Image:
    """Create a square QA tile: left half checkerboard, right half gallery paper #F4F1EA."""
    sprite = Image.fromarray(rgba, mode="RGBA").resize((tile_size, tile_size), Image.Resampling.LANCZOS)

    bg = np.zeros((tile_size, tile_size, 3), dtype=np.uint8)
    half = tile_size // 2

    # Neutral light grey-white checkerboard on left half.
    cell = 16
    yy, xx = np.indices((tile_size, half))
    checker = ((xx // cell) + (yy // cell)) % 2 == 0
    bg[:, :half] = np.where(checker[..., None], (232, 232, 232), (196, 196, 196))
    # Warm gallery paper on right half.
    bg[:, half:] = PAPER_RGB

    canvas = Image.fromarray(bg, mode="RGB").convert("RGBA")
    canvas.alpha_composite(sprite)
    rgb_out = canvas.convert("RGB")
    draw = ImageDraw.Draw(rgb_out)
    draw.line([(half, 0), (half, tile_size)], fill=(120, 120, 120), width=1)
    return rgb_out


def build_alpha_contact_sheet(rgba_stack: np.ndarray, output_jpg: Path) -> None:
    """Build 3x2 Transparency QA Contact Sheet over checkerboard | warm paper."""
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    tile = 384
    sheet = Image.new("RGB", (tile * 3, tile * 2), PAPER_RGB)
    draw = ImageDraw.Draw(sheet)

    indices = [round(i * (len(rgba_stack) - 1) / 5) for i in range(6)]
    for pos, idx in enumerate(indices):
        col = pos % 3
        row = pos // 3
        x0, y0 = col * tile, row * tile
        tile_img = make_split_qa_tile(rgba_stack[idx], tile)
        sheet.paste(tile_img, (x0, y0))
        draw.rectangle([x0 + 10, y0 + 10, x0 + 68, y0 + 34], fill=(255, 255, 255))
        draw.text((x0 + 16, y0 + 16), f"f{idx:02d}", fill=(30, 30, 30))

    sheet.save(output_jpg, format="JPEG", quality=90)


def main() -> None:
    if not MATTE_BIN.exists():
        raise FileNotFoundError(f"Compiled binary missing: {MATTE_BIN}")

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
            rgba_stack = refine_and_align(raw_paths, mask_dir)

        out_dir = PUBLIC_SPRITES / sid
        saved = save_webp_sprites(rgba_stack, out_dir)
        qa_path = REVIEW_DIR / f"{sid}_alpha_sheet.jpg"
        build_alpha_contact_sheet(rgba_stack, qa_path)

        manifest.append(
            {
                **spec,
                "frameDir": f"/sprites/{sid}",
                "frameCount": len(saved),
            }
        )
        print(f"[OK] {sid}: duration={duration:.2f}s, sprites={len(saved)}, qa={qa_path.relative_to(ROOT)}")

    SPECIES_JSON.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[OK] Wrote {SPECIES_JSON.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
