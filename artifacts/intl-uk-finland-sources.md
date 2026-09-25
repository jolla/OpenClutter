# UK and Finland sources for OpenClutter

Research only, from branch `dev` (v1.1.9 pipeline). No feature code in this note.

Checked against the tree and a few live requests on 25 Sep 2026. Licences marked **TODO verify** were not read in full by counsel. Do not treat a “free to download” page as permission to ship a commercial Hamina export.

## Recommendation (short)

Keep the export frame in WGS84 (`EPSG:4326`) and local clipboard metres. Do not convert the zip to EPSG:27700 or EPSG:3067.

Route **DEM only** at first:

1. United States: USGS 3DEP, as today (bare earth).
2. Everywhere 3DEP returns no grid, including the UK and Finland: Copernicus DEM GLO-30, read as a COG window from the public AWS bucket. It is a **surface** model, not bare earth. Paste terrain from it, and **do not** turn on the 20 m slope-lift (`bottom_height`) unless the DEM is tagged bare-earth.

Buildings and the draw/export image already have a global path (Overture, Esri World Imagery). Foliage already has a global height grid (Meta/WRI CHM v2). US-only layers (NLCD, MSBFP2, USA Structures, the committed Microsoft index) should keep failing soft.

First `/dev` slice: that DEM fallback, plus a retest that Overture buildings and Esri imagery survive a Helsinki address and a London address. Leave national 1 m / 2 m DEMs, OS premium data, and NLS API keys for a later PR.

---

## 1. Current pipeline geography locks

There is **no CONUS bounding-box reject**. `geoFrame()` in `netlify/lib/geo-frame.js` only rejects a box whose side is under 40 m or over 2.5 km. The page does the same check in `applyExtent()` in `public/app.js`. A London or Helsinki draw is legal. The US bias is which URLs get called, and one committed index that only lists United States quadkeys.

Clipboard maths are not a US CRS. `metersPerDeg()` uses a spherical scale (`111320 * cos(lat)` east-west, `110540` north-south). `llToClipboard()` then builds local metres on that frame. OpenIntent vertices also carry international feet (`pipeline.js`, × 1/0.3048). That is a unit triple Hamina expects, not NAD83. The draw chip in `public/bbox-area.js` displays feet with `en-US` grouping. Cosmetic, not a data lock.

The map opens on Las Vegas (`public/app.js`, `L.map(...).setView([36.128, -115.16], 15)`). Search is not US-filtered.

| Layer | What the code calls | US-only? | What happens outside the US |
|---|---|---|---|
| Terrain | `fetchDemSamples` | Yes | Live London call returns HTTP 200 with an error body. Zip still exports. Terrain file omitted. |
| Canopy percent | `canopySamplesUrl` / `fetchCanopyTrees` | Yes (CONUS) | Error / nodata. Reason string `nodata-or-outside-conus`. Polygons do not fall back to an RGB spray. |
| Canopy height | `fetchChmGrid` | No | Global COG. See §2. |
| Buildings, base | `fetchOvertureFootprints` | No | Global row-group index. See §2. |
| Buildings, Microsoft file | `fetchMsGlobalFootprints` | Index is US-only | Quadkey missing from `ms-buildings-index.json` → zero features. Not an error. |
| Buildings, Esri MSBFP2 | `fetchMsFootprints` | Yes | Empty page. |
| Buildings, FEMA | `fetchUsaStructures` | Yes | Empty id list. |
| Export JPEG | `esriImageryUrl` | No | World Imagery, `bboxSR=4326`, `imageSR=4326`. |
| Draw basemap | Leaflet in `public/app.js` | No | Carto dark + Esri World Imagery tiles. The Carto layer is not the zip image. |
| Geocode | `netlify/functions/geocode.js` | No | Nominatim, no `countrycodes`. |
| OSM trees | `fetchOsmTreeNodes` | No | API flag only (`osmTrees: true`). Off in the UI. |
| Imagery roof fill | `supplementFootprints` | No | Colour heuristic on the Esri JPEG. |

### Terrain — USGS 3DEP only

`netlify/lib/terrain.js`

- `DEM_URL` = `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples`
- `fetchDemSamples(frame, fetchFn, opts)` posts the snapped lon/lat envelope with `spatialReference.wkid: 4326`, bilinear interpolation, and a sample count from `sampleCountForResolution` (Auto up to 625, Default 144, Fine 324, Finest 576).
- `parseDemSamples` keeps numeric `z` in `[-500, 9000]`. A live Oak Creek sample came back as the string `"214.485717773"` at about 1 m resolution. `Number()` accepts that. The code treats `z` as metres. 3DEP CONUS values are NAVD88 orthometric metres.
- `terrainFromSamples` stores clipboard `z` as metres **above the lowest sample**, not as an absolute datum.
- `noteMissingTerrain` / `terrainBundleFields` warn `Terrain omitted: USGS 3DEP did not return a usable grid` and still return the OpenIntent zip.
- `netlify/functions/clutter.js` starts this only after imagery metadata snaps the extent (`beginOptional` → `fetchDemSamples`). A miss is a warning, not a 502.
- `TERRAIN_README` in `netlify/lib/pipeline.js` tells the user the grid is “USGS 3DEP bare-earth”.

