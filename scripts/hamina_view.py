#!/usr/bin/env python3
"""Render one close oblique view of a preview scene, for regression pictures.

usage: hamina_view.py scene.json out.png cx cy radius azimuth_deg [elev_deg]
cx, cy are scene metres; azimuth is the compass bearing the camera looks toward.
"""
import json, math, sys
import numpy as np
import hamina_preview as h


def main():
    scene = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    cx, cy, r, az = (float(v) for v in sys.argv[3:7])
    elev = math.radians(float(sys.argv[7]) if len(sys.argv) > 7 else 28)

    def inside(ring):
        x, y = h._centroid(ring)
        return abs(x - cx) <= r and abs(y - cy) <= r

    scene["objects"] = [o for o in scene["objects"] if o.get("ring") and inside(o["ring"])]
    scene["floors"] = [f for f in scene.get("floors") or [] if f.get("ring") and inside(f["ring"])]
    zs = [p[2] for f in scene["floors"] for p in f["ring"] if len(p) > 2] or [0.0]
    z0 = float(np.median(zs))

    def camera(_scene, _z):
        center = np.array([cx, cy, z0], dtype=np.float64)
        dist = r * 1.6
        a = math.radians(az)
        # Scene y grows downward on the map image, so north is -y.
        look = np.array([math.sin(a), -math.cos(a), 0.0])
        eye = center - look * math.cos(elev) * dist + np.array([0, 0, math.sin(elev) * dist])
        forward = center - eye
        forward /= np.linalg.norm(forward)
        right = np.cross(forward, np.array([0.0, 0.0, 1.0]))
        right /= np.linalg.norm(right)
        return eye, right, np.cross(right, forward), forward

    h.camera = camera
    h.render(scene, out)


if __name__ == "__main__":
    main()
