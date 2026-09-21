# Handoff — keep iterating here

Repo: https://github.com/jolla/OpenClutter
Owner: jolla (Jerry / Hamina)

## What to tell a new Grok chat

> Continue https://github.com/jolla/OpenClutter
> Prefer a branch + PR. Read HANDOFF.md first.

Do **not** use an X Grok bot. It cannot push to GitHub.

## Product

**OpenClutter** — search, draw a rectangle, export. Clutter lines up with the map in Hamina Planner, every time, for any site.

**UI (must stay this simple):** address search → draw rectangle → one Export. No source picker, OSM checkbox, calibration textarea, or format choosers on the page. Canopy (NLCD) with silent RGB fallback. OSM / `controlPoints` stay API-only.

**Default path (exact, repeatable):** one shared bbox frame.

| Piece | Source | Frame |
|---|---|---|
| Map image | Esri World Imagery export | `bboxSR=4326` `imageSR=4326` `size=imgW,imgH` |
| Buildings | Microsoft US Building Footprints (Esri MSBFP2) | same west/south/east/north |
| Trees | **USFS/NLCD percent tree canopy** (CONUS ImageServer `getSamples`) | same west/south/east/north; ≥30% canopy → lon/lat. **Imagery RGB** only if canopy is missing/nodata for the bbox. OSM nodes optional, **off**. |
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

Do **not** inject OSM building or tree **rings** (broke v8 — Hamina dropped all attenuation_areas). OSM tree **nodes** remain an API flag (`osmTrees: true`), off and hidden from the default page.

## Calibration escape hatch

`controlPoints`: 3+ `{lon,lat,xM,yM}` → affine lon/lat → clipboard meters. **API-only** — not on the default page. **Only** for a map already in Hamina at the wrong scale. Default path must stay shared-bbox (no affine).

## Known issues

1. MS footprint vintage can sit a few meters off current imagery.
2. Heights are heuristics unless the footprint has `height`.
3. Vegetation: default is USFS/NLCD percent tree canopy (30 m, CONUS). Imagery RGB is fallback when the raster is missing/nodata for the bbox (outside CONUS, empty samples). RGB prefers textured woody canopy over smooth lawn and never fills MAX_TREES north-first.
4. Netlify hobby ~10s: footprints + imagery must fit; jpeg-js decode stays **off** the request path (504s). Canopy `getSamples` is JSON (~0.8 s). Browser tries canopy first and sends lon/lat + `treesSource`.
5. US footprints only. NLCD TCC CONUS does not cover HI / PR / SEAK — those sites fall back to imagery RGB.

## Next fixes (priority)

1. USGS 3DEP or other height when available. Meta canopy *height* (not percent) is optional later.
2. If Hamina ever exports a project that already contains objects, diff that JSON against our clipboard and lock any remaining origin quirks.
3. Optional server-side vegetation worker (not jpeg-js in the 10s function) for the RGB fallback path.

## Tree source (do not re-learn)

**Bug (8121 S Long Meadow Dr, Oak Creek WI):** buildings aligned; trees were a dense band of foliage on the **north lawn** with almost none on the **south winter woods**.

Root cause of the old RGB path: `isVeg` matched olive lawn and missed brown canopy, and hits were scanned top→bottom then capped at 180 — northern grass filled the quota.

**Default now:** USFS NLCD Tree Canopy Cover CONUS ImageServer

`https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_NLCD_TCC_CONUS/ImageServer/getSamples`

Same west/south/east/north as the Esri map (`sr=4326`), latest `beginyear`, values 0–100 percent (254/255 nodata). Threshold **≥ 30%**. Spatially stratified pick up to `MAX_TREES` (250). Server still drops points inside building AABBs.

**Fallback to imagery RGB** only when canopy fetch fails **or** fewer than `MIN_VALID_SAMPLES` (20) valid 0–100 pixels (empty raster / outside CONUS). A site that truly has 0–7 trees above 30% stays `nlcd-canopy` — do **not** RGB-paint the lawn.

RGB fallback: reject smooth lawn (low local luma variance); keep textured green + winter brown/gray canopy; collect the whole image then stratified sample (never north-first cap).

`stats.treesSource`: `"nlcd-canopy" | "imagery-rgb" | "none"` in the API/stats payload — **never a UI picker**. Shared logic: `public/tree-detect.js` (browser + Node).

**UX (Jerry):** super simple tool. Search → Draw → Export. Hide OSM checkbox, control-points textarea, format choosers. One status line (“Building map + clutter…”). One-line help: Import zip in Hamina, then paste JSON. OSM/`controlPoints` remain API escape hatches for tests only.

## How to work

```
npm test
edit netlify/lib/*.js netlify/functions/clutter.js public/*
open a branch + PR
```

PR #1 (`feat/hamina-clipboard-consistent-transform`) added a clipboard-only path and dual-scale docs. This shared-bbox pipeline **supersedes** that dual-scale default: clipboard still uses consistent `widthM`/`lengthM`, but the map is the Esri zip, not a GE screenshot.