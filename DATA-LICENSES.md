# Data licenses

OpenClutter's code is under the MIT license (see `LICENSE`). **The MIT license covers the code only.** Data that OpenClutter reads, ships in an export, or keeps in this repository stays under the license of its source.

Every export zip carries `ATTRIBUTION.txt` with the map image it shipped (source, vendor, capture date when published, credit, license) and the list below. The site shows the same list at `/licenses.html` (generated from `netlify/lib/data-credits.js` by `node scripts/build-licenses-page.js`).

## Open Database License

Contains information from OpenStreetMap (c) OpenStreetMap contributors, Microsoft Global ML Building Footprints, and Overture Maps Foundation, available under the Open Database License (ODbL) 1.0. The vector data in an export (the attenuation areas in the OpenIntent JSON) is made available under the ODbL: https://opendatacommons.org/licenses/odbl/1-0/

## Sources

| Source | Used for | Credit | License |
|---|---|---|---|
| OpenStreetMap (via Overpass, Photon, Nominatim) | building parts, poles, lamps, water, parking, walls, rail, map notes, place search | (c) OpenStreetMap contributors | ODbL 1.0 |
| Microsoft Global ML Building Footprints | building footprints and heights | Microsoft Global ML Building Footprints, ODbL | ODbL 1.0 |
| Overture Maps Foundation buildings | building footprints and heights | Overture Maps Foundation; includes OpenStreetMap, Microsoft, Esri Community Maps contributors (CC BY 4.0), Google Open Buildings (CC BY 4.0). See https://docs.overturemaps.org/attribution/ | ODbL 1.0 |
| FEMA USA Structures | US building footprints | Courtesy of FEMA | Public domain |
| Meta / WRI CHMv2 canopy height | canopy outlines and heights | Meta and World Resources Institute (WRI) - 2026. Version 2 High Resolution Canopy Height Maps (CHMv2). Source imagery for CHM (c) 2016 Vantor | CC BY 4.0 (AWS Open Data Registry). The CHMv2 paper also names the DINOv3 License; that conflict is unresolved |
| ESA WorldCover 2021 | tree cover gap fill | (c) ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium | CC BY 4.0 |
| USFS NLCD Tree Canopy Cover | US canopy percent | Courtesy of the USDA Forest Service | Public domain |
| USGS 3DEP elevation and lidar | US terrain and heights | Courtesy of the U.S. Geological Survey | Public domain |
| Copernicus DEM GLO-30 | terrain outside the US | Produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved | Copernicus DEM licence |
| National Land Survey of Finland laser scanning | building heights, `netlify/lib/nls-hamina-ndsm.gz` | Contains data from the National Land Survey of Finland Laser scanning data 2008-2019 | CC BY 4.0 |

## Map images

| Source | Where | Credit | License |
|---|---|---|---|
| Esri World Imagery | draw map on every host; export image on production and when chosen on /dev | Powered by Esri. Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community | Esri terms of use |
| USDA NAIP (via Microsoft Planetary Computer) | /dev Auto or NAIP | USDA Farm Production and Conservation Business Center | Public domain |
| swisstopo SWISSIMAGE | /dev National, Switzerland | Federal Office of Topography swisstopo | OGD |
| PDOK Luchtfoto | /dev National, Netherlands | Beeldmateriaal Nederland / PDOK | CC BY 4.0 |
| NLS Finland orthophoto | /dev National, Finland | National Land Survey of Finland | CC BY 4.0 |
| IGN BD ORTHO | /dev National, France | IGN | Licence Ouverte 2.0 |

## Files in this repository

- `test/fixtures/**/imagery.jpg` and `test/fixtures/structure-sites/*.jpg` are USDA NAIP crops (public domain). Older commits held Esri World Imagery crops in the same paths; they were replaced in v1.2.11.
- `test/fixtures/**/footprints.geojson`, `overture.geojson`, and `bench/fixtures/*.json` hold OpenStreetMap, Microsoft, and Overture data under the ODbL 1.0.
- `test/fixtures/**/chm-grid.json` is Meta / WRI CHMv2 (CC BY 4.0, source imagery (c) 2016 Vantor).
- `test/fixtures/**/tcc-samples.json` and `dem-samples.json` are USFS NLCD and USGS 3DEP samples (public domain).
- `netlify/lib/nls-hamina-ndsm.gz` is derived from National Land Survey of Finland laser scanning data (CC BY 4.0).

## Service use

- OpenStreetMap data is read from Overpass, not the OSM editing API.
- Nominatim is called only after a user search (never for autocomplete), at most 1 request per second across the app, with an identifying User-Agent. The endpoint is `NOMINATIM_URL` so the provider can be switched without a code change.
- Esri World Imagery export images are not written to the Netlify Blobs source cache. A finished zip is kept for 24 hours so Download again works.
