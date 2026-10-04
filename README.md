# OpenClutter

**OpenClutter** turns a map box into clutter that lines up with the map in [Hamina Planner](https://hamina.com): one georeferenced [OpenIntent](https://github.com/google/openintent) zip. Import the zip for the map and **buildings**. **Include foliage** is off by default. Check it to add traced canopy polygons. `hamina-clipboard.json` is optional legacy paste and follows the same choice.

**v1.0.0** — stable buildings → Hamina OpenIntent import (production freeze).

**v1.1.38** on `dev` — A measured tower taller than Hamina’s Ten Floor stock keeps that height. A wider lower footprint with a taller inset inside it is two attenuating objects: the podium on its own plan, and the tower on its plan at the measured height. A plain box stays one object. A height no source recorded is not invented. Finish shape stays gone. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.38`).

**v1.1.37** on `dev` — Finish shape is gone. Click the map to place corners; there is no extra close button. Click the first corner to close a shape of 3 or more corners. Export commits an open polygon of 3 or more corners and refuses one or two. Right-drag or a two-finger drag pans and does not finish the shape or open a menu. Hold Space and drag to pan, including while a polygon is open. The badge stays (`dev · v1.1.37`).

**v1.1.36** on `dev` — A pasted hill lifts every building, including a US bare-earth slope under 20 m and a raised-layer stack. The bottom is the high edge of each slope cell the footprint sits in, so the low side of a ramp does not leave the building under the floor. A shared cell edge still uses the height at that edge. Pieces of a steep footprint and a tower on a podium each use the slope under their own outline. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.36`).

**v1.1.35** on `dev` — Include foliage stays off and Experimental. A measured canopy cell that is a real tree is kept, including a tall crown only one or two cells wide. Roofs, roads, pavement, and water stay clear, and a percent reading does not invent a tree where the canopy-height model is empty. Terrain on still has no resolution slider. Auto fills the 20×20 paste budget on a mild hill as well as a ski hill; a larger draw stays coarse because that cap is what Planner Plus accepts. Raised layers use the same plan. The badge stays (`dev · v1.1.35`).

**v1.1.34** on `dev` — On a sloped site, each building’s bottom height from floor is the top of the slope under that footprint, including a cell edge the outline only shares. A footprint that climbs more than about 8 m is split so each piece sits on its own slope. A taller plan inside a shorter one (a tower on a podium) is two attenuating objects; a single simple box stays one. Include foliage stays off and Experimental. The badge stays (`dev · v1.1.34`).

**v1.1.33** on `dev` — Left click still draws; Draw is optional. A right-drag pans the map and does not finish the shape or open a menu. Hold Space and drag to pan, including while a polygon is open. Click the first corner to close a shape of 3 or more corners. Finish shape stays optional. Export still commits an open polygon of 3 or more corners and still refuses one or two. The badge stays (`dev · v1.1.33`).

**v1.1.32** on `dev` — Include foliage stays off unless checked, and it still wears the Experimental tag. Canopy is still a traced outline, not a grid square. Foliage attenuating objects set Hamina’s Transparent in 3D flag (`transparencyEnabled: true`) on the OpenIntent material and on the clipboard zone type. Buildings omit that flag and stay opaque. Turn on Transparency effects in Hamina settings to see through the canopy. The badge stays (`dev · v1.1.32`).

**v1.1.31** on `dev` — The map starts ready to draw. Click it to place corners; Draw is optional. A shape with 3 or more corners closes when you click the first corner again, including a click that comes back near the start. Double-click still finishes. Finish shape stays optional. A two-corner line does not close. Export still commits an open polygon of 3 or more corners and still refuses one or two. The badge stays (`dev · v1.1.31`).

**v1.1.30** on `dev` — Include foliage stays off unless checked, and it still wears the Experimental tag. When it is on, canopy extent and height come from the Meta/WRI canopy height model. US tree-canopy percent can add cells only where that cover is denser and a measured height is already known. Canopy is kept off building footprints and pavement, so it does not sit on roofs or parking. Bottom height from floor is the terrain under the footprint. Top height from floor is that bottom plus the measured canopy height. If the canopy-height read times out, foliage is left out of the zip and the status says so. Buildings still download. The badge stays (`dev · v1.1.30`).

