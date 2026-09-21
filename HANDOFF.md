# Handoff — keep iterating here

Repo: https://github.com/jolla/OpenClutter
Owner: jolla (Jerry / Hamina)

## What to tell a new Grok chat

> Continue https://github.com/jolla/OpenClutter
> Prefer a branch + PR. Read HANDOFF.md first.

Do **not** use an X Grok bot. It cannot push to GitHub.

## Product

**OpenClutter** — user draws/enters a bbox (or address) → app produces clutter that lines up with the map in Hamina Planner, every time, for any site.

**Default path (exact, repeatable):** one shared bbox frame.

| Piece | Source | Frame |
|---|---|---|
| Map image | Esri World Imagery export | `bboxSR=4326` `imageSR=4326` `size=imgW,imgH` |
| Buildings | Microsoft US Building Footprints (Esri MSBFP2) | same west/south/east/north |
| Trees | Imagery vegetation (browser) | lon/lat → same frame; OSM nodes optional, **off** |
| Map size | OpenIntent zip `dimensions` meters | `widthM` × `lengthM` from bbox |
| Objects | HaminaClipboard JSON paste | same `widthM`/`lengthM`, documented origin |

Import **zip first** (sets map size), **then paste clipboard**. No per-site nudge.

Shared math lives in `netlify/lib/geo-frame.js`. Pipeline in `netlify/lib/pipeline.js`. HTTP in `netlify/functions/clutter.js`. Tests in `test/`.

Clipboard origin:

```
SW → (−widthM, −lengthM)   NE → (0, 0)
x_clip = x_px * mpuX − widthM
y_clip = y_from_south_px * mpuY − lengthM
```

HaminaClipboard schema (header, empty collections, zone types with `ituRModelEnabled` / `transparencyEnabled`, stock names) matches the working geo paste. Types: Foliage - Heavy/Light, Tree Trunk, Building - One/Five Floor, Hotel podium.

## Root cause we already hit (do not re-learn the hard way)

Mixing a **Google Earth screenshot** (Hamina auto-scale ≠ photo meters) with **lon/lat footprints** is the failure mode.

Wynn example: 3840×2160 GE frame is ~2376×1337 m geographically; Hamina’s scale bar showed ~796×448 m. Clipboard built for 796 m **piled in a corner**. Clipboard built for the OpenIntent geographic meters **spread**. Guessing a dual-scale transform (world file → pixels → Hamina map meters) is fragile and site-specific.

**GE screenshots as maps are an anti-pattern.** The zip from this app *is* the map.

OpenIntent `attenuation_areas` imports are unreliable in Hamina; clipboard paste is the dependable object path. Keep emitting both: zip for map size + image, clipboard for objects.

Do **not** inject OSM building or tree **rings** (broke v8 — Hamina dropped all attenuation_areas). Optional OSM is tree **nodes** only.

## Calibration escape hatch

`controlPoints`: 3+ `{lon,lat,xM,yM}` → affine lon/lat → clipboard meters. **Only** for a map already in Hamina at the wrong scale. Default path must stay shared-bbox (no affine).

## Known issues

1. MS footprint vintage can sit a few meters off current imagery.
2. Heights are heuristics unless the footprint has `height`.
3. Vegetation detection is color heuristic (desert/golf tuned); not species ID.
4. Netlify hobby ~10s: footprints + imagery must fit; jpeg-js decode stays **off** the request path (504s). Trees are detected in the browser and sent as lon/lat.
5. US footprints only.

## Next fixes (priority)

1. USGS 3DEP or other height when available.
2. If Hamina ever exports a project that already contains objects, diff that JSON against our clipboard and lock any remaining origin quirks.
3. Optional server-side vegetation worker (not jpeg-js in the 10s function).

## How to work

```
npm test
edit netlify/lib/*.js netlify/functions/clutter.js public/*
open a branch + PR
```

PR #1 (`feat/hamina-clipboard-consistent-transform`) added a clipboard-only path and dual-scale docs. This shared-bbox pipeline **supersedes** that dual-scale default: clipboard still uses consistent `widthM`/`lengthM`, but the map is the Esri zip, not a GE screenshot.