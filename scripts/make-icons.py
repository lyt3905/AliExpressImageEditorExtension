"""Generate the extension toolbar icons as PNG files.

Dependency-free: writes PNGs with zlib + struct only.
Run:  python scripts/make-icons.py
"""

from __future__ import annotations

import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")
SIZES = (16, 32, 48, 128)
SS = 3  # supersampling factor per axis

BG = (255, 90, 31)      # AliExpress orange
FRAME = (255, 255, 255)  # white photo frame
MOUNT = (255, 90, 31)    # mountain / sun punched out of the frame


def rounded_rect_sdf(x: float, y: float, left: float, top: float, right: float, bottom: float, radius: float) -> float:
    """Signed distance to a rounded rectangle; negative means inside."""
    cx = (left + right) / 2.0
    cy = (top + bottom) / 2.0
    hx = (right - left) / 2.0 - radius
    hy = (bottom - top) / 2.0 - radius
    dx = abs(x - cx) - hx
    dy = abs(y - cy) - hy
    outside = (max(dx, 0.0) ** 2 + max(dy, 0.0) ** 2) ** 0.5
    inside = min(max(dx, dy), 0.0)
    return outside + inside - radius


def in_triangle(px: float, py: float, a, b, c) -> bool:
    def sign(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])

    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def sample(x: float, y: float) -> tuple[int, int, int, int]:
    """Colour of the icon at normalised coordinates (0..1)."""
    outer = rounded_rect_sdf(x, y, 0.05, 0.05, 0.95, 0.95, 0.22)
    if outer > 0:
        return (0, 0, 0, 0)

    frame = rounded_rect_sdf(x, y, 0.235, 0.27, 0.765, 0.73, 0.07)
    if frame <= 0:
        # Inside the white frame: punch the sun and the mountain back out.
        if (x - 0.62) ** 2 + (y - 0.42) ** 2 < 0.07 ** 2:
            return (*MOUNT, 255)
        if in_triangle(x, y, (0.30, 0.68), (0.47, 0.44), (0.66, 0.68)):
            return (*MOUNT, 255)
        return (*FRAME, 255)

    return (*BG, 255)


def render(size: int) -> bytes:
    """Render one icon as raw RGBA scanlines (no filter bytes)."""
    rows = []
    step = 1.0 / size
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) * step
                    y = (py + (sy + 0.5) / SS) * step
                    r, g, b, a = sample(x, y)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            samples = SS * SS
            alpha = acc[3] / samples
            if acc[3] > 0:
                row += bytes(
                    (
                        round(acc[0] / acc[3]),
                        round(acc[1] / acc[3]),
                        round(acc[2] / acc[3]),
                        round(alpha),
                    )
                )
            else:
                row += b"\x00\x00\x00\x00"
        rows.append(row)
    return b"".join(b"\x00" + bytes(r) for r in rows)


def chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def write_png(path: str, size: int, raw: bytes) -> None:
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n"
    data += chunk(b"IHDR", ihdr)
    data += chunk(b"IDAT", zlib.compress(raw, 9))
    data += chunk(b"IEND", b"")
    with open(path, "wb") as handle:
        handle.write(data)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        raw = render(size)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, size, raw)
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