**v1.1.29** on `dev` — A large campus with Terrain on still returns **Copy terrain** for **Sloped** and **Raised layers**. Both styles use the same elevation read. When the full grid does not come back, a coarser grid is pasted instead (still at most 20×20, and at most 400 raised floors). The status still starts with `Terrain sloped` or `Terrain raised layers`. The OpenIntent zip is unchanged. The badge stays (`dev · v1.1.29`).

**v1.1.28** on `dev` — With Terrain on, the page offers **Sloped** (the default ramp mesh, one quad per cell) and **Raised layers** (stacked height-band rectangles, 1 m bands, at most 400 floors). The style radios appear only when Terrain is on. Status names the mode (`Terrain sloped 20×20` or `Terrain raised layers 12×8`). Terrain stays a checkbox, on by default, with no resolution control. When it is off, that export skips the DEM and Copy terrain. The badge stays (`dev · v1.1.28`).

**v1.1.27** on `dev` — Terrain stays a checkbox, on by default, with no resolution control. When it is on, Auto sizes cells from the draw: about 1 m on a small hill and coarser on a large one, at most 20×20 quads, so Copy terrain stays a paste Planner Plus can take. When it is off, that export skips the DEM and Copy terrain. The badge stays (`dev · v1.1.27`).

**v1.1.26** on `dev` — A polygon closes without a right-click. After three corners, double-click, click the first corner, or **Finish shape**. Export commits that open polygon. A ring of one or two corners blocks export instead of sending the previous outline. Esc still drops only the open corners. The badge stays (`dev · v1.1.26`).

**v1.1.25** on `dev` — The Terrain resolution control is gone. Terrain stays a checkbox, on by default. When it is on, export uses the densest mesh that still fits (about 1 m cells, stepped coarser only when that grid will not fit the response). When it is off, that export skips the DEM and Copy terrain. The subtitle and muted badge stay (`dev · v1.1.25`).

**v1.1.24** on `dev` — Include foliage wears an Experimental tag and stays off unless checked. A Terrain checkbox sits next to it, on by default. Turn it off and that export skips the DEM and Copy terrain. Terrain resolution stays hidden while Terrain is off. The subtitle and muted badge stay (`dev · v1.1.24`).

**v1.1.23** on `dev` — The subtitle under the title says what Export does: a zip you import in Hamina for the aerial map and buildings. The small muted build label stays (`dev · v1.1.23`).

**v1.1.22** on `dev` — The address panel drops “One zip.” The build label sits in the corner in small muted type (`dev · v1.1.22`). Address, draw, and export stay the same.

**v1.1.21** on `dev` — Finland terrain paste uses the same ground-meter frame as the aerial, so the quads are roughly square and the status shows that cell size. A 1 m or Auto paste on a town is meter-scale: the mesh steps coarser only when the draw will not fit, and the readout names that size instead of a 500×500 label on a stretched slab. GLO-30 is still about 30 m native; a finer cell is interpolated. A Finland town export still offers **Copy terrain** after the ground-meter aerial resample. When little time is left, the elevation grid steps down to a coarser lattice and still pastes, instead of omitting terrain with a timeout. A Finland town import keeps the shape and the ground scale of the map you drew. The aerial is resampled so east–west and north–south pixels are ground meters, and buildings and terrain paste use that same frame. A US site keeps the existing aerial grid. A Finland export finishes. The Hamina NLS laser grid is packaged with the function, so measured building heights still apply, and a grid that cannot be read omits those heights inside a successful zip instead of Export failed (502). Buildings and canopy sit on the pasted slope: bottom height from floor is the higher of the DEM under the footprint and the pasted floor there, and top height from floor is that bottom plus the object height. A US bare-earth hill still lifts the same way; a US site under 20 m of relief still stays on the floor. Terrain resolution on the dev host adds **20, 15, 10, 5, and 1 m** past Finest (~25 m). Auto, Default, and Fine stay. Those finer stops can paste denser than the old 20×20 Hamina expectation so a ski hill can keep that cell size (mesh cap 500 quads on a side, enough for about 5 m on a 2.5 km draw). The readout shows the cell size and the ground that mesh covers. A paste past 20×20 is listed in `export-warnings.json`. A mesh that will not fit beside the zip in one response is coarsened until Copy terrain still returns with the download. The status names that reduction. If it still cannot, Copy terrain is left out and the OpenIntent zip still downloads. DEM samples for those stops step down when time is short. The dev host still keeps the v1.1.14 sharper Esri World Imagery JPEG (1600 px on the long side instead of 1040); production keeps the 1040 cap, and there is no imagery-quality control on the page. Outside USGS 3DEP coverage the dev host still gives up on that request quickly and reads Copernicus DEM GLO-30, including a coarser grid when the aerial has already used the export clock. Building and foliage objects sit on that surface. A US 3DEP hit is unchanged. Production stays 3DEP only. The page title and the export zip (`openclutter_version`) both read this from `package.json`.

