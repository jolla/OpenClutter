# OpenClutter

**OpenClutter** turns a map box into clutter that lines up with the map in [Hamina Planner](https://hamina.com): one georeferenced [OpenIntent](https://github.com/google/openintent) zip. Import the zip for the map and **buildings**. **Include foliage** is off by default. Check it to add canopy polygons. `hamina-clipboard.json` is optional legacy paste and follows the same choice.

**v1.0.0** — stable buildings → Hamina OpenIntent import (production freeze).

**v1.1.1** on `dev` — foliage toggle, terrain Copy, Sphere-area roofs. The page title and the export zip (`openclutter_version`) both read this from `package.json`.

Live: https://openclutter.netlify.app · Dev: https://openclutter.netlify.app/dev · Source: https://github.com/jolla/OpenClutter

## Production vs Dev

| | Production | Dev |
|---|---|---|
| URL | https://openclutter.netlify.app | https://openclutter.netlify.app/dev → https://dev--openclutter.netlify.app |
| Git branch | `main` | `dev` |
| Purpose | Frozen **v1.0** buildings OpenIntent import — address, draw, export | Experiments (trees-in-OI, terrain, etc.) without breaking production |

- Use **production** for the known-good 1.0 buildings workflow.
- Hack on **https://openclutter.netlify.app/dev**. The title row shows a **dev** badge and the build version (`dev · v1.1.1`).
- Workflow: open feature PRs against `dev`. Promote with a PR `dev` → `main` only for a production release; then tag (e.g. `v1.1.0`).


## Exact alignment (every site)

Hamina **2026-09-01** (docs.hamina.com release notes): “OpenIntent import and export now supports attenuating objects!” The [support matrix](https://docs.hamina.com/hamina/live/openintent) shows Attenuating Objects ✅ import/export. Buildings use Hamina’s Building - One/Two/Five/Ten Floor catalog (Jerry’s gold export). When Include foliage is on, canopy uses the picker types **Foliage - Heavy** (19.68 ft, 2 dB/m) and **Foliage - Light** (19.68 ft, 1 dB/m), same object shape. A measured height that is not 19.68 ft is a custom `Foliage - Heavy H.H` / `Foliage - Light H.H`. There is no Tree type. `Tree Trunk` and per-metre `Foliage N.N m` stay off the OpenIntent catalog.

One bbox drives everything:

1. Esri World Imagery for that bbox (`bboxSR=4326`, `imageSR=4326`). **The frame is the JPEG’s actual `extent`**, which is often taller than the drawn box. After that snap, meters are unified to the JPEG pixel aspect (`lengthM = imgH * widthM/imgW`) so Hamina’s isotropic map scale matches — the aerial content grid is kept (no geodesic stretch).
2. Building footprints mapped through that actual extent: Microsoft Global ML (height used when the tile has one), Overture Buildings (`height` or `num_floors`), Esri MSBFP2, then FEMA USA Structures. One ring per roof; the best measured height wins.
3. **Include foliage** (off unless checked). When on, USFS/NLCD percent tree canopy is emitted as connected canopy polygons (imagery RGB only if the canopy raster is missing/empty — **not** when NLCD is valid zeros on parking/lawn). Canopy rings are cut around building footprints (4 m buffer) and imagery water before they are emitted, so foliage does not cover roofs or ponds. A Meta/WRI canopy-height window sets foliage `top_height` when it returns. Individual tree-point circles and median dots are not emitted. Trunks are not emitted.
4. lon/lat → JPEG pixels with the actual west/south/east/north (OpenIntent Y-up / JPEG Y-down).
5. OpenIntent `attenuation_areas` are **buildings** by default. Buildings use Building - One/Two/Five/Ten Floor. With Include foliage on, canopy polygons use Foliage - Heavy or Foliage - Light. A measured or CHM height that is not the stock 19.68 ft uses `Foliage - Heavy H.H` or `Foliage - Light H.H` at that height. A multi-cell NLCD patch is one canopy polygon. A lone tree point is not a circle.

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

With **Include foliage** checked, canopy comes from **USFS/NLCD percent tree canopy** on the same extent (threshold ≥18%). Connected cells become one polygon per height band. A single cell, a placed tree point, and a parking-median dot are not emitted as circles. If that raster is missing or nodata for the box (outside CONUS), the app does not fall back to a spray of RGB crowns. Valid NLCD — including sparse or all-zero parking lots — is trusted. OSM tree *nodes* and `controlPoints` calibration are API-only (not on the default page). OSM building/tree **rings** are never emitted (they caused Hamina to drop all `attenuation_areas` on v8). Polygons are clipped to the JPEG and invalid rings are dropped so one bad ring cannot wipe the import.

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

The page has one extra control: **Include foliage**, unchecked by default. Tree source (NLCD canopy polygons when that box is checked), OSM, and calibration stay automatic or API-only.

## API

`POST /api/clutter`

```json
{
  "west": -115.1735, "south": 36.1205, "east": -115.1488, "north": 36.1355,
  "name": "Site",
  "includeFoliage": false,
  "trees": [{ "lon": -115.16, "lat": 36.128 }],
  "treesSource": "nlcd-canopy",
  "osmTrees": false,
  "format": "bundle"
}
```

- `includeFoliage` — default `false`. `false` exports buildings only (tree points and canopy hits are ignored). `true` adds connected canopy polygons and skips individual tree-point circles. Query `includeFoliage=true` is the same switch.
- `format: "bundle"` (default) — JSON with `zipBase64`, `frame`, `stats`, `alignment`, `terrainStatus`. When 3DEP returns a grid, `terrainClipboard` is the Planner Plus paste (**Copy terrain**) and `terrainFilename` is the zip member `terrain-clipboard.json`. The page downloads only the OpenIntent zip. Otherwise both fields are null and `terrainStatus` says the DEM was omitted. `stats` includes `includeFoliage`, `buildingsKept`, `treesKept`, `treesSource`, `fetched`, and drop reasons. With foliage off, `treesSource` is `"none"` and `treesKept` is 0.
- `format: "zip"` — same OpenIntent zip bytes
- `format: "hamina-clipboard"` — clipboard JSON only (skips imagery fetch; old-Hamina fallback)

Calibration (API only): `"controlPoints": [{ "lon", "lat", "xM", "yM" }, …]` (3+). Not shown in the UI.

## Limits

Global ML (zoom-9 quadkey, clipped to the JPEG) is the base polygon. Overture Buildings release `2026-08-19.0` is read from one or two Azure GeoParquet row groups (committed bbox index, not a full scan). Esri MSBFP2 (paginated to 2000) and FEMA USA Structures fill centroids still uncovered. A candidate is the same roof when its centroid sits inside a kept ring or within 11 m of that ring’s centroid. Geometry is replaced only for a single exterior that is more detailed at a similar area, or when the kept ring is a stub inside a fuller outline. Height rank: Overture explicit height, then Microsoft Global ML `height` (values ≤ 2 m and −1 ignored), then FEMA `HEIGHT`, then Overture `num_floors` × 3 m, then the nearest measured neighbor within 120 m, then stock One Floor / Five Floor / Hotel bins. Ties keep the height already on the ring. A stub whose area is outside 0.4–2.5× does not overwrite a larger footprint’s height. OpenIntent building `area_materials` stay the four Hamina outdoor Building - One/Two/Five/Ten Floor objects. Tree attenuation areas add stock Foliage - Heavy / Light, or `Foliage - Heavy H.H` / `Foliage - Light H.H` at a measured height (`compatibilityMode` `stock-foliage`). `hamina-clipboard.json` remains optional for foliage/trunk names and exact metres. OSM building ways are not read.

A large smooth bright roof that none of those layers contain is filled from the Esri JPEG (connected membrane pixels, ≥2500 m², skipped when a vector already covers it). Boxes over ~2.5 km fail. Campus-merge blobs &gt; 150,000 m² are dropped. When Include foliage is on, NLCD canopy polygons still refuse roofs and pavement. Individual tree points and median dots are not emitted. Meta/WRI CHM v2 (zoom-10 COG, pixel window, max side 180) overrides foliage `top_height` where the canopy is above 2 m. USGS 3DEP `getSamples` (36 points, no API key) becomes `terrain-clipboard.json` only: flat pads when a cell’s corner relief is under 0.5 m, otherwise one open sloped quad (low edge, then the opposite high edge). OpenIntent and `hamina-clipboard.json` stay free of raised and sloped floors. The DEM request starts after imagery metadata snaps the extent and overlaps the JPEG, so a long aerial download does not skip it. Overture starts with the aerial JPEG, before the Global ML download, on its own abort. A finished read is kept even if the core phase has passed 5 seconds. A read still in flight may run until 23 seconds from the start (about 4.5 seconds of grace after a slow map). The row group that contains the site center is read first, and only GeoParquet pages whose bbox stats hit the site are fetched. The Las Vegas Sphere is in that center row group and missing from Microsoft and USA Structures; aborting the read at 9 seconds dropped it on the live dev export. Canopy height still starts after the aerial and footprints are in memory, with a 2 second abort, and is skipped if that phase already used 5 seconds. A 3DEP or canopy miss is recorded in `export-warnings.json` and the OpenIntent zip still exports. The page does not ask for a smaller box when a source times out. FEMA, NLCD, and 3DEP are United States sources.

## Development

Feature work targets the long-lived **`dev`** branch (see [Production vs Dev](#production-vs-dev)). Promote `dev` → `main` only for production releases.

```bash
npm test
npm run eval          # image-space quality gate on cached fixtures
npx netlify dev
```

`npm run eval` scores the default export (Include foliage off) against cached aerial fixtures: buildings only, no foliage attenuation areas. It fails if rooftops are missed, large footprints are dropped, the default zip emits foliage, measured building heights collapse back to stock bins, Overture does not add or upgrade a footprint, the terrain clipboard is empty on a sloped DEM, or the imagery mask cannot restore the Oak Creek white retail roof after that polygon is removed. Foliage-on coverage (canopy polygons only, no tree-point circles, foliage/building and foliage/foliage overlap) is in the test suite. Optional: `npm run eval -- --live` to refresh against live imagery.


## License

MIT. Imagery © Esri. Building footprints © Microsoft (ODbL), Overture Maps Foundation, and FEMA USA Structures (ORNL / NGA). Canopy height © Meta / World Resources Institute. Elevation © USGS 3DEP.
