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

**Happy path:** import the zip. Status copy: “Import this zip in Hamina (Projects → Import → OpenIntent).” No paste instructions in the main UI. Clipboard paste is optional legacy.

**Default path (exact, repeatable):** one shared bbox frame.

| Piece | Source | Frame |
|---|---|---|
| Map image | Esri World Imagery export | `bboxSR=4326` `imageSR=4326`; **snap frame to the export’s actual `extent` + JPEG size** (Esri often pads N/S) |
| Buildings | Microsoft **Global ML** (zoom-9 quadkey gzip, bbox-clipped, `height` when above 2 m) then **Overture Buildings** `2026-08-19.0` (`height`, else `num_floors` × 3 m), then Esri MSBFP2, then FEMA **USA Structures**. One ring per roof. MSBFP2 paginated to 2000 | same **actual** west/south/east/north as the JPEG |
| Trees | **USFS/NLCD percent tree canopy** as a **density field** (jittered NMS, not the 30 m sample lattice). **Meta/WRI CHM v2** sets `top_height` from a windowed COG when the pixel is above 2 m | same extent; ≥18% canopy. **Imagery RGB** only if canopy is missing/nodata (true gaps). Valid NLCD zeros/sparse stay NLCD — do not RGB-paint parking. No trees on roofs or pavement. OSM nodes optional, **off**. |
| Map size | OpenIntent zip `dimensions` meters | `widthM` × `lengthM` from the **snapped JPEG extent** |
| Objects | OpenIntent buildings and trees, both on Building - One/Two/Five/Ten Floor | exact foliage names + measured heights on optional `hamina-clipboard.json` |

Hamina **2026-09-01** (docs.hamina.com): “OpenIntent import and export now supports attenuating objects!” Support matrix: Attenuating Objects ✅ import/export. Clipboard paste was the workaround from when import dropped areas.

`hamina-clipboard.json` still carries **Foliage / Tree Trunk** names and exact measured heights. Import OpenIntent for the map, buildings, and tree rings. Buildings stay on the gold Building set. Trees use `Tree Foliage H.H` and `Tree Wood H.H` at the measured height. Do not emit `Foliage N.N m`, `Tree Trunk`, or `Foliage - Heavy` — those emptied every attenuation area.

Shared math lives in `netlify/lib/geo-frame.js`. Pipeline in `netlify/lib/pipeline.js`. HTTP in `netlify/functions/clutter.js`. Tests in `test/`.

OpenIntent pixels (Y-up from SW) and clipboard meters (NE = 0,0) share the JPEG extent. After Esri N/S pad, `lockIsotropicImagery` keeps the **Esri content pixel grid** (downscale only if over maxSide — no geodesic stretch) and `unifyFrameMpu` sets `lengthM = imgH * mpu` so Hamina’s isotropic map meters match the image aspect. Stretching the aerial to geodesic aspect made footprints sit south/large of rooftops. Clipboard building rings use **OI pixel vertices only**. Floorplan `dimensions[].height` is Hamina outdoor **2.5 m** / 8.202 ft (not 12 m). `scoreClipboardOverlayAlignment` fails on systematic south shift or scale>1 vs `alignment-overlay.svg`.

If OpenIntent import still shows map-only after height=2.5 + gold Building-* materials, treat **clipboard paste as required for clutter** until Hamina confirms outdoor OI import; keep shipping both.

```
OpenIntent: SW → (0, 0) px ; NE → (imgW, imgH) px
Clipboard:  SW → (−widthM, −lengthM) ; NE → (0, 0)
JPEG (Y-down from NW):  x_clip = x_img * mpuX − widthM ;  y_clip = −y_img * mpuY
OpenIntent (Y-up from SW): x_clip = x_up * mpuX − widthM ; y_clip = y_up * mpuY − lengthM
y_up + y_img = imgH
```

`widthM`×`lengthM` are the **JPEG’s actual Esri extent**, not the rectangle the user drew. World Imagery `imageSR=4326` routinely returns a taller lat span than requested (~1/cos φ). Mapping footprints with the drawn box was the Long Meadow rooftop miss.

Zip also contains `alignment-overlay.svg` (buildings+trees on the exact Esri JPEG) and `frame-lock.json`. Open the SVG after unzip to verify image-space lock before blaming Hamina.