Live check, 25 Sep 2026, 4 samples:

- Oak Creek (`-87.922, 42.890, -87.921, 42.891`): HTTP 200, 4 samples, about 214.5 m.
- Trafalgar (`-0.128, 51.507, -0.127, 51.508`): HTTP 200, body `error.message` = `Invalid or missing input parameters` (cloud `Open` failed on an `.aux.xml`). `fetchDemSamples` throws on `body.error`. Terrain omitted.

### Foliage percent — NLCD TCC CONUS only

`public/tree-detect.js` (re-exported by `netlify/lib/tree-source.js`)

- `TCC_IMAGESERVER` = `https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_NLCD_TCC_CONUS/ImageServer`
- `canopySamplesUrl` calls `getSamples` with `sr=4326`.
- `decideCanopy`: fewer than `MIN_VALID_SAMPLES` (20) valid 0–100 values → `{ ok: false, reason: "nodata-or-outside-conus" }`.
- `fetchCanopyTrees` then returns `source: null`.

`HANDOFF.md` already says this raster does not cover Hawaii, Puerto Rico, or southeast Alaska, and that those sites fall through. The same hole is the whole of Europe.

`netlify/lib/vegetation.js` `treePairsFromPoints`: if a CHM grid resolves crowns, those polygons win (`foliageGeometry: "chm-crown"`). Otherwise `canopyPolygonsFromHits` needs NLCD hits (`nlcd-polygon`). Tree points are not emitted as circles. `crownSupported` treats “fewer than 4 NLCD hits” as “the CHM itself is the mask”, so a CONUS miss does not block CHM crowns.

The browser may still run an RGB detector (`detectRgbTrees` in `public/app.js`) when NLCD is a true gap. The server does not turn those points into canopy polygons. README: outside CONUS the app does not fall back to a spray of RGB crowns.

### Buildings — three of four sources are US-locked

Order in `assembleFootprints` (`netlify/lib/conflate.js`): Microsoft Global ML, then Overture, then Esri MSBFP2, then FEMA USA Structures. Height rank: Overture `height`, then Microsoft `height` (> 2 m), then FEMA `HEIGHT`, then Overture `num_floors` × 3 m.

**Microsoft file (US index, not a geographic formula).** `netlify/lib/ms-global.js`

- `urlsForBbox` only emits a URL when the zoom-9 quadkey is a key in `netlify/lib/ms-buildings-index.json`.
- That file has **2415** keys. Every URL contains `RegionName=UnitedStates` and the `2026-07-24` release. `HANDOFF.md` says the same.
- `MAX_GZIP_BYTES` is 80 MB. Larger tiles are skipped (Los Angeles).
- Probe of the index: London quadkey `031313131` absent. Helsinki quadkey `120120211` absent. Oak Creek `030222210` present.

The Microsoft manifest is wider than the index. `https://bfppub.z5.web.core.windows.net/2026-08-13/dataset-links.csv` (fetched 25 Sep 2026) includes:

| RegionName | Quadkeys in that CSV | Notes for a first slice |
|---|---|---|
| UnitedStates | 2415 | What the repo indexes, one release older (`2026-07-24`). |
| UnitedKingdom | 194 | London `031313131` is **113.7 MB**. Over the 80 MB cap, so indexing it would still skip the tile. |
| Finland | 352 | Helsinki `120120211` is **11.6 MB**. Small enough to download. |
| Europe | 476 | Coarse leftover region, not a substitute for the country folders. |

Microsoft’s current GitHub readme licenses Global ML Building Footprints under **CDLA Permissive 2.0**. This repo’s README still says “Microsoft (ODbL)”. Overture’s attribution page also calls the Microsoft building source ODbL. **TODO verify** which licence applies to the exact `2026-07-24` United States files in the index versus the `2026-08-13` UK/Finland files. CDLA-Permissive allows commercial use without share-alike. ODbL does not, for a derivative database.

**Esri MSBFP2 (US).** `msFootprintsUrl` / `fetchMsFootprints` in `netlify/lib/geo-frame.js`:

`https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/MSBFP2/FeatureServer/0/query`

`inSR=4326`, `outSR=4326`, paginated, cap 2000. `HANDOFF.md`: `dataLastEditDate` 2022-04-13, US Microsoft footprints, not the global set.

