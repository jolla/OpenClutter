# OpenClutter

**OpenClutter** turns a map box into clutter that lines up with the map in [Hamina Planner](https://hamina.com): one georeferenced [OpenIntent](https://github.com/google/openintent) zip. Import that zip and you get the map **and** all attenuating objects. No clipboard paste.

Live: https://openclutter.netlify.app · Source: https://github.com/jolla/OpenClutter

## Exact alignment (every site)

Hamina **2026-09-01** (docs.hamina.com release notes): “OpenIntent import and export now supports attenuating objects!” The [support matrix](https://docs.hamina.com/hamina/live/openintent) shows Attenuating Objects ✅ import/export. Older OpenClutter clipboard paste was a workaround from when import dropped areas.

This tool does not mix sources. One bbox drives everything:

1. Esri World Imagery for that bbox (`bboxSR=4326`, `imageSR=4326`). **The frame is the JPEG’s actual `extent`**, which is often taller than the drawn box.
2. Microsoft US Building Footprints (Esri MSBFP2) mapped through that actual extent.
3. USFS/NLCD percent tree canopy as a density field (jitter + NMS; imagery RGB only if the canopy raster is missing/empty — **not** when NLCD is valid zeros on parking/lawn).
4. lon/lat → JPEG pixels with the actual west/south/east/north (OpenIntent Y-up / JPEG Y-down).
5. OpenIntent `floorplans[].attenuation_areas[]` + `area_materials` use that same snapped frame (stock Hamina type names, heights, dB/m).

**Import this zip in Hamina (Projects → Import → OpenIntent).** No per-site hand nudge. Do not use a GE screenshot as the map.

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
   - `openIntent_<slug>.json` — OpenIntent 2.0.1 with `attenuation_areas` (buildings + tree pairs) at the JPEG’s geographic size
   - `images/<slug>.jpg` — Esri aerial
   - `alignment-overlay.svg` — buildings (red) + trees (green) on that JPEG
   - `frame-lock.json` — pixel/meter corners for Hamina vs OpenIntent vs JPEG
   - `export-warnings.json`
   - `hamina-clipboard.json` — silent fallback for Hamina builds before OpenIntent attenuating-object import
   - `README.txt` — import-only instructions plus coverage stats (`buildingsKept`, `treesKept`, `treesSource`, fetched, drop reasons)
   - `export-stats.json` — same coverage numbers as machine-readable JSON
4. Hamina: **Projects → Import → OpenIntent**.
5. Optional: unzip and open `alignment-overlay.svg` next to `images/` to check rooftops.

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

US footprints only (MSBFP2 is paginated up to 2000, queried against the snapped JPEG extent). Boxes over ~2.5 km fail. Microsoft campus-merge blobs &gt; 150,000 m² are dropped; big-box / warehouse roofs on a tight commercial map are kept. Tree and height accuracy is heuristic, not survey-grade. Function time is bounded by Netlify’s hobby limit.

## Development

```bash
npm test
npm run eval          # image-space quality gate on cached fixtures
npx netlify dev
```

`npm run eval` scores building/tree placement against cached aerial fixtures (no Hamina login). It fails if rooftops are missed, large footprints are dropped, or trees land on pavement. Optional: `npm run eval -- --live` to refresh against live Esri/NLCD.


## License

MIT. Imagery © Esri. Building footprints © Microsoft (ODbL).
