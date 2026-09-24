"use strict";

/**
 * FEMA / Oak Ridge USA Structures (Living Atlas).
 *
 * MSBFP2 and the July/August 2026 Global ML quadkey both miss large roofs
 * inside the Oak Creek corridor. This layer has some of those polygons
 * (ORNL / NGA). An envelope query that returns geometry times out on this
 * service, so the fetch is object ids first, then geometry by id.
 * Callers merge these only when the centroid is not already inside a
 * Microsoft footprint. OSM building ways are not read.
 */

const LAYER =
  "https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/USA_Structures_View/FeatureServer/0/query";

const ID_CAP = 500;
const CHUNK = 50;
const POOL = 4;

function usableHeight(attrs) {
  const h = Number(attrs && attrs.HEIGHT);
  return h > 2 && h < 400 ? h : 0;
}

/** Esri polygon: first ring is the exterior, later rings are holes. */
function esriFeaturesToGeojson(features) {
  const out = [];
  const list = Array.isArray(features) ? features : [];
  for (let i = 0; i < list.length; i++) {
    const rings = list[i] && list[i].geometry && list[i].geometry.rings;
    if (!rings || !rings[0] || rings[0].length < 4) continue;
    const height = usableHeight(list[i].attributes);
    const properties = { geomSource: "usa" };
    if (height) {
      properties.height = height;
      properties.heightSource = "fema";
    }
    out.push({
      type: "Feature",
      properties,
      geometry: { type: "Polygon", coordinates: [rings[0]] },
    });
  }
  return out;
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  return /abort|timeout/i.test(String(err.message || err));
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(limit, items.length);
  const jobs = [];
  for (let i = 0; i < n; i++) jobs.push(worker());
  await Promise.all(jobs);
  return out;
}

async function fetchUsaStructures(frame, fetchFn) {
  const geometry = [frame.west, frame.south, frame.east, frame.north].join(",");
  const idUrl =
    LAYER +
    "?" +
    new URLSearchParams({
      where: "1=1",
      geometry,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      returnIdsOnly: "true",
      f: "json",
    });
  const idRes = await fetchFn(idUrl);
  if (!idRes || idRes.ok === false) {
    throw new Error("usa structures ids HTTP " + (idRes && idRes.status));
  }
  const idJson = await idRes.json();
  if (idJson && idJson.error) {
    throw new Error("usa structures " + (idJson.error.message || "ids"));
  }
  const ids = (idJson.objectIds || []).slice(0, ID_CAP);
  if (!ids.length) return { features: [], partial: false };
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  let partial = false;
  const parts = await mapPool(chunks, POOL, async (chunk) => {
    const url =
      LAYER +
      "?" +
      new URLSearchParams({
        objectIds: chunk.join(","),
        outFields: "HEIGHT",
        outSR: "4326",
        returnGeometry: "true",
        f: "json",
      });
    try {
      const res = await fetchFn(url);
      if (!res || res.ok === false) {
        throw new Error("usa structures HTTP " + (res && res.status));
      }
      const body = await res.json();
      if (body && body.error) {
        throw new Error("usa structures " + (body.error.message || "query"));
      }
      return esriFeaturesToGeojson(body.features);
    } catch (e) {
      if (isAbortError(e)) {
        partial = true;
        return [];
      }
      throw e;
    }
  });
  const features = [];
  for (const part of parts) {
    for (const feature of part || []) features.push(feature);
  }
  return { features, partial };
}

module.exports = {
  LAYER,
  ID_CAP,
  esriFeaturesToGeojson,
  fetchUsaStructures,
};