**FEMA USA Structures (US).** `fetchUsaStructures` in `netlify/lib/usa-structures.js`:

`https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/USA_Structures_View/FeatureServer/0/query`

Envelope query, `inSR=4326`, `outSR=4326`, `HEIGHT` when between 2 m and 400 m. ORNL / NGA. Empty outside the US is a soft miss.

**Overture is the one building reader that already selects London and Helsinki.** See §2.

### Imagery

Export JPEG: `esriExportQuery` / `esriImageryUrl` / `esriImageryMetaUrl` in `netlify/lib/geo-frame.js`.

`https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=…&bboxSR=4326&imageSR=4326`

`extentFromMeta` refuses any `wkid` other than 4326 or 84, then `applyImageryMeta` snaps the frame to the JPEG’s real extent. At Helsinki’s latitude the usual Esri north-south pad (`~1/cos φ`) is larger than in Wisconsin. The snap path already exists; it just has to be retested, because a missed snap was the Long Meadow rooftop bug.

Draw UI tiles in `public/app.js`: Esri World Imagery (`attribution: "Esri"`) over Carto (`© OSM © CARTO`). The zip image is the export JPEG, not the Carto tiles.

### Geocoding

`netlify/functions/geocode.js` proxies

`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=`

No `countrycodes`, no viewbox. User-Agent comes from `netlify/lib/version.js`. The public Nominatim policy is about one request per second and is not a bulk commercial geocoder. Volume here is one search per draw, which is the same as the US. **TODO verify** the current OSMF operations policy before calling this acceptable for a Hamina-facing product at higher traffic. It is not a UK/Finland functional gap.

### Attribution strings that are US-specific

- `README.md` licence line: Imagery © Esri. Footprints © Microsoft (ODbL), Overture, FEMA USA Structures (ORNL / NGA). Canopy © Meta / WRI. Elevation © USGS 3DEP.
- `TERRAIN_README` in `netlify/lib/pipeline.js`: “USGS 3DEP bare-earth”.
- The page has no DEM-source control. `test/pipeline.test.js` asserts the HTML does not mention “DEM source” or “3DEP source”. A country router should stay off the main UI.

### What is not a lock

- No EPSG:27700, EPSG:3067, or EPSG:3857 in the export frame. CHM tiles are Pseudo-Mercator on disk; `readTileWindow` in `netlify/lib/canopy-height.js` converts the bbox through `mercator()` only to window the COG.
- OSM building ways are intentionally not read (`conflate.js`, `overture.js`). That was a Hamina import failure (v8), not a geography choice.

---

## 2. What already works globally

| Piece | Where | Evidence |
|---|---|---|
| Address search | `geocode.js` | Nominatim, worldwide. Policy limit, not a coverage limit. |
| Draw and export image | `esriImageryUrl`, Leaflet Esri tiles | World Imagery is global. Frame stays EPSG:4326. |
| Overture buildings `2026-08-19.0` | `netlify/lib/overture.js`, index `overture-rg-data.js` | Index extent is about lon −180..180, lat −84..83. 512 files, 92032 row groups. |
| Meta/WRI CHM v2 | `chmUrl` in `canopy-height.js` | Path is `…/dinov3_global_chm_v2_ml3/chm/{quadkey}.tif`. No country test. `MAX_TILES` 4, window resampled to ≤320 px. |
| Optional OSM tree nodes | `osm-trees.js` | Overpass `node["natural"="tree"]`. Off unless `osmTrees: true`. |
| Roof fill, water mask, pavement reject | `surface-mask.js`, `pavement.js` | They use the JPEG, not a US raster. |
| Local metre clipboard | `geo-frame.js`, `terrain.js` | Relative to the JPEG extent and, for terrain, to the lowest sample. |

Overture row groups that overlap a small test box (index only, parquet not downloaded):

| Site | Groups | Cap |
|---|---|---|
| London `−0.14, 51.49, −0.10, 51.52` | 4, in `part-00126-…zstd.parquet` | `MAX_GROUPS` is 4, so this box is already at the cap. A fifth overlapping group would be dropped. |
| Helsinki `24.92, 60.16, 24.96, 60.18` | 1, in `part-00254-…zstd.parquet`, bbox about `24.79, 60.08, 25.38, 60.20` | Fine. |
| Oak Creek | 1 | Current US path. |

CHM tile HEAD, 25 Sep 2026, HTTP 200 `binary/octet-stream`:

- London zoom-10 `0313131311`
- Helsinki zoom-10 `1201202110`
- Oak Creek zoom-10 `0302222101`

So a `/dev` export with **Include foliage** on can already request a real canopy-height window in both cities. Whether `fetchChmGrid` finishes inside the 2 s optional budget (and the “skip if the core phase already used 5 s” rule in `clutter.js`) is unproven from Europe. That is a timing risk, not a missing URL.