Live: https://openclutter.netlify.app · Dev: https://openclutter.netlify.app/dev · Source: https://github.com/jolla/OpenClutter

## Production vs Dev

| | Production | Dev |
|---|---|---|
| URL | https://openclutter.netlify.app | https://openclutter.netlify.app/dev → https://dev--openclutter.netlify.app |
| Git branch | `main` | `dev` |
| Purpose | Frozen **v1.0** buildings OpenIntent import — address, draw, export | Experiments (trees-in-OI, terrain, etc.) without breaking production |

- Use **production** for the known-good 1.0 buildings workflow.
- Hack on **https://openclutter.netlify.app/dev**. The panel corner shows a small muted build label (`dev · v1.1.38`). The same dev host shows **Include foliage** with an Experimental tag (off unless checked) and **Terrain**, on by default. With Terrain on, choose **Sloped** (default, one ramp or pad per cell) or **Raised layers** (stacked plates, at most 400 floors). The lattice is Auto: about 1 m on a small hill, coarser on a large one, at most 20×20. There is no resolution control. The style radios hide when Terrain is off, and both the checkbox and the radios stay hidden off this host.
- Workflow: open feature PRs against `dev`. Promote with a PR `dev` → `main` only for a production release; then tag (e.g. `v1.1.0`).


## Exact alignment (every site)

