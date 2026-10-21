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

## Data credits

Map images: Powered by Esri (Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community), or USDA NAIP and national orthophotos on /dev. Vector data from OpenStreetMap, Microsoft Global ML Building Footprints and Overture Maps Foundation is available under the Open Database License (ODbL) 1.0. Canopy, elevation and other sources keep their own licenses.

The full list is in [DATA-LICENSES.md](DATA-LICENSES.md), on the site at `/licenses.html` ([dev](https://dev.openclutter.com/licenses.html); production gets it with the next release), and in `ATTRIBUTION.txt` inside every export zip.

## License

MIT, for the code only (see [LICENSE](LICENSE)). Data keeps its source license.
