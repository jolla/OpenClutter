# Handoff — keep iterating here

Repo: https://github.com/jolla/OpenClutter
Owner: jolla (Jerry / Hamina)

## What to tell a new Grok chat

> Continue https://github.com/jolla/OpenClutter
> Prefer a branch + PR. Read HANDOFF.md first.

Do **not** use an X Grok bot. It cannot push to GitHub.

## Product

**OpenClutter** — search, draw a rectangle, export. Clutter lines up with the map in Hamina Planner, every time, for any site.

**UI (must stay this simple):** address search → draw rectangle → one Export → **one `.zip` download**. No source picker, OSM checkbox, calibration textarea, or format choosers on the page. Canopy (NLCD) with silent RGB fallback. OSM / `controlPoints` stay API-only.

**Happy path:** import the zip. Status copy: “Import this zip in Hamina (Projects → Import → OpenIntent).” No paste instructions in the main UI.

**Default path (exact, repeatable):** one shared bbox frame.

| Piece | Source | Frame |
|---|---|---|
| Map image | Esri World Imagery export | `bboxSR=4326` `imageSR=4326`; **snap frame to the export’s actual `extent` + JPEG size** (Esri often pads N/S) |
| Buildings | Microsoft US Building Footprints (Esri MSBFP2), **paginated** to 2000 | same **actual** west/south/east/north as the JPEG |
| Trees | **USFS/NLCD percent tree canopy** as a **density field** (jittered NMS, not the 30 m sample lattice) | same extent; ≥18% canopy. **Imagery RGB** only if canopy is missing/nodata, or when TCC is valid but too sparse for the bbox (desert golf). OSM nodes optional, **off**. |
| Map size | OpenIntent zip `dimensions` meters | `widthM` × `lengthM` from the **snapped JPEG extent** |
| Objects | OpenIntent `floorplans[].attenuation_areas[]` + `area_materials` | same snapped extent, Y-up pixels, stock Hamina type names |

Hamina **2026-09-01** (docs.hamina.com): “OpenIntent import and export now supports attenuating objects!” Support matrix: Attenuating Objects ✅ import/export. Clipboard paste was the workaround from when import dropped areas.

`hamina-clipboard.json` stays **inside the zip as a silent fallback** for older Hamina builds. Do not make paste the happy path. The UI must not trigger a second clipboard download.

Shared math lives in `netlify/lib/geo-frame.js`. Pipeline in `netlify/lib/pipeline.js`. HTTP in `netlify/functions/clutter.js`. Tests in `test/`.

OpenIntent pixels (Y-up from SW) and clipboard meters (NE = 0,0) share the JPEG extent:

```
OpenIntent: SW → (0, 0) px ; NE → (imgW, imgH) px
Clipboard:  SW → (−widthM, −lengthM) ; NE → (0, 0)
JPEG (Y-down from NW):  x_clip = x_img * mpuX − widthM ;  y_clip = −y_img * mpuY
OpenIntent (Y-up from SW): x_clip = x_up * mpuX − widthM ; y_clip = y_up * mpuY − lengthM
y_up + y_img = imgH
```

`widthM`×`lengthM` are the **JPEG’s actual Esri extent**, not the rectangle the user drew. World Imagery `imageSR=4326` routinely returns a taller lat span than requested (~1/cos φ). Mapping footprints with the drawn box was the Long Meadow rooftop miss.

Zip also contains `alignment-overlay.svg` (buildings+trees on the exact Esri JPEG) and `frame-lock.json`. Open the SVG after unzip to verify image-space lock before blaming Hamina.

Stock Hamina type names (do not invent): Foliage - Heavy/Light, Tree Trunk, Building - One/Five Floor, Hotel podium. Heights and `attenuation_per_m` match the clipboard zone types. Schema: OpenIntent 2.0.1 `attenuation_area` = `{ area: { coordinates: [{coordinate_xyz:{x,y,unit:"pixels"}}] }, area_material }`. Coords must be ≥ 0 (schema minimum). Invalid / OSM rings historically caused Hamina to drop **all** areas — emit fewer, clipped, closed polygons only.

## Root cause we already hit (do not re-learn the hard way)

Mixing a **Google Earth screenshot** (Hamina auto-scale ≠ photo meters) with **lon/lat footprints** is the failure mode.

Wynn example: 3840×2160 GE frame is ~2376×1337 m geographically; Hamina’s scale bar showed ~796×448 m. Clipboard built for 796 m **piled in a corner**. Clipboard built for the OpenIntent geographic meters **spread**. Guessing a dual-scale transform (world file → pixels → Hamina map meters) is fragile and site-specific.

