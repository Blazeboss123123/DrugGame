#!/usr/bin/env python3
"""
Generates the game's HD surface textures (all original, procedural, seamlessly tiling).

    python3 tools/gen-textures.py            -> public/assets/tex/*.jpg|png

Each surface gets a colour map (_c), a normal map (_n, OpenGL convention: green = +V) and, where
useful, an ORM map (_orm: R = occlusion, G = roughness, B = metalness) in the layout three.js expects.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'tex')
os.makedirs(OUT, exist_ok=True)
N = 1024


# ----------------------------------------------------------------------------- tileable building blocks
def fnoise(n, beta, seed, lo=1.0, hi=None):
    """Seamless 1/f^beta noise in [0, 1] (white noise shaped in the frequency domain)."""
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((n, n))
    f = np.fft.fft2(w)
    ky = np.fft.fftfreq(n)[:, None] * n
    kx = np.fft.fftfreq(n)[None, :] * n
    k = np.sqrt(kx * kx + ky * ky)
    k[0, 0] = 1
    amp = 1.0 / k ** beta
    amp[k < lo] = 0
    if hi is not None:
        amp *= np.exp(-((k / hi) ** 2))
    amp[0, 0] = 0
    r = np.real(np.fft.ifft2(f * amp))
    r -= r.min()
    r /= r.max() + 1e-9
    return r


def voronoi(n, cells, seed, jitter=1.0):
    """Seamless Voronoi: returns (F1, F2, cell id) in pixels, distances wrap around the tile."""
    rng = np.random.default_rng(seed)
    g = int(np.sqrt(cells))
    pts = []
    for j in range(g):
        for i in range(g):
            pts.append(((i + 0.5 + (rng.random() - 0.5) * jitter) * n / g, (j + 0.5 + (rng.random() - 0.5) * jitter) * n / g))
    pts = np.array(pts)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    f1 = np.full((n, n), 1e9, np.float32)
    f2 = np.full((n, n), 1e9, np.float32)
    ids = np.zeros((n, n), np.int32)
    for idx, (px, py) in enumerate(pts):
        dx = np.abs(xx - px)
        dx = np.minimum(dx, n - dx)
        dy = np.abs(yy - py)
        dy = np.minimum(dy, n - dy)
        d = np.sqrt(dx * dx + dy * dy)
        closer = d < f1
        f2 = np.where(closer, f1, np.minimum(f2, d))
        ids = np.where(closer, idx, ids)
        f1 = np.where(closer, d, f1)
    return f1, f2, ids


def blur_wrap(a, r):
    """Gaussian blur that wraps around the edges (keeps tiling seamless)."""
    if r <= 0:
        return a
    n = a.shape[0]
    ky = np.fft.fftfreq(n)[:, None]
    kx = np.fft.fftfreq(a.shape[1])[None, :]
    g = np.exp(-2 * (np.pi * r) ** 2 * (kx * kx + ky * ky))
    if a.ndim == 3:
        return np.stack([np.real(np.fft.ifft2(np.fft.fft2(a[..., c]) * g)) for c in range(a.shape[2])], -1)
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g))


def normal_from_height(h, strength):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    drow = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    nx = -dx * strength
    ny = drow * strength  # image rows run down; texture V runs up
    nz = np.ones_like(h)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / l, ny / l, nz / l], -1) * 0.5 + 0.5


def save(name, a, q=88, size=None):
    a = np.clip(a, 0, 1)
    img = Image.fromarray((a * 255 + 0.5).astype(np.uint8))
    if size and img.size[0] != size:
        img = img.resize((size, size), Image.LANCZOS)
    path = os.path.join(OUT, name)
    if name.endswith('.png'):
        img.save(path, optimize=True)
    else:
        img.save(path, quality=q, subsampling=0 if q >= 90 else 2, optimize=True)
    print(f'{name:22s} {img.size[0]}x{img.size[1]}  {os.path.getsize(path) // 1024} KB')


def hsv(h, s, v):
    """Vectorised HSV -> RGB (all arrays or scalars in 0..1)."""
    h = np.asarray(h) % 1.0
    i = np.floor(h * 6).astype(int) % 6
    f = h * 6 - np.floor(h * 6)
    p = v * (1 - s)
    q = v * (1 - f * s)
    t = v * (1 - (1 - f) * s)
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return np.stack([r, g, b], -1)


def wrapped(draw_fn, n, x, y, ext):
    """Calls draw_fn at (x, y) and at every wrapped copy whose extent crosses an edge."""
    for ox in (-n, 0, n):
        if (ox < 0 and x + ox + ext < 0) or (ox > 0 and x + ox - ext > n) or (ox == 0 and False):
            continue
        for oy in (-n, 0, n):
            if (oy < 0 and y + oy + ext < 0) or (oy > 0 and y + oy - ext > n):
                continue
            draw_fn(x + ox, y + oy)


def lerp(a, b, t):
    return a + (b - a) * t


def ss(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------- grass
def grass():
    S = 2048  # supersampled, downsized to 1024
    rng = np.random.default_rng(11)
    col = Image.new('RGB', (S, S))
    hgt = Image.new('L', (S, S), 0)
    # Undergrowth: dark mottled base.
    base_n = fnoise(S, 1.4, 1, lo=2)
    base = hsv(0.25 + base_n * 0.03, 0.75, 0.10 + base_n * 0.08)
    col = Image.fromarray((base * 255).astype(np.uint8))
    dc = ImageDraw.Draw(col)
    dh = ImageDraw.Draw(hgt)
    patch = fnoise(S, 2.2, 2, lo=1)  # drier / lusher patches
    blades = 115000
    for b in range(blades):
        layer = b / blades
        x = rng.random() * S
        y = rng.random() * S
        L = rng.uniform(22, 58) * (0.8 + layer * 0.4)
        a = rng.uniform(0, 2 * np.pi)
        w = rng.uniform(3.0, 6.5)
        p = patch[int(y) % S, int(x) % S]
        dry = rng.random() < 0.035 + 0.05 * p
        if dry:
            hue, sat, val = rng.uniform(0.11, 0.16), rng.uniform(0.35, 0.55), rng.uniform(0.45, 0.7)
        else:
            hue = rng.uniform(0.215, 0.29) - p * 0.025
            sat = rng.uniform(0.55, 0.85)
            val = (0.22 + layer * 0.5) * rng.uniform(0.75, 1.15) * (0.9 + p * 0.2)
        r, g, bb = hsv(hue, sat, min(val, 0.95)).tolist()
        tip_r, tip_g, tip_b = hsv(hue - 0.01, sat * 0.85, min(val * 1.25, 0.98)).tolist()
        cx, cy = np.cos(a), np.sin(a)
        nx, ny = -cy, cx
        curve = rng.uniform(-0.35, 0.35)

        def blade(px, py):
            # Two-segment tapered blade: darker base half, lighter tip half.
            mx, my = px + cx * L * 0.5 + nx * curve * L * 0.15, py + cy * L * 0.5 + ny * curve * L * 0.15
            tx, ty = px + cx * L + nx * curve * L * 0.35, py + cy * L + ny * curve * L * 0.35
            p1 = [(px + nx * w / 2, py + ny * w / 2), (mx + nx * w * 0.38, my + ny * w * 0.38), (mx - nx * w * 0.38, my - ny * w * 0.38), (px - nx * w / 2, py - ny * w / 2)]
            p2 = [(mx + nx * w * 0.38, my + ny * w * 0.38), (tx, ty), (mx - nx * w * 0.38, my - ny * w * 0.38)]
            dc.polygon(p1, fill=(int(r * 255), int(g * 255), int(bb * 255)))
            dc.polygon(p2, fill=(int(tip_r * 255), int(tip_g * 255), int(tip_b * 255)))
            hv = int(60 + layer * 190)
            dh.polygon(p1, fill=hv)
            dh.polygon(p2, fill=min(255, hv + 25))

        wrapped(blade, S, x, y, L + w)
    # Occasional clover leaves and tiny flowers for interest.
    for _ in range(900):
        x, y = rng.random() * S, rng.random() * S
        rr = rng.uniform(5, 9)
        c = tuple(int(v * 255) for v in hsv(rng.uniform(0.24, 0.3), 0.6, rng.uniform(0.35, 0.55)).tolist())

        def clover(px, py):
            for k in range(3):
                ang = k * 2.1 + rng.random()
                ox, oy = np.cos(ang) * rr * 0.8, np.sin(ang) * rr * 0.8
                dc.ellipse([px + ox - rr, py + oy - rr, px + ox + rr, py + oy + rr], fill=c)
                dh.ellipse([px + ox - rr, py + oy - rr, px + ox + rr, py + oy + rr], fill=200)

        wrapped(clover, S, x, y, rr * 2)
    c = np.asarray(col).astype(np.float32) / 255
    h = np.asarray(hgt).astype(np.float32) / 255
    c = np.asarray(Image.fromarray((c * 255).astype(np.uint8)).resize((N, N), Image.LANCZOS)).astype(np.float32) / 255
    h = np.asarray(Image.fromarray((h * 255).astype(np.uint8)).resize((N, N), Image.LANCZOS)).astype(np.float32) / 255
    # Ambient occlusion from height: low blades are shaded by those above.
    ao = 0.55 + 0.45 * ss(0.1, 0.8, blur_wrap(h, 1.2))
    c = c * ao[..., None]
    # Subtle large-scale tone variation (still tiles).
    tone = fnoise(N, 2.0, 3, lo=1)
    c *= (0.92 + tone * 0.16)[..., None]
    save('grass_c.jpg', c)
    save('grass_n.jpg', normal_from_height(blur_wrap(h, 0.6), 5.0), q=90)


# ----------------------------------------------------------------------------- dirt / path
def dirt():
    rng = np.random.default_rng(21)
    n1 = fnoise(N, 1.6, 21, lo=2)
    n2 = fnoise(N, 1.0, 22, lo=8)
    h = n1 * 0.6 + n2 * 0.25
    base = np.stack([0.42 + n1 * 0.10, 0.31 + n1 * 0.08, 0.21 + n1 * 0.05], -1) * (0.85 + n2 * 0.3)[..., None]
    img = Image.fromarray((np.clip(base, 0, 1) * 255).astype(np.uint8))
    hi = Image.fromarray((np.clip(h, 0, 1) * 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    dh = ImageDraw.Draw(hi)
    # Pebbles: shaded ellipses with a highlight.
    for _ in range(1000):
        x, y = rng.random() * N, rng.random() * N
        r = rng.uniform(2, 8) if rng.random() < 0.9 else rng.uniform(8, 15)
        ex = r * rng.uniform(0.7, 1.3)
        v = rng.uniform(0.35, 0.7)
        tint = rng.uniform(-0.05, 0.05)
        c0 = (int((v * 0.95 + tint) * 255), int(v * 0.88 * 255), int((v * 0.78 - tint) * 255))
        c1 = tuple(min(255, int(k * 1.25)) for k in c0)
        cs = tuple(int(k * 0.45) for k in c0)

        def peb(px, py):
            d.ellipse([px - ex + 1.5, py - r + 2, px + ex + 1.5, py + r + 2], fill=cs)  # contact shadow
            d.ellipse([px - ex, py - r, px + ex, py + r], fill=c0)
            d.ellipse([px - ex * 0.55 - ex * 0.2, py - r * 0.6 - r * 0.2, px + ex * 0.25, py + r * 0.1], fill=c1)
            for k in range(4):
                s = 1 - k / 4
                dh.ellipse([px - ex * s, py - r * s, px + ex * s, py + r * s], fill=int(150 + 100 * (1 - s)))

        wrapped(peb, N, x, y, max(ex, r) + 3)
    # Dry grass bits.
    for _ in range(500):
        x, y = rng.random() * N, rng.random() * N
        a = rng.uniform(0, 2 * np.pi)
        L = rng.uniform(8, 20)
        c = tuple(int(v * 255) for v in hsv(rng.uniform(0.1, 0.16), 0.45, rng.uniform(0.45, 0.65)).tolist())
        wrapped(lambda px, py: d.line([px, py, px + np.cos(a) * L, py + np.sin(a) * L], fill=c, width=2), N, x, y, L)
    c = np.asarray(img).astype(np.float32) / 255
    hh = np.asarray(hi).astype(np.float32) / 255
    ao = 0.7 + 0.3 * ss(0.2, 0.7, blur_wrap(hh, 2))
    c *= ao[..., None]
    save('dirt_c.jpg', c)
    save('dirt_n.jpg', normal_from_height(blur_wrap(hh, 0.7), 4.0), q=90)


# ----------------------------------------------------------------------------- rock
def rock():
    # Weathered cliff stone: domain-warped ridged noise, a few deep fractures, strata and lichen.
    big = fnoise(N, 2.0, 32, lo=1)
    mid = fnoise(N, 1.5, 33, lo=4)
    fine = fnoise(N, 1.0, 34, lo=30)
    wx = fnoise(N, 2.0, 38, lo=1) * 60
    wy = fnoise(N, 2.0, 39, lo=1) * 60
    yy, xx = np.mgrid[0:N, 0:N]
    ridge_src = fnoise(N, 1.7, 40, lo=3)
    warped = ridge_src[(yy + wy.astype(int)) % N, (xx + wx.astype(int)) % N]
    ridged = 1 - np.abs(warped * 2 - 1)
    ridged = ridged ** 2.2
    f1, f2, ids = voronoi(N, 25, 31, 0.9)
    crack = 1 - ss(0, 5, f2 - f1)
    crack *= ss(0.35, 0.6, fnoise(N, 1.4, 41, lo=2))  # fractures fade in and out
    strata = 0.5 + 0.5 * np.sin((yy + wy * 0.6) / N * 2 * np.pi * 7)
    h = 0.35 * ridged + 0.3 * big + 0.18 * mid + 0.07 * fine + 0.06 * strata - 0.35 * crack
    h = blur_wrap(h, 0.6)
    v = 0.32 + 0.09 * big + 0.22 * ridged + 0.1 * fine + 0.05 * strata + 0.05 * mid
    c = np.stack([v * 1.03, v * 0.99, v * 0.93], -1)
    stain = ss(0.55, 0.85, fnoise(N, 2.2, 36, lo=1))
    c = lerp(c, c * np.array([1.15, 0.97, 0.78]), stain[..., None] * 0.6)
    lich = ss(0.7, 0.85, fnoise(N, 1.3, 37, lo=6)) * (1 - crack)
    c = lerp(c, np.array([0.50, 0.55, 0.36]), lich[..., None] * 0.45)
    ao = 0.6 + 0.4 * ss(0.15, 0.7, blur_wrap(h, 3))
    c *= (ao * (1 - crack * 0.6))[..., None]
    save('rock_c.jpg', c)
    save('rock_n.jpg', normal_from_height(h, 6.0), q=90)


# ----------------------------------------------------------------------------- asphalt
def asphalt():
    rng = np.random.default_rng(41)
    agg = rng.random((N, N))
    stones = blur_wrap((agg > 0.86).astype(np.float32), 0.7)
    stones_d = blur_wrap((agg < 0.06).astype(np.float32), 0.6)
    patch = fnoise(N, 2.2, 42, lo=1)
    wear = fnoise(N, 1.4, 43, lo=3)
    fine_n = fnoise(N, 0.6, 47, lo=60)
    v = 0.2 + 0.035 * patch + 0.035 * wear + 0.15 * stones - 0.06 * stones_d + 0.05 * fine_n
    c = np.stack([v, v * 1.0, v * 1.03], -1)
    # Fine cracks along a sparse Voronoi network, masked so only some show.
    f1, f2, _ = voronoi(N, 16, 44, 1.0)
    crack = (1 - ss(0.0, 2.0, f2 - f1)) * ss(0.55, 0.7, fnoise(N, 1.6, 45, lo=2))
    c *= (1 - crack * 0.55)[..., None]
    # Oil / tar stains.
    stain = ss(0.74, 0.86, fnoise(N, 2.0, 46, lo=3))
    c *= (1 - stain * 0.18)[..., None]
    h = 0.5 * stones + 0.2 * wear - 0.5 * crack - 0.2 * stones_d
    rough = 0.82 + 0.1 * wear - 0.25 * stain - 0.1 * stones
    orm = np.stack([1 - crack * 0.5, rough, np.zeros_like(rough)], -1)
    save('asphalt_c.jpg', c)
    save('asphalt_n.jpg', normal_from_height(blur_wrap(h, 0.5), 3.5), q=90)
    save('asphalt_orm.jpg', orm, q=85, size=512)


# ----------------------------------------------------------------------------- concrete paving slabs (2 x 2 per tile)
def paving():
    n_big = fnoise(N, 2.0, 51, lo=1)
    n_mid = fnoise(N, 1.4, 52, lo=4)
    rng = np.random.default_rng(53)
    pits = blur_wrap((rng.random((N, N)) > 0.985).astype(np.float32), 0.8)
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    half = N / 2
    jx = np.minimum(xx % half, half - xx % half)
    jy = np.minimum(yy % half, half - yy % half)
    joint = np.minimum(jx, jy)
    groove = 1 - ss(2.0, 7.0, joint)  # 1 in the joint
    slab_id = (xx // half).astype(int) + 2 * (yy // half).astype(int)
    slab_tone = np.array([0.0, 0.03, -0.025, 0.015])[slab_id]
    v = 0.60 + 0.07 * n_big + 0.05 * n_mid + slab_tone - 0.18 * pits
    c = np.stack([v * 1.01, v * 0.99, v * 0.95], -1)
    c *= (1 - groove * 0.42)[..., None]
    # Weathering near the joints.
    dirt = ss(0.0, 1.0, 1 - ss(4, 40, joint)) * (0.5 + 0.5 * n_mid)
    c = lerp(c, c * np.array([0.82, 0.8, 0.74]), dirt[..., None] * 0.5)
    h = 0.6 - 0.6 * groove + 0.1 * n_mid - 0.3 * pits + 0.05 * n_big
    rough = 0.86 + 0.08 * n_mid - 0.1 * dirt
    save('pave_c.jpg', c)
    save('pave_n.jpg', normal_from_height(blur_wrap(h, 0.8), 6.0), q=90)
    save('pave_orm.jpg', np.stack([1 - groove * 0.4, rough, np.zeros_like(rough)], -1), q=85, size=512)


# ----------------------------------------------------------------------------- bark (512)
def bark():
    n = 512
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    warp = fnoise(n, 1.8, 61, lo=1) * 40
    ridges = 0.5 + 0.5 * np.sin((xx + warp) / n * 2 * np.pi * 9)
    ridges = ridges ** 1.6
    fine = fnoise(n, 1.0, 62, lo=20)
    plates = fnoise(n, 1.5, 63, lo=3)
    h = 0.6 * ridges + 0.25 * plates + 0.15 * fine
    v = 0.22 + 0.25 * h
    c = np.stack([v * 1.25, v * 0.82, v * 0.6], -1)
    save('bark_c.jpg', c, size=512)
    save('bark_n.jpg', normal_from_height(blur_wrap(h, 0.5), 6.0), q=90, size=512)


# ----------------------------------------------------------------------------- large-scale variation (R: tone, G: patches, B: fine)
def macro():
    n = 512
    save('macro.jpg', np.stack([fnoise(n, 2.2, 71, lo=1), fnoise(n, 1.8, 72, lo=2), fnoise(n, 1.2, 73, lo=6)], -1), q=90, size=512)


# ----------------------------------------------------------------------------- foliage cards (RGBA png)
def leaves():
    """Broadleaf cluster card: many overlapping leaves on a transparent background."""
    S = 1024
    rng = np.random.default_rng(81)
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = S / 2, S / 2
    # Twigs first.
    for k in range(7):
        a = k / 7 * 2 * np.pi + rng.uniform(-0.3, 0.3)
        d.line([cx, cy, cx + np.cos(a) * S * 0.42, cy + np.sin(a) * S * 0.42], fill=(70, 52, 36, 255), width=7)
    for i in range(520):
        rr = np.sqrt(rng.random()) * S * 0.43
        a = rng.uniform(0, 2 * np.pi)
        x, y = cx + np.cos(a) * rr, cy + np.sin(a) * rr
        L = rng.uniform(46, 78)
        W = L * rng.uniform(0.38, 0.5)
        ang = a + rng.uniform(-0.8, 0.8)
        layer = i / 520
        hue = rng.uniform(0.22, 0.31)
        val = 0.28 + layer * 0.42 + rng.uniform(-0.06, 0.06)
        base = hsv(hue, rng.uniform(0.55, 0.8), val)
        pts = []
        for t in np.linspace(0, 1, 9):
            pts.append((t, np.sin(np.pi * t) ** 0.8 * W / 2))
        poly_l = [(x + np.cos(ang) * t * L - np.sin(ang) * w, y + np.sin(ang) * t * L + np.cos(ang) * w) for t, w in pts]
        poly_r = [(x + np.cos(ang) * t * L + np.sin(ang) * w, y + np.sin(ang) * t * L - np.cos(ang) * w) for t, w in reversed(pts)]
        c0 = tuple(int(v * 255) for v in base.tolist()) + (255,)
        c1 = tuple(min(255, int(v * 255 * 1.18)) for v in base.tolist()) + (255,)
        d.polygon(poly_l + poly_r, fill=c0)
        d.polygon(poly_l + [(x + np.cos(ang) * L, y + np.sin(ang) * L)], fill=c1)  # lit half
        d.line([x, y, x + np.cos(ang) * L * 0.9, y + np.sin(ang) * L * 0.9], fill=tuple(int(v * 0.8) for v in c0[:3]) + (255,), width=2)
    img = img.resize((512, 512), Image.LANCZOS)
    img.save(os.path.join(OUT, 'leaves.png'), optimize=True)
    print('leaves.png', os.path.getsize(os.path.join(OUT, 'leaves.png')) // 1024, 'KB')


def needles():
    """Pine branch texture (opaque): dense needle strokes, dark inside, light tips toward +V."""
    S = 1024
    rng = np.random.default_rng(91)
    base = fnoise(S, 1.5, 92, lo=2)
    c = hsv(0.33 + base * 0.03, 0.62, 0.08 + base * 0.06)
    img = Image.fromarray((c * 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    for i in range(26000):
        x, y = rng.random() * S, rng.random() * S
        t = y / S  # brighter toward the top (branch tips)
        L = rng.uniform(14, 34)
        a = -np.pi / 2 + rng.uniform(-0.9, 0.9)
        val = 0.14 + 0.45 * (1 - t) * rng.uniform(0.6, 1.1) + 0.1 * i / 26000
        col = tuple(int(v * 255) for v in hsv(rng.uniform(0.27, 0.36), rng.uniform(0.5, 0.75), min(val, 0.85)).tolist())
        wrapped(lambda px, py: d.line([px, py, px + np.cos(a) * L, py + np.sin(a) * L], fill=col, width=3), S, x, y, L)
    a = np.asarray(img).astype(np.float32) / 255
    save('needles_c.jpg', a, size=512)


def flowers():
    """Small flower heads for ground clutter (RGBA, 4 colours in a 2x2 atlas)."""
    S = 512
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cols = [(245, 245, 240), (250, 214, 60), (170, 110, 220), (220, 60, 90)]
    for k, col in enumerate(cols):
        ox, oy = (k % 2) * 256 + 128, (k // 2) * 256 + 128
        for p in range(6):
            a = p / 6 * 2 * np.pi
            px, py = ox + np.cos(a) * 52, oy + np.sin(a) * 52
            d.ellipse([px - 44, py - 44, px + 44, py + 44], fill=col + (255,))
            d.ellipse([px - 20, py - 20, px + 20, py + 20], fill=tuple(min(255, int(v * 1.08)) for v in col) + (255,))
        d.ellipse([ox - 30, oy - 30, ox + 30, oy + 30], fill=(235, 180, 40, 255) if k != 1 else (200, 120, 30, 255))
    d.rectangle([0, 0, 23, 23], fill=(62, 104, 40, 255))  # stem colour, sampled at the atlas corner
    img.save(os.path.join(OUT, 'flowers.png'), optimize=True)
    print('flowers.png', os.path.getsize(os.path.join(OUT, 'flowers.png')) // 1024, 'KB')


JOBS = {'grass': grass, 'dirt': dirt, 'rock': rock, 'asphalt': asphalt, 'paving': paving, 'bark': bark, 'macro': macro, 'leaves': leaves, 'needles': needles, 'flowers': flowers}
if __name__ == '__main__':
    for name in sys.argv[1:] or JOBS:
        JOBS[name]()
