# OpenClutter

**OpenClutter** turns a map box into clutter that lines up with the map in [Hamina Planner](https://hamina.com): one georeferenced [OpenIntent](https://github.com/google/openintent) zip. Import the zip for the map and **buildings**. **Include foliage** is off by default. Check it to add canopy crowns. `hamina-clipboard.json` is optional legacy paste and follows the same choice.

**v1.0.0** — stable buildings → Hamina OpenIntent import (production freeze).

**v1.1.21** on `dev` — Finland terrain paste uses the same ground-meter frame as the aerial, so the quads are roughly square and the status shows that cell size. A 1 m or Auto paste on a town is meter-scale: the mesh steps coarser only when the draw will not fit, and the readout names that size instead of a 500×500 label on a stretched slab. GLO-30 is still about 30 m native; a finer cell is interpolated. A Finland town export still offers **Copy terrain** after the ground-meter aerial resample. When little time is left, the elevation grid steps down to a coarser lattice and still pastes, instead of omitting terrain with a timeout. A Finland town import keeps the shape and the ground scale of the map you drew. The aerial is resampled so east–west and north–south pixels are ground meters, and buildings and terrain paste use that same frame. A US site keeps the existing aerial grid. A Finland export finishes. The Hamina NLS laser grid is packaged with the function, so measured building heights still apply, and a grid that cannot be read omits those heights inside a successful zip instead of Export failed (502). Buildings and canopy sit on the pasted slope: bottom height from floor is the higher of the DEM under the footprint and the pasted floor there, and top height from floor is that bottom plus the object height. A US bare-earth hill still lifts the same way; a US site under 20 m of relief still stays on the floor. Terrain resolution on the dev host adds **20, 15, 10, 5, and 1 m** past Finest (~25 m). Auto, Default, and Fine stay. Those finer stops can paste denser than the old 20×20 Hamina expectation so a ski hill can keep that cell size (mesh cap 500 quads on a side, enough for about 5 m on a 2.5 km draw). The readout shows the cell size and the ground that mesh covers. A paste past 20×20 is listed in `export-warnings.json`. A mesh that will not fit beside the zip in one response is coarsened until Copy terrain still returns with the download. The status names that reduction. If it still cannot, Copy terrain is left out and the OpenIntent zip still downloads. DEM samples for those stops step down when time is short. The dev host still keeps the v1.1.14 sharper Esri World Imagery JPEG (1600 px on the long side instead of 1040); production keeps the 1040 cap, and there is no imagery-quality control on the page. Outside USGS 3DEP coverage the dev host still gives up on that request quickly and reads Copernicus DEM GLO-30, including a coarser grid when the aerial has already used the export clock. Building and foliage objects sit on that surface. A US 3DEP hit is unchanged. Production stays 3DEP only. The page title and the export zip (`openclutter_version`) both read this from `package.json`.

Live: https://openclutter.netlify.app · Dev: https://openclutter.netlify.app/dev · Source: https://github.com/jolla/OpenClutter

## Production vs Dev

| | Production | Dev |
|---|---|---|
| URL | https://openclutter.netlify.app | https://openclutter.netlify.app/dev → https://dev--openclutter.netlify.app |
| Git branch | `main` | `dev` |
| Purpose | Frozen **v1.0** buildings OpenIntent import — address, draw, export | Experiments (trees-in-OI, terrain, etc.) without breaking production |

- Use **production** for the known-good 1.0 buildings workflow.
- Hack on **https://openclutter.netlify.app/dev**. The title row shows a **dev** badge and the build version (`dev · v1.1.21`). The same dev host shows **Terrain resolution** (Auto / Default / Fine / 25 / 20 / 15 / 10 / 5 / 1 m) next to Include foliage. Auto is selected by default.
- Workflow: open feature PRs against `dev`. Promote with a PR `dev` → `main` only for a production release; then tag (e.g. `v1.1.0`).


## Exact alignment (every site)

Hamina **2026-09-01** (docs.hamina.com release notes): “OpenIntent import and export now supports attenuating objects!” The [support matrix](https://docs.hamina.com/hamina/live/openintent) shows Attenuating Objects ✅ import/export. Buildings use Hamina’s Building - One/Two/Five/Ten Floor catalog (Jerry’s gold export). When Include foliage is on, canopy uses the picker types **Foliage - Heavy** (19.68 ft, 2 dB/m) and **Foliage - Light** (19.68 ft, 1 dB/m), same object shape. A measured height that is not 19.68 ft is a custom `Foliage - Heavy H.H` / `Foliage - Light H.H`. There is no Tree type. `Tree Trunk` and per-metre `Foliage N.N m` stay off the OpenIntent catalog.

One bbox drives everything:

1. Esri World Imagery for that bbox (`bboxSR=4326`, `imageSR=4326`). **The frame is the JPEG’s actual `extent`**, which is often taller than the drawn box. After that snap, meters are unified to the JPEG pixel aspect (`lengthM = imgH * widthM/imgW`) so Hamina’s isotropic map scale matches. In the continental US the aerial content grid is kept. At high latitude (Finland), that degree grid is resampled so pixels are square in ground meters, and buildings, the aerial, and terrain paste use that frame.
2. Building footprints mapped through that actual extent: Microsoft Global ML (height used when the tile has one), Overture Buildings (`height` or `num_floors`), Esri MSBFP2, then FEMA USA Structures. One ring per roof; the best measured height wins.
3. **Include foliage** (off unless checked). When on, a Meta/WRI canopy-height window is turned into individual crown polygons: each ring follows the measured canopy cells and uses that crown’s height. If the height model does not resolve crowns, USFS/NLCD percent tree canopy is emitted as connected canopy polygons (imagery RGB only if the canopy raster is missing/empty — **not** when NLCD is valid zeros on parking/lawn). Rings are cut around building footprints (4 m buffer) and imagery water before they are emitted, so foliage does not cover roofs or ponds. A short height spike far from NLCD canopy is not emitted, so pavement does not grow trees. Individual tree-point circles and median dots are not emitted. Trunks are not emitted — OpenIntent has no Tree type, so a trunk cannot be imported that way.
4. lon/lat → JPEG pixels with the actual west/south/east/north (OpenIntent Y-up / JPEG Y-down).
5. OpenIntent `attenuation_areas` are **buildings** by default. Buildings use Building - One/Two/Five/Ten Floor. With Include foliage on, canopy uses Foliage - Heavy or Foliage - Light. A measured or CHM height that is not the stock 19.68 ft uses `Foliage - Heavy H.H` or `Foliage - Light H.H` at that height. A CHM peak is one crown polygon. Without a usable height grid, a multi-cell NLCD patch is one canopy polygon. A lone tree point is not a circle.

**Import this zip in Hamina (Projects → Import → OpenIntent)** for the map and buildings. Check Include foliage before export when the site should include canopy. Do not use a GE screenshot as the map.

### Materials that import

Every `area_material` is an object with exactly these keys: `name`, `rf_properties.attenuation_per_m`, `top_height`, `display_color`. No `itu_material_type`, no `bottom_height`. The object deep-equals its catalog entry (a stock name with a different `top_height` is rejected). Buildings are always the gold prefix. A vegetation material is added only when an area uses it, so a buildings-only zip stays the four gold objects.

| Name | Color | Top height | dB/m | Used for |
|---|---|---|---|---|
| Building - One Floor | `#9AA5AC` | 4.5 | 5 | buildings under 6 m |
| Building - Two Floor | `#9A4159` | 7.620092660326749 | 5 | buildings under 11 m |
| Building - Five Floor | `#9AA5AC` | 15.240185320653499 | 5 | buildings under 24 m |
| Building - Ten Floor | `#9AA5AC` | 32 | 5 | taller buildings |
| Foliage - Heavy | `#3F7D2A` | 19.68 ft | 2 | stock canopy, and measured heights within 0.25 m of that |
| Foliage - Light | `#6FA84A` | 19.68 ft | 1 | lighter stock canopy |
| Foliage - Heavy H.H | `#3F7D2A` | measured metres | 2 | measured canopy at or above 12 m |
| Foliage - Light H.H | `#6FA84A` | measured metres | 1 | measured canopy under 12 m |

These names emptied every `attenuation_area` when they were in the catalog, and they are not emitted: `Tree Trunk`, `Foliage N.N m`, `Tree Trunk N.N m`, `Hotel podium`, `Building N.N m`. With Include foliage on, measured canopy metres stay on `hamina-clipboard.json` as `foliage-m-*` for the canopy polygons (not trunks, not tree-point circles). Building metres stay on `bldg-m-*`. The stock names above are the picker types, emitted as full material objects (not a name string, and not with `itu_material_type` or `bottom_height`). Foliage materials are added only when Include foliage is on.

Rings over 40 vertices, or thinner than 4 px on either axis, are omitted. They do not drop the buildings. `VERIFY.txt` lists `openIntentBuildingAreas` and `openIntentTreeAreas`.

A/B from the gold schema: the default zip is the four gold objects. Include foliage adds an unmeasured canopy polygon as the exact `Foliage - Heavy` or `Foliage - Light` object (19.68 ft, 2 or 1 dB/m) and leaves the building `area_material` unchanged. A 14.2 m canopy adds `Foliage - Heavy 14.2` (top_height 14.2, 2 dB/m, `#3F7D2A`) instead of a 9 m or 15 m bucket. OpenIntent 2.0.1 does not enum-restrict material names. `Foliage - Heavy 14.2` is not `Foliage 14.2 m`. Each area deep-equals its catalog entry. Rings stay at ≤40 vertices and ≥4 px on both axes. NLCD patches of two or more cells are the cell outline. A lone tree point is omitted. If a Hamina import still drops every area, the next step is binning every canopy polygon into the two stock objects.

OpenIntent pixels (unit-tested; Y-up from SW, matching oiconvert / Hamina OI):

```
SW (west, south) → (0, 0) px
SE (east, south) → (imgW, 0) px
NW (west, north) → (0, imgH) px
NE (east, north) → (imgW, imgH) px

JPEG Y-down:  y_img from NW
OpenIntent Y-up: y_up from SW
y_up + y_img = imgH
```

Clipboard meters (silent fallback JSON inside the zip, same frame):

```
SW → (−widthM, −lengthM)   NE → (0, 0)
JPEG Y-down:  x_clip = x_img * mpuX − widthM ;  y_clip = −y_img * mpuY
```

With **Include foliage** checked, canopy comes first from the **Meta/WRI canopy height** window on the same extent. Each peaked crown is one polygon at its measured height. A compact clump with no internal peak stays one outline; a flat woods is not scattered into placeholder circles. If that grid is missing, canopy comes from **USFS/NLCD percent tree canopy** (threshold ≥18%). Connected cells become one polygon per height band. A single NLCD cell, a placed tree point, and a parking-median dot are not emitted as circles. If that raster is missing or nodata for the box (outside CONUS), the app does not fall back to a spray of RGB crowns. Valid NLCD — including sparse or all-zero parking lots — is trusted. OSM tree *nodes* and `controlPoints` calibration are API-only (not on the default page). OSM building/tree **rings** are never emitted (they caused Hamina to drop all `attenuation_areas` on v8). Polygons are clipped to the JPEG and invalid rings are dropped so one bad ring cannot wipe the import.

`stats.includeFoliage` is `false` by default. `stats.treesSource` is `"none"` unless foliage is on, then `"nlcd-canopy"`, `"imagery-rgb"`, or `"none"`.

## Use

1. Search an address.
2. Draw the site (under ~2 km on a side).
3. **Include foliage** — leave unchecked for buildings only. Check it to add canopy polygons.
4. **Export** — `{site}-openintent.zip` only. When USGS 3DEP returns a grid, **Copy terrain** pastes pads and slopes into Planner Plus. A DEM miss does not block the zip. Inside:
   - `openIntent_<slug>.json` — OpenIntent 2.0.1 with building `attenuation_areas` (gold Building materials). With Include foliage on, canopy polygons use Foliage - Heavy / Light, or a measured-height custom. Floorplan height 2.5 m (Hamina outdoor default)
   - `images/<slug>.jpg` — Esri aerial
   - `alignment-overlay.svg` — buildings (red). Canopy polygons (green) only when Include foliage was on. No tree-point circles
   - `frame-lock.json` — pixel/meter corners for Hamina vs OpenIntent vs JPEG
   - `export-warnings.json`
   - `hamina-clipboard.json` — optional legacy paste. Buildings only by default. With Include foliage on, the same canopy polygons (no trunks, no tree-point circles). Raised and sloped floors stay empty here
   - `terrain-clipboard.json` — the same Planner Plus JSON as **Copy terrain**, stored in the zip when 3DEP returns a grid. Absent when the DEM request fails. Export does not download this as a second file. Do not import it as OpenIntent.
   - `README.txt` — import-only instructions, coverage stats, terrain paste steps, and troubleshooting if Hamina shows the map but no objects
   - `export-stats.json` — same coverage numbers as machine-readable JSON, including `attenuationAreasEmitted` and `openclutterVersion`
   - `VERIFY.txt` — exact `attenuation_areas` length (same as `openIntent_*.json`) and `openclutter_version`
5. Hamina: **Projects → Import → OpenIntent**.
6. Optional: unzip. Confirm `VERIFY.txt` `attenuation_areas` is a positive integer. `openIntentTreeAreas` is 0 unless Include foliage was on. Open `alignment-overlay.svg` next to `images/`. If that count is >0 but Hamina shows map-only, paste `hamina-clipboard.json` and try 2D view / hardware acceleration off. Zip `README.txt` has the full steps.

### Sloped sites (Granite Peak)

Terrain still cannot go in the OpenIntent zip. **Copy terrain** pastes open quads into Planner Plus. Flat ground stays a 2×2 pad. A mild rise uses a 4×3 lattice. Relief under 20 m stays 6×5. A ski hill (DEM relief at least 20 m) uses the **Terrain resolution** control on the dev page. **Auto** is the default: cell size follows the draw (about 1 m on a ~20 m hill, about 10 m on a ~200 m hill, about 40 m on an ~800 m hill), filling up to 20×20 quads and never going under about 1 m. The 3DEP sample count scales with that mesh and stays at most 625. **Default** is about 80 m quads, at most 12×12 (144 DEM samples) — the same mesh as v1.1.5. **Fine** is about 40 m, at most 16×16 (324 samples). **Finest** is about 25 m, at most 20×20 (576 samples). Those three are manual overrides for A/B tests. The paste never exceeds 20×20 quads. Quads stay Jerry’s open-quad schema: four corners, ring not closed, sloped floors with one z on the low edge and a higher z on the opposite edge. The ring is counterclockwise in clipboard meters on a north, south, east, or west grade. The grade axis is the larger rise/run, not the larger raw `|Δz|`. `slabOnly` stays false.

Hamina’s attenuating-object fields are **bottom height from floor** and **top height from floor**. On a ski-hill DEM those are OpenIntent `bottom_height` and `top_height` (clipboard `bottomEdge` and `topEdge`):

- Bottom height from floor = the slope top under that footprint (meters above the lowest DEM sample, same zero as the terrain paste).
- Top height from floor = that bottom + the building height. With Include foliage on, canopy uses that bottom + the foliage height (the same thickness already stored on the vegetation material).

The building material name is `Building - One Floor 86.4` (the number is the bottom). A lifted canopy is `Foliage - Heavy @ 86.4`, or `Foliage - Heavy 14.2 @ 86.4` when 14.2 m is the canopy thickness. Those are not the poisoned `Building N.N m` / `Foliage N.N m` forms, and they are not `bottom_height: 0` on a gold object. Oak Creek (~6 m), Long Meadow (~15 m), and the Las Vegas Sphere box (~17 m) stay below the 20 m gate, so `bottom_height` is omitted and the top stays the stock height (bottom ≈ 0). Include foliage stays off unless checked. A Copernicus surface DEM uses the same bottom and top pair for every footprint whose ground is at least 1 m, including relief under 20 m. The 20 m gate stays a bare-earth rule.

Retest Granite Peak / Rib Mountain, Wausau WI: draw the ski hill (under ~2 km on a side), Export, Import the zip, Copy terrain and paste it in Planner Plus, then check 3D. Uphill buildings should sit on the slope, not under it. Check Include foliage, export again, Import and Copy terrain: foliage should be visible on the slope in 3D. A valley object whose ground is under 1 m stays on the floor.

The page has **Include foliage**, unchecked by default. On the dev host only, **Terrain resolution** sits next to it: one slider, Auto / Default / Fine / Finest (~25 m) / 20 / 15 / 10 / 5 / 1 m, starting on Auto. The readout shows the cell size, and for the meter stops the ground that mesh covers (at the old 20×20 size before a box is drawn). It is hidden wherever the dev badge is hidden. Tree source (NLCD canopy polygons when Include foliage is checked), OSM, and calibration stay automatic or API-only.

## API

`POST /api/clutter`

```json
{
  "west": -115.1735, "south": 36.1205, "east": -115.1488, "north": 36.1355,
  "name": "Site",
  "includeFoliage": false,
  "terrainResolution": "auto",
  "trees": [{ "lon": -115.16, "lat": 36.128 }],
  "treesSource": "nlcd-canopy",
  "osmTrees": false,
  "format": "bundle"
}
```

- `includeFoliage` — default `false`. `false` exports buildings only (tree points and canopy hits are ignored). `true` adds connected canopy polygons and skips individual tree-point circles. Query `includeFoliage=true` is the same switch.
- `terrainResolution` — `auto` (omit it, or send an unknown value, and the server uses this), `default`, `fine`, `finest`, `20`, `15`, `10`, `5`, or `1` (`20m` is the same as `20`). Query `terrainResolution=` is the same switch; a non-empty body value wins. On a ski hill (DEM relief at least 20 m) Auto picks the densest paste that still fits 20×20, with cells about the draw size divided by that budget and never under about 1 m (~1 m on a 20 m box, ~10 m on 200 m, ~40 m on 800 m). Its 3DEP `sampleCount` scales with that mesh and stays at most 2500. The named manuals stay fixed: Default ~80 m / max 12×12 / 144 samples, Fine ~40 m / max 16×16 / 324, Finest ~25 m / max 20×20 / 576. The meter stops aim at that cell size and may pass 20×20, up to 500 quads on a side, so a 2.5 km draw can still fill at about 5 m. A 1 m mesh on that draw is capped and the warning says how much ground 1 m would cover. A paste that will not fit beside the zip in one response is coarsened until Copy terrain still returns with the download, and that reduction is named in the export status and `export-warnings.json`. If it still cannot, Copy terrain is left out and the zip still downloads. DEM samples for the meter stops step down when the budget is short (at most 2500). Relief under 20 m keeps the 2×2, 4×3, or 6×5 ladder for Auto and every manual. The dev page sends this from the Terrain resolution slider. The older Hamina paste expectation is about 20×20 quads.
- `format: "bundle"` (default) — JSON with `zipBase64`, `frame`, `stats`, `alignment`, `terrainStatus`. When 3DEP returns a grid, `terrainClipboard` is the Planner Plus paste (**Copy terrain**) and `terrainFilename` is the zip member `terrain-clipboard.json`. The page downloads only the OpenIntent zip. Otherwise both fields are null and `terrainStatus` says the DEM was omitted. `stats` includes `includeFoliage`, `buildingsKept`, `treesKept`, `treesSource`, `fetched`, and drop reasons. With foliage off, `treesSource` is `"none"` and `treesKept` is 0.
- `format: "zip"` — same OpenIntent zip bytes
- `format: "hamina-clipboard"` — clipboard JSON only (skips imagery fetch; old-Hamina fallback)

Calibration (API only): `"controlPoints": [{ "lon", "lat", "xM", "yM" }, …]` (3+). Not shown in the UI.

## Limits

Global ML (zoom-9 quadkey, clipped to the JPEG) is the base polygon. Overture Buildings release `2026-08-19.0` is read from one or two Azure GeoParquet row groups (committed bbox index, not a full scan). Esri MSBFP2 (paginated to 2000) and FEMA USA Structures fill centroids still uncovered. A candidate is the same roof when its centroid sits inside a kept ring or within 11 m of that ring’s centroid. Geometry is replaced only for a single exterior that is more detailed at a similar area, or when the kept ring is a stub inside a fuller outline. Height rank: Overture explicit height, then Microsoft Global ML `height` (values ≤ 2 m and −1 ignored), then FEMA `HEIGHT`, then Overture `num_floors` × 3 m, then the nearest measured neighbor within 120 m, then stock One Floor / Five Floor / Hotel bins. Ties keep the height already on the ring. A stub whose area is outside 0.4–2.5× does not overwrite a larger footprint’s height. OpenIntent building `area_materials` stay the four Hamina outdoor Building - One/Two/Five/Ten Floor objects. Tree attenuation areas add stock Foliage - Heavy / Light, or `Foliage - Heavy H.H` / `Foliage - Light H.H` at a measured height (`compatibilityMode` `stock-foliage`). `hamina-clipboard.json` remains optional for foliage/trunk names and exact metres. OSM building ways are not read.

A large smooth bright roof that none of those layers contain is filled from the Esri JPEG (connected membrane pixels, ≥2500 m², skipped when a vector already covers it). Boxes over ~2.5 km fail before the export runs. A Microsoft footprint tile larger than 80 MB (the Los Angeles quadkey is well over that; Oak Creek and Las Vegas are not) is left out of that one export. The zip still includes the other building sources, and `export-warnings.json` plus the page status say the tile was omitted. If the campus still will not fit in one download, the zip keeps the largest roofs and says so. A draw that already has more than 1500 building footprints skips imagery roof fill, and that skip is the same kind of note. Campus-merge blobs &gt; 150,000 m² are dropped. When Include foliage is on, CHM crowns (or NLCD polygons if the height grid is missing) still refuse roofs and pavement. Individual tree points and median dots are not emitted. Meta/WRI CHM v2 (zoom-10 COG, pixel window, max side 320) supplies those crown outlines, and on the NLCD fallback overrides foliage `top_height` where the canopy is above 2 m. USGS 3DEP `getSamples` (no API key; Auto scales with the draw, at most 2500 points; Default 144, Fine 324, Finest 576; 20/15/10/5/1 m step down from at most 2500 when the budget is short) becomes `terrain-clipboard.json` only. On the dev host, a 3DEP miss reads Copernicus DEM GLO-30 for that same box (surface model; `bottom_height` stays off). Production does not. Flat pads are used when a cell’s corner relief is under 0.5 m, otherwise one open sloped quad (low edge, then the opposite high edge). OpenIntent and `hamina-clipboard.json` stay free of raised and sloped floors. The DEM request starts after imagery metadata snaps the extent and overlaps the JPEG, so a long aerial download does not skip it. Overture starts with the aerial JPEG, before the Global ML download, on its own abort. A finished read is kept even if the core phase has passed 5 seconds. A read still in flight may run until 23 seconds from the start (about 4.5 seconds of grace after a slow map). The row group that contains the site center is read first, and only GeoParquet pages whose bbox stats hit the site are fetched. The Las Vegas Sphere is in that center row group and missing from Microsoft and USA Structures; aborting the read at 9 seconds dropped it on the live dev export. Canopy height still starts after the aerial and footprints are in memory, with a 2 second abort, and is skipped if that phase already used 5 seconds. A 3DEP or canopy miss is recorded in `export-warnings.json` and the OpenIntent zip still exports. The page does not ask for a smaller box when a source times out. FEMA, NLCD, and 3DEP are United States sources.

## Development

Feature work targets the long-lived **`dev`** branch (see [Production vs Dev](#production-vs-dev)). Promote `dev` → `main` only for production releases.

```bash
npm test
npm run eval          # image-space quality gate on cached fixtures
npx netlify dev
```

`npm run eval` scores the default export (Include foliage off) against cached aerial fixtures: buildings only, no foliage attenuation areas. It fails if rooftops are missed, large footprints are dropped, the default zip emits foliage, measured building heights collapse back to stock bins, Overture does not add or upgrade a footprint, the terrain clipboard is empty on a sloped DEM, or the imagery mask cannot restore the Oak Creek white retail roof after that polygon is removed. Foliage-on coverage (canopy polygons only, no tree-point circles, foliage/building and foliage/foliage overlap) is in the test suite. Optional: `npm run eval -- --live` to refresh against live imagery.


## License

MIT. Imagery © Esri. Building footprints © Microsoft (ODbL), Overture Maps Foundation, and FEMA USA Structures (ORNL / NGA). Canopy height © Meta / World Resources Institute. Elevation © USGS 3DEP. On the dev host, when that grid is missing: Copernicus DEM GLO-30, © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.
