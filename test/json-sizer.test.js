"use strict";

// 1.3.41: the byte-budget checks add cached per-area bytes to one stringify
// of the document shell. The sum must equal the full stringify, and the trim
// must keep the same chunks as the old full-stringify search.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame } = require("../netlify/lib/geo-frame");
const exportMode = require("../netlify/lib/export-mode");
const {
  buildOpenIntent,
  makeOpenIntentSizer,
  fitChunksToJsonBudget,
  overJsonBudget,
  thinTreeOutlines,
} = require("../netlify/lib/pipeline");

function ring(pts) {
  const c = pts.map(([x, y]) => ({ coordinate_xyz: { x, y, unit: "pixels" } }));
  c.push({ coordinate_xyz: { x: pts[0][0], y: pts[0][1], unit: "pixels" } });
  return { coordinates: c };
}

let seed = 7;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function crown(cx, cy, r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rr = r * (0.8 + rnd() * 0.4);
    pts.push([cx + Math.cos(t) * rr, cy + Math.sin(t) * rr]);
  }
  return pts;
}

function makeChunks() {
  const chunks = [];
  for (let i = 0; i < 12; i++) {
    chunks.push({
      role: "building",
      areas: [
        {
          area: ring([[i * 50, 10], [i * 50 + 40, 10], [i * 50 + 40, 50], [i * 50, 50]]),
          area_material: { name: "Building - " + (4 + i) + ".0 Åbo", rf_properties: { attenuation_per_m: 5 }, top_height: 4 + i },
        },
      ],
    });
  }
  for (let i = 0; i < 6; i++) {
    chunks.push({
      role: "outdoor",
      kind: "rv",
      areas: [
        {
          area: ring([[10 + i * 60, 100], [50 + i * 60, 106], [48 + i * 60, 118], [8 + i * 60, 112]]),
          area_material: { name: "RV 3.5", rf_properties: { attenuation_per_m: 9 }, top_height: 3.5, display_color: "#8A9098" },
        },
      ],
    });
  }
  for (let i = 0; i < 300; i++) {
    const cx = 40 + (i % 20) * 30;
    const cy = 200 + Math.floor(i / 20) * 30;
    const areas = [
      {
        area: ring(crown(cx, cy, 12, 24 + (i % 9))),
        area_material: { name: "Foliage - medium " + (6 + (i % 5)) + ".0", rf_properties: { attenuation_per_m: 0.4 }, top_height: 6 + (i % 5), bottom_height: 2 },
      },
    ];
    if (i % 3 === 0) {
      areas.push({
        area: ring([[cx - 1, cy - 1], [cx + 1, cy - 1], [cx + 1, cy + 1], [cx - 1, cy + 1]]),
        area_material: { name: "Tree trunk", rf_properties: { attenuation_per_m: 3 }, top_height: 2 },
      });
    }
    chunks.push({ role: "tree", areas });
  }
  return chunks;
}

function flatten(chunks) {
  const out = [];
  for (const c of chunks) for (const a of c.areas) out.push(a);
  return out;
}

describe("OpenIntent byte sizer", () => {
  const frame = geoFrame({ west: -89.7, south: 44.91, east: -89.69, north: 44.92, name: "Sizer" });
  afterEach(() => {
    exportMode.setRvShell(false);
  });

  for (const shell of [false, true]) {
    it("equals the full stringify " + (shell ? "with" : "without") + " RV shells", () => {
      exportMode.setRvShell(shell);
      const chunks = makeChunks();
      const flat = flatten(chunks);
      const sizer = makeOpenIntentSizer();
      for (const n of [0, 1, 5, 13, 18, 19, 40, 200, flat.length]) {
        const oi = buildOpenIntent(frame, "Sizer Ä", "map.jpg", flat.slice(0, n));
        assert.equal(sizer(oi), Buffer.byteLength(JSON.stringify(oi)), "n=" + n);
      }
      // A thinned crown replaces area.area; the cached bytes must follow.
      const trees = chunks.filter((c) => c.role === "tree");
      assert.ok(thinTreeOutlines(trees, 2.5) > 0);
      const oi = buildOpenIntent(frame, "Sizer Ä", "map.jpg", flat);
      assert.equal(sizer(oi), Buffer.byteLength(JSON.stringify(oi)));
    });

    it("keeps the same chunks as the full search " + (shell ? "with" : "without") + " RV shells", () => {
      exportMode.setRvShell(shell);
      const chunks = makeChunks();
      const full = Buffer.byteLength(JSON.stringify(buildOpenIntent(frame, "Sizer", "map.jpg", flatten(chunks))));
      for (const budget of [1000, Math.round(full * 0.1), Math.round(full * 0.55), full - 1, full, full + 100]) {
        const sizer = makeOpenIntentSizer();
        const a = fitChunksToJsonBudget(frame, "Sizer", "map.jpg", chunks, budget);
        const b = fitChunksToJsonBudget(frame, "Sizer", "map.jpg", chunks, budget, sizer);
        assert.equal(b.chunks.length, a.chunks.length, "budget " + budget);
        assert.equal(b.areas.length, a.areas.length);
        assert.equal(b.trimmed, a.trimmed);
        assert.ok(Math.abs(b.bytes - a.bytes) <= 0, "bytes " + a.bytes + " vs " + b.bytes);
        assert.equal(
          overJsonBudget(frame, "Sizer", "map.jpg", chunks, budget, sizer),
          overJsonBudget(frame, "Sizer", "map.jpg", chunks, budget)
        );
      }
    });
  }
});
