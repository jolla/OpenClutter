#!/usr/bin/env python3
"""Headless Hamina-style preview.

Reads a scene JSON (OpenIntent objects in clipboard meters, plus Copy terrain
floors) and an aerial JPEG. Draws an oblique view the way Hamina does: the
aerial is draped on the terrain floors, and each attenuation area is a
vertical prism from bottom height to top height.

No WebGL. The picture is a software z-buffer.

  python3 scripts/hamina_preview.py scene.json out.png
  python3 scripts/hamina_preview.py --self-test
"""

import json
import math
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

W = 1280
H = 800
FOV = math.radians(38)


def kind_color(kind, given):
    if given and len(given) == 3:
        return np.array(given, dtype=np.float64)
    if kind == "tree":
        return np.array([63, 125, 42], dtype=np.float64)
    if kind == "trunk":
        return np.array([120, 90, 55], dtype=np.float64)
    if kind == "water":
        return np.array([70, 130, 170], dtype=np.float64)
    return np.array([176, 180, 184], dtype=np.float64)


def close_ring(ring):
    if len(ring) >= 2 and ring[0][:2] == ring[-1][:2]:
        return ring[:-1]
    return ring


def fan(ring):
    pts = close_ring(ring)
    tris = []
    if len(pts) < 3:
        return tris
    for i in range(1, len(pts) - 1):
        tris.append((pts[0], pts[i], pts[i + 1]))
    return tris


def _signed_area(pts):
    area = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i][0], pts[i][1]
        x2, y2 = pts[(i + 1) % n][0], pts[(i + 1) % n][1]
        area += x1 * y2 - x2 * y1
    return area * 0.5


def triangulate(ring):
    """Ear-clip a ring so a concave bay stays open. A fan from vertex 0 fills that bay."""
    pts = close_ring([p[:] if isinstance(p, list) else list(p) for p in ring])
    if len(pts) < 3:
        return []
    if len(pts) == 3:
        return [(pts[0], pts[1], pts[2])]
    wind = 1.0 if _signed_area(pts) >= 0 else -1.0
    idx = list(range(len(pts)))

    def cross(i, j, k):
        a, b, c = pts[i], pts[j], pts[k]
        return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])

    def contains(i, j, k, p):
        c0 = cross(i, j, p) * wind
        c1 = cross(j, k, p) * wind
        c2 = cross(k, i, p) * wind
        return c0 >= -1e-8 and c1 >= -1e-8 and c2 >= -1e-8

    tris = []
    guard = 0
    limit = len(pts) * len(pts) + 4
    while len(idx) > 3 and guard < limit:
        guard += 1
        n = len(idx)
        ear = None
        for t in range(n):
            i0 = idx[t]
            i1 = idx[(t + 1) % n]
            i2 = idx[(t + 2) % n]
            if cross(i0, i1, i2) * wind <= 1e-8:
                continue
            blocked = False
            for p in idx:
                if p == i0 or p == i1 or p == i2:
                    continue
                if contains(i0, i1, i2, p):
                    blocked = True
                    break
            if blocked:
                continue
            ear = t
            break
        if ear is None:
            break
        n = len(idx)
        i0 = idx[ear]
        i1 = idx[(ear + 1) % n]
        i2 = idx[(ear + 2) % n]
        tris.append((pts[i0], pts[i1], pts[i2]))
        del idx[(ear + 1) % n]
    if len(idx) == 3:
        tris.append((pts[idx[0]], pts[idx[1]], pts[idx[2]]))
    if len(tris) < len(pts) - 2:
        return fan(ring)
    return tris


def prism(ring2, bottom, top, color):
    """Vertical extrusion. Top face plus a wall on each edge."""
    ring = close_ring([[p[0], p[1], bottom] for p in ring2])
    if len(ring) < 3 or not (top > bottom + 0.05):
        top_ring = [[p[0], p[1], max(top, bottom)] for p in ring] if ring else []
        return fan(top_ring), color
    top_pts = [[p[0], p[1], top] for p in ring]
    bot_pts = [[p[0], p[1], bottom] for p in ring]
    tris = triangulate(top_pts)
    wall = color * 0.72
    walls = []
    n = len(ring)
    for i in range(n):
        j = (i + 1) % n
        quad = [bot_pts[i], bot_pts[j], top_pts[j], top_pts[i]]
        walls.extend(fan(quad))
    return tris, color, walls, wall


def floor_tris(floors):
    tris = []
    uvs = []
    for floor in floors or []:
        raw = floor.get("ring") or []
        kind = floor.get("kind")
        if kind == "raised":
            h = float(floor.get("height") or 0)
            ring = [[p[0], p[1], h] for p in raw]
        else:
            ring = [[p[0], p[1], p[2] if len(p) > 2 else 0] for p in raw]
        ring = close_ring(ring)
        parts = triangulate(ring)
        for a, b, c in parts:
            tris.append((a, b, c))
            uvs.append((a[:2], b[:2], c[:2]))
    return tris, uvs