CHM licence is inconsistent in public sources. The AWS Open Data registry yaml for this bucket says **CC BY 4.0**. The CHMv2 paper says the dataset is under the **DINOv3 licence**. Citation text also says source imagery © Vantor. **TODO verify** before relying on it for commercial Hamina exports. CC BY 4.0 would allow commercial use with attribution. A DINOv3 model licence may not.

Overture buildings are **ODbL** because the theme includes OpenStreetMap (`docs.overturemaps.org`). This repo already ships that for US sites. Share-alike applies to a derivative database, not automatically to every picture of a map. Per-site zips are the same legal shape as today’s US exports. Attribution still has to name OSM contributors and the other sources Overture lists (Esri Community Maps CC BY 4.0, Google Open Buildings CC BY 4.0, Microsoft as Overture states it). **TODO verify** the attribution block against the current Overture licence page before the zip `README.txt` is shown to UK/FI customers.

---

## 3. United Kingdom sources

Great Britain and Northern Ireland are not one open-data regime. “UK” in the product sense needs a Great Britain path plus a Northern Ireland TODO.

### DEM / terrain

| Source | Resolution / type | Access that fits a bbox clip | Licence for commercial Hamina use | Use |
|---|---|---|---|---|
| Copernicus DEM GLO-30 (COP-DEM-GLO-30 Public) | ~30 m **DSM** (WorldDEM-30), global, EGM2008 heights | Public COG. Confirmed HTTP 200: `https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/Copernicus_DSM_COG_10_N51_00_W001_00_DEM/Copernicus_DSM_COG_10_N51_00_W001_00_DEM.tif` | Free and open **for GLO-30**, with a required Airbus/DLR/EU credit. See below. | **First slice.** |
| Copernicus WorldDEM-10 / EEA-10 | ~10 m | Separate distribution | The GLO-30 licence **excludes** redistributing the 10 m DEM to the general public. | Do not use. |
| Environment Agency LiDAR Composite DTM 1 m | ~1 m **bare earth**, ~99% of **England**, Ordnance Datum Newlyn, stored in **EPSG:27700** | WCS 2.0.1, not the old Esri ImageServer. `https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs` | **Open Government Licence.** Commercial use allowed with attribution (Environment Agency copyright and database right). | Best later upgrade for England. Needs a 27700 transform. |
| OS Terrain 50 | 50 m DTM, Great Britain, ODN | Bulk download (ASCII grid / GML), June 2026 vintage on the OS Data Hub. Not a small bbox API. | **OGL.** Attribution: `Contains OS data © Crown copyright and database right [year]`. | Coarser than GLO-30. Skip for the clip path. |
| OS Terrain 5 | 5 m DTM, Great Britain | Premium. Data Exploration is a trial, not a product licence. | **Not open.** Commercial use needs an OS licence. | **Blocks** unlicensed Hamina use. Do not call it. |
| Scotland, Wales, Northern Ireland LiDAR | Varies | Separate publishers (Scottish Government / NatureScot, Natural Resources Wales, OSNI) | **TODO verify** each licence. Do not assume OGL. | Later. Copernicus covers the gap. |

Copernicus GLO-30 licence (COP-DEM-GLO-30-F, “Free & Open”): reproduction and use are free of charge, including the uses needed to put a derived terrain mesh in an export. The user must show, when distributing it: **© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018 provided under COPERNICUS by the European Union and ESA; all rights reserved**. The product is a digital **surface** model. It is not a bare-earth DTM.

On 17 Jul 2026 Copernicus announced that the **DEM 30 m view service** on the Data Space would be limited to authorised Contributing-Missions users from 28 Jul 2026. The AWS Open Data objects above still answered HTTP 200 on 25 Sep 2026. Build against the S3 COGs, not the view service. **TODO verify** the bucket policy still allows anonymous reads when the PR is written.

EA composite is the right bare-earth upgrade for England and is OGL, so it does not block commercial use. It will not serve Scotland or Northern Ireland. WCS subsets are in British National Grid metres. A Helmert-only WGS84↔27700 transform is a few metres off; OSTN15 is the accurate grid. For a 30 m mesh that error is hidden. For a 1 m mesh aligned to an Esri WGS84 JPEG it is not. That is why EA is not the first slice.

### Building footprints / heights

