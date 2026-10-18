# OpenClutter API v1 (draft)

Direct site model API for Hamina (and other planners). This path returns structured site data. It does **not** use the OpenIntent zip or the HaminaClipboard paste.

Status: draft for product discussion, with a working prototype (see section 13). Field names follow OpenClutter's existing export pipeline (v1.1.210+), not a greenfield invent.

Base URL (proposed): `https://api.openclutter.com`

Prototype (live on /dev since v1.1.220): `https://dev--openclutter.netlify.app/v1` (also `https://dev.openclutter.com/v1`). Not on openclutter.com. Section 13 lists where the prototype differs from this draft.

---

## 1. Overview

OpenClutter builds outdoor clutter for Wi-Fi / AFC planning from free public data: building footprints and heights, lidar / canopy trees, outdoor objects (poles, walls, water, parking), terrain, GPS anchors, map notes, and an aerial imagery reference.

**Today's web product** (`POST /api/clutter`) returns an OpenIntent zip plus optional clipboard paste. That remains for openclutter.com.

**This v1 API** exposes the same detection pipeline as GeoJSON FeatureCollections and a terrain mesh, so Hamina can ingest natively (domes, crowns, poles as first-class objects) without the 5 MB OpenIntent limit or the zip+paste two-step.

### Design goals

- One request: polygon (or bbox) in, async job, structured result out
- Coordinates in WGS84 (EPSG:4326); heights and sizes in meters
- Schema close to internal IR (`height`, `heightSource`, `levelBaseM`, `buildingPart`, `roofShape`, …)
- Page or tile large areas instead of one giant body
- Explicit attribution / licence flags per data source
- API keys, rate limits, and a stable `/v1` contract

---

## 2. Auth

All `/v1/*` routes require an API key.

```
Authorization: Bearer oc_live_...
```

or

```
X-OpenClutter-Key: oc_live_...
```

| Prefix | Use |
| --- | --- |
| `oc_live_` | Production |
| `oc_test_` | Sandbox (same schema, may skip paid imagery, stricter quotas) |

Keys are issued per customer (or per Hamina environment). Rotate by creating a new key and revoking the old one. Do not put keys in query strings or client-side web apps.

Unauthorized → `401`. Wrong scope / revoked → `403`.

---

## 3. Units and CRS

| Quantity | Unit / CRS |
| --- | --- |
| Horizontal geometry | EPSG:4326, GeoJSON `[lon, lat]` (and `[lon, lat, z]` only where noted) |
| Lengths, diameters, cell size | meters |
| Heights (`baseHeightM`, `topHeightM`, `crownBaseM`, …) | meters above local ground under the feature (same meaning as pipeline `height` / `levelBaseM` / material `bottom_height`+`top_height`) |
| Terrain elevations | meters in the declared vertical datum (see `terrain.verticalDatum`) |
| Attenuation | dB/m at the declared frequency (default **5 GHz**, matching current outdoor defaults) |
| Timestamps | ISO 8601 UTC |

Local ground for buildings and trees is bare-earth (or surface DEM when that is what was used). Absolute ellipsoidal height is not required in v1.

---

## 4. Versioning

- Path prefix `/v1` is the contract version.
- Response includes `apiVersion: "1.0.0"` and `engineVersion` (OpenClutter build, e.g. `"1.1.210"`).
- Additive fields may appear without a major bump. Removals or meaning changes require `/v2`.
- Clients should ignore unknown properties.

---

## 5. Endpoints

### 5.1 `POST /v1/sites`

Create a site build job.

**Request body**

```json
{
  "name": "Hamina town square",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[
      [27.1860, 60.5688],
      [27.1905, 60.5688],
      [27.1905, 60.5710],
      [27.1860, 60.5710],
      [27.1860, 60.5688]
    ]]
  },
  "options": {
    "includeBuildings": true,
    "includeFoliage": true,
    "includePoles": true,
    "includeWater": true,
    "includeParking": true,
    "includeWalls": true,
    "includeTerrain": true,
    "includeAerial": true,
    "includeMapNotes": true,
    "includeGpsAnchors": true,
    "terrainResolution": "auto",
    "imageryQuality": "auto",
    "attenuationFrequencyGHz": 5,
    "webhookUrl": "https://hamina.example/hooks/openclutter",
    "webhookSecret": "whsec_..."
  }
}
```

