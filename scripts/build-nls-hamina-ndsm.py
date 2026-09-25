#!/usr/bin/env python3
"""Rebuild netlify/lib/nls-hamina-ndsm.gz from the open NLS lidar tile.

Tile L5211C3 (2009) is the 3 km square over Hamina town center.
National Land Survey of Finland Laser scanning data 2008–2019, CC BY 4.0.
Funet publishes it without an API key. NLS_API_KEY is for the official WCS
and OGC API Processes services; this script does not use one.

Requires: numpy, laspy[lazrs]
"""

import gzip
import os
import urllib.request

import numpy as np
import laspy

URL = (
    "https://www.nic.funet.fi/pub/sci/geo/geodata/mml/laserkeilaus/"
    "2008_latest/2009/L521/2/L5211C3.laz"
)
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "netlify", "lib", "nls-hamina-ndsm.gz")
ORIGIN_E = 509000.0
ORIGIN_N = 6714000.0
CELL = 2.0
COLS = 1500
ROWS = 1500


def main():
    laz = os.environ.get("NLS_LAZ") or "/tmp/nls/L5211C3.laz"
    if not os.path.isfile(laz):
        os.makedirs(os.path.dirname(laz), exist_ok=True)
        urllib.request.urlretrieve(URL, laz)
    las = laspy.read(laz)
    x = np.asarray(las.x)
    y = np.asarray(las.y)
    z = np.asarray(las.z)
    c = np.asarray(las.classification)

    def bin_idx(xx, yy):
        col = np.floor((xx - ORIGIN_E) / CELL).astype(np.int32)
        row = np.floor((yy - ORIGIN_N) / CELL).astype(np.int32)
        return col, row

    g = c == 2
    gc, gr = bin_idx(x[g], y[g])
    ok = (gc >= 0) & (gc < COLS) & (gr >= 0) & (gr < ROWS)
    acc = np.zeros((ROWS, COLS), np.float64)
    cnt = np.zeros((ROWS, COLS), np.int32)
    np.add.at(acc, (gr[ok], gc[ok]), z[g][ok])
    np.add.at(cnt, (gr[ok], gc[ok]), 1)
    ground = np.full((ROWS, COLS), np.nan, np.float64)
    hit = cnt > 0
    ground[hit] = acc[hit] / cnt[hit]
    for _ in range(12):
        nan = np.isnan(ground)
        if not nan.any():
            break
        accf = np.zeros_like(ground)
        cf = np.zeros_like(ground)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                shifted = np.roll(np.roll(ground, dy, 0), dx, 1)
                good = np.isfinite(shifted)
                accf[good] += np.nan_to_num(shifted)[good]
                cf[good] += 1
        fill = nan & (cf > 0)
        ground[fill] = accf[fill] / cf[fill]

    u = c == 1
    uc, ur = bin_idx(x[u], y[u])
    ok = (uc >= 0) & (uc < COLS) & (ur >= 0) & (ur < ROWS)
    h = z[u][ok] - ground[ur[ok], uc[ok]]
    keep = np.isfinite(h) & (h >= 2.0) & (h <= 60.0)
    hgt = np.zeros((ROWS, COLS), np.float32)
    np.maximum.at(hgt, (ur[ok][keep], uc[ok][keep]), h[keep].astype(np.float32))
    dm = np.round(hgt * 10).astype(np.uint16)
    dm[hgt < 2.0] = 0
    raw = dm.tobytes(order="C")
    with gzip.open(OUT, "wb", compresslevel=9) as f:
        f.write(raw)
    print("wrote", OUT, "bytes", os.path.getsize(OUT), "cells", int((dm > 0).sum()))


if __name__ == "__main__":
    main()
