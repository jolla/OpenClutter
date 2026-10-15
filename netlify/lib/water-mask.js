"use strict";

/**
 * Water has no canopy. Dark open water reads as a dark conifer stand on the
 * aerial, and the canopy height model sometimes carries noise over a harbor,
 * so crowns used to stand out on the bay. This mask clears canopy cells and
 * tree points that sit inside water.
 *
 * Water is ESA WorldCover class 80 (lakes, rivers, and the sea, so a coast
 * with no OSM polygon is covered) or an OSM water polygon (natural=water,
 * water=*, waterway=riverbank, landuse=reservoir, harbour and basin tags).
 * A point counts only when its neighbors a few metres away are water too, so
 * a crown on the shoreline, a pier, or an island stays. OSM inner rings are
 * islands and stay land.
 */

const { WATER } = require("./worldcover");

// WorldCover is a 10 m grid. Every probe this far out must also read water.
const COVER_PROBE_M = 12;
// OSM outlines are drawn on the bank. A crown overhanging it keeps its cell.
const OSM_PROBE_M = 6;

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function polyBox(rings) {
  const outer = rings[0];
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (let i = 0; i < outer.length; i++) {
    const p = outer[i];
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return { w, s, e, n };
}

/**
 * @param {{worldcover?:{sample:Function}|null, waterPolygons?:Array<Array<Array<[number,number]>>>}} opts
 * waterPolygons are [outer, ...inner] rings in lon/lat.
 * @returns {null|((lon:number, lat:number) => boolean)}
 */
function createWaterTest(opts) {
  const cover = opts && opts.worldcover && typeof opts.worldcover.sample === "function" ? opts.worldcover : null;
  const polys = [];
  const list = (opts && opts.waterPolygons) || [];
  for (let i = 0; i < list.length; i++) {
    const rings = list[i];
    if (!Array.isArray(rings) || !rings[0] || rings[0].length < 4) continue;
    polys.push({ rings, box: polyBox(rings) });
  }
  if (!cover && !polys.length) return null;

  function inPolys(lon, lat) {
    for (let i = 0; i < polys.length; i++) {
      const b = polys[i].box;
      if (lon < b.w || lon > b.e || lat < b.s || lat > b.n) continue;
      const rings = polys[i].rings;
      if (!pointInRing(lon, lat, rings[0])) continue;
      let hole = false;
      for (let r = 1; r < rings.length; r++) {
        if (rings[r] && rings[r].length >= 4 && pointInRing(lon, lat, rings[r])) {
          hole = true;
          break;
        }
      }
      if (!hole) return true;
    }
    return false;
  }
  function coverWater(lon, lat) {
    return cover.sample(lon, lat) === WATER;
  }

  return function isWater(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    const mx = 111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const my = 110540;
    if (cover && coverWater(lon, lat)) {
      const dx = COVER_PROBE_M / mx;
      const dy = COVER_PROBE_M / my;
      if (
        coverWater(lon + dx, lat) &&
        coverWater(lon - dx, lat) &&
        coverWater(lon, lat + dy) &&
        coverWater(lon, lat - dy)
      ) {
        return true;
      }
    }
    if (polys.length && inPolys(lon, lat)) {
      const dx = OSM_PROBE_M / mx;
      const dy = OSM_PROBE_M / my;
      if (inPolys(lon + dx, lat) && inPolys(lon - dx, lat) && inPolys(lon, lat + dy) && inPolys(lon, lat - dy)) {
        return true;
      }
    }
    return false;
  };
}

/** Zero canopy cells over water. Returns the number of cells cleared. */
function clearWaterCanopy(grid, isWater) {
  if (!grid || !isWater || !grid.values) return 0;
  const w = grid.width | 0;
  const h = grid.height | 0;
  if (w < 1 || h < 1) return 0;
  if (typeof grid.values === "string") grid.values = Buffer.from(grid.values, "base64");
  const values = grid.values;
  const dLon = +grid.east - +grid.west || 1e-9;
  const dLat = +grid.north - +grid.south || 1e-9;
  let cleared = 0;
  for (let y = 0; y < h; y++) {
    const lat = +grid.north - ((y + 0.5) / h) * dLat;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!(values[i] > 0)) continue;
      const lon = +grid.west + ((x + 0.5) / w) * dLon;
      if (isWater(lon, lat)) {
        values[i] = 0;
        cleared++;
      }
    }
  }
  return cleared;
}

/** Drop points ({lon,lat} or [lon,lat]) that sit in water. */
function dropWaterPoints(points, isWater) {
  if (!isWater || !Array.isArray(points) || !points.length) return { points: points || [], dropped: 0 };
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const lon = Array.isArray(p) ? +p[0] : p ? +p.lon : NaN;
    const lat = Array.isArray(p) ? +p[1] : p ? +p.lat : NaN;
    if (Number.isFinite(lon) && Number.isFinite(lat) && isWater(lon, lat)) continue;
    out.push(p);
  }
  return { points: out, dropped: points.length - out.length };
}

module.exports = { createWaterTest, clearWaterCanopy, dropWaterPoints, COVER_PROBE_M, OSM_PROBE_M };