| Field | Notes |
| --- | --- |
| `geometry` | GeoJSON `Polygon` or `MultiPolygon` (EPSG:4326). Also accepted: `bbox: [west, south, east, north]` (same as today's `west/south/east/north`). If both are sent, `geometry` wins; the engine still clips to the axis-aligned frame of the geometry (same as the current UI). |
| `options.include*` | Defaults match the current Advanced panel: foliage/parking/walls/poles/terrain on; water off unless set. |
| `terrainResolution` | `auto` \| `default` \| `fine` \| `finest` \| meter stops (`20`, `15`, `10`, `5`, `1`) |
| `imageryQuality` | `auto` \| `high` \| `medium` \| `low` (maps to existing plate ladder) |
| `attenuationFrequencyGHz` | Default `5`. Values are the pipeline's per-meter figures at that band; Hamina may rescale. |
| `webhookUrl` | Optional HTTPS endpoint. On terminal state, POST the same JSON as `GET /v1/sites/{id}` (status view), signed. |

**Response `202 Accepted`**

```json
{
  "id": "3f2a9c1e-4b7d-4e2a-9c11-8a0b6d5e4f21",
  "apiVersion": "1.0.0",
  "status": "queued",
  "statusUrl": "/v1/sites/3f2a9c1e-4b7d-4e2a-9c11-8a0b6d5e4f21",
  "resultUrl": "/v1/sites/3f2a9c1e-4b7d-4e2a-9c11-8a0b6d5e4f21/result",
  "createdAt": "2026-10-17T14:32:00Z",
  "expiresAt": "2026-10-18T14:32:00Z"
}
```

Jobs expire after about 24 hours (same order as today's blob jobs).

---

### 5.2 `GET /v1/sites/{id}`

Job status (poll every 1-2 s while `queued` / `running`).

```json
{
  "id": "3f2a9c1e-4b7d-4e2a-9c11-8a0b6d5e4f21",
  "apiVersion": "1.0.0",
  "engineVersion": "1.1.210",
  "status": "running",
  "stage": "Trees",
  "progress": 0.62,
  "percent": 62,
  "createdAt": "2026-10-17T14:32:00Z",
  "updatedAt": "2026-10-17T14:33:10Z",
  "warnings": [],
  "error": null,
  "statsPreview": {
    "buildings": 42,
    "trees": 118,
    "poles": 9
  }
}
```

| `status` | Meaning |
| --- | --- |
| `queued` | Accepted, not started |
| `running` | Pipeline in progress (`stage` mirrors today's stages: aerial, buildings, trees, …) |
| `succeeded` | Result ready at `/result` |
| `failed` | See `error` |
| `expired` | Blobs gone; create a new job |

---

### 5.3 `GET /v1/sites/{id}/result`

Full structured site (only when `status === succeeded`).

**Query**

| Param | Default | Meaning |
| --- | --- | --- |
| `collections` | all | Comma list: `buildings,trees,poles,water,parking,walls,terrain,gpsAnchors,mapNotes,aerial,provenance` |
| `page` | `1` | 1-based page within a collection (or within a tile) |
| `pageSize` | `500` | Max features per page (cap 2000) |
| `tile` | omit | Optional `"{z}/{x}/{y}"` Web Mercator tile to clip features (for large draws) |
| `bbox` | omit | Optional `west,south,east,north` clip |

When the site is larger than one page, the response includes `paging` and may omit heavy collections until requested.

**Response shape (success)**

```json
{
  "id": "...",
  "apiVersion": "1.0.0",
  "engineVersion": "1.1.210",
  "name": "Hamina town square",
  "crs": "EPSG:4326",
  "frame": {
    "west": 27.1860,
    "south": 60.5688,
    "east": 27.1905,
    "north": 60.5710,
    "widthM": 248.1,
    "lengthM": 244.6
  },
  "buildings": { "type": "FeatureCollection", "features": [] },
  "trees": { "type": "FeatureCollection", "features": [] },
  "poles": { "type": "FeatureCollection", "features": [] },
  "water": { "type": "FeatureCollection", "features": [] },
  "parking": { "type": "FeatureCollection", "features": [] },
  "walls": { "type": "FeatureCollection", "features": [] },
  "terrain": { },
  "gpsAnchors": { "type": "FeatureCollection", "features": [] },
  "mapNotes": { "type": "FeatureCollection", "features": [] },
  "aerial": { },
  "provenance": { },
  "stats": { },
  "warnings": [],
  "paging": {
    "page": 1,
    "pageSize": 500,
    "totalFeatures": 180,
    "totalPages": 1,
    "next": null
  }
}
```

---

### 5.4 Webhook (optional)

When `options.webhookUrl` is set, on `succeeded` or `failed` OpenClutter POSTs the status document to that URL.

Headers:

```
Content-Type: application/json
X-OpenClutter-Job: <id>
X-OpenClutter-Signature: sha256=<hex HMAC of raw body with webhookSecret>
```

Retries: a few times with backoff. Hamina should treat the webhook as a hint and still poll if needed.

---

## 6. Result collections (schema)

Properties below are the **API contract**. Names in parentheses are the current pipeline fields they map from.

### 6.1 Buildings (`buildings`)

GeoJSON `Polygon` or `MultiPolygon` footprint.

```json
{
  "type": "Feature",
  "id": "bldg-hamina-townhall",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[27.1879, 60.5697], [27.1886, 60.5697], [27.1886, 60.5701], [27.1879, 60.5701], [27.1879, 60.5697]]]
  },
  "properties": {
    "kind": "building",
    "name": "Haminan raatihuone",
    "baseHeightM": 0,
    "topHeightM": 12.9,
    "heightSource": "nls-laser",
    "heightConfidence": 0.85,
    "geomSource": "osm",
    "buildingPart": false,
    "podium": false,
    "roofShape": null,
    "roofHeightM": null,
    "roofDirectionDeg": null,
    "material": {
      "name": "Building - 12.9",
      "attenuationDbPerMeter": 5.0,
      "frequencyGHz": 5,
      "displayColor": "#ABB1B7"
    },
    "tiers": [
      {
        "id": "tier-hall",
        "role": "mass",
        "baseHeightM": 0,
        "topHeightM": 12.9,
        "buildingPart": false,
        "geometry": { "type": "Polygon", "coordinates": ["…same as feature…"] }
      },
      {
        "id": "tier-clock-tower",
        "role": "tower",
        "baseHeightM": 12.9,
        "topHeightM": 23.1,
        "buildingPart": true,
        "levelBaseM": 12.9,
        "floatSpan": true,
        "roofShape": null,
        "geometry": {
          "type": "Polygon",
          "coordinates": [[[27.18815, 60.56985], [27.18835, 60.56985], [27.18835, 60.57000], [27.18815, 60.57000], [27.18815, 60.56985]]]
        }
      },
      {
        "id": "tier-clock-dome",
        "role": "dome",
        "baseHeightM": 23.1,
        "topHeightM": 27.0,
        "buildingPart": true,
        "levelBaseM": 23.1,
        "roofShape": "dome",
        "geometry": {
          "type": "Polygon",
          "coordinates": [[[27.18818, 60.56988], [27.18832, 60.56988], [27.18832, 60.56997], [27.18818, 60.56997], [27.18818, 60.56988]]]
        }
      }
    ]
  }
}
```

| Property | Pipeline source |
| --- | --- |
| `topHeightM` | `properties.height` |
| `baseHeightM` | terrain seat / `levelBaseM` when floating; else `0` |
| `heightSource` | `osm` \| `overture` \| `overture-floors` \| `ms-global` \| `fema` \| `nls-laser` \| `nearby` \| `lidar` \| … |
| `heightConfidence` | Derived (measured laser/lidar high; floor estimate lower). Not stored today; computed for the API. |
| `buildingPart`, `levelBaseM`, `floatSpan`, `podium` | same names |
| `roofShape`, `roofHeightM`, `roofDirectionDeg` | `roofShape`, `roofHeight`, `roofDirection` |
| `tiers[]` | building parts + dome stacks from `roof-form` / `building-shape` |
| `material.attenuationDbPerMeter` | outdoor building default **5** dB/m @ 5 GHz |

A single-mass building may omit `tiers` or send one tier equal to the footprint.

### 6.2 Trees (`trees`)

One feature per discrete tree or stand. Geometry is the **crown** polygon when known; otherwise a Point at the stem with `crownRadiusM`.

```json
{
  "type": "Feature",
  "geometry": { "type": "Polygon", "coordinates": ["…crown ring lon/lat…"] },
  "properties": {
    "kind": "tree",
    "stem": { "type": "Point", "coordinates": [27.1872, 60.5699] },
    "crownBaseM": 3.5,
    "crownTopM": 14.2,
    "trunkHeightM": 3.5,
    "trunkDiameterM": null,
    "speciesClass": "broadleaf",
    "leafState": "unknown",
    "foliageClass": "heavy",
    "materialCrown": {
      "name": "Foliage - Heavy 14.2",
      "attenuationDbPerMeter": 1.5,
      "frequencyGHz": 5,
      "displayColor": "#3F7D2A"
    },
    "materialTrunk": {
      "name": "Foliage - Trunk 3.5",
      "attenuationDbPerMeter": 3.0,
      "frequencyGHz": 5,
      "displayColor": "#8B6B4F"
    },
    "heightSource": "chm",
    "heightConfidence": 0.7
  }
}
```

| Property | Pipeline source |
| --- | --- |
| `crownBaseM` / `crownTopM` | seated crown (`bottom_height` / `top_height` on foliage materials) |
| `speciesClass` | `palm` (OSM palm tags / palm detector), `conifer` / `broadleaf` (aerial + CHM heuristics), else `unknown` |
| `leafState` | `leaf-on` \| `leaf-off` \| `unknown` (not modeled in OI today; reserved) |
| `foliageClass` | heavy (≥12 m → 1.5 dB/m) vs light (1.0 dB/m) |
| Large stands | may set `kind: "stand"` with understory material (~0.6 dB/m) plus crown |

### 6.3 Poles (`poles`)

```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [27.1875, 60.5695] },
  "properties": {
    "kind": "pole",
    "poleType": "lighting",
    "heightM": 9.0,
    "diameterM": 0.3,
    "explicitHeight": false,
    "material": {
      "name": "Light pole",
      "attenuationDbPerMeter": 10.0,
      "frequencyGHz": 5,
      "displayColor": "#4A4A4A"
    }
  }
}
```

Maps from outdoor `kind: "pole"` (`man_made` mast / pole / lighting). Defaults: **9 m** tall, **0.3 m** diameter (pipeline `POLE_HEIGHT_M`, `POLE_DIAMETER_M`).

### 6.4 Water, parking, walls

Same FeatureCollection pattern:

| Collection | `properties.kind` | Defaults (5 GHz) |
| --- | --- | --- |
| `water` | `water` | 0.1 dB/m, ~0.1 m sheet |
| `parking` | `parking` | 2 dB/m (open deck) |
| `walls` | `wall` \| `retaining` \| `fence` \| `hedge` | 8 / 6 / 1 / 1 dB/m |

Geometry: Polygon (water, parking) or thin Polygon / LineString extruded (walls). Heights in `baseHeightM` / `topHeightM`.

### 6.5 Terrain (`terrain`)

Either a regular grid or a TIN of open quads (Planner Plus style).

```json
{
  "representation": "grid",
  "cellSizeM": 5.0,
  "cols": 48,
  "rows": 48,
  "west": 27.1860,
  "south": 60.5688,
  "east": 27.1905,
  "north": 60.5710,
  "verticalDatum": "NAVD88",
  "kind": "bare-earth",
  "attribution": "NLS Finland laser / Copernicus DEM GLO-30",
  "minZ": 2.1,
  "maxZ": 8.4,
  "reliefM": 6.3,
  "samples": [
    { "lon": 27.1860, "lat": 60.5688, "z": 3.2 }
  ],
  "quads": null
}
```

| Field | Notes |
| --- | --- |
| `kind` | `bare-earth` (USGS 3DEP) or `surface` (Copernicus GLO-30) |
| `verticalDatum` | Documented per source; US 3DEP is orthometric (NAVD88-related); GLO-30 is EGM2008-based. Exact EPSG code listed in `provenance.sources`. |
| `quads` | Optional open quads `{ ring: [[xM,yM,z],…], style: "sloped"|"raised" }` in local meters relative to NE=(0,0) when Hamina wants the current paste mesh. Prefer `samples` + `cellSizeM` for a clean API. |

### 6.6 GPS anchors (`gpsAnchors`)

Two (or more) points tying the aerial to WGS84. Same role as today's `gpsClipboard.tiePoints` (SW and NE of the imported map; NE local meters = 0,0).

```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [27.1905, 60.5710] },
  "properties": {
    "role": "northeast",
    "localXM": 0,
    "localYM": 0
  }
}
```

### 6.7 Map notes (`mapNotes`)

```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [27.1882, 60.5699] },
  "properties": {
    "text": "Clock tower ~27 m (NLS laser + OSM part)",
    "color": "#db6921",
    "icon": "NOTICE_OUTLINE"
  }
}
```

### 6.8 Aerial (`aerial`)

```json
{
  "url": "https://api.openclutter.com/v1/sites/{id}/aerial.jpg",
  "contentType": "image/jpeg",
  "widthPx": 2048,
  "heightPx": 2016,
  "bbox": { "west": 27.1860, "south": 60.5688, "east": 27.1905, "north": 60.5710 },
  "crs": "EPSG:4326",
  "metersPerPixelX": 0.12,
  "metersPerPixelY": 0.12,
  "provider": "esri-world-imagery",
  "licence": {
    "commercialUseAllowed": false,
    "note": "Esri World Imagery needs a commercial licence inside a paid product. Flag is false until a licensed source is configured for this key."
  },
  "attribution": "Esri, Maxar, Earthstar Geographics, and the GIS User Community"
}
```

Binary download: `GET /v1/sites/{id}/aerial` (same auth). Licence flag must be checked before shipping imagery into a paid Hamina cloud.

### 6.9 Provenance and stats

```json
{
  "provenance": {
    "sources": [
      {
        "id": "osm",
        "role": "buildings-parts-poles",
        "licence": "ODbL",
        "attribution": "© OpenStreetMap contributors",
        "commercialUseAllowed": true
      },
      {
        "id": "ms-global",
        "role": "building-footprints",
        "licence": "ODbL",
        "attribution": "© Microsoft",
        "commercialUseAllowed": true
      },
      {
        "id": "overture",
        "role": "building-footprints-heights",
        "licence": "CDLA Permissive 2.0",
        "attribution": "Overture Maps Foundation",
        "commercialUseAllowed": true
      },
      {
        "id": "nls-laser",
        "role": "building-heights-finland",
        "licence": "NLS open",
        "attribution": "National Land Survey of Finland",
        "commercialUseAllowed": true
      },
      {
        "id": "meta-chm",
        "role": "canopy-height",
        "licence": "CC BY 4.0",
        "attribution": "Meta / WRI canopy height",
        "commercialUseAllowed": true
      },
      {
        "id": "usgs-3dep",
        "role": "terrain-us",
        "licence": "public-domain",
        "attribution": "USGS 3DEP",
        "commercialUseAllowed": true,
        "verticalDatum": "NAVD88"
      },
      {
        "id": "copernicus-glo30",
        "role": "terrain-fallback",
        "licence": "Copernicus",
        "attribution": "Copernicus DEM GLO-30",
        "commercialUseAllowed": true,
        "verticalDatum": "EGM2008"
      },
      {
        "id": "esri-world-imagery",
        "role": "aerial",
        "licence": "Esri proprietary",
        "attribution": "Esri World Imagery",
        "commercialUseAllowed": false
      }
    ]
  },
  "stats": {
    "buildings": 42,
    "buildingParts": 11,
    "trees": 118,
    "discreteTrees": 96,
    "poles": 9,
    "water": 1,
    "parking": 3,
    "walls": 14,
    "terrainCells": 2304,
    "areaM2": 60680,
    "timingsMs": { "total": 82000, "buildings": 12000, "trees": 41000 }
  }
}
```

---

## 7. Error model

All errors:

```json
{
  "error": {
    "code": "area_too_large",
    "message": "Each side must be at most 10 km.",
    "requestId": "req_..."
  }
}
```

| HTTP | `code` examples |
| --- | --- |
| 400 | `invalid_geometry`, `bbox_required`, `area_too_small`, `area_too_large` |
| 401 | `unauthorized` |
| 403 | `forbidden`, `licence_blocked` |
| 404 | `job_not_found` |
| 409 | `job_not_ready`, `job_failed` |
| 410 | `job_expired` |
| 413 | `result_too_large` (use paging / tiles) |
| 429 | `rate_limited` |
| 500 / 503 | `internal`, `upstream_unavailable` |

---

## 8. Rate limits

| Tier | Create jobs | Poll status | Result download |
| --- | --- | --- | --- |
| test | 10 / hour | 120 / min | 30 / hour |
| live (default) | 60 / hour | 300 / min | 120 / hour |

Headers on every response:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 41
X-RateLimit-Reset: 1697550000
```

Heavy draws may also count against a monthly export budget on the key.

---

## 9. Example: Hamina town hall (snippet)

Illustrative only (coordinates rounded). Matches the v1.1.209+ tower behavior: hall slab, clock tower walls, dome cap from NLS laser + OSM `building:part` / `roof:shape=dome`.

```json
{
  "id": "job-hamina-demo",
  "name": "Hamina town square",
  "crs": "EPSG:4326",
  "buildings": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "id": "bldg-raatihuone",
        "geometry": {
          "type": "Polygon",
          "coordinates": [[
            [27.18795, 60.56972],
            [27.18855, 60.56972],
            [27.18855, 60.57008],
            [27.18795, 60.57008],
            [27.18795, 60.56972]
          ]]
        },
        "properties": {
          "kind": "building",
          "name": "Haminan raatihuone",
          "baseHeightM": 0,
          "topHeightM": 12.9,
          "heightSource": "nls-laser",
          "heightConfidence": 0.9,
          "geomSource": "osm",
          "material": {
            "name": "Building - 12.9",
            "attenuationDbPerMeter": 5.0,
            "frequencyGHz": 5,
            "displayColor": "#ABB1B7"
          },
          "tiers": [
            {
              "id": "mass",
              "role": "mass",
              "baseHeightM": 0,
              "topHeightM": 12.9,
              "buildingPart": false
            },
            {
              "id": "clock-tower",
              "role": "tower",
              "baseHeightM": 12.9,
              "topHeightM": 23.1,
              "buildingPart": true,
              "levelBaseM": 12.9,
              "floatSpan": true,
              "heightSource": "nls-laser"
            },
            {
              "id": "clock-dome",
              "role": "dome",
              "baseHeightM": 23.1,
              "topHeightM": 27.0,
              "buildingPart": true,
              "levelBaseM": 23.1,
              "roofShape": "dome",
              "heightSource": "nls-laser"
            }
          ]
        }
      }
    ]
  },
  "poles": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": { "type": "Point", "coordinates": [27.1874, 60.5696] },
        "properties": {
          "kind": "pole",
          "poleType": "lighting",
          "heightM": 9,
          "diameterM": 0.3,
          "material": {
            "name": "Light pole",
            "attenuationDbPerMeter": 10,
            "frequencyGHz": 5
          }
        }
      }
    ]
  },
  "gpsAnchors": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": { "type": "Point", "coordinates": [27.1860, 60.5688] },
        "properties": { "role": "southwest", "localXM": -248.1, "localYM": -244.6 }
      },
      {
        "type": "Feature",
        "geometry": { "type": "Point", "coordinates": [27.1905, 60.5710] },
        "properties": { "role": "northeast", "localXM": 0, "localYM": 0 }
      }
    ]
  },
  "aerial": {
    "provider": "esri-world-imagery",
    "licence": { "commercialUseAllowed": false }
  },
  "stats": { "buildings": 1, "buildingParts": 2, "poles": 1 }
}
```

---

## 10. Relationship to today's HTTP surface

| Today | v1 API |
| --- | --- |
| `POST /api/clutter` → zip / bundle | `POST /v1/sites` → job |
| `GET /api/export-status` | `GET /v1/sites/{id}` |
| `GET /api/export-file` (zip, one-shot) | `GET /v1/sites/{id}/result` (JSON, pageable) |
| `format: "terrain"` / clipboard paste | `terrain` object in result |
| No auth | API keys |
| CORS `*` for the web app | Locked to Hamina / server callers |

The OpenIntent zip path stays for the public site until Hamina cuts over.

---

## 11. Open questions for Hamina

1. **Ingest shape:** Prefer one FeatureCollection per layer (as drafted), or a single FeatureCollection with `properties.layer`?
2. **Heights:** Confirm meters above local ground (pipeline meaning) vs meters above a project floor / ellipsoid.
3. **Tiers:** Native multi-mass buildings (tower + dome) vs flattened list of separate building features?
4. **Trees:** Native crown+trunk objects vs two attenuating prisms (current OI workaround)?
5. **Poles:** Point + height + diameter enough for AP mounting, or need material / arm geometry?
6. **Terrain:** Regular grid of `z` samples vs open quads (current clipboard) vs both?
7. **Aerial:** Will Hamina bring its own licensed imagery, or need OpenClutter to supply a commercially licensed plate per key?
8. **Attenuation:** Keep OpenClutter's 5 GHz dB/m defaults, or return only material class and let Hamina assign RF?
9. **Webhooks vs poll-only** for the first integration?
10. **Auth:** Hamina-managed service account keys, or per-customer keys issued inside Hamina?
11. **SLA / region:** US-only Fly worker today; EU data residency needed for Finnish sites?
12. **Polygon fidelity:** Clip features to the true polygon hole, or keep today's bbox frame of the draw?

---

## 12. Files

- Readable spec: this document
- Machine-readable: `openclutter-api-v1.yaml` (OpenAPI 3.1)

---

## 13. Prototype (v1.1.221 on /dev)

What runs today, and where it differs from sections 1-11. Where they disagree, this section describes the deployed behavior.

### 13.1 Routing and auth

- `GET /v1/health` (no key), `POST /v1/sites`, `GET /v1/sites/{id}`, `GET /v1/sites/{id}/result`.
- Netlify function `api-v1` behind the `/v1/*` rewrite on the dev branch deploy. The build runs through the same background export as the web page (`clutter-export-background`, then the Fly worker `openclutter-export`), with `format: "site-v1"`. No OpenIntent zip is stored or returned.
- Key: `Authorization: Bearer oc_test_...` or `X-OpenClutter-Key`. The function compares the SHA-256 of the key with `OPENCLUTTER_API_KEY_HASHES` (comma list, Netlify secret, branch-deploy context). The key itself is not stored on Netlify or Fly and is never forwarded to the export job. Only `oc_test_` keys exist; there is no scope/revocation list yet, so `403` is not used.
- A job created through the web page is not visible through `/v1` (404), and `/v1` jobs carry `api: "v1"`.

### 13.2 POST /v1/sites

- `geometry` (Polygon, MultiPolygon, or a Feature wrapping one) or `bbox`. The engine builds the axis-aligned frame of the geometry; features are not clipped to the polygon outline yet.
- Sides must be within the export limits (about 15 km max per side; the error text names the limit).
- Supported `options`: `includeFoliage` (default true), `includePoles` (true), `includeParking` (true), `includeWalls` (true), `includeWater` (false), `includeVehicles` (false, RVs and cars), `includeTerrain` (true), `includeMapNotes` (true), `terrainResolution`, `imageryQuality`, `lidarHeights` (false; dev-only lidar building heights).
- Not implemented yet: `webhookUrl` / `webhookSecret`, `includeAerial`, `includeGpsAnchors` (always returned), `attenuationFrequencyGHz` (always 5).
- `?wait=N` (or `options.waitSeconds`, max 20) keeps the request open and returns `200` with the full result if the job finishes in time. In practice even a 100 m box takes 25-40 s (Fly start plus the pipeline), so expect `202` and poll.
- `202` body is the status document below, plus a `Location` header.

### 13.3 GET /v1/sites/{id}

Fields: `id, apiVersion, engineVersion, status, stage, createdAt, updatedAt, expiresAt, warnings, error, statusUrl, resultUrl`, and when finished `statsPreview {buildings, trees, poles, terrainCells}`, `resultBytes`, `elapsedMs`. `progress` / `percent` are not returned yet.

### 13.4 GET /v1/sites/{id}/result

- `collections` accepts `buildings,trees,poles,water,parking,walls,vehicles,other,terrain,gpsAnchors,mapNotes,aerial,provenance`. `vehicles` (rv, car, semi, boat, trailer) and `other` (guideway, bridge, storage, unpaired trunk) are new.
- `page` / `pageSize` page every FeatureCollection independently. `paging` is `{page, pageSize, totalPages, totals: {collection: count}, next}`. `tile` and `bbox` clips are not implemented.
- A body above about 5.5 MB answers `413 result_too_large`; ask for fewer collections or a smaller page.
- Top-level extras: `heightDatum` (text), `timings` (engine stage clock).

**Buildings.** One feature per extruded mass the export emits, not one feature with nested `tiers`. Masses on the same footprint share `buildingId`; the lowest has `tier: "mass"`, the rest `tier: "part"` with `buildingPart: true`. Also `heightM` (top minus base), `footprintAreaM2`, `materialClass` (`building` or `podium`). `roofHeightM` / `roofDirectionDeg` are not returned.

**Heights.** With terrain on, `baseHeightM` / `topHeightM` (and tree `crownBaseM` / `crownTopM`) are meters above the lowest terrain sample in the frame (`terrain.minZ`), exactly as the export seats them on the slope. Every feature also has `groundOffsetM`: the terrain under its centroid above that same datum (nearest grid node). Height above local ground is `topHeightM - groundOffsetM`. With terrain off they are above local ground.

**Trees.** Crown polygon from the export (lidar / CHM crowns after splitting). `stem` is the trunk centroid when the export drew a trunk, else the crown centroid. `trunkHeightM`, `trunkDiameterM`, `materialTrunk` are filled when a trunk prism sits inside the crown. `crownRadiusM` and `crownAreaM2` are derived from the polygon. `foliageClass` is `heavy`, `light`, or `understory` (stands). `speciesClass` is `palm` only when the material says so, else `unknown`; `heightSource` / `heightConfidence` are not returned for trees yet. The API keeps up to 3x the zip's crown cap (max 3600 crowns) because there is no OpenIntent size limit; the export's area cap still applies.

**Poles.** Point at the pole centroid, `heightM`, `diameterM` from the drawn footprint, `baseHeightM`, `topHeightM`, `poleType: "lighting"`. `explicitHeight` is not returned.

**Terrain.** `representation: "grid"`, `cols`, `rows`, `cellSizeM`, `lons` (west to east), `lats` (north to south), and `z` as `rows` arrays of `cols` elevations (null for a missing node), instead of a `samples` object list. `west/south/east/north` are not repeated (see `frame`). `quads` is not returned. `verticalDatum` is `NAVD88` for 3DEP and `EGM2008` for Copernicus GLO-30.

**Map notes.** Same notes as the paste, as Points with `text`, `color`, `icon`.

**Aerial.** Metadata only: `bbox`, `widthPx`, `heightPx`, provider, licence flag (`commercialUseAllowed: false`), `url: null`. `GET /v1/sites/{id}/aerial` is not implemented.

### 13.5 Rate limits

Per key, fixed windows, best effort (counter in Netlify Blobs, not atomic): create 60/hour, status 300/minute, result 120/hour. `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on every authenticated response; `429 rate_limited` with `Retry-After` past the limit. There is no monthly budget yet.

### 13.6 Errors implemented

`400 invalid_json, invalid_geometry, bbox_required, area_too_large, area_too_small, invalid_collections`; `401 unauthorized`; `404 job_not_found, not_found`; `405 method_not_allowed`; `409 job_not_ready, job_failed`; `410 job_expired`; `413 result_too_large`; `429 rate_limited`; `503 upstream_unavailable`.

### 13.7 Measured on dev (v1.1.221)

| Draw | Area | Time to succeeded | Full result | gzip | Counts |
| --- | --- | --- | --- | --- | --- |
| Las Vegas, Sphere block (-115.1655, 36.1205, -115.1625, 36.1225) | 0.06 km2 | 37 s | 139 KB | 18 KB | 18 building masses, 124 crowns, 594 terrain cells, 7 notes |
| Hamina centre (27.1915, 60.5665, 27.2045, 60.573) | 1.03 km2 | 51 s | 788 KB | 85 KB | 468 building masses (399 NLS laser heights), 2435 crowns + 76 stands, 57 walls, 576 terrain cells |