OpenIntent buildings (Jerry’s gold Hamina export): Building - One / Two / Five / Ten Floor. Tree `attenuation_areas` add custom materials with that same object shape: `Tree Foliage H.H` (canopy, top_height = measured/CHM metres, about 0.8–2.2 dB/m, green) and `Tree Wood H.H` (point-tree trunk, same height, 10 dB/m, `#937E75`). Multi-cell NLCD patches are canopy polygons; a lone tree is a circle. A vegetation entry is in `area_materials` only when an area uses it. Clipboard may still use Foliage - Heavy/Light, Tree Trunk, Hotel podium, and measured `bldg-m-*` / `foliage-m-*` / `trunk-m-*` types. Those names, and per-metre `Foliage N.N m` / `Tree Trunk N.N m` / `Building N.N m`, stay off OpenIntent — they emptied every attenuation_area. Schema: OpenIntent 2.0.1 `attenuation_area` = `{ area: { coordinates: [pixel, meter, foot, …] }, area_material }` where each vertex is three consecutive `coordinate_xyz` entries and `area_material` is the material object (keys `name`, `rf_properties`, `top_height`, `display_color` — no `itu_material_type`, no `bottom_height`). Coords must be ≥ 0 (schema minimum). Invalid / OSM rings historically caused Hamina to drop **all** areas — emit fewer, clipped, closed polygons only (≤40 verts, both axes ≥4 px).

## Root cause we already hit (do not re-learn the hard way)

Mixing a **Google Earth screenshot** (Hamina auto-scale ≠ photo meters) with **lon/lat footprints** is the failure mode.

Wynn example: 3840×2160 GE frame is ~2376×1337 m geographically; Hamina’s scale bar showed ~796×448 m. Clipboard built for 796 m **piled in a corner**. Clipboard built for the OpenIntent geographic meters **spread**. Guessing a dual-scale transform (world file → pixels → Hamina map meters) is fragile and site-specific.

**GE screenshots as maps are an anti-pattern.** The zip from this app *is* the map.

Do **not** inject OSM building or tree **rings** (broke v8 — Hamina dropped all attenuation_areas). OSM tree **nodes** remain an API flag (`osmTrees: true`), off and hidden from the default page.

## Calibration escape hatch

`controlPoints`: 3+ `{lon,lat,xM,yM}` → affine lon/lat → clipboard meters. **API-only** — not on the default page. **Only** for a map already in Hamina at the wrong scale. Default path must stay shared-bbox (no affine).

## Known issues

