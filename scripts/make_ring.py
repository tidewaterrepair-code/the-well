#!/usr/bin/env python3
"""Turn a 360-degree orbit of the sphere into the web-ready frame ring.

The whole site runs on this one asset: a loop of frames where the sphere turns
once. Feed it a video or a folder of numbered images:

    python3 scripts/make_ring.py assets/source/orbit.mp4 --frames 72
    python3 scripts/make_ring.py assets/source/turntable_frames/ --sphere 0.5,0.5,0.375

    # optional: a sharp still shown while the sphere rests on one chamber
    python3 scripts/make_ring.py assets/source/iv_upscaled.png --plate iv --sphere 0.5,0.5,0.375

What it does:
  1. Picks --frames evenly spaced frames (a video should be exactly one full turn).
  2. Fits each onto a 4:3 canvas. With --sphere cx,cy,r (fractions of the SOURCE
     frame: centre x, centre y, radius as a fraction of frame height) the sphere is
     re-centred and scaled so it sits identically in every output size.
  3. Fades the frame edges to black so no rectangle shows in the browser.
  4. Writes web/public/frames/<width>/001.webp ... for each --sizes width.
  5. Updates config/scene.json (frame count, sizes, version) so browsers refetch.

Needs: Python 3, Pillow, numpy, and ffmpeg for video input.
"""
import argparse, json, subprocess, sys, tempfile, time
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_SPHERE = (0.5, 0.5, 0.375)  # where the sphere lands in every output frame
ASPECT = 4 / 3


def source_frames(src: Path, n: int, tmp: Path) -> list[Path]:
    if src.is_dir():
        files = sorted(p for p in src.iterdir() if p.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'})
    else:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(src), str(tmp / '%05d.png')], check=True)
        files = sorted(tmp.glob('*.png'))
    if len(files) < 2:
        sys.exit(f'No frames found in {src}')
    idx = np.round(np.linspace(0, len(files), n, endpoint=False)).astype(int)
    return [files[i] for i in idx]


def edge_fade(w: int, h: int, amount: float) -> np.ndarray:
    x = np.minimum(np.arange(w), np.arange(w)[::-1]) / (w * amount)
    y = np.minimum(np.arange(h), np.arange(h)[::-1]) / (h * amount)
    s = lambda t: np.clip(t, 0, 1) ** 2 * (3 - 2 * np.clip(t, 0, 1))
    return (s(y)[:, None] * s(x)[None, :])[..., None]


def place(img: Image.Image, sphere, width: int, fade: float) -> Image.Image:
    height = round(width / ASPECT)
    sw, sh = img.size
    if sphere:
        cx, cy, r = sphere
        scale = (OUT_SPHERE[2] * height) / (r * sh)
        ox = OUT_SPHERE[0] * width - cx * sw * scale
        oy = OUT_SPHERE[1] * height - cy * sh * scale
    else:  # no sphere given: fit the whole frame inside the canvas
        scale = min(width / sw, height / sh)
        ox, oy = (width - sw * scale) / 2, (height - sh * scale) / 2
    scaled = img.resize((max(1, round(sw * scale)), max(1, round(sh * scale))), Image.LANCZOS)
    mask = Image.fromarray((edge_fade(scaled.width, scaled.height, fade)[..., 0] * 255).astype(np.uint8))
    canvas = Image.new('RGB', (width, height), (0, 0, 0))
    canvas.paste(scaled, (round(ox), round(oy)), mask)
    return canvas


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source', type=Path, help='orbit video, folder of frames, or (with --plate) one still image')
    ap.add_argument('--plate', metavar='CHAMBER_ID', help='make a sharp still for one chamber instead of a ring, e.g. --plate iv')
    ap.add_argument('--frames', type=int, default=72)
    ap.add_argument('--sizes', default='640,1024,1600', help='output widths; phones load the smallest that looks sharp')
    ap.add_argument('--sphere', help='cx,cy,r of the sphere in the source frames (fractions)')
    ap.add_argument('--fade', type=float, default=0.08, help='edge fade as a fraction of the frame')
    ap.add_argument('--quality', type=int, default=78)
    ap.add_argument('--out', type=Path, default=ROOT / 'web' / 'public' / 'frames')
    ap.add_argument('--no-config', action='store_true', help='do not touch config/scene.json')
    a = ap.parse_args()

    sphere = tuple(float(v) for v in a.sphere.split(',')) if a.sphere else None
    sizes = sorted(int(s) for s in a.sizes.split(','))
    if a.plate:
        img = Image.open(a.source).convert('RGB')
        out = ROOT / 'web' / 'public' / 'img' / 'plates' / f'{a.plate}.webp'
        out.parent.mkdir(parents=True, exist_ok=True)
        width = min(2048, round(img.width * 1.2))
        place(img, sphere, width, a.fade).save(out, 'WEBP', quality=86, method=6)
        print(f'Wrote {out.relative_to(ROOT)} ({width}px, {out.stat().st_size / 1e3:.0f} KB)')
        print(f'Now add this to chamber "{a.plate}" in config/chambers.json:   "plate": "img/plates/{a.plate}.webp"')
        print('The still must show the sphere in the same pose as that chamber\'s ring frame (upscale that exact frame).')
        return
    with tempfile.TemporaryDirectory() as tmp:
        files = source_frames(a.source, a.frames, Path(tmp))
        src_w = Image.open(files[0]).width
        sizes = [s for s in sizes if s <= src_w * 1.6] or [sizes[0]]  # never upscale far past the source
        total = 0
        for size in sizes:
            d = a.out / str(size)
            d.mkdir(parents=True, exist_ok=True)
            for old in d.glob('*.webp'):
                old.unlink()
            for i, f in enumerate(files, 1):
                out = d / f'{i:03d}.webp'
                place(Image.open(f).convert('RGB'), sphere, size, a.fade).save(out, 'WEBP', quality=a.quality, method=6)
                total += out.stat().st_size
            first = sum(p.stat().st_size for p in sorted(d.glob('*.webp'))[::8])
            print(f'{size}px: {len(files)} frames, {sum(p.stat().st_size for p in d.glob("*.webp")) / 1e6:.1f} MB (first paint loads {first / 1e3:.0f} KB)')

    if not a.no_config:
        cfg_path = ROOT / 'config' / 'scene.json'
        cfg = json.loads(cfg_path.read_text())
        cfg['ring'].update(frames=len(files), sizes=sizes, ext='webp', aspect=round(ASPECT, 4), version=time.strftime('%Y%m%d%H%M'),
                           sphere=dict(cx=OUT_SPHERE[0], cy=OUT_SPHERE[1], r=OUT_SPHERE[2]) if sphere else cfg['ring'].get('sphere'))
        cfg_path.write_text(json.dumps(cfg, indent=2) + '\n')
        print(f'Updated {cfg_path.relative_to(ROOT)}. Now set each chamber\'s "frame" in config/chambers.json.')
    print(f'Done: {total / 1e6:.1f} MB total in {a.out}')


if __name__ == '__main__':
    main()
