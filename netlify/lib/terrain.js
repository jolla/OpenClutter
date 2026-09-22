"use strict";

/**
 * USGS 3DEP bare-earth DEM → a second HaminaClipboard JSON.
 * OpenIntent has no raisedFloorZones / slopedFloors. This file is paste-only
 * for Planner Plus and is not the OpenIntent import.
 *
 * Clipboard meters match hamina-clipboard.js: NE is (0, 0), SW is
 * (−widthM, −lengthM). z on sloped floors is meters above the lowest sample.
 * The DEM is simplified to a 2×2 or 3×3 lattice (at most 18 facets).
 */

const { llToClipboard } = require("./geo-frame");
const { emptyClipboard } = require("./hamina-clipboard");

const DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples";
const FLAT_M = 0.5;
const SAMPLE_COUNT = 36;

function idw(samples, lon, lat) {
  let wsum = 0;
  let zsum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const dx = s.lon - lon;
    const dy = s.lat - lat;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-18) return s.z;
    const w = 1 / d2;
    wsum += w;
    zsum += s.z * w;
  }
  return wsum ? zsum / wsum : samples[0].z;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function closeRing(ring) {
  const out = ring.map((p) => p.slice());
  const a = out[0];
  const b = out[out.length - 1];
  const same = a.length === b.length && a.every((v, i) => v === b[i]);
  if (!same) out.push(a.slice());
  return out;
}

function chooseGrid(relief) {
  if (relief < 1) return [2, 2];
  if (relief < 4) return [3, 2];
  return [3, 3];
}

function lattice(samples, frame, cols, rows) {
  const nodes = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const lon = frame.west + (c / cols) * (frame.east - frame.west);
      const lat = frame.south + (r / rows) * (frame.north - frame.south);
      const z = idw(samples, lon, lat);
      const [x, y] = llToClipboard(lon, lat, frame);
      nodes.push({ x: round3(x), y: round3(y), z });
    }
  }
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const n of nodes) {
    if (n.z < minZ) minZ = n.z;
    if (n.z > maxZ) maxZ = n.z;
  }
  for (const n of nodes) n.zRel = round1(n.z - minZ);
  return { nodes, cols, rows, minZ, maxZ, relief: maxZ - minZ };
}

function at(grid, c, r) {
  return grid.nodes[r * (grid.cols + 1) + c];
}

function xy(n) {
  return [n.x, n.y];
}

function xyz(n) {
  return [n.x, n.y, n.zRel];
}

function zoneArea(ring) {
  return { type: "Polygon", coordinates: [closeRing(ring)] };
}

/**
 * @param {{lon:number,lat:number,z:number}[]} samples
 * @param {object} frame geo frame with west/south/east/north and meter scale
 */
function terrainFromSamples(samples, frame) {
  const pts = (samples || []).filter(
    (s) => s && Number.isFinite(+s.lon) && Number.isFinite(+s.lat) && Number.isFinite(+s.z)
  );
  if (pts.length < 4 || !frame) return null;
  const clean = pts.map((s) => ({ lon: +s.lon, lat: +s.lat, z: +s.z }));
  let minS = Infinity;
  let maxS = -Infinity;
  for (const s of clean) {
    if (s.z < minS) minS = s.z;
    if (s.z > maxS) maxS = s.z;
  }
  const [cols, rows] = chooseGrid(maxS - minS);
  const grid = lattice(clean, frame, cols, rows);
  const raised = [];
  const sloped = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sw = at(grid, c, r);
      const se = at(grid, c + 1, r);
      const ne = at(grid, c + 1, r + 1);
      const nw = at(grid, c, r + 1);
      const zs = [sw.zRel, se.zRel, ne.zRel, nw.zRel];
      const z0 = Math.min(...zs);
      const z1 = Math.max(...zs);
      if (z1 - z0 < FLAT_M) {
        const height = round1((z0 + z1) / 2);
        raised.push({
          area: zoneArea([xy(sw), xy(se), xy(ne), xy(nw)]),
          height,
          attenuationDbPerMeter: 0,
          slabOnly: true,
        });
      } else {
        sloped.push({
          area: zoneArea([xyz(sw), xyz(se), xyz(ne)]),
          attenuationDbPerMeter: 0,
          crowdEnabled: false,
          drawStairs: false,
          slabOnly: true,
          crowdHeight: 0,
          crowdAttenuationDbPerMeter: 0,
        });
        sloped.push({
          area: zoneArea([xyz(sw), xyz(ne), xyz(nw)]),
          attenuationDbPerMeter: 0,
          crowdEnabled: false,
          drawStairs: false,
          slabOnly: true,
          crowdHeight: 0,
          crowdAttenuationDbPerMeter: 0,
        });
      }
    }
  }
  if (!raised.length && !sloped.length) return null;
  const clip = emptyClipboard();
  clip.raisedFloorZones = raised;
  clip.slopedFloors = sloped;
  clip.attenuatingZones = [];
  return {
    clipboard: clip,
    raised: raised.length,
    sloped: sloped.length,
    reliefM: Math.round((maxS - minS) * 10) / 10,
    minZ: Math.round(minS * 10) / 10,
    maxZ: Math.round(maxS * 10) / 10,
  };
}

function parseDemSamples(body) {
  const samples = body && Array.isArray(body.samples) ? body.samples : [];
  const out = [];
  for (let i = 0; i < samples.length; i++) {
    const row = samples[i];
    const loc = row && row.location;
    const z = Number(row && row.value);
    const lon = loc && +loc.x;
    const lat = loc && +loc.y;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(z)) continue;
    if (z < -500 || z > 9000) continue;
    out.push({ lon, lat, z });
  }
  return out;
}

async function fetchDemSamples(frame, fetchFn, opts) {
  const fetchImpl = fetchFn || fetch;
  const signal = (opts && opts.signal) || AbortSignal.timeout(2000);
  const geometry = JSON.stringify({
    xmin: +frame.west,
    ymin: +frame.south,
    xmax: +frame.east,
    ymax: +frame.north,
    spatialReference: { wkid: 4326 },
  });
  const url =
    DEM_URL +
    "?" +
    new URLSearchParams({
      geometry,
      geometryType: "esriGeometryEnvelope",
      sampleCount: String(SAMPLE_COUNT),
      interpolation: "RSP_BilinearInterpolation",
      f: "json",
    });
  const res = await fetchImpl(url, { signal });
  if (!res || res.ok === false) throw new Error("3DEP HTTP " + (res && res.status));
  const body = await res.json();
  if (body && body.error) throw new Error("3DEP " + (body.error.message || "query"));
  return parseDemSamples(body);
}

module.exports = {
  DEM_URL,
  FLAT_M,
  SAMPLE_COUNT,
  terrainFromSamples,
  parseDemSamples,
  fetchDemSamples,
  chooseGrid,
};