1. Esri MSBFP2 (`dataLastEditDate` 2022-04-13) is not the full Microsoft set. Jerry’s Oak Creek draw is the north–south commercial corridor in the 877×1046 export (extent in `test/fixtures/oak-creek-commercial/bbox.json`, ~877×1417 m). That export fetched **49** MSBFP2 footprints and kept **48** (one tiny). Hamina imported all **558** emitted areas. The large white retail roof is not in those 49. Global ML for quadkey `030222210` clips to **68** on that extent (the 2026-08-13 tile was checked; the polygons that hit this bbox match the 2026-07-24 file). Overture, then FEMA USA Structures, add roofs whose centroids are still outside that merge. A few bright roofs are in none of the vector layers and are filled from the JPEG when they are large, smooth, and bright (≥2500 m²). Index: `netlify/lib/ms-buildings-index.json`. Refresh when Microsoft moves `dataset-links.csv` (index is the 2026-07-24 UnitedStates rows; current manifest is `https://bfppub.z5.web.core.windows.net/2026-08-13/dataset-links.csv`). A failed or slow (>8s) global, Overture, USA Structures, CHM, or 3DEP download is ignored. OSM building ways are still not fetched.
2. Measured heights are emitted. Conflation lives in `netlify/lib/conflate.js`. Same roof: exterior centroid inside a kept ring, or within 11 m of that ring’s centroid. Geometry replace: single exterior, more vertices and area ratio 0.65–1.5, or the kept ring is a stub inside a fuller outline (area ratio 1.35–2.4). Height rank: Overture explicit, then Microsoft Global ML, then FEMA `HEIGHT`, then Overture floors × 3 m, then the nearest measured neighbor within 120 m, then stock bins. Area ratio outside 0.4–2.5 does not copy height onto a different-sized ring. OpenIntent building `area_materials` are Hamina’s outdoor Building - One/Two/Five/Ten Floor objects (gold export match), then `Tree Foliage H.H` / `Tree Wood H.H` at the measured height when a tree area uses them. Each `attenuation_area.area_material` is a full copy of that catalog entry with Hamina-native keys only (`name`, `rf_properties`, `top_height`, `display_color` — no `itu_material_type`, no `bottom_height`). Each ring vertex is emitted as consecutive `pixels`, `meters`, `feet` `coordinate_xyz` entries. Pixel aspect equals meter aspect after the Esri snap (isotropic mpu). `reference_markers` is empty. Foliage - Heavy / Tree Trunk / Hotel podium / per-metre **names** stay off OpenIntent — they emptied every attenuation_area for Jerry. Tree rings use Tree Foliage and Tree Wood at the measured height (not a 9 m / 15 m bucket). Exact metres stay on `hamina-clipboard.json` zone types (`bldg-m-*`, `foliage-m-*`, `trunk-m-*`). `stats.compatibilityMode` is `custom-vegetation`. The zip emits at most 982 areas (buildings first, then canopy, then trunks). Clipboard zones are clipped to the JPEG meter frame (NE = 0,0, SW = −widthM,−lengthM). Tree placement stays NLCD. Meta/WRI CHM v2 (`netlify/lib/canopy-height.js`) sets foliage `top_height` from a zoom-10 COG window resampled to at most 180 px on a side; values at or below 2 m or at or above 80 m are ignored and the NLCD-informed height remains. Parking medians stay a separate imagery pass.
3. Vegetation: default is USFS/NLCD percent tree canopy (30 m, CONUS) treated as a **density field** — jittered stratified samples + NMS, not one tree per getSamples lattice point. Continuous woods pack tighter (about a 5 m floor) than isolated 18% cells, which stay sparse so parking is not carpeted. The browser sends NLCD hits (`canopyHits`); the server re-places them after footprints exist and rejects points on building boxes, so rooftop false trees do not use up the cap. Imagery RGB is fallback **only** when the raster is missing/nodata for the bbox (outside CONUS, empty samples). Valid NLCD with 0 trees (parking lots) stays `nlcd-canopy`. RGB requires textured woody canopy (not smooth lawn, not gray parking). Never a step lattice, never north-first cap. CHM does not add or remove trees.
4. Netlify hobby ~10s. The Esri JPEG starts immediately on its own abort (8.5s per attempt, one retry after 400ms only when that still leaves 1.2s under an 8.5s ceiling) and a 1040px long-side cap. Imagery metadata is the same export service and is capped at 4s in parallel with the JPEG — do not await it before `fetchImageryJpeg`. Esri often returns that JSON in ~3s and the extent is hundreds of metres taller than the request at the same pixel size; skipping the snap clips the corridor. MSBFP2, Global ML, USA Structures, and NLCD keep a separate 7s clock and are not aborted by the imagery signal. Overture starts with the JPEG on the request bbox (own abort, not the imagery signal), before Global ML, so the GeoParquet read is not stuck behind the quadkey gzip. A read that has already finished is kept even if core then passes 5s. If it is still running, wait up to 1.5s more but not past 9s from the start — aborting at 5s with no grace is how the Las Vegas Sphere disappeared (Overture 2026-08-19.0 has the ~24k m² ring; MS Global quadkey `023013100` and USA Structures do not; it is under the 150k m² mega cutoff). CHM and 3DEP still start only after that core phase, each aborted at 2s, and they are skipped entirely once the core phase has used 5s. Their failures are lines in `export-warnings.json`, never a 502, and never the words “Esri” or “smaller box”. Do not put them back inside the core `Promise.all` — a hanging COG or parquet read aborted the aerial download and the handler labeled it Esri. Do not pass a COG `bbox` into `readRasters` (that fetches every tile). jpeg-js decode stays **off** the request path except the existing imagery roof/median pass. Rebuild the Overture index with `node scripts/build-overture-index.js` when the release changes; do not vendor DuckDB. Prove an Oak Creek export with `node scripts/verify-oak-creek.js` (or `--url https://openclutter.netlify.app` after this branch is on production).
5. FEMA, NLCD, and 3DEP are United States sources. NLCD TCC CONUS does not cover HI / PR / SEAK — those sites fall back to imagery RGB. Overture and Global ML apply wherever their tiles exist. 3DEP terrain is a second clipboard, not an OpenIntent object: `terrain-clipboard.json` uses the same NE-origin meters as `hamina-clipboard.json`. `raisedFloorZones` are flat pads (`area` xy, `height`, `attenuationDbPerMeter` 0, `slabOnly` true). `slopedFloors` are triangles (`area` xyz, z = meters above the lowest lattice node, `crowdEnabled` false, `drawStairs` false, `slabOnly` true). The main clipboard keeps both arrays empty. Paste steps are in the zip `README.txt`.