def camera(scene, z_focus):
    width = float(scene["widthM"])
    length = float(scene["lengthM"])
    span = max(width, length, 20.0)
    center = np.array([-width * 0.5, -length * 0.5, z_focus], dtype=np.float64)
    elev = math.radians(34)
    dist = span * 1.35
    eye = center + np.array(
        [-math.cos(elev) * dist * 0.82, -math.cos(elev) * dist * 0.48, math.sin(elev) * dist],
        dtype=np.float64,
    )
    forward = center - eye
    forward /= np.linalg.norm(forward)
    up = np.array([0.0, 0.0, 1.0])
    right = np.cross(forward, up)
    right /= np.linalg.norm(right)
    cam_up = np.cross(right, forward)
    return eye, right, cam_up, forward


def project(world, eye, right, up, forward):
    rel = world - eye
    depth = rel @ forward
    x = rel @ right
    y = rel @ up
    focal = (H * 0.5) / math.tan(FOV * 0.5)
    sx = W * 0.5 + focal * x / np.maximum(depth, 1e-3)
    sy = H * 0.5 - focal * y / np.maximum(depth, 1e-3)
    return np.stack([sx, sy, depth], axis=-1)


def raster_solid(tri, color, zbuf, img):
    if np.any(tri[:, 2] <= 1.0):
        return
    xs = tri[:, 0]
    ys = tri[:, 1]
    minx = max(0, int(math.floor(xs.min())))
    maxx = min(W - 1, int(math.ceil(xs.max())))
    miny = max(0, int(math.floor(ys.min())))
    maxy = min(H - 1, int(math.ceil(ys.max())))
    if minx > maxx or miny > maxy:
        return
    area = (tri[1, 0] - tri[0, 0]) * (tri[2, 1] - tri[0, 1]) - (tri[2, 0] - tri[0, 0]) * (
        tri[1, 1] - tri[0, 1]
    )
    if abs(area) < 0.5:
        return
    gx = np.arange(minx, maxx + 1) + 0.5
    gy = np.arange(miny, maxy + 1) + 0.5
    x, y = np.meshgrid(gx, gy)
    den = 1.0 / area
    w0 = ((tri[1, 0] - x) * (tri[2, 1] - y) - (tri[2, 0] - x) * (tri[1, 1] - y)) * den
    w1 = ((tri[2, 0] - x) * (tri[0, 1] - y) - (tri[0, 0] - x) * (tri[2, 1] - y)) * den
    w2 = 1.0 - w0 - w1
    # A hair outside the edge still paints, so shared edges do not leave sky dots.
    mask = (w0 >= -0.02) & (w1 >= -0.02) & (w2 >= -0.02)
    if not np.any(mask):
        return
    depth = w0 * tri[0, 2] + w1 * tri[1, 2] + w2 * tri[2, 2]
    view = zbuf[miny : maxy + 1, minx : maxx + 1]
    hit = mask & (depth < view)
    if not np.any(hit):
        return
    view[hit] = depth[hit]
    img[miny : maxy + 1, minx : maxx + 1][hit] = color


def raster_textured(tri, uv, photo, origin, span, zbuf, img):
    if np.any(tri[:, 2] <= 1.0):
        return
    xs = tri[:, 0]
    ys = tri[:, 1]
    minx = max(0, int(math.floor(xs.min())))
    maxx = min(W - 1, int(math.ceil(xs.max())))
    miny = max(0, int(math.floor(ys.min())))
    maxy = min(H - 1, int(math.ceil(ys.max())))
    if minx > maxx or miny > maxy:
        return
    area = (tri[1, 0] - tri[0, 0]) * (tri[2, 1] - tri[0, 1]) - (tri[2, 0] - tri[0, 0]) * (
        tri[1, 1] - tri[0, 1]
    )
    if abs(area) < 0.5:
        return
    ph, pw = photo.shape[:2]
    gx = np.arange(minx, maxx + 1) + 0.5
    gy = np.arange(miny, maxy + 1) + 0.5
    x, y = np.meshgrid(gx, gy)
    den = 1.0 / area
    w0 = ((tri[1, 0] - x) * (tri[2, 1] - y) - (tri[2, 0] - x) * (tri[1, 1] - y)) * den
    w1 = ((tri[2, 0] - x) * (tri[0, 1] - y) - (tri[0, 0] - x) * (tri[2, 1] - y)) * den
    w2 = 1.0 - w0 - w1
    mask = (w0 >= -0.02) & (w1 >= -0.02) & (w2 >= -0.02)
    if not np.any(mask):
        return
    depth = w0 * tri[0, 2] + w1 * tri[1, 2] + w2 * tri[2, 2]
    view = zbuf[miny : maxy + 1, minx : maxx + 1]
    hit = mask & (depth < view)
    if not np.any(hit):
        return
    mx = (w0 * uv[0][0] + w1 * uv[1][0] + w2 * uv[2][0] - origin[0]) / span[0]
    my = (w0 * uv[0][1] + w1 * uv[1][1] + w2 * uv[2][1] - origin[1]) / span[1]
    col = np.clip((mx * (pw - 1)).astype(np.int32), 0, pw - 1)
    # Clipboard y grows north. The JPEG's first row is north, so y=0 (north) is row 0.
    row = np.clip(((1.0 - my) * (ph - 1)).astype(np.int32), 0, ph - 1)
    sample = photo[row, col]
    shade = 0.92 + 0.08 * np.clip((tri[:, 2].mean()) / 800.0, 0, 1)
    painted = np.clip(sample * shade, 0, 255)
    view[hit] = depth[hit]
    img[miny : maxy + 1, minx : maxx + 1][hit] = painted[hit]


