#!/usr/bin/env python3
"""Extract WebP frame sequences, sample corner studio background color,
copy MP4s, generate 3x2 review contact sheets, and write public/flowers.json.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import shutil
import statistics
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS_VIDEOS = ROOT / "assets" / "videos"
REVIEW_DIR = ROOT / "assets" / "review"
PUBLIC_FRAMES = ROOT / "public" / "frames"
PUBLIC_VIDEOS = ROOT / "public" / "videos"
FLOWERS_JSON = ROOT / "public" / "flowers.json"

FRAME_SIZE = 960
TARGET_FRAMES = 90
CORNER_PATCH = 32

SPECIMENS = [
    {
        "id": "peony",
        "index": "01",
        "zhName": "牡丹",
        "enName": "Peony",
        "latinName": "Paeonia suffruticosa",
        "tagline": "初绽芳华 · 层叠盛放",
        "accentColor": "#C47D88",
    },
    {
        "id": "iris",
        "index": "02",
        "zhName": "鸢尾",
        "enName": "Iris",
        "latinName": "Iris germanica",
        "tagline": "紫韵轻展 · 如蝶翩跹",
        "accentColor": "#7B68A8",
    },
    {
        "id": "camellia",
        "index": "03",
        "zhName": "山茶",
        "enName": "Camellia",
        "latinName": "Camellia japonica",
        "tagline": "素白凝露 · 静雅舒展",
        "accentColor": "#5E7B64",
    },
]


def probe_duration(video_path: Path) -> float:
    """Return video duration in seconds via ffprobe."""
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    out = subprocess.check_output(cmd, text=True).strip()
    duration = float(out)
    return duration if duration > 0 else 5.0


def extract_webp_frames(video_path: Path, out_dir: Path, duration: float) -> list[Path]:
    """Extract evenly spaced 960x960 WebP frames into out_dir."""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Slight headroom ensures we hit TARGET_FRAMES even if duration rounds down by a ms.
    fps_expr = f"{TARGET_FRAMES + 0.4:.4f}/{duration:.6f}"
    vf = (
        f"fps={fps_expr},"
        f"scale={FRAME_SIZE}:{FRAME_SIZE}:force_original_aspect_ratio=decrease,"
        f"pad={FRAME_SIZE}:{FRAME_SIZE}:(ow-iw)/2:(oh-ih)/2:color=#F4F2EC"
    )

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        cmd = [
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
            str(tmp_dir / "frame_%03d.png"),
        ]
        subprocess.run(cmd, check=True)
        png_files = sorted(tmp_dir.glob("frame_*.png"))

        def convert_one(png_path: Path) -> Path:
            dest = out_dir / f"{png_path.stem}.webp"
            with Image.open(png_path) as im:
                im.convert("RGB").save(dest, format="WEBP", quality=86, method=4)
            return dest

        with ThreadPoolExecutor(max_workers=8) as pool:
            webp_files = list(pool.map(convert_one, png_files))

    return sorted(webp_files)


def sample_corner_hex(frames: list[Path]) -> str:
    """Compute median studio background hex color from outer fade-ring patches across first/mid/last frames."""
    if not frames:
        return "#F4F2EC"

    sample_indices = sorted({0, len(frames) // 2, len(frames) - 1})
    rs: list[int] = []
    gs: list[int] = []
    bs: list[int] = []

    for idx in sample_indices:
        with Image.open(frames[idx]) as im:
            rgb = im.convert("RGB")
            w, h = rgb.size
            p = CORNER_PATCH
            # Sample upper and side fade-ring patches (avoiding bottom tabletop shadows)
            boxes = (
                (72, 72, 72 + p, 72 + p),
                (w - 72 - p, 72, w - 72, 72 + p),
                (48, h // 2 - p // 2, 48 + p, h // 2 + p // 2),
                (w - 48 - p, h // 2 - p // 2, w - 48, h // 2 + p // 2),
            )
            for box in boxes:
                patch = rgb.crop(box)
                pixels = patch.get_flattened_data() if hasattr(patch, "get_flattened_data") else patch.getdata()
                for r, g, b in pixels:
                    rs.append(r)
                    gs.append(g)
                    bs.append(b)

    if not rs:
        return "#F4F2EC"

    r_med = int(round(statistics.median(rs)))
    g_med = int(round(statistics.median(gs)))
    b_med = int(round(statistics.median(bs)))
    return f"#{r_med:02X}{g_med:02X}{b_med:02X}"


def build_contact_sheet(frames: list[Path], output_jpg: Path) -> None:
    """Build a 3x2 review contact sheet from 6 evenly spaced frames."""
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    if len(frames) < 6:
        return

    tile = 480
    sheet = Image.new("RGB", (tile * 3, tile * 2), (244, 242, 236))
    draw = ImageDraw.Draw(sheet)

    indices = [round(i * (len(frames) - 1) / 5) for i in range(6)]
    for pos, frame_idx in enumerate(indices):
        col = pos % 3
        row = pos // 3
        x0, y0 = col * tile, row * tile
        with Image.open(frames[frame_idx]) as im:
            thumb = im.convert("RGB").resize((tile, tile), Image.Resampling.LANCZOS)
        sheet.paste(thumb, (x0, y0))
        draw.rectangle([x0 + 12, y0 + 12, x0 + 74, y0 + 40], fill=(255, 255, 255))
        draw.text((x0 + 20, y0 + 20), f"f{frame_idx:02d}", fill=(35, 34, 32))

    sheet.save(output_jpg, format="JPEG", quality=90)


def main() -> None:
    PUBLIC_FRAMES.mkdir(parents=True, exist_ok=True)
    PUBLIC_VIDEOS.mkdir(parents=True, exist_ok=True)

    manifest = []
    for spec in SPECIMENS:
        fid = spec["id"]
        video_path = ASSETS_VIDEOS / f"{fid}.mp4"
        if not video_path.exists():
            raise FileNotFoundError(f"Missing video file: {video_path}")

        duration = probe_duration(video_path)
        shutil.copy2(video_path, PUBLIC_VIDEOS / f"{fid}.mp4")

        frame_dir = PUBLIC_FRAMES / fid
        frames = extract_webp_frames(video_path, frame_dir, duration)
        bg_hex = sample_corner_hex(frames)
        sheet_path = REVIEW_DIR / f"{fid}_sheet.jpg"
        build_contact_sheet(frames, sheet_path)

        entry = {
            **spec,
            "frameDir": f"/frames/{fid}",
            "frameCount": len(frames),
            "videoUrl": f"/videos/{fid}.mp4",
            "bgColor": bg_hex,
        }
        manifest.append(entry)
        print(
            f"[OK] {fid}: duration={duration:.2f}s, frames={len(frames)}, "
            f"bgColor={bg_hex}, sheet={sheet_path.relative_to(ROOT)}"
        )

    FLOWERS_JSON.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[OK] Wrote {FLOWERS_JSON.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