**GE screenshots as maps are an anti-pattern.** The zip from this app *is* the map.

Do **not** inject OSM building or tree **rings** (broke v8 — Hamina dropped all attenuation_areas). OSM tree **nodes** remain an API flag (`osmTrees: true`), off and hidden from the default page.

## Calibration escape hatch

`controlPoints`: 3+ `{lon,lat,xM,yM}` → affine lon/lat → clipboard meters. **API-only** — not on the default page. **Only** for a map already in Hamina at the wrong scale. Default path must stay shared-bbox (no affine).

## Known issues

1. MS footprint vintage can sit a few meters off current imagery.
2. Heights are heuristics unless the footprint has `height`.
3. Vegetation: default is USFS/NLCD percent tree canopy (30 m, CONUS) treated as a **density field** — jittered stratified samples + NMS, not one tree per getSamples lattice point. Imagery RGB is fallback when the raster is missing/nodata for the bbox (outside CONUS, empty samples) **or** when TCC is valid but places 0 trees (Oak Creek parking / winter street trees) or is too sparse for golf woods. RGB prefers textured woody canopy over smooth lawn, then the same scatter/NMS (never a step lattice, never north-first cap).
4. Netlify hobby ~10s: footprints + imagery must fit; jpeg-js decode stays **off** the request path (504s). Canopy `getSamples` is JSON (~0.8 s). Browser tries canopy first and sends lon/lat + `treesSource`.
5. US footprints only. NLCD TCC CONUS does not cover HI / PR / SEAK — those sites fall back to imagery RGB.

## Next fixes (priority)

1. USGS 3DEP or other height when available. Meta canopy *height* (not percent) is optional later.
2. If Hamina exports a project that already contains objects, diff that OpenIntent JSON against ours and lock any remaining origin quirks.
3. Optional server-side vegetation worker (not jpeg-js in the 10s function) for the RGB fallback path.

## Tree source (do not re-learn)

**Bug (8121 S Long Meadow Dr, Oak Creek WI):** buildings aligned; trees were a dense band of foliage on the **north lawn** with almost none on the **south winter woods**.

Root cause of the old RGB path: `isVeg` matched olive lawn and missed brown canopy, and hits were scanned top→bottom then capped at 180 — northern grass filled the quota.

**Default now:** USFS NLCD Tree Canopy Cover CONUS ImageServer

`https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_NLCD_TCC_CONUS/ImageServer/getSamples`

Same west/south/east/north as the Esri map (`sr=4326`), latest `beginyear`, values 0–100 percent (254/255 nodata). Threshold **≥ 18%**. **Do not place a tree on every sample center** — `getSamples` is a regular grid (the Long Meadow orchard). `placeTreesFromCanopy` treats % as density: local maxima, jitter inside the cell, NMS spacing ~7–16 m (tighter in continuous woods), lawns/low % get few/none. Cap `maxTreesForBbox` (180 small maps, 600–800 large golf/campus). Server still drops points inside building AABBs. Stratified bins fill woods, not just building-yard peaks.

**Fallback to imagery RGB** only when canopy fetch fails **or** fewer than `MIN_VALID_SAMPLES` (20) valid 0–100 pixels (empty raster / outside CONUS). A site that truly has 0–7 trees above 30% stays `nlcd-canopy` — do **not** RGB-paint the lawn.

RGB fallback: reject smooth lawn (low local luma variance); keep textured green + winter brown/gray canopy; collect the whole image then stratified sample (never north-first cap).

`stats.treesSource`: `"nlcd-canopy" | "imagery-rgb" | "none"` in the API/stats payload — **never a UI picker**. Shared logic: `public/tree-detect.js` (browser + Node).

**UX (Jerry):** super simple tool. Search → Draw → Export → **one `.zip`**. Hide OSM checkbox, control-points textarea, format choosers. One status line (“Building map + clutter…”). After export: “Import this zip in Hamina (Projects → Import → OpenIntent).” plus coverage stats (buildings kept/fetched/drops, trees kept). OSM/`controlPoints` remain API escape hatches for tests only.

## How to work

```
npm test
edit netlify/lib/*.js netlify/functions/clutter.js public/*
open a branch + PR
```

PR #1 (`feat/hamina-clipboard-consistent-transform`) added a clipboard-only path and dual-scale docs. This shared-bbox pipeline **supersedes** that dual-scale default. As of Hamina 2026-09-01, OpenIntent import is the object path; clipboard is fallback only.