| Source | Heights | Clip-friendly | Licence | Use |
|---|---|---|---|---|
| Overture buildings `2026-08-19.0` | `height` or `num_floors` already read | Yes, existing range read | ODbL (theme). Already in production for the US. | **First slice.** |
| Microsoft Global ML, `RegionName=UnitedKingdom` | Often no lidar height. **TODO verify** on a sample row. | Gzip per zoom-9 quadkey. Central London is 113.7 MB, over the 80 MB cap. | CDLA Permissive 2.0 on the current Microsoft readme. **TODO verify** the file in the manifest. | Not the first slice. A later index can add UK quadkeys under 80 MB. |
| OS Open Zoomstack `local_buildings` | No. `id` / `uuid` only. Generalised. | Bulk GeoPackage. Storage CRS EPSG:27700. An unofficial demo API is not a contract. | OGL. | Fallback polygons if Overture is thin. Not first. |
| OS OpenMap Local buildings | No measured height. Generalised polygons. | Bulk, not a bbox API in this repo. | OGL. | Same. |
| OS NGD buildings / MasterMap / Building Height Attribute | Relative and absolute heights exist on the premium products. | OS Data Hub / NGD API, API key, paid plan for commercial use. | **Premium.** Unlicensed commercial use is not allowed. | **Do not use** without an OS contract. |

OS OpenData (OGL) is safe commercially and useless for heights. OS premium heights would match Hamina better and are the licence that would block an unlicensed product. Stay on Overture.

### Trees / canopy

| Source | What it is | Licence | Use |
|---|---|---|---|
| Meta/WRI CHM v2 | ~1.2 m canopy **height**, global COG, tile exists for London | CC BY 4.0 **or** DINOv3 licence. **TODO verify.** | Already coded. Retest on `/dev` before adding anything else. |
| Copernicus HRL Tree Cover Density, 10 m, EEA | Percent crown cover, annual from 2018. Closest NLCD analogue. EPSG:3035 tiles. Sentinel Hub BYOC needs an account. | CLMS: free for any purpose, with attribution. **TODO verify** the current data policy text. | Later, and only if CHM crowns are empty. Not a height. |
| National Forest Inventory (Forestry Commission) | Woodland polygons, not a canopy-height grid. | OGL for the open NFI maps. **TODO verify** the exact product. | Too coarse for crowns. |
| OSM `natural=wood` / landuse | Rings | ODbL, and this repo refuses OSM rings because Hamina dropped every attenuation area. | Do not emit. |

### Imagery for the draw UI and the zip

Keep **Esri World Imagery** for both. It is the frame every footprint is snapped to. Swapping the zip JPEG for OS MasterMap imagery would be a premium licence and would move the alignment problem.

OS Maps API is not open for unlicensed commercial basemaps. **TODO verify** Esri’s current basemap terms for storing the export JPEG inside a customer zip. That question already applies to US exports; UK does not make it new.

### Geocoding

| Source | Notes | Licence |
|---|---|---|
| Nominatim (already wired) | Works for “Trafalgar Square, London”. Public instance policy. | OSM data ODbL. Usage policy is the constraint, not the country. |
| OS Names API (Open Names) | Gazetteer, not a full address matcher. API key, free OS OpenData tier. | OGL for OS Open Names. |
| OS Places API | Real addresses. | **Premium.** Do not use unlicensed. |
| postcodes.io | Postcodes only. | Open, not an address geocoder. |

First slice: leave `geocode.js` as it is.

---

## 4. Finland sources

### DEM / terrain

| Source | Resolution / type | Access | Licence | Use |
|---|---|---|---|---|
| Copernicus DEM GLO-30 | ~30 m DSM, EGM2008 | COG confirmed HTTP 200: `…/Copernicus_DSM_COG_10_N60_00_E024_00_DEM/Copernicus_DSM_COG_10_N60_00_E024_00_DEM.tif` | Same GLO-30 free licence as the UK. Not the 10 m product. | **First slice.** |
| NLS (Maanmittauslaitos) Korkeusmalli 2 m | 2 m **bare earth** from lidar (≥0.5 pts/m²). N2000. Gaps in parts of the outer archipelago and the eastern border. | WCS 2.0.1 `https://avoin-karttakuva.maanmittauslaitos.fi/ortokuvat-ja-korkeusmallit/wcs/v2` coverage id `korkeusmalli_2m`. GeoTIFF or ASCII grid. Can request 2, 4, 8, … 512 m. **API key required** (free, Basic auth user = key, empty password, or `api-key=`). Example subsets are **EPSG:3067** metres (`SUBSET=E…&SUBSET=N…`). | **CC BY 4.0.** Attribution must name Maanmittauslaitos, the dataset, and the delivery date. Commercial use is allowed. | Best later DEM. Not first: key + 3067 transform. |
| Helsinki 3D city terrain | City only, with the semantic model. ETRS-GK25 (**EPSG:3879**), N2000. | Download / WFS, not a national clip. | CC BY 4.0 (Helsinki Region Infoshare). | City-only. Skip while NLS 2 m exists. |

NLS documents two quality classes (leaf-off class I is edited; summer class II is not). Either is still bare earth, unlike Copernicus.

### Building footprints / heights