def point_z(tris, x, y):
    best = None
    for a, b, c in tris:
        area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
        if abs(area) < 1e-6:
            continue
        w0 = ((b[0] - x) * (c[1] - y) - (c[0] - x) * (b[1] - y)) / area
        w1 = ((c[0] - x) * (a[1] - y) - (a[0] - x) * (c[1] - y)) / area
        w2 = 1.0 - w0 - w1
        if w0 >= -0.02 and w1 >= -0.02 and w2 >= -0.02:
            z = w0 * a[2] + w1 * b[2] + w2 * c[2]
            if best is None or z < best:
                best = z
    return best


def _centroid(ring):
    return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)


def _ring_area(ring):
    area = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        area += x1 * y2 - x2 * y1
    return abs(area) * 0.5


def sits_on_canopy(obj, trees):
    """An inset upper band rests on the band under it. A neighbor on the ground does not.

    The inset of a concave woods can move the centroid by tens of metres, so
    the match is the shared height plus a distance that scales with the stand.
    """
    ring = obj["ring"]
    if not ring:
        return False
    cx, cy = _centroid(ring)
    area = _ring_area(ring)
    bottom = obj["bottom"]
    for other in trees:
        if other is obj or not other["ring"]:
            continue
        if abs(bottom - other["top"]) > 0.5:
            continue
        other_area = _ring_area(other["ring"])
        if other_area < 8:
            continue
        ox, oy = _centroid(other["ring"])
        reach = max(8.0, 0.55 * math.sqrt(max(area, other_area)))
        if abs(cx - ox) <= reach and abs(cy - oy) <= reach:
            return True
    return False


