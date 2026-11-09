# OpenClutter

OpenClutter turns a box drawn on a map into outdoor clutter for Wi-Fi planning in [Hamina Planner](https://hamina.com). It builds buildings, trees, water, parking, walls, poles, vehicles and terrain from free public data, lines them up with an aerial image, and exports one georeferenced [OpenIntent](https://github.com/google/openintent) zip that Hamina imports as the map plus attenuating objects. Terrain, two GPS tie points and map notes go into Hamina through a separate Copy terrain paste, because OpenIntent cannot carry them.

## Use

1. Search an address or place.
2. Drag a box on the map, or click corners and click the first one to close a polygon (up to 15 km on a side).
3. Optional: open Advanced to turn foliage, water, parking, cars, walls, poles, RVs, terrain, lidar heights, map notes and map quality on or off.
4. Click Export. The zip holds the OpenIntent JSON, the aerial image and `ATTRIBUTION.txt`.
5. In Hamina: Projects, Import, OpenIntent, then pick the zip.
6. If the export included terrain, the button becomes Copy terrain. Paste that into Planner Plus to add the terrain mesh, GPS points and map notes.

Finished exports stay available for 24 hours through Download again.

## Sites

| | Production | Dev |
|---|---|---|
| URL | https://openclutter.com | https://dev.openclutter.com |
| Branch | `main` | `dev` |
| Purpose | Stable release | New work and experiments, shown with a `dev` badge |

The /dev site also has an aerial Source picker (Esri, Auto, NAIP in the US, or national orthophotos) and testing overrides. Production always uses Esri World Imagery.

## API

`POST /api/clutter` with a bbox in WGS84:

```json
{ "west": -115.1735, "south": 36.1205, "east": -115.1488, "north": 36.1355,
  "name": "Site", "includeFoliage": true, "format": "bundle" }
```

- `includeFoliage` is off unless set. `includeTerrain` and `mapNotes` are on unless set to `false`.
- `format`: `bundle` (default, JSON with `zipBase64`, `stats`, `terrainClipboard` and `gpsClipboard`), `zip` (the zip bytes), or `hamina-clipboard` (clipboard JSON only).
- A draft structured API (`/v1/sites`, API key required) runs as a prototype on /dev only. See [docs/api/openclutter-api-v1.md](docs/api/openclutter-api-v1.md).

## Limits

- A draw can be up to 15 km on a side. Large draws get a coarser map and keep the largest and tallest roofs.
- The OpenIntent JSON is budgeted at about 4.9 MB, under Hamina's import limit. The aerial uploads separately and does not count.
- OpenIntent has no terrain, GPS or map note fields, so those stay on the Copy terrain paste.
- USGS 3DEP lidar and elevation, FEMA structures and NLCD canopy cover the United States only. Outside 3DEP coverage, terrain comes from Copernicus DEM GLO-30.
- Heavy exports run on a Fly.io worker when one is configured, and fall back to a Netlify background function.

## Development

Open feature work against `dev`. Promote `dev` to `main` only for a production release, keep the version numbers in sync with `npm run bump`, and tag the release.

```bash
npm install
npm test              # unit tests
npm run eval          # image-space quality gate on cached fixtures
npx netlify dev       # local site and functions
npm run bump          # bump the patch version
npm run overture:index  # rebuild the Overture buildings index for a new release
```

More detail on the pipeline and the Fly worker is in [HANDOFF.md](HANDOFF.md) and [docs/fly-worker.md](docs/fly-worker.md). Release history is in [CHANGELOG.md](CHANGELOG.md).

## Usage counts

OpenClutter counts anonymous totals of page views and exports by day, week, and month. The page sends one small request when it loads. There are no cookies, and raw IP addresses are not stored. A browser with Do Not Track or Global Privacy Control set is not counted, and neither is an export from that browser. The same note is in How it works on the page.

A visitor id is the hash of a random monthly salt, the IP, and the user agent. The salt lives in the Netlify Blobs store `openclutter-usage` for that America/Chicago month. It is not an environment variable. The salt and the per-visitor records are deleted on the 4th day of the next month, after the month's totals have been saved. Only those totals are kept. An id from one month cannot be matched to the next.

`prod` is openclutter.com (and www.openclutter.com). `dev` is dev.openclutter.com. Every other host is `other`. Each period reports page views, unique users, exporting users (at least one export started), exports started, done, error, and cancelled, the mean and median exports started among exporting users, a histogram (1, 2-3, 4-10, 11+), and two ratios: exports started per page view, and exporting users per unique user.

A week that starts in one month and ends in the next counts a person once on each side, so that week's unique users can be high. The response sets `approx` on those weeks. Two events for the same visitor at the same moment can miss or double one increment until the month is reconciled.

`GET /api/usage` returns the aggregates only. With no date it returns the last 30 days, 12 weeks, or 12 months. When `OPENCLUTTER_API_KEY_HASHES` is set (the same key list as the draft `/v1` API), the request needs `Authorization: Bearer <key>` or `X-OpenClutter-Key`. When that variable is empty, the read is public. The counts contain no personal data.

```bash
curl -sS "https://openclutter.com/api/usage?period=day&date=2026-11-09"
curl -sS "https://openclutter.com/api/usage?period=day&from=2026-10-11&to=2026-11-09"
curl -sS "https://openclutter.com/api/usage?period=week"
curl -sS "https://openclutter.com/api/usage?period=month"
curl -sS -H "Authorization: Bearer YOUR_KEY" "https://dev.openclutter.com/api/usage?period=day&date=2026-11-09"
```

An export is tied to the same visitor id from the moment it is created on Netlify. A finish (done, error, or cancelled) is counted on the Chicago day the job was created. The in-process benches call the export function directly and do not create a job or load the page, so they are not counted. There is no bench header or query flag on those calls.

The Fly worker writes the finished job into the same job record. It does not see the IP. The visitor id is already on the job. This site counts that finish when the Netlify background function sees the worker's answer, and when something reads export status, so a Fly worker redeploy is not required for the usual path. A finish is missed only when the worker writes it after Netlify has stopped watching and nothing reads status. Redeploying the Fly worker makes that write count on its own, including the missed case. Job creation and Cancel run on Netlify either way.

## Data credits

Map images: Powered by Esri (Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community), or USDA NAIP and national orthophotos on /dev. Vector data from OpenStreetMap, Microsoft Global ML Building Footprints and Overture Maps Foundation is available under the Open Database License (ODbL) 1.0. Canopy, elevation and other sources keep their own licenses.

The full list is in [DATA-LICENSES.md](DATA-LICENSES.md), on the site at `/licenses.html` ([dev](https://dev.openclutter.com/licenses.html); production gets it with the next release), and in `ATTRIBUTION.txt` inside every export zip.

## License

MIT, for the code only (see [LICENSE](LICENSE)). Data keeps its source license.
