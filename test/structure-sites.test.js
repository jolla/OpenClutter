"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jpeg = require("jpeg-js");
const { geoFrame, lockIsotropicImagery, llToPx } = require("../netlify/lib/geo-frame");
const { rejectPavementFootprints } = require("../netlify/lib/pavement");
const { footprintsToClutter } = require("../netlify/lib/pipeline");
const { parseBuildingDetail, shapeBuildings } = require("../netlify/lib/building-shape");
const { semisAtDocks, yardInsideFootprint } = require("../netlify/lib/vehicle-track");

const dir = path.join(__dirname, "fixtures/structure-sites");
const sites = JSON.parse(fs.readFileSync(path.join(dir, "sites.json"), "utf8"));

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const hit = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function edgeMeters(pt, ring) {
  const mLon = 111320 * Math.cos((pt[1] * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const ax = ring[i][0] * mLon;
    const ay = ring[i][1] * 110540;
    const bx = ring[i + 1][0] * mLon;
    const by = ring[i + 1][1] * 110540;
    const px = pt[0] * mLon;
    const py = pt[1] * 110540;
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy || 1;
    let t = ((px - ax) * vx + (py - ay) * vy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const d = Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
    if (d < best) best = d;
  }
  return best;
}

function centroid(ring) {
  let n = ring.length;
  if (ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n--;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return [sx / n, sy / n];
}

function exportSite(site) {
  const buf = fs.readFileSync(path.join(dir, site.id + ".jpg"));
  const frame0 = geoFrame(Object.assign({ name: site.place }, site.bbox), { maxSpanM: 20000, metersPerPx: 1, maxSide: 1040 });
  const locked = lockIsotropicImagery(frame0, buf, { maxSide: 1040 });
  const frame = locked.frame;
  const raw = jpeg.decode(locked.jpegBuf, { useTArray: true, maxResolutionInMP: 20, formatAsRGBA: true });
  const plate = { data: raw.data, width: raw.width, height: raw.height };
  const props = { geomSource: "overture" };
  const levels = Number(site.tags.levels);
  if (levels >= 2) props.numFloors = levels;
  const feature = {
    type: "Feature",
    properties: props,
    geometry: { type: "Polygon", coordinates: [site.ring] },
  };
  const paved = rejectPavementFootprints(plate, frame, [feature]);
  const tags = {
    name: site.tags.name,
    building: site.tags.building,
    parking: site.tags.parking,
  };
  if (site.tags.levels) tags["building:levels"] = String(site.tags.levels);
  const el = {
    type: "way",
    id: site.osmId,
    tags,
    geometry: site.ring.map(([lon, lat]) => ({ lon, lat })),
  };
  const detail = parseBuildingDetail({ elements: [el] }, site.bbox);
  const shaped = shapeBuildings(paved.features, {
    parts: detail.parts,
    openings: detail.openings,
    buildings: detail.buildings,
    structures: detail.structures,
    imagery: { data: plate.data, width: plate.width, height: plate.height, frame },
  });
  const built = footprintsToClutter(shaped.features, frame, null);
  const c = centroid(site.ring);
  const px = llToPx(c[0], c[1], frame);
  let material = null;
  for (let i = 0; i < built.overlayRings.length; i++) {
    if (!pointInRing(px, built.overlayRings[i])) continue;
    const mat = built.oiAreas[i] && built.oiAreas[i].area_material;
    if (!mat || !String(mat.name || "").startsWith("Building")) continue;
    material = mat;
    break;
  }
  const trailers = site.kind === "warehouse" ? semisAtDocks([site.ring], frame, plate, [site.ring]) : [];
  return { paved, shaped, built, material, trailers, frame, plate };
}

describe("deck and warehouse rules on other US sites", () => {
  assert.equal(sites.length, 10);

  for (const site of sites) {
    it(site.place + " stays a building", () => {
      const out = exportSite(site);
      assert.equal(out.built.stats.droppedMega, 0, site.id + " dropped as a campus blob");
      assert.ok(out.built.stats.buildings >= 1, site.id + " buildings " + out.built.stats.buildings);
      assert.ok(out.built.stats.buildings <= 4, site.id + " split into " + out.built.stats.buildings);
      assert.ok(out.material, site.id + " centroid is not in a building");
      assert.equal(out.material.rf_properties.attenuation_per_m, 5);
      const top = Number(out.material.top_height);
      if (site.height === 15) {
        assert.ok(top >= 14.5 && top <= 15.5, site.id + " top " + top);
      } else {
        assert.equal(top, site.height, site.id + " " + out.material.name);
      }
      assert.ok(top >= 8 && top <= 40, site.id + " height " + top);
      if (site.trailers === "n/a") return;
      if (site.trailers === "no") {
        assert.equal(out.trailers.length, 0, site.id + " lit empty pavement");
        return;
      }
      assert.ok(out.trailers.length >= 1, site.id + " trailers " + out.trailers.length);
      assert.ok(out.trailers.length <= 40, site.id + " trailer carpet " + out.trailers.length);
      const yardRecall = {
        "amazon-ind5": 10,
        "walmart-tx": 12,
        "amazon-ont9": 5,
        "walmart-pa": 10,
      };
      if (yardRecall[site.id]) {
        assert.ok(
          out.trailers.length >= yardRecall[site.id],
          site.id + " yard recall " + out.trailers.length
        );
      }
      const yard = yardInsideFootprint(site.ring, out.frame, out.plate);
      for (const trailer of out.trailers) {
        assert.equal(trailer.heightM, 4.1);
        if (!trailer.center || !pointInRing(trailer.center, site.ring)) continue;
        const inside = edgeMeters(trailer.center, site.ring);
        if (inside <= 8) continue;
        const x = ((trailer.center[0] - out.frame.west) / (out.frame.east - out.frame.west)) * out.frame.imgW;
        const y = ((out.frame.north - trailer.center[1]) / (out.frame.north - out.frame.south)) * out.frame.imgH;
        assert.ok(yard.allow && yard.allow(x, y), site.id + " trailer " + inside.toFixed(1) + " m inside the roof");
      }
    });
  }
});