| Source | Heights | Access | Licence | Use |
|---|---|---|---|---|
| Overture buildings | `height` / `num_floors` | Already indexed. Helsinki test box hits one row group. | ODbL theme. | **First slice.** |
| Microsoft `RegionName=Finland` quadkey `120120211` | **TODO verify** whether `height` is set. Global ML outside US lidar is often heightless. | 11.6 MB gzip, under the 80 MB cap. | CDLA Permissive 2.0 on the Microsoft readme. **TODO verify.** | Optional later index add. Not required to prove buildings exist. |
| NLS Maastotietokanta, collection `rakennus` | No metre height. Some `kohdeluokka` values encode a **storey band**. The official example is `42211` = residential, 1–2 storeys. **TODO verify** the class list before mapping bands to × 3 m. | OGC API Features `https://avoin-paikkatieto.maanmittauslaitos.fi/maastotiedot/features/v1/collections/rakennus/items`. API key. `bbox` can be requested in EPSG:3067 or, with the right `bbox-crs`, in WGS84. The old standalone building API was removed on 7 Apr 2025. | CC BY 4.0. | Good geometry fallback if Overture is thin. Not first. |
| Helsinki 3D city model | LoD1 / LoD2 CityGML, `bldg:measuredHeight`, N2000, EPSG:3879 | WFS 2.0.0 `https://kartta.hel.fi/3d/citydb-wfs/wfs` | CC BY 4.0. | Best heights **inside Helsinki**. CityGML parse is a large second slice, not the first. |
| Ryhti / building register | Address and registry attributes. NLS says the authoritative ids and addresses moved toward Syke Ryhti. | Not a national footprint-with-height clip. | **TODO verify** before use. | Do not block the first slice on it. |

### Trees / canopy

| Source | Notes | Licence |
|---|---|---|
| Meta/WRI CHM v2 | Helsinki tile exists (HEAD 200). Same licence TODO as the UK. | See §2. |
| Copernicus HRL Tree Cover Density 10 m | Covers Finland (EEA). Percent, not height. | CLMS, attribution. **TODO verify** policy text. |
| Luke (Natural Resources Institute) MS-NFI | 16 m forest-resource grids (volume, site type). Not a crown outline. | CC BY 4.0. **TODO verify** the current download terms. |
| Helsinki urban tree points | City points, not a national canopy. | CC BY 4.0 via HRI. **TODO verify** the dataset record. |
| NLS topographic `puisto` / forest polygons | Land use, not crowns. | CC BY 4.0. |

Same foliage decision as the UK: retest CHM; do not add OSM rings.

### Imagery

| Source | Notes | Licence |
|---|---|---|
| Esri World Imagery | Keep as the zip and the draw image so Overture rings share the JPEG extent. | Same Esri question as the US. |
| NLS ortokuva, 0.5 m colour | WCS coverage `ortokuva_vari` on the same endpoint as the 2 m DEM. API key. | CC BY 4.0. |

Do not switch the zip JPEG to NLS orthophotos in the first slice. Footprints are aligned to the Esri extent on purpose. A national orthophoto is only worth it when footprints come from the same national CRS.

### Geocoding

| Source | Notes | Licence |
|---|---|---|
| Nominatim | Works for Helsinki addresses. Same usage policy. | ODbL data. |
| NLS Geocoding API v2 | `https://avoin-paikkatieto.maanmittauslaitos.fi/geocoding/v2/pelias/search`. API key. Names, Ryhti building addresses, interpolated road addresses. Reverse geocode exists. | CC BY 4.0 on the open datasets behind it. **TODO verify** the API terms of use (they are separate from the data licence). |

First slice stays on Nominatim. NLS geocoding is the right Finland upgrade once an API key is acceptable in Netlify env.

---

## 5. Country routing

### Detect country

Do not call Nominatim a second time just to choose a DEM. The public instance is already used for search, and a failed search should not change the export.

For the first slice, **do not classify the country at all**. Try 3DEP. If `fetchDemSamples` throws or returns no usable samples, read Copernicus GLO-30 for that same snapped bbox. US sites keep 3DEP, including Hawaii and Alaska where 3DEP actually returns a grid. UK, Finland, and the rest of Europe fall through with no country table.

When a national bare-earth DEM is added, detect from the bbox centroid with a small in-repo polygon (Natural Earth admin-0, simplified, for `GB` and `FI` only). Nominatim reverse (`zoom` for country, `address.country_code`) is a fallback if the polygon misses, not the primary. A 2.5 km box does not span countries except on a border; if it does, use the centroid and say so in `export-warnings.json`.

### Provider interface

One module, four layers, each a ordered list. The handler asks the list and keeps the first success. US-only providers stay in the list and fail soft, as they do now.