def diagnose(scene, floor_xyz):
    trees = [o for o in scene["objects"] if o["kind"] == "tree"]
    buildings = [o for o in scene["objects"] if o["kind"] == "building"]
    thick = [o["top"] - o["bottom"] for o in trees]
    flat = sum(1 for t in thick if t < 1.0)
    floating = 0
    buried = 0
    checked = 0
    if floor_xyz and trees:
        for o in trees:
            ring = o["ring"]
            if not ring or sits_on_canopy(o, trees):
                continue
            cx, cy = _centroid(ring)
            samples = list(ring) + [[cx, cy]]
            zs = [point_z(floor_xyz, p[0], p[1]) for p in samples]
            zs = [z for z in zs if z is not None]
            if not zs:
                continue
            checked += 1
            ground = min(zs)
            # Bottom height is the downhill ground. A base several metres
            # above every sample under the crown is floating.
            if o["bottom"] > ground + 3.0:
                floating += 1
            if o["top"] < ground - 1.0:
                buried += 1
    med = sorted(thick)[len(thick) // 2] if thick else None
    return {
        "trees": len(trees),
        "buildings": len(buildings),
        "flatTrees": flat,
        "medianTreeM": None if med is None else round(med, 2),
        "treeSamplesOnTerrain": checked,
        "floatingTrees": floating,
        "buriedTrees": buried,
        "floors": len(scene.get("floors") or []),
    }


def render(scene, out_path):
    width = float(scene["widthM"])
    length = float(scene["lengthM"])
    photo = np.asarray(Image.open(scene["image"]).convert("RGB").resize((768, 768), Image.Resampling.BILINEAR))
    floors = scene.get("floors") or []
    ftris, fuv = floor_tris(floors)
    if not ftris:
        z0 = 0.0
        ring = [[-width, -length, z0], [0, -length, z0], [0, 0, z0], [-width, 0, z0]]
        ftris, fuv = floor_tris([{"kind": "slope", "ring": ring}])
    zs = [p[2] for tri in ftris for p in tri]
    z_focus = float(np.median(zs)) if zs else 0.0
    eye, right, up, forward = camera(scene, z_focus)
    img = np.zeros((H, W, 3), dtype=np.uint8)
    img[:] = (214, 226, 236)
    zbuf = np.full((H, W), np.inf, dtype=np.float64)
    origin = (-width, -length)
    span = (width, length)
    for tri, uv in zip(ftris, fuv):
        world = np.array(tri, dtype=np.float64)
        screen = project(world, eye, right, up, forward)
        raster_textured(screen, uv, photo, origin, span, zbuf, img)
    draw_objects = sorted(scene["objects"], key=lambda o: o["bottom"])
    for obj in draw_objects:
        color = kind_color(obj["kind"], obj.get("color"))
        parts = prism(obj["ring"], float(obj["bottom"]), float(obj["top"]), color)
        if len(parts) == 2:
            tris, col = parts
            groups = [(tris, col)]
        else:
            top, col, walls, wall = parts
            groups = [(walls, wall), (top, col)]
        for tris, col in groups:
            rgb = np.clip(col, 0, 255).astype(np.uint8)
            for a, b, c in tris:
                world = np.array([a, b, c], dtype=np.float64)
                screen = project(world, eye, right, up, forward)
                raster_solid(screen, rgb, zbuf, img)
    picture = Image.fromarray(img, "RGB")
    bar = ImageDraw.Draw(picture)
    stats = diagnose(scene, ftris)
    label = (
        scene.get("name")
        or "preview"
    ) + "   trees %d   buildings %d   median tree %.1f m   flat %d   floating %d" % (
        stats["trees"],
        stats["buildings"],
        stats["medianTreeM"] or 0,
        stats["flatTrees"],
        stats["floatingTrees"],
    )
    bar.rectangle((0, 0, W, 28), fill=(0, 0, 0))
    bar.text((8, 8), label[:170], fill=(255, 255, 255))
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    picture.save(out)
    stats_path = out.with_suffix(".json")
    stats_path.write_text(json.dumps(stats, indent=2) + "\n")
    print(json.dumps({"png": str(out), **stats}))
    return stats


def self_test():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        photo = Image.new("RGB", (64, 64), (90, 140, 70))
        px = photo.load()
        for i in range(64):
            px[i, 0] = (200, 40, 40)
            px[0, i] = (40, 40, 200)
        photo.save(tmp / "plate.jpg")
        scene = {
            "name": "self-test",
            "widthM": 100,
            "lengthM": 100,
            "image": str(tmp / "plate.jpg"),
            "floors": [
                {
                    "kind": "slope",
                    "ring": [[-100, -100, 0], [0, -100, 0], [0, 0, 8], [-100, 0, 8]],
                }
            ],
            "objects": [
                {
                    "kind": "building",
                    "ring": [[-70, -60], [-50, -60], [-50, -40], [-70, -40]],
                    "bottom": 0,
                    "top": 12,
                },
                {
                    "kind": "tree",
                    "ring": [[-40, -30], [-28, -30], [-28, -18], [-40, -18]],
                    "bottom": 2,
                    "top": 18,
                },
                {
                    "kind": "tree",
                    "ring": [[-20, -30], [-12, -30], [-12, -22], [-20, -22]],
                    "bottom": 2,
                    "top": 2.2,
                },
            ],
        }
        (tmp / "scene.json").write_text(json.dumps(scene))
        stats = render(scene, tmp / "out.png")
        im = np.asarray(Image.open(tmp / "out.png"))
        assert im.shape == (H, W, 3)
        assert int(im.mean()) > 20
        assert stats["trees"] == 2
        assert stats["flatTrees"] == 1
        assert stats["buildings"] == 1
        assert stats["floors"] == 1
        green = ((im[:, :, 1] > im[:, :, 0] + 15) & (im[:, :, 1] > 60)).sum()
        assert green > 30, green
        bay = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10]]
        clipped = triangulate(bay)
        area = 0.0
        for a, b, c in clipped:
            area += abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) * 0.5
        assert abs(area - 52) < 1.0, area
        fanned = 0.0
        for a, b, c in fan(bay):
            fanned += abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) * 0.5
        assert fanned > area + 10, fanned
    print("self-test ok")


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--self-test":
        self_test()
        return
    if len(sys.argv) != 3:
        print("usage: hamina_preview.py scene.json out.png", file=sys.stderr)
        sys.exit(2)
    scene = json.loads(Path(sys.argv[1]).read_text())
    render(scene, sys.argv[2])


if __name__ == "__main__":
    main()