## Next fixes (priority)

1. Bare-earth 3DEP is terrain, not roof height. There is still no public DSM−DTM service for CONUS roof height. Imagery roof fill covers large smooth bright roofs absent from Global ML, Overture, MSBFP2, and USA Structures: bright, low-saturation, low local variance, ≥2500 m², convex hull, skipped when vectors already cover the component. Eval deletes the Oak Creek white-retail polygon and requires the mask to put it back.
2. If Hamina exports a project that already contains objects, diff that OpenIntent JSON against ours and lock any remaining origin quirks. Import-proofing: every ring is validated before emit (closed, finite, pixels Y-up, stock materials); omit `bottom_height` on OI materials (Hamina “Invalid OpenIntent format”); expand sub-pixel trunks; `VERIFY.txt` + `export-stats.json` `attenuationAreasEmitted` record the exact `attenuation_areas` length. One bad ring must never wipe the import. Jerry’s Oak Creek zip had 845 well-formed areas and still showed none in Hamina — generation ≠ display.
3. Optional server-side vegetation worker (not jpeg-js in the 10s function) for the RGB fallback path.
4. Keep `npm run eval` green; refresh fixtures with `npm run fixtures:fetch` if Esri/NLCD vintage drifts.

## Tree source (do not re-learn)

**Bug (8121 S Long Meadow Dr, Oak Creek WI):** buildings aligned; trees were a dense band of foliage on the **north lawn** with almost none on the **south winter woods**.

Root cause of the old RGB path: `isVeg` matched olive lawn and missed brown canopy, and hits were scanned top→bottom then capped at 180 — northern grass filled the quota.

**Default now:** USFS NLCD Tree Canopy Cover CONUS ImageServer

`https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_NLCD_TCC_CONUS/ImageServer/getSamples`

Same west/south/east/north as the Esri map (`sr=4326`), latest `beginyear`, values 0–100 percent (254/255 nodata). Threshold **≥ 18%**. **Do not place a tree on every sample center** — `getSamples` is a regular grid (the Long Meadow orchard). `placeTreesFromCanopy` treats % as density: local maxima, jitter inside the cell, NMS spacing ~7–16 m (tighter in continuous woods), lawns/low % get few/none. Cap `maxTreesForBbox` (180 small maps, 600–800 large golf/campus). Server still drops points inside building AABBs. Stratified bins fill woods, not just building-yard peaks.

**Fallback to imagery RGB** only when canopy fetch fails **or** fewer than `MIN_VALID_SAMPLES` (20) valid 0–100 pixels (empty raster / outside CONUS). A site that truly has 0–7 trees above threshold stays `nlcd-canopy` — do **not** RGB-paint the lawn or parking lot (PR #8’s “RGB when NLCD=0” did that).

RGB fallback: reject smooth lawn and gray pavement (low local luma variance, high luma, low sat); keep textured green + winter brown canopy; collect the whole image then stratified sample (never north-first cap).

`stats.treesSource`: `"nlcd-canopy" | "imagery-rgb" | "none"` in the API/stats payload — **never a UI picker**. Shared logic: `public/tree-detect.js` (`resolveTrees` / `rgbFillNeeded`) used by the browser, eval, and Node tests.

**Eval (no Hamina, no Jerry):** `npm run eval` scores cached fixtures in `test/fixtures/` (Oak Creek commercial + Long Meadow). Image-space overlay + `export-stats.json`. `--legacy` / `--compare-legacy` replays RGB-carpet. `--live` hits Esri/NLCD. Exit non-zero on over-trees or dropped large roofs.

**UX (Jerry):** super simple tool. Search → Draw → Export → **one `.zip`**. Hide OSM checkbox, control-points textarea, format choosers. One status line (“Building map + clutter…”). After export: “Import this zip in Hamina (Projects → Import → OpenIntent).” plus coverage stats (buildings kept/fetched/drops, trees kept). OSM/`controlPoints` remain API escape hatches for tests only.

## How to work

```
npm test
npm run eval
edit netlify/lib/*.js netlify/functions/clutter.js public/*
open a branch + PR
```

PR #1 (`feat/hamina-clipboard-consistent-transform`) added a clipboard-only path and dual-scale docs. This shared-bbox pipeline **supersedes** that dual-scale default. As of Hamina 2026-09-01, OpenIntent import is the object path; clipboard is fallback only.
