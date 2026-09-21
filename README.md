# OpenClutter

**OpenClutter** turns a map box into clutter that lines up with the map in [Hamina Planner](https://hamina.com): a georeferenced [OpenIntent](https://github.com/google/openintent) zip **and** a pasteable HaminaClipboard JSON, both in the **same geographic frame**.

Live: https://openclutter.netlify.app · Source: https://github.com/jolla/OpenClutter

## Exact alignment (every site)

Hamina OpenIntent `attenuation_areas` imports are unreliable. The dependable object path is **HaminaClipboard JSON paste**. Alignment fails when the **map image** and the **clipboard meters** disagree — typically a Google Earth screenshot that Hamina auto-scales to the wrong size, then lon/lat footprints converted with a second guessed scale.

This tool does not mix sources. One bbox drives everything:

1. Esri World Imagery for that bbox (`bboxSR=4326`, `imageSR=4326`, same `size` as the math).
2. Microsoft US Building Footprints (Esri MSBFP2) for that bbox.
3. USFS/NLCD percent tree canopy for that bbox (imagery RGB only if the canopy raster is missing/empty).
4. lon/lat → image pixels with the same west/south/east/north.
5. Clipboard meters use that same `widthM` × `lengthM`.

**Import the zip first** (sets the Hamina map to geographic size), **then paste the clipboard**. No per-site hand nudge. Do not use a GE screenshot as the map.

Clipboard origin (unit-tested):

```
SW (west, south) → (−widthM, −lengthM)
SE (east, south) → (0, −lengthM)
NW (west, north) → (−widthM, 0)
NE (east, north) → (0, 0)

x_clip = x_px * mpuX − widthM
y_clip = y_from_south_px * mpuY − lengthM
```

Trees come from **USFS/NLCD percent tree canopy** on the same bbox (threshold ≥30%), not from lawn-colored pixels. If that raster is missing or nodata for the box (outside CONUS), the app **silently** falls back to Esri aerial RGB that prefers textured woody canopy over smooth grass. OSM tree *nodes* and `controlPoints` calibration are API-only (not on the default page). OSM building/tree **rings** are never emitted (they caused Hamina to drop all `attenuation_areas` on v8).

`stats.treesSource` is `"nlcd-canopy"`, `"imagery-rgb"`, or `"none"` (in the API payload, not a UI picker).

## Use

1. Search an address.
2. Draw the site (under ~2 km on a side).
3. **Export** — downloads the OpenIntent zip and HaminaClipboard JSON.
4. Import the zip in Hamina, then paste the JSON.

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

- `format: "bundle"` (default) — JSON with `zipBase64`, `clipboard`, `frame`, `stats`, `alignment`
- `format: "zip"` — OpenIntent zip bytes
- `format: "hamina-clipboard"` — clipboard JSON only (skips imagery fetch)

Calibration (API only): `"controlPoints": [{ "lon", "lat", "xM", "yM" }, …]` (3+). Not shown in the UI.

## Limits

US footprints only. Boxes over ~2.5 km fail. Campus polygons &gt; 15,000 m² are dropped. Tree and height accuracy is heuristic, not survey-grade. Function time is bounded by Netlify’s hobby limit.

## Local

```bash
npm test
npx netlify dev
```

## License

MIT. Imagery © Esri. Building footprints © Microsoft (ODbL).
