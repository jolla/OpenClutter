#!/usr/bin/env python3
"""Ground-truth tree checks on a Wynn preview scene (scripts/hamina-preview.js).

Each reference is a box in scene metres with what Street View shows there.
Reports tree tops, trunk counts, and the widest crown piece in each box.
usage: tree-refs.py full.scene.json [refs.json]
"""
import json, sys, os

def area(r):
    a = 0
    for i in range(len(r)):
        x1, y1 = r[i][:2]; x2, y2 = r[(i + 1) % len(r)][:2]; a += x1 * y2 - x2 * y1
    return abs(a) / 2

def centre(r):
    return sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)

scene = json.load(open(sys.argv[1]))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hamina_preview as hp
floor = hp.floor_tris(scene.get("floors") or [])[0]
refs = json.load(open(sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "bench", "tree-refs.json")))
out = []
for ref in refs:
    x0, y0, x1, y1 = ref["box"]
    inside = lambda o: x0 <= centre(o["ring"])[0] <= x1 and y0 <= centre(o["ring"])[1] <= y1
    trees = [o for o in scene["objects"] if o["kind"] == "tree" and inside(o)]
    trunks = [o for o in scene["objects"] if o["kind"] == "trunk" and inside(o)]
    # Tops are above the local terrain, not above the scene datum.
    def above(o):
        c = centre(o["ring"])
        z = hp.point_z(floor, c[0], c[1]) if floor else None
        return o["top"] - (z or 0)
    top = max((above(o) for o in trees), default=0)
    # Crown width is checked on tree crowns; a hedge or shrub bed under
    # 4 m is not a crown.
    widest = max((area(o["ring"]) for o in trees if above(o) >= 4), default=0)
    lo, hi = ref["heightM"]
    fails = []
    if trees and top > hi + 2:
        fails.append("height %.1f > %g" % (top, hi + 2))
    if len(trunks) < ref.get("minTrunks", 0):
        fails.append("trunks %d < %d" % (len(trunks), ref["minTrunks"]))
    if widest > ref.get("maxCrownM2", 1e9):
        fails.append("crown %d m2 > %g" % (round(widest), ref["maxCrownM2"]))
    out.append({"id": ref["id"], "trees": len(trees), "trunks": len(trunks), "maxTop": round(top, 1), "widestM2": round(widest), "expect": ref["heightM"], "pass": not fails, "fails": fails})
print(json.dumps(out, indent=1))