Hamina **2026-09-01** (docs.hamina.com release notes): “OpenIntent import and export now supports attenuating objects!” The [support matrix](https://docs.hamina.com/hamina/live/openintent) shows Attenuating Objects ✅ import/export. Buildings use Hamina’s Building - One/Two/Five/Ten Floor catalog (Jerry’s gold export). When Include foliage is on, canopy uses the picker types **Foliage - Heavy** (19.68 ft, 2 dB/m) and **Foliage - Light** (19.68 ft, 1 dB/m), same object shape. A measured height that is not 19.68 ft is a custom `Foliage - Heavy H.H` / `Foliage - Light H.H`. There is no Tree type. `Tree Trunk` and per-metre `Foliage N.N m` stay off the OpenIntent catalog.

One bbox drives everything:

1. Esri World Imagery for that bbox (`bboxSR=4326`, `imageSR=4326`). **The frame is the JPEG’s actual `extent`**, which is often taller than the drawn box. After that snap, meters are unified to the JPEG pixel aspect (`lengthM = imgH * widthM/imgW`) so Hamina’s isotropic map scale matches. In the continental US the aerial content grid is kept. At high latitude (Finland), that degree grid is resampled so pixels are square in ground meters, and buildings, the aerial, and terrain paste use that frame.
2. Building footprints mapped through that actual extent: Microsoft Global ML (height used when the tile has one), Overture Buildings (`height` or `num_floors`), Esri MSBFP2, then FEMA USA Structures. One ring per roof; the best measured height wins.
3. **Include foliage** (off unless checked, still marked Experimental). When on, canopy extent and height come from the Meta/WRI canopy height model. Each polygon is the traced outline of a connected canopy, simplified so it follows that edge instead of a grid square, at the measured height. US tree-canopy percent can add a cell only where that cover is denser and a measured height is already known. It does not replace the height. Cells on building footprints and on pavement or roads are cleared, and rings are cut around footprints (4 m buffer) and water, so canopy does not sit on roofs, parking, or ponds. If the canopy-height read times out, foliage is left out of the zip and the status says so. Buildings still export. Individual tree-point circles are not emitted. Trunks are not emitted — OpenIntent has no Tree type, so a trunk cannot be imported that way.
4. lon/lat → JPEG pixels with the actual west/south/east/north (OpenIntent Y-up / JPEG Y-down).
5. OpenIntent `attenuation_areas` are **buildings** by default. Buildings use Building - One/Two/Five/Ten Floor. With Include foliage on, canopy uses Foliage - Heavy or Foliage - Light. A measured canopy height that is not the stock 19.68 ft uses `Foliage - Heavy H.H` or `Foliage - Light H.H` at that height. Bottom height from floor is the terrain under the footprint (the same rule as buildings). Top height from floor is that bottom plus the measured canopy height. A lone tree point is not a circle.

**Import this zip in Hamina (Projects → Import → OpenIntent)** for the map and buildings. Check Include foliage before export when the site should include canopy. Do not use a GE screenshot as the map.

### Materials that import

Building `area_material` objects keep exactly these keys: `name`, `rf_properties.attenuation_per_m`, `top_height`, `display_color`. Foliage adds `transparencyEnabled: true`, the flag Hamina already uses for Transparent in 3D on an attenuating zone type. Buildings omit that key. No `itu_material_type`, no `bottom_height` on a flat site. The object deep-equals its catalog entry (a stock name with a different `top_height` is rejected). Buildings are always the gold prefix. A vegetation material is added only when an area uses it, so a buildings-only zip stays the four gold objects. Clipboard foliage types set the same `transparencyEnabled` flag; building types leave it false. Hamina only draws that transparency when Transparency effects are on in Settings.

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

With **Include foliage** checked, canopy extent and height come from the **Meta/WRI canopy height** window on the same extent. Each polygon is the traced canopy outline at that measured height, not a grid square, not a circle, and not a percent bucket. USFS/NLCD percent tree canopy (threshold ≥18%) can add a cell only where that cover is denser and a measured height is already known. A single NLCD cell, a placed tree point, and a parking-median dot are not emitted as circles. Aerial color is not used to place canopy. If the canopy-height read times out, foliage is omitted and the status says so. OSM tree *nodes* and `controlPoints` calibration are API-only (not on the default page). OSM building/tree **rings** are never emitted (they caused Hamina to drop all `attenuation_areas` on v8). Polygons are clipped to the JPEG and invalid rings are dropped so one bad ring cannot wipe the import.

`stats.includeFoliage` is `false` by default. `stats.treesSource` is `"none"` unless foliage is on, then `"nlcd-canopy"` or `"none"`. A canopy-height timeout keeps `includeFoliage` true and sets the status to foliage omitted.

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

Terrain still cannot go in the OpenIntent zip. **Copy terrain** pastes open quads into Planner Plus. **Auto** fills the paste budget on a flat lot and on a hill: about 1 m cells, at most 20×20 quads. A larger draw is coarser because that cap is what Planner Plus accepts, not because relief under 20 m drops to 6×5. The 3DEP sample count is denser than that mesh and stays at most 576. **Default** is about 80 m quads, at most 12×12 (144 DEM samples) — the same mesh as v1.1.5. **Fine** is about 40 m, at most 16×16 (324 samples). **Finest** is about 25 m, at most 20×20 (576 samples). The page always uses that Auto. On the dev host, Terrain on also offers **Raised layers**: the same lattice, but Copy terrain is stacked raised-floor plates (1 m height bands, at most 400 floors) instead of one ramp per cell. **Sloped** stays the default. Default, Fine, and Finest stay available on the API and stay inside 20×20 quads. Quads stay Jerry’s open-quad schema: four corners, ring not closed, sloped floors with one z on the low edge and a higher z on the opposite edge. The ring is counterclockwise in clipboard meters on a north, south, east, or west grade. The grade axis is the larger rise/run, not the larger raw `|Δz|`. `slabOnly` stays false.

Hamina’s attenuating-object fields are **bottom height from floor** and **top height from floor**. On a ski-hill DEM those are OpenIntent `bottom_height` and `top_height` (clipboard `bottomEdge` and `topEdge`):

- Bottom height from floor = the slope top under that footprint (meters above the lowest DEM sample, same zero as the terrain paste).
- Top height from floor = that bottom + the building height. With Include foliage on, canopy uses that bottom + the foliage height (the same thickness already stored on the vegetation material).

The building material name is `Building - One Floor 86.4` (the number is the bottom). A lifted canopy is `Foliage - Heavy @ 86.4`, or `Foliage - Heavy 14.2 @ 86.4` when 14.2 m is the canopy thickness. Those are not the poisoned `Building N.N m` / `Foliage N.N m` forms, and they are not `bottom_height: 0` on a gold object. A pasted mesh sets that bottom on bare earth and on a surface DEM, including Oak Creek (~6 m), Long Meadow (~15 m), and the Las Vegas Sphere box (~17 m). The bottom is the high edge of each slope cell the footprint sits in, and the height at a shared edge when the outline only touches that cell. Ground under 1 m still omits `bottom_height`. Include foliage stays off unless checked.

Retest Granite Peak / Rib Mountain, Wausau WI: draw the ski hill (under ~2 km on a side), Export, Import the zip, Copy terrain and paste it in Planner Plus, then check 3D. Uphill buildings should sit on the slope, not under it. Check Include foliage, export again, Import and Copy terrain: foliage should be visible on the slope in 3D. A valley object whose ground is under 1 m stays on the floor.

The page has **Include foliage**, unchecked by default. On the dev host only, a **Terrain** checkbox sits under it, on by default. With Terrain on, two radios appear: **Sloped** (default) and **Raised layers**. Export uses Auto either way: about 1 m cells on a small hill, coarser on a large one, at most 20×20 quads. There is no resolution control. The checkbox and the radios are hidden wherever the dev badge is hidden. Tree source (NLCD canopy polygons when Include foliage is checked), OSM, and calibration stay automatic or API-only.

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
- `terrainResolution` — `auto` (omit it, or send an unknown value, and the server uses this), `default`, `fine`, `finest`, `20`, `15`, `10`, `5`, or `1` (`20m` is the same as `20`). Query `terrainResolution=` is the same switch; a non-empty body value wins. On a ski hill (DEM relief at least 20 m) Auto sizes cells from the draw, about 1 m on a small hill and coarser on a large one, and stays at most 20×20 quads. Its 3DEP `sampleCount` is denser than that mesh and stays at most 576. The named manuals stay fixed: Default ~80 m / max 12×12 / 144 samples, Fine ~40 m / max 16×16 / 324, Finest ~25 m / max 20×20 / 576. The meter stops aim at that cell size and may pass 20×20, up to 500 quads on a side, so a 2.5 km draw can still fill at about 5 m. A 1 m mesh on that draw is capped and the warning says how much ground 1 m would cover. A paste that will not fit beside the zip in one response is coarsened until Copy terrain still returns with the download, and that reduction is named in the export status and `export-warnings.json`. If it still cannot, Copy terrain is left out and the zip still downloads. DEM samples for the meter stops step down when the budget is short (at most 2500). Relief under 20 m keeps the 2×2, 4×3, or 6×5 ladder for Auto and every manual. The dev page sends `auto` when Terrain is checked and skips the DEM when Terrain is off. The older Hamina paste expectation is about 20×20 quads.
- `format: "bundle"` (default) — JSON with `zipBase64`, `frame`, `stats`, `alignment`, `terrainStatus`. When 3DEP returns a grid, `terrainClipboard` is the Planner Plus paste (**Copy terrain**) and `terrainFilename` is the zip member `terrain-clipboard.json`. The page downloads only the OpenIntent zip. Otherwise both fields are null and `terrainStatus` says the DEM was omitted. `stats` includes `includeFoliage`, `buildingsKept`, `treesKept`, `treesSource`, `fetched`, and drop reasons. With foliage off, `treesSource` is `"none"` and `treesKept` is 0.
- `format: "zip"` — same OpenIntent zip bytes
- `format: "hamina-clipboard"` — clipboard JSON only (skips imagery fetch; old-Hamina fallback)

Calibration (API only): `"controlPoints": [{ "lon", "lat", "xM", "yM" }, …]` (3+). Not shown in the UI.

## Limits

Global ML (zoom-9 quadkey, clipped to the JPEG) is the base polygon. Overture Buildings release `2026-08-19.0` is read from one or two Azure GeoParquet row groups (committed bbox index, not a full scan). Esri MSBFP2 (paginated to 2000) and FEMA USA Structures fill centroids still uncovered. A candidate is the same roof when its centroid sits inside a kept ring or within 11 m of that ring’s centroid. Geometry is replaced only for a single exterior that is more detailed at a similar area, or when the kept ring is a stub inside a fuller outline. Height rank: Overture explicit height, then Microsoft Global ML `height` (values ≤ 2 m and −1 ignored), then FEMA `HEIGHT`, then Overture `num_floors` × 3 m, then the nearest measured neighbor within 120 m, then stock One Floor / Five Floor / Hotel bins. Ties keep the height already on the ring. A stub whose area is outside 0.4–2.5× does not overwrite a larger footprint’s height. OpenIntent building `area_materials` stay the four Hamina outdoor Building - One/Two/Five/Ten Floor objects. Tree attenuation areas add stock Foliage - Heavy / Light, or `Foliage - Heavy H.H` / `Foliage - Light H.H` at a measured height (`compatibilityMode` `stock-foliage`). `hamina-clipboard.json` remains optional for foliage/trunk names and exact metres. OSM building ways are not read.

A large smooth bright roof that none of those layers contain is filled from the Esri JPEG (connected membrane pixels, ≥2500 m², skipped when a vector already covers it). Boxes over ~2.5 km fail before the export runs. A Microsoft footprint tile larger than 80 MB (the Los Angeles quadkey is well over that; Oak Creek and Las Vegas are not) is left out of that one export. The zip still includes the other building sources, and `export-warnings.json` plus the page status say the tile was omitted. If the campus still will not fit in one download, the zip keeps the largest roofs and says so. A draw that already has more than 1500 building footprints skips imagery roof fill, and that skip is the same kind of note. Campus-merge blobs &gt; 150,000 m² are dropped. When Include foliage is on, canopy comes from the Meta/WRI canopy height model and is cleared off building footprints and pavement. Individual tree points and median dots are not emitted. A canopy-height timeout leaves foliage out of the zip. The status says so, and buildings still export. On a large draw, canopy cells are merged until the zip still downloads. USGS 3DEP `getSamples` (no API key; Auto scales with the draw, at most 576 points; Default 144, Fine 324, Finest 576; 20/15/10/5/1 m step down from at most 2500 when the budget is short) becomes `terrain-clipboard.json` only. On the dev host, a 3DEP miss reads Copernicus DEM GLO-30 for that same box (surface model; `bottom_height` stays off). Production does not. Flat pads are used when a cell’s corner relief is under 0.5 m, otherwise one open sloped quad (low edge, then the opposite high edge). OpenIntent and `hamina-clipboard.json` stay free of raised and sloped floors. The DEM request starts after imagery metadata snaps the extent and overlaps the JPEG, so a long aerial download does not skip it. Overture starts with the aerial JPEG, before the Global ML download, on its own abort. A finished read is kept even if the core phase has passed 5 seconds. A read still in flight may run until 23 seconds from the start (about 4.5 seconds of grace after a slow map). The row group that contains the site center is read first, and only GeoParquet pages whose bbox stats hit the site are fetched. The Las Vegas Sphere is in that center row group and missing from Microsoft and USA Structures; aborting the read at 9 seconds dropped it on the live dev export. If the canopy-height read does not finish, foliage is left out and `export-warnings.json` says so. The OpenIntent zip still exports. A 3DEP miss is recorded the same way. The page does not ask for a smaller box when a source times out. FEMA, NLCD, and 3DEP are United States sources.

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