```text
dem:        [threeDep, copernicusGlo30]           # later: nls2m, eaDtm1m before copernicus when tagged bare-earth
buildings:  [msGlobal, overture, msbfp2, usaStructures]
foliage:    [chmV2, nlcdTcc]                      # nlcd returns no hits outside CONUS; chm still runs
geocode:    [nominatim]                           # later: nlsGeocode when the query looks Finnish, still Nominatim as fallback
```

Each DEM provider returns `{ samples: [{lon, lat, z}], kind: "bare-earth" | "surface", attribution: string }` in WGS84 degrees and metres. `terrainFromSamples` stays datum-agnostic (z above the lowest sample). `siteWarrantsLift` runs only when `kind === "bare-earth"`. A surface model can still produce `terrain-clipboard.json`, but it must not set OpenIntent `bottom_height`. A 30 m DSM of central London or Helsinki includes roofs. Relief across a block can exceed the 20 m lift gate and then stack building height on top of roof height.

Buildings stay in `assembleFootprints`. No new conflation rule in the first PR. Foliage stays in `treePairsFromPoints`. Geocode stays a separate function.

### Fallback chain

| Layer | First | Fallback | Do not |
|---|---|---|---|
| DEM | 3DEP bare earth | Copernicus GLO-30 surface, lift suppressed | OS Terrain 5, Copernicus 10 m, mixing two datums in one box |
| Buildings | Existing chain. Overture is the one that hits UK/FI today. | NLS `rakennus` or OS Open Zoomstack only if a retest shows Overture empty | OS NGD / MasterMap without a licence. OSM building ways. |
| Foliage | CHM v2 crowns | Nothing (foliage empty, warning). NLCD remains the US fallback. | OSM landuse rings. RGB crown spray. |
| Geocode | Nominatim | Later NLS, then Nominatim | OS Places without a licence |

### Minimal first slice on `/dev`

Country: **both**, by the 3DEP-miss fallback, not by a UK-only flag. Production (`main`, openclutter.netlify.app) stays US-only.

Layers to unlock:

1. **DEM:** Copernicus GLO-30 when 3DEP misses. New reader. Do not reuse `readTileWindow` unchanged: that function assumes a Web Mercator CHM. GLO-30 COGs are geographic degree tiles. `geotiff` is already a dependency.
2. **Buildings:** no new source. Confirm Overture on the two acceptance boxes.
3. **Foliage:** no new source. Confirm CHM crowns, or accept an empty foliage layer with a warning. Toggle stays off by default.
4. **Geocode and imagery:** unchanged.

National bare-earth (NLS 2 m, EA 1 m) is the second slice, after the GLO-30 mesh is aligned.

---

## 6. Risks

| Risk | Why it matters |
|---|---|
| Copernicus is a DSM | Roofs and canopy become terrain. On a flat city block the 20 m lift can fire. Suppress lift unless `kind === "bare-earth"`. |
| Height datums | 3DEP NAVD88, GLO-30 EGM2008, EA Newlyn (OSGM15), NLS N2000, Helsinki N2000. Clipboard z is relative to the lowest sample **of that one grid**. Do not blend two DEMs in one box. Absolute elevation is not comparable across countries, and it does not need to be. |
| EPSG:27700 and EPSG:3067 | National services want projected metres. The zip must stay WGS84 plus local metres. A weak transform shifts terrain relative to the Esri JPEG. GLO-30 avoids that because the COG is already geographic. |
| High latitude pad | Esri `imageSR=4326` pads north-south by about `1/cos φ`. Helsinki (60°N) pads more than Oak Creek. `applyImageryMeta` has to snap, or roofs drift south. This is the Long Meadow bug at a higher latitude. |
| London Microsoft tile | 113.7 MB > 80 MB. Indexing United Kingdom does not fix central London. |
| Overture group cap | The London sample box already matches 4 groups, and `MAX_GROUPS` is 4. Watch for a clipped neighbourhood on the acceptance draw. |
| CHM time budget | Optional read aborts at 2 s and is skipped if the core phase used 5 s. Tiles exist; the function may still time out. |
| No metre heights | OS OpenData and NLS topographic buildings have no lidar height. Overture `num_floors × 3` is the same estimate the US path already uses. Helsinki LoD2 is the first real measured-height upgrade, and only in the city. |
| Foliage vs US CHM+NLCD | CHM v2 can run in Europe. NLCD cannot. Quality will not match a US site where NLCD masks pavement and CHM supplies height. Expect more pavement crowns, or empty foliage if the COG read fails. Do not “fix” that with RGB. |
| Rate limits and keys | Nominatim ~1 r/s. NLS open APIs need a free key and have their own terms (no published hard quota in the WCS page; they still forbid abuse). EA WCS is anonymous but not a guaranteed SLA. Netlify’s export clock does not grow because the site is in Europe. |
| Licences that block commercial use | OS Terrain 5, OS NGD, OS Places, MasterMap, Copernicus 10 m / EEA-10 redistribution. |
| Licences that allow it if attributed | OGL (EA LiDAR, OS Terrain 50, OS Open Zoomstack), CC BY 4.0 (NLS DEM, orthophotos, topographic buildings, Helsinki 3D), Copernicus GLO-30 free licence (fixed Airbus/DLR credit). |
| Licences to re-read before shipping | Overture buildings ODbL (already shipped in the US). Microsoft CDLA vs the README’s ODbL. CHM CC BY 4.0 vs DINOv3. Esri JPEG redistribution. Nominatim operations policy. |
| CDSE view-service lock | Do not point the function at the Copernicus Data Space DEM view. Use the AWS COG that still returned 200. |

