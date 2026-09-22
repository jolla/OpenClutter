# OpenClutter

**OpenClutter** turns a map box into clutter that lines up with the map in [Hamina Planner](https://hamina.com): one georeferenced [OpenIntent](https://github.com/google/openintent) zip. Import the zip for the map **and buildings**. Paste `hamina-clipboard.json` from the same zip for trees and exact measured heights.

**v1.0.0** — stable buildings → Hamina OpenIntent import (production freeze).

Live: https://openclutter.netlify.app · Dev: https://openclutter.netlify.app/dev · Source: https://github.com/jolla/OpenClutter

## Production vs Dev

| | Production | Dev |
|---|---|---|
| URL | https://openclutter.netlify.app | https://openclutter.netlify.app/dev → https://dev--openclutter.netlify.app |
| Git branch | `main` | `dev` |
| Purpose | Frozen **v1.0** buildings OpenIntent import — address, draw, export | Experiments (trees-in-OI, terrain, etc.) without breaking production |

- Use **production** for the known-good 1.0 buildings workflow.
- Hack on **https://openclutter.netlify.app/dev**. The UI shows a small **dev** badge there.
- Workflow: open feature PRs against `dev`. Promote with a PR `dev` → `main` only for a production release; then tag (e.g. `v1.1.0`).


## Exact alignment (every site)

Hamina **2026-09-01** (docs.hamina.com release notes): “OpenIntent import and export now supports attenuating objects!” The [support matrix](https://docs.hamina.com/hamina/live/openintent) shows Attenuating Objects ✅ import/export. OpenIntent outdoor imports accept Hamina’s Building - One/Two/Five/Ten Floor catalog (Jerry’s gold export). Foliage / Tree Trunk names emptied every attenuation_area, so trees stay on the clipboard paste.

One bbox drives everything:

1. Esri World Imagery for that bbox (`bboxSR=4326`, `imageSR=4326`). **The frame is the JPEG’s actual `extent`**, which is often taller than the drawn box. After that snap, meters are unified to the JPEG pixel aspect (`lengthM = imgH * widthM/imgW`) so Hamina’s isotropic map scale matches — the aerial content grid is kept (no geodesic stretch).
2. Building footprints mapped through that actual extent: Microsoft Global ML (height used when the tile has one), Overture Buildings (`height` or `num_floors`), Esri MSBFP2, then FEMA USA Structures. One ring per roof; the best measured height wins.
3. USFS/NLCD percent tree canopy as a density field (jitter + NMS; imagery RGB only if the canopy raster is missing/empty — **not** when NLCD is valid zeros on parking/lawn). A Meta/WRI canopy-height window sets foliage `top_height` when it returns; NLCD still decides where trees go.
4. lon/lat → JPEG pixels with the actual west/south/east/north (OpenIntent Y-up / JPEG Y-down).
5. OpenIntent `attenuation_areas` are **buildings only**, using Building - One/Two/Five/Ten Floor materials (Hamina outdoor gold set). Trees and exact metres are in `hamina-clipboard.json`.

**Import this zip in Hamina (Projects → Import → OpenIntent)** for the map and buildings. **Paste hamina-clipboard.json** for trees / exact heights. Do not use a GE screenshot as the map.

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

Trees come from **USFS/NLCD percent tree canopy** on the same extent (threshold ≥18%), placed with **jittered NMS** rather than on the 30 m sample lattice. Large maps scale the tree cap (up to 800) and relax spacing in continuous woods. If that raster is missing or nodata for the box (outside CONUS), the app **silently** falls back to Esri aerial RGB that requires textured woody canopy (not smooth grass, not gray parking). Valid NLCD — including sparse or all-zero parking lots — is trusted; RGB does not carpet the lawn. OSM tree *nodes* and `controlPoints` calibration are API-only (not on the default page). OSM building/tree **rings** are never emitted (they caused Hamina to drop all `attenuation_areas` on v8). Polygons are clipped to the JPEG and invalid rings are dropped so one bad ring cannot wipe the import.

`stats.treesSource` is `"nlcd-canopy"`, `"imagery-rgb"`, or `"none"` (in the API payload, not a UI picker).

## Use

1. Search an address.
2. Draw the site (under ~2 km on a side).
3. **Export** — one `{site}-openintent.zip` download. Inside:
   - `openIntent_<slug>.json` — OpenIntent 2.0.1 with building `attenuation_areas` (Building - One/Two/Five/Ten Floor) at the JPEG meter size; floorplan height 2.5 m (Hamina outdoor default)
   - `images/<slug>.jpg` — Esri aerial
   - `alignment-overlay.svg` — buildings (red) + trees (green) on that JPEG
   - `frame-lock.json` — pixel/meter corners for Hamina vs OpenIntent vs JPEG
   - `export-warnings.json`
   - `hamina-clipboard.json` — silent fallback for Hamina builds before OpenIntent attenuating-object import (raised and sloped floors stay empty here)
   - `terrain-clipboard.json` — optional USGS 3DEP pads and sloped facets for Planner Plus paste, same NE-origin meter frame. Absent when the DEM request fails. Do not import this file as OpenIntent.
   - `README.txt` — import-only instructions, coverage stats, terrain paste steps, and troubleshooting if Hamina shows the map but no objects
   - `export-stats.json` — same coverage numbers as machine-readable JSON, including `attenuationAreasEmitted`
   - `VERIFY.txt` — exact `attenuation_areas` length (same as `openIntent_*.json`)
4. Hamina: **Projects → Import → OpenIntent**.
5. Optional: unzip. Confirm `VERIFY.txt` `attenuation_areas` is a positive integer, then open `alignment-overlay.svg` next to `images/`. If that count is >0 but Hamina shows map-only after OpenIntent import, paste `hamina-clipboard.json` for clutter (buildings + trees) until Hamina confirms outdoor OI import; also try 2D view / hardware acceleration off. Zip `README.txt` has the full steps.

The page has no extra options. Tree source (NLCD canopy, RGB fallback), OSM, and calibration are automatic or API-only.

## API

`POST /api/clutter`

```json
{
  "west": -115.1735, "south": 36.1205, "east": -115.1488, "north": 36.1355,
  "name": "Site",
  "trees": [{ "lon": -115.16, "lat": 36.128 }],
  "treesSource": "nlcd-canopy",
  "osmTrees": false,
  "format": "bundle"
}
```

- `format: "bundle"` (default) — JSON with `zipBase64`, `frame`, `stats`, `alignment`. `stats` includes `buildingsKept`, `treesKept`, `treesSource`, `fetched`, and drop reasons.
- `format: "zip"` — same OpenIntent zip bytes
- `format: "hamina-clipboard"` — clipboard JSON only (skips imagery fetch; old-Hamina fallback)

Calibration (API only): `"controlPoints": [{ "lon", "lat", "xM", "yM" }, …]` (3+). Not shown in the UI.

## Limits

Global ML (zoom-9 quadkey, clipped to the JPEG) is the base polygon. Overture Buildings release `2026-08-19.0` is read from one or two Azure GeoParquet row groups (committed bbox index, not a full scan). Esri MSBFP2 (paginated to 2000) and FEMA USA Structures fill centroids still uncovered. A candidate is the same roof when its centroid sits inside a kept ring or within 11 m of that ring’s centroid. Geometry is replaced only for a single exterior that is more detailed at a similar area, or when the kept ring is a stub inside a fuller outline. Height rank: Overture explicit height, then Microsoft Global ML `height` (values ≤ 2 m and −1 ignored), then FEMA `HEIGHT`, then Overture `num_floors` × 3 m, then the nearest measured neighbor within 120 m, then stock One Floor / Five Floor / Hotel bins. Ties keep the height already on the ring. A stub whose area is outside 0.4–2.5× does not overwrite a larger footprint’s height. OpenIntent `area_materials` stay the four Hamina outdoor Building - One/Two/Five/Ten Floor names (`compatibilityMode` `stock-openintent`). Trees are not written into OpenIntent; paste `hamina-clipboard.json` for foliage/trunks and exact metres. OSM building ways are not read.

A large smooth bright roof that none of those layers contain is filled from the Esri JPEG (connected membrane pixels, ≥2500 m², skipped when a vector already covers it). Boxes over ~2.5 km fail. Campus-merge blobs &gt; 150,000 m² are dropped. NLCD still places trees and still refuses roofs and pavement; a textured canopy island with a pavement ring is kept as a median. Meta/WRI CHM v2 (zoom-10 COG, pixel window, max side 180) overrides foliage `top_height` where the canopy is above 2 m. USGS 3DEP `getSamples` (36 points, no API key) becomes `terrain-clipboard.json` only: flat pads when a cell’s corner relief is under 0.5 m, otherwise two sloped triangles. OpenIntent and `hamina-clipboard.json` stay free of raised and sloped floors. Overture, canopy height, and 3DEP start only after the aerial image and footprints are in memory. Each has its own 2 second abort. If the map fetch already used 5 seconds, they are skipped. A miss is recorded in `export-warnings.json` and the OpenIntent zip still exports. The page does not ask for a smaller box when a source times out. FEMA, NLCD, and 3DEP are United States sources.

## Development

Feature work targets the long-lived **`dev`** branch (see [Production vs Dev](#production-vs-dev)). Promote `dev` → `main` only for production releases.

```bash
npm test
npm run eval          # image-space quality gate on cached fixtures
npx netlify dev
```

`npm run eval` scores building/tree placement against cached aerial fixtures (no Hamina login). It fails if rooftops are missed, large footprints are dropped, trees land on pavement or roofs, measured heights collapse back to stock bins, Overture does not add or upgrade a footprint, CHM does not set foliage heights, the terrain clipboard is empty on a sloped DEM, or the imagery mask cannot restore the Oak Creek white retail roof after that polygon is removed. Optional: `npm run eval -- --live` to refresh against live Esri/NLCD.


## License

MIT. Imagery © Esri. Building footprints © Microsoft (ODbL), Overture Maps Foundation, and FEMA USA Structures (ORNL / NGA). Canopy height © Meta / World Resources Institute. Elevation © USGS 3DEP.
