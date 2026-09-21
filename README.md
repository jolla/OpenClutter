# OpenClutter

**OpenClutter** turns a map box into clutter that lines up with the map in [Hamina Planner](https://hamina.com): a georeferenced [OpenIntent](https://github.com/google/openintent) zip **and** a pasteable HaminaClipboard JSON, both in the **same geographic frame**.

Live: https://openclutter.netlify.app · Source: https://github.com/jolla/OpenClutter

## Exact alignment (every site)

Hamina OpenIntent `attenuation_areas` imports are unreliable. The dependable object path is **HaminaClipboard JSON paste**. Alignment fails when the **map image** and the **clipboard meters** disagree — typically a Google Earth screenshot that Hamina auto-scales to the wrong size, then lon/lat footprints converted with a second guessed scale.

This tool does not mix sources. One bbox drives everything:

1. Esri World Imagery for that bbox (`bboxSR=4326`, `imageSR=4326`, same `size` as the math).
2. Microsoft US Building Footprints (Esri MSBFP2) for that bbox.
3. lon/lat → image pixels with the same west/south/east/north.
4. Clipboard meters use that same `widthM` × `lengthM`.

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

Trees come from vegetation pixels on the Esri aerial (OSM tree *nodes* optional, off by default). OSM building/tree **rings** are never emitted (they caused Hamina to drop all `attenuation_areas` on v8).

## Use

1. Open the deployed site.
2. Search an address.
3. Draw a rectangle over the site (keep it under ~2 km on a side).
4. **Export clutter** downloads two files:
   - `{site}-openintent.zip` — aerial + OpenIntent metadata at geographic size
   - `{site}-hamina-clipboard.json` — pasteable zones (stock Hamina type names)
5. Hamina **Projects → Import → OpenIntent** the zip.
6. Copy the JSON, click the map canvas, paste (⌘V / Ctrl+V).

Optional: 3+ `{lon,lat,xM,yM}` control points calibrate clipboard output onto a *legacy* wrong-scale map. Leave that empty for new sites.

## API

`POST /api/clutter`

```json
{
  "west": -115.1735, "south": 36.1205, "east": -115.1488, "north": 36.1355,
  "name": "Site",
  "trees": [{ "lon": -115.16, "lat": 36.128 }],
  "osmTrees": false,
  "format": "bundle"
}
```

- `format: "bundle"` (default) — JSON with `zipBase64`, `clipboard`, `frame`, `stats`, `alignment`
- `format: "zip"` — OpenIntent zip bytes
- `format: "hamina-clipboard"` — clipboard JSON only (skips imagery fetch)

Calibration: `"controlPoints": [{ "lon", "lat", "xM", "yM" }, …]` (3+).

## Limits

US footprints only. Boxes over ~2.5 km fail. Campus polygons &gt; 15,000 m² are dropped. Tree and height accuracy is heuristic, not survey-grade. Function time is bounded by Netlify’s hobby limit.

## Local

```bash
npm test
npx netlify dev
```

## License

MIT. Imagery © Esri. Building footprints © Microsoft (ODbL).