---

## 7. Proposed first PR (`/dev` only)

**Title:** Copernicus DEM when 3DEP misses, so UK and Finland draws get a terrain clipboard.

**Out of scope:** production, country picker UI, NLS key, EA WCS, OS anything premium, Microsoft index rebuild, Helsinki CityGML, foliage redesign, Nominatim replacement.

**Code shape (for the next run, not this one):**

- Add `fetchCopernicusDemSamples` next to `fetchDemSamples`. Same `{lon, lat, z}` array. Tag `kind: "surface"`.
- In `clutter.js`, on 3DEP failure only, call it inside the existing terrain optional budget (grace 1.5 s, hard 9 s). If both fail, today’s warning stands.
- `siteWarrantsLift` stays false for `kind: "surface"`.
- `TERRAIN_README` and the zip status line name the DEM that actually returned (3DEP bare-earth vs Copernicus surface) and include the GLO-30 credit when that path hits.
- Dev host only, same gate as the Terrain resolution slider, until Jerry accepts the two cities. Production keeps calling 3DEP alone.

**Acceptance — Jerry, on `https://openclutter.netlify.app/dev`:**

1. Search `Helsinki Cathedral, Helsinki, Finland`. Draw a block around Senate Square, under 2.5 km on a side, Include foliage **off**. Export.
   - OpenIntent zip downloads. `VERIFY.txt` `attenuation_areas` is a positive integer (buildings).
   - `images/` JPEG is aerial of that square. `alignment-overlay.svg` roofs sit on buildings, not shifted by a hundred metres. This is the high-latitude Esri pad check.
   - `terrain-clipboard.json` is present. Status text says Copernicus, not 3DEP.
   - OpenIntent building materials do **not** carry `bottom_height` (surface DEM must not lift).
   - Copy terrain pastes in Planner Plus without “Sloped floor coordinates are not valid”.
2. Search `Trafalgar Square, London, United Kingdom`. Same checks on a block that includes a few streets of rooftops.
3. Include foliage **on** for one of those two exports. Either green canopy polygons appear on trees, or foliage counts are 0 and `export-warnings.json` says the canopy grid was missed. There must be no field of circles on pavement.
4. Regression: Oak Creek (or the existing eval fixture) still uses 3DEP. `npm test` and `npm run eval` stay green. Production `https://openclutter.netlify.app` is unchanged.

If London’s Overture read hits the 4-group cap and a whole street is missing, that is a follow-up on `MAX_GROUPS`, not a reason to add OS NGD.

---

## Source matrix

| Need | United States (today) | United Kingdom | Finland | First `/dev` slice |
|---|---|---|---|---|
| DEM | 3DEP bare earth, NAVD88, `getSamples`, no key | GLO-30 DSM now. EA 1 m DTM later (England, OGL, EPSG:27700). OS Terrain 5 is premium. | GLO-30 DSM now. NLS 2 m later (CC BY 4.0, EPSG:3067, API key, N2000). | GLO-30 only when 3DEP misses. Lift off. |
| Buildings | MS index + Overture + MSBFP2 + USA Structures | Overture. MS London tile too big. OS OpenData has no height. OS NGD premium. | Overture. MS Helsinki tile is 11.6 MB. NLS polygons, storey class only. Helsinki LoD2 has real heights, city only, CC BY 4.0. | Overture already indexed. No new reader. |
| Foliage | CHM v2, else NLCD TCC CONUS | CHM tile exists. NLCD does not. TCD 10 m is a later percent layer. | Same. | Retest CHM. Empty is acceptable. No OSM rings. |
| Draw / zip image | Esri World Imagery | Same | Same. NLS 0.5 m orthophoto is later and must not replace the alignment JPEG alone. | Unchanged. |
| Geocode | Nominatim | Nominatim. OS Places is premium. | Nominatim. NLS Geocoding v2 is the later upgrade. | Unchanged. |
| CRS in the zip | WGS84 + local metres + feet triples | Same. Do not emit EPSG:27700. | Same. Do not emit EPSG:3067 or EPSG:3879. | Unchanged. |
