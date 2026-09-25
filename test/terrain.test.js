"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geoFrame, cornerClipboard } = require("../netlify/lib/geo-frame");
const {
  terrainFromSamples,
  parseDemSamples,
  terrainBundleFields,
  noteMissingTerrain,
  chooseGrid,
  fetchDemSamples,
  fetchTerrainDem,
  isDevDemHost,
  frameHas3dep,
  DEP3_PROBE_SAMPLES,
  GLO30_CREDIT,
  normalizeTerrainResolution,
  RAISED_KEYS,
  SLOPED_KEYS,
  TERRAIN_FILENAME,
  MAX_GRID,
  TARGET_CELL_M,
  SAMPLE_COUNT,
  TERRAIN_RESOLUTIONS,
  PASTE_SOFT_GRID,
  ABSOLUTE_MAX_GRID,
  ABSOLUTE_MAX_SAMPLES,
  PASTE_BUILD_MAX_QUADS,
  TERRAIN_PASTE_JSON_MAX,
  LAMBDA_SYNC_PAYLOAD_MAX,
  EXPORT_PAYLOAD_BUDGET,
  estimateBundlePayload,
  maxPasteJsonForCompanion,
  MIN_CELL_M,
  terrainResolutionNotes,
  fitPasteAxes,
  LIFT_RELIEF_M,
  siteWarrantsLift,
  demUnderFootprint,
  slopeTopUnderRing,
  pasteableQuad,
  slopedRing,
} = require("../netlify/lib/terrain");
const { buildClutter } = require("../netlify/lib/pipeline");
const { unzipStore } = require("../netlify/lib/zip-store");
const { canopyHitsGrid } = require("./canopy-grid");
const pasteSample = require("./fixtures/hamina-raised-sloped-clipboard-sample.json");

function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Jerry's working Planner Plus paste: open convex CCW quads, not closed GeoJSON rings. */
function assertOpenQuad(ring, dim) {
  assert.equal(ring.length, 4);
  for (let i = 0; i < 4; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % 4];
    assert.equal(p.length, dim);
    assert.ok(p[0] !== q[0] || p[1] !== q[1]);
    const r = ring[(i + 2) % 4];
    const cross = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
    assert.ok(cross > 0, "convex CCW corner");
  }
  assert.ok(signedArea(ring) > 0);
}

/** Sloped floors are ramps: first edge one z, opposite edge a higher z. */
function assertSlopedRamp(ring) {
  assertOpenQuad(ring, 3);
  assert.equal(ring[0][2], ring[1][2]);
  assert.equal(ring[2][2], ring[3][2]);
  assert.ok(ring[2][2] > ring[0][2]);
  for (const p of ring) assert.ok(p[2] >= 0);
}

function gridSamples(frame, zAt) {
  const samples = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      const lon = frame.west + ((c + 0.5) / 6) * (frame.east - frame.west);
      const lat = frame.south + ((r + 0.5) / 6) * (frame.north - frame.south);
      samples.push({ lon, lat, z: zAt(r, c, lon, lat) });
    }
  }
  return samples;
}

function assertFrameSpan(zones, frame) {
  const corners = cornerClipboard(frame);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const z of zones) {
    for (const p of z.area.coordinates[0]) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  assert.ok(Math.abs(maxX - corners.ne[0]) < 0.05, "NE x " + maxX);
  assert.ok(Math.abs(maxY - corners.ne[1]) < 0.05, "NE y " + maxY);
  assert.ok(Math.abs(minX - corners.sw[0]) < 0.05, "SW x " + minX);
  assert.ok(Math.abs(minY - corners.sw[1]) < 0.05, "SW y " + minY);
}

describe("3DEP terrain clipboard", () => {
  it("turns a flat DEM into raisedFloorZones on the clipboard meter frame", () => {
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "Flat" });
    const terrain = terrainFromSamples(gridSamples(frame, () => 214.2), frame);
    assert.ok(terrain);
    assert.equal(terrain.sloped, 0);
    const [cols, rows] = chooseGrid(terrain.reliefM);
    assert.equal(terrain.raised, cols * rows);
    assert.ok(terrain.raised <= 4);
    assert.equal(terrain.reliefM, 0);
    assert.equal(terrain.clipboard.header.type, "HaminaClipboard");
    assert.equal(terrain.clipboard.attenuatingZones.length, 0);
    assert.equal(terrain.clipboard.slopedFloors.length, 0);
    for (const z of terrain.clipboard.raisedFloorZones) {
      assert.deepEqual(Object.keys(z), RAISED_KEYS);
      assert.equal(z.area.type, "Polygon");
      assert.equal(z.height, 0);
      assert.equal(z.attenuationDbPerMeter, 0);
      assert.equal(z.slabOnly, false);
      assertOpenQuad(z.area.coordinates[0], 2);
    }
    assertFrameSpan(terrain.clipboard.raisedFloorZones, frame);
    const fields = terrainBundleFields(terrain, []);
    assert.equal(fields.terrainFilename, TERRAIN_FILENAME);
    assert.equal(fields.terrainClipboard.raisedFloorZones.length, terrain.raised);
    assert.match(fields.terrainStatus, /Copy terrain/);
    assert.match(fields.terrainStatus, /paste it in Planner Plus/);
    assert.match(fields.terrainStatus, /Do not import it as OpenIntent/);
    assert.equal(/terrain-clipboard\.json/.test(fields.terrainStatus), false);
  });

  it("requests solid floors, not slab-only, on pads and sloped ramps", () => {
    assert.equal(pasteSample.raisedFloorZones[0].slabOnly, false);
    assert.equal(pasteSample.slopedFloors[0].slabOnly, false);
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "Solid" });
    const flat = terrainFromSamples(gridSamples(frame, () => 200), frame);
    const sloped = terrainFromSamples(gridSamples(frame, (r) => 180 + r * 8), frame);
    assert.ok(flat.clipboard.raisedFloorZones.length >= 1);
    assert.equal(flat.clipboard.slopedFloors.length, 0);
    for (const z of flat.clipboard.raisedFloorZones) assert.equal(z.slabOnly, false);
    assert.ok(sloped.clipboard.slopedFloors.length >= 1);
    for (const z of sloped.clipboard.slopedFloors) {
      assert.equal(z.slabOnly, false);
      assertSlopedRamp(z.area.coordinates[0]);
    }
    for (const z of sloped.clipboard.raisedFloorZones) assert.equal(z.slabOnly, false);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [],
      name: "Solid",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain: sloped,
    });
    const readme = unzipStore(built.zip)["README.txt"].toString();
    assert.match(readme, /slabOnly is false/);
    assert.match(readme, /solid floor/);
    const clip = JSON.parse(unzipStore(built.zip)["terrain-clipboard.json"].toString());
    const zones = clip.raisedFloorZones.concat(clip.slopedFloors);
    assert.ok(zones.length >= 1);
    assert.ok(zones.every((z) => z.slabOnly === false));
  });

  it("turns a sloped DEM into slopedFloors with xyz vertices", () => {
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "Slope" });
    const terrain = terrainFromSamples(
      gridSamples(frame, (r) => 180 + r * 4),
      frame
    );
    assert.ok(terrain);
    assert.ok(terrain.reliefM > 2);
    const [cols, rows] = chooseGrid(terrain.reliefM, frame);
    assert.equal(terrain.raised + terrain.sloped, cols * rows);
    assert.ok(terrain.sloped > 9);
    assert.ok(terrain.sloped <= ABSOLUTE_MAX_GRID * ABSOLUTE_MAX_GRID);
    for (const z of terrain.clipboard.slopedFloors) {
      assert.deepEqual(Object.keys(z), SLOPED_KEYS);
      assert.equal(z.area.type, "Polygon");
      assert.equal(z.attenuationDbPerMeter, 0);
      assert.equal(z.crowdEnabled, false);
      assert.equal(z.drawStairs, false);
      assert.equal(z.slabOnly, false);
      assert.equal(z.crowdHeight, 0);
      assert.equal(z.crowdAttenuationDbPerMeter, 0);
      assertSlopedRamp(z.area.coordinates[0]);
      const ring = z.area.coordinates[0];
      const lowY = Math.min(ring[0][1], ring[1][1]);
      const highY = Math.min(ring[2][1], ring[3][1]);
      assert.ok(lowY < highY, "north-rising slope starts on the south edge");
    }
    assertFrameSpan(terrain.clipboard.slopedFloors.concat(terrain.clipboard.raisedFloorZones), frame);
  });

  it("notes a soft miss without a terrain file", () => {
    const warnings = [];
    noteMissingTerrain(null, warnings);
    assert.match(warnings[0], /Terrain omitted/);
    noteMissingTerrain(null, warnings);
    assert.equal(warnings.length, 1);
    const fields = terrainBundleFields(null, ["Terrain omitted: timed out"]);
    assert.equal(fields.terrainFilename, null);
    assert.equal(fields.terrainClipboard, null);
    assert.match(fields.terrainStatus, /Terrain omitted: timed out/);
    assert.match(fields.terrainStatus, /OpenIntent zip is unchanged/);
  });

  it("turns a sloped sample grid into a few raised pads or xyz facets", () => {
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "Oak" });
    const samples = [];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        samples.push({
          lon: frame.west + ((c + 0.5) / 6) * (frame.east - frame.west),
          lat: frame.south + ((r + 0.5) / 6) * (frame.north - frame.south),
          z: 210 + r * 1.1 + c * 0.15,
        });
      }
    }
    const terrain = terrainFromSamples(samples, frame);
    assert.ok(terrain);
    assert.ok(terrain.reliefM > 2);
    assert.ok(terrain.sloped >= 1);
    const [mildCols, mildRows] = chooseGrid(terrain.reliefM, frame);
    assert.equal(terrain.raised + terrain.sloped, mildCols * mildRows);
    assert.ok(terrain.raised + terrain.sloped <= MAX_GRID * MAX_GRID);
    assert.equal(terrain.clipboard.header.type, "HaminaClipboard");
    assert.equal(terrain.clipboard.attenuatingZones.length, 0);
    for (const z of terrain.clipboard.slopedFloors) {
      const ring = z.area.coordinates[0];
      assertSlopedRamp(ring);
      assert.equal(z.slabOnly, false);
      assert.equal(z.crowdEnabled, false);
      assert.equal(z.drawStairs, false);
      assert.equal(z.attenuationDbPerMeter, 0);
      for (const p of ring) {
        assert.ok(p[0] <= 0.001 && p[0] >= -frame.widthM - 0.01);
        assert.ok(p[1] <= 0.001 && p[1] >= -frame.lengthM - 0.01);
      }
    }
    for (const z of terrain.clipboard.raisedFloorZones) {
      assertOpenQuad(z.area.coordinates[0], 2);
      assert.equal(z.slabOnly, false);
      assert.ok(z.height >= 0);
    }
  });

  it("uses the same open-quad conventions as a paste that Planner Plus accepts", () => {
    for (const z of pasteSample.raisedFloorZones) {
      assert.deepEqual(Object.keys(z), RAISED_KEYS);
      assertOpenQuad(z.area.coordinates[0], 2);
    }
    for (const z of pasteSample.slopedFloors) {
      assert.deepEqual(Object.keys(z), SLOPED_KEYS);
      assertSlopedRamp(z.area.coordinates[0]);
    }
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "EW" });
    const terrain = terrainFromSamples(
      gridSamples(frame, (r, c) => 150 + c * 3),
      frame
    );
    assert.equal(terrain.raised, 0);
    const [cols, rows] = chooseGrid(terrain.reliefM, frame);
    assert.equal(terrain.sloped, cols * rows);
    assert.ok(terrain.sloped > 9);
    assert.ok(terrain.sloped <= MAX_GRID * MAX_GRID);
    for (const z of terrain.clipboard.slopedFloors) {
      assert.deepEqual(Object.keys(z), SLOPED_KEYS);
      const ring = z.area.coordinates[0];
      assertSlopedRamp(ring);
      const lowX = Math.min(ring[0][0], ring[1][0]);
      const highX = Math.min(ring[2][0], ring[3][0]);
      assert.ok(lowX < highX, "east-rising slope starts on the west edge");
    }
    for (const z of terrain.clipboard.raisedFloorZones) assertOpenQuad(z.area.coordinates[0], 2);

    const towardWest = terrainFromSamples(
      gridSamples(frame, (r, c) => 400 - c * 4),
      frame
    );
    assert.ok(towardWest.sloped > 9);
    for (const z of towardWest.clipboard.slopedFloors) {
      const ring = z.area.coordinates[0];
      assertSlopedRamp(ring);
      const lowX = (ring[0][0] + ring[1][0]) / 2;
      const highX = (ring[2][0] + ring[3][0]) / 2;
      assert.ok(lowX > highX, "low edge is the east side");
    }
    const towardSouth = terrainFromSamples(
      gridSamples(frame, (r) => 400 - r * 4),
      frame
    );
    assert.ok(towardSouth.sloped > 9);
    for (const z of towardSouth.clipboard.slopedFloors) {
      const ring = z.area.coordinates[0];
      assertSlopedRamp(ring);
      const lowY = (ring[0][1] + ring[1][1]) / 2;
      const highY = (ring[2][1] + ring[3][1]) / 2;
      assert.ok(lowY > highY, "low edge is the north side");
    }
  });

  it("parses 3DEP getSamples and keeps terrain out of the OpenIntent zip path", () => {
    const parsed = parseDemSamples({
      samples: [
        { location: { x: -87.92, y: 42.9 }, value: "215.2" },
        { location: { x: 0, y: 0 }, value: "nope" },
      ],
    });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].z, 215.2);
    const frame = geoFrame({ west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "T" });
    const samples = [];
    for (let i = 0; i < 8; i++) {
      samples.push({
        lon: frame.west + (i % 4) * 0.004,
        lat: frame.south + Math.floor(i / 4) * 0.008,
        z: 200 + i,
      });
    }
    const terrain = terrainFromSamples(samples, frame);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [],
      name: "Terrain",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain,
    });
    const files = unzipStore(built.zip);
    assert.ok(files["terrain-clipboard.json"]);
    assert.equal(built.clipboard.raisedFloorZones.length, 0);
    assert.equal(built.clipboard.slopedFloors.length, 0);
    const oi = JSON.stringify(built.openintent);
    assert.equal(oi.includes("raisedFloorZones"), false);
    assert.match(files["README.txt"].toString(), /terrain-clipboard\.json/);
    assert.match(files["README.txt"].toString(), /bottom height from floor/);
    assert.match(files["README.txt"].toString(), /Do not import/);
    const clip = JSON.parse(files["terrain-clipboard.json"].toString());
    assert.ok(clip.raisedFloorZones.length + clip.slopedFloors.length >= 1);
    assert.equal(clip.header.type, "HaminaClipboard");
  });
});

describe("sloped floor winding", () => {
  function node(x, y, z) {
    return { x, y, zRel: z };
  }

  /** Clipboard rectangle: x increases east, y increases north. */
  const sw = [-10, -8];
  const se = [-2, -8];
  const ne = [-2, -1];
  const nw = [-10, -1];

  function ringOf(zsw, zse, zne, znw) {
    return slopedRing(node(sw[0], sw[1], zsw), node(se[0], se[1], zse), node(ne[0], ne[1], zne), node(nw[0], nw[1], znw));
  }

  function cornerName(p) {
    const west = p[0] === sw[0];
    const south = p[1] === sw[1];
    if (west && south) return "sw";
    if (!west && south) return "se";
    if (!west && !south) return "ne";
    return "nw";
  }

  function assertGrade(ring, order, lowZ, highZ) {
    assert.equal(pasteableQuad(ring), true);
    assertSlopedRamp(ring);
    assert.equal(ring.map(cornerName).join(","), order);
    assert.equal(ring[0][2], lowZ);
    assert.equal(ring[1][2], lowZ);
    assert.equal(ring[2][2], highZ);
    assert.equal(ring[3][2], highZ);
    assert.ok(ring[0][2] < ring[2][2]);
  }

  it("emits a pasteable CCW low-first ramp for every grade", () => {
    assertGrade(ringOf(0, 0, 6, 6), "sw,se,ne,nw", 0, 6);
    assertGrade(ringOf(6, 6, 0, 0), "ne,nw,sw,se", 0, 6);
    assertGrade(ringOf(0, 6, 6, 0), "nw,sw,se,ne", 0, 6);
    assertGrade(ringOf(6, 0, 0, 6), "se,ne,nw,sw", 0, 6);
    // East rise is the stronger axis, so the ramp follows that grade.
    assertGrade(ringOf(0, 4, 5, 1), "nw,sw,se,ne", 0.5, 4.5);
    // South rise is the stronger axis.
    assertGrade(ringOf(5, 4, 0, 1), "ne,nw,sw,se", 0.5, 4.5);
  });

  function ringAt(corners, zsw, zse, zne, znw) {
    return slopedRing(
      node(corners.sw[0], corners.sw[1], zsw),
      node(corners.se[0], corners.se[1], zse),
      node(corners.ne[0], corners.ne[1], zne),
      node(corners.nw[0], corners.nw[1], znw)
    );
  }

  function assertElongatedGrade(corners, zsw, zse, zne, znw, order, lowZ, highZ) {
    const ring = ringAt(corners, zsw, zse, zne, znw);
    function cornerNameAt(p) {
      const west = p[0] === corners.sw[0];
      const south = p[1] === corners.sw[1];
      if (west && south) return "sw";
      if (!west && south) return "se";
      if (!west && !south) return "ne";
      return "nw";
    }
    assert.equal(pasteableQuad(ring), true);
    assertSlopedRamp(ring);
    assert.equal(ring.map(cornerNameAt).join(","), order);
    assert.equal(ring[0][2], lowZ);
    assert.equal(ring[2][2], highZ);
  }

  it("picks the steeper short axis when the long axis has the larger rise", () => {
    // 20 m east-west, 4 m north-south. |Δz| is 3 m east-west and 1 m north-south,
    // so raw |Δz| would ramp east. Rise/run is 0.15 vs 0.25, so the short face wins.
    const wide = {
      sw: [0, 0],
      se: [20, 0],
      ne: [20, 4],
      nw: [0, 4],
    };
    assertElongatedGrade(wide, 0, 3, 4, 1, "sw,se,ne,nw", 1.5, 2.5);

    // 4 m east-west, 20 m north-south. |Δz| is 3 m north-south and 1 m east-west.
    // Rise/run is 0.15 vs 0.25, so the short east-west face wins.
    const tall = {
      sw: [0, 0],
      se: [4, 0],
      ne: [4, 20],
      nw: [0, 20],
    };
    assertElongatedGrade(tall, 0, 1, 4, 3, "nw,sw,se,ne", 1.5, 2.5);
  });

  it("keeps the north-south ramp when the two slopes tie", () => {
    // 10 m × 5 m. |Δz| is 2 m east-west and 1 m north-south (raw |Δz| would go east).
    // Both slopes are 0.2, so the tie stays north-south.
    const cell = {
      sw: [0, 0],
      se: [10, 0],
      ne: [10, 5],
      nw: [0, 5],
    };
    assertElongatedGrade(cell, 0.5, 1.5, 3.5, 0.5, "sw,se,ne,nw", 1, 2);
  });

  it("rejects the clockwise low-first orders", () => {
    const xyz = (xy, z) => [xy[0], xy[1], z];
    // North edge first, walked east: clockwise. The CCW walk of that edge starts at ne.
    const northLowClockwise = [xyz(nw, 0), xyz(ne, 0), xyz(se, 6), xyz(sw, 6)];
    // West edge first, walked north: clockwise. The CCW walk of that edge starts at nw.
    const westLowClockwise = [xyz(sw, 0), xyz(nw, 0), xyz(ne, 6), xyz(se, 6)];
    assert.equal(pasteableQuad(northLowClockwise), false);
    assert.equal(pasteableQuad(westLowClockwise), false);
    assert.equal(pasteableQuad(ringOf(6, 6, 0, 0)), true);
    assert.equal(pasteableQuad(ringOf(0, 6, 6, 0)), true);
  });

  function cornerSamples(frame, zAt) {
    const n = 6;
    const samples = [];
    for (let r = 0; r <= n; r++) {
      for (let c = 0; c <= n; c++) {
        samples.push({
          lon: frame.west + (c / n) * (frame.east - frame.west),
          lat: frame.south + (r / n) * (frame.north - frame.south),
          z: zAt(c, r),
        });
      }
    }
    return samples;
  }

  function label(p, ring) {
    const xs = ring.map((q) => q[0]);
    const ys = ring.map((q) => q[1]);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const west = p[0] < midX;
    const south = p[1] < midY;
    if (west && south) return "sw";
    if (!west && south) return "se";
    if (!west && !south) return "ne";
    return "nw";
  }

  it("pastes every relief cell as a DEM-aligned ramp instead of a raised pad", () => {
    const frame = geoFrame({ west: -87.922, south: 42.89, east: -87.912, north: 42.903, name: "Grades" });
    const grades = [
      {
        name: "south low",
        zAt: (c, r) => 100 + r * 2,
        order: "sw,se,ne,nw",
        risesNorth: true,
      },
      {
        name: "north low",
        zAt: (c, r) => 100 + (6 - r) * 2,
        order: "ne,nw,sw,se",
        risesNorth: false,
      },
      {
        name: "west low",
        zAt: (c) => 100 + c * 2,
        order: "nw,sw,se,ne",
        risesEast: true,
      },
      {
        name: "east low",
        zAt: (c) => 100 + (6 - c) * 2,
        order: "se,ne,nw,sw",
        risesEast: false,
      },
    ];
    for (const grade of grades) {
      const terrain = terrainFromSamples(cornerSamples(frame, grade.zAt), frame);
      assert.ok(terrain.reliefM > 8 && terrain.reliefM < LIFT_RELIEF_M, grade.name + " relief " + terrain.reliefM);
      const [cols, rows] = chooseGrid(terrain.reliefM, frame);
      assert.equal(terrain.sloped, cols * rows, grade.name + " sloped");
      assert.equal(terrain.raised, 0, grade.name + " fell back to a raised pad");
      for (const zone of terrain.clipboard.slopedFloors) {
        const ring = zone.area.coordinates[0];
        assert.equal(pasteableQuad(ring), true, grade.name);
        assertSlopedRamp(ring);
        assert.equal(ring.map((p) => label(p, ring)).join(","), grade.order, grade.name);
        const lowX = (ring[0][0] + ring[1][0]) / 2;
        const highX = (ring[2][0] + ring[3][0]) / 2;
        const lowY = (ring[0][1] + ring[1][1]) / 2;
        const highY = (ring[2][1] + ring[3][1]) / 2;
        if (grade.risesNorth !== undefined) {
          assert.equal(lowY < highY, grade.risesNorth, grade.name + " north");
        }
        if (grade.risesEast !== undefined) {
          assert.equal(lowX < highX, grade.risesEast, grade.name + " east");
        }
      }
    }
  });
});

function squareFeature(west, south, east, north, props) {
  return {
    type: "Feature",
    properties: props || {},
    geometry: {
      type: "Polygon",
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    },
  };
}

describe("building height from floor on a slope", () => {
  const frame = geoFrame({ west: -89.7, south: 44.91, east: -89.684, north: 44.926, name: "Granite Peak" });

  function buildOn(zAt, features) {
    const terrain = terrainFromSamples(gridSamples(frame, zAt), frame);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features },
      treePoints: [],
      name: "Granite Peak",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain,
    });
    return { terrain, built };
  }

  it("keeps bottom height on the floor when relief is below the ski-hill gate", () => {
    const span = frame.north - frame.south;
    const spanLon = frame.east - frame.west;
    const lat0 = frame.south + span * 0.7;
    const lon0 = frame.west + spanLon * 0.4;
    const lat1 = lat0 + span * 0.012;
    const lon1 = lon0 + spanLon * 0.012;
    const { terrain, built } = buildOn(
      (r, c, lon, lat) => 400 + ((lat - frame.south) / span) * 12,
      [squareFeature(lon0, lat0, lon1, lat1)]
    );
    assert.ok(terrain.reliefM < LIFT_RELIEF_M);
    assert.equal(siteWarrantsLift(terrain), false);
    assert.equal(built.stats.buildingsLifted, 0);
    const area = built.openintent.floorplans[0].attenuation_areas[0];
    assert.equal(area.area_material.name, "Building - One Floor");
    assert.equal("bottom_height" in area.area_material, false);
    assert.equal(area.area_material.top_height, 4.5);
    const zone = built.clipboard.attenuatingZones[0];
    const type = built.clipboard.attenuatingZoneTypes.find((t) => t.id === zone.typeId);
    assert.equal(type.bottomEdge, null);
    assert.equal(type.topEdge, 4.5);
    assert.ok(terrain.raised + terrain.sloped > 9);
    for (const z of terrain.clipboard.slopedFloors) assertSlopedRamp(z.area.coordinates[0]);
    for (const z of terrain.clipboard.raisedFloorZones) assertOpenQuad(z.area.coordinates[0], 2);
  });

  it("sets bottom height from floor to the slope top and top height to bottom plus building height", () => {
    const span = frame.north - frame.south;
    const spanLon = frame.east - frame.west;
    const dLat = span * 0.012;
    const dLon = spanLon * 0.012;
    const southB = squareFeature(
      frame.west + spanLon * 0.2,
      frame.south + span * 0.02,
      frame.west + spanLon * 0.2 + dLon,
      frame.south + span * 0.02 + dLat
    );
    const northB = squareFeature(
      frame.west + spanLon * 0.5,
      frame.south + span * 0.75,
      frame.west + spanLon * 0.5 + dLon,
      frame.south + span * 0.75 + dLat,
      { height: 6.4 }
    );
    const { terrain, built } = buildOn((r, c, lon, lat) => {
      const t = (lat - frame.south) / span;
      return t < 0.35 ? 300 : 300 + ((t - 0.35) / 0.65) * 180;
    }, [southB, northB]);
    assert.ok(terrain.reliefM >= LIFT_RELIEF_M);
    assert.equal(siteWarrantsLift(terrain), true);
    assert.ok(terrain.sloped > 9);
    assert.ok(terrain.sloped <= ABSOLUTE_MAX_GRID * ABSOLUTE_MAX_GRID);
    for (const z of terrain.clipboard.slopedFloors) assertSlopedRamp(z.area.coordinates[0]);
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.equal(areas.length, 2);
    const valley = areas.find((a) => a.area_material.name === "Building - One Floor");
    const hill = areas.find((a) => String(a.area_material.name).indexOf("Building - Two Floor ") === 0);
    assert.ok(valley, "valley building stays on the floor");
    assert.equal("bottom_height" in valley.area_material, false);
    assert.equal(valley.area_material.top_height, 4.5);
    assert.ok(hill);
    assert.ok(hill.area_material.bottom_height >= 50, "bottom " + hill.area_material.bottom_height);
    assert.equal(
      hill.area_material.top_height,
      Math.round((hill.area_material.bottom_height + 7.620092660326749) * 10) / 10
    );
    assert.equal(hill.area_material.name, "Building - Two Floor " + hill.area_material.bottom_height.toFixed(1));
    assert.deepEqual(Object.keys(hill.area_material), [
      "name",
      "rf_properties",
      "top_height",
      "bottom_height",
      "display_color",
    ]);
    const gold = built.openintent.area_materials.slice(0, 4).map((m) => m.name);
    assert.deepEqual(gold, ["Building - One Floor", "Building - Two Floor", "Building - Five Floor", "Building - Ten Floor"]);
    assert.ok(built.openintent.area_materials.some((m) => m.name === hill.area_material.name));
    assert.equal(JSON.stringify(built.openintent).includes("raisedFloorZones"), false);
    const hillZone = built.clipboard.attenuatingZones.find((z) => String(z.typeId).indexOf("-b") > 0);
    const hillType = built.clipboard.attenuatingZoneTypes.find((t) => t.id === hillZone.typeId);
    assert.equal(hillType.bottomEdge, hill.area_material.bottom_height);
    assert.equal(hillType.topEdge, Math.round((hillType.bottomEdge + 6.4) * 10) / 10);
    assert.ok(hillType.topEdge > hillType.bottomEdge);
    assert.equal(built.stats.buildingsLifted, 1);
  });
});

describe("foliage height from floor on a slope", () => {
  const frame = geoFrame({ west: -89.7, south: 44.91, east: -89.684, north: 44.926, name: "Granite Peak" });

  function buildFoliage(zAt, hits, heightSample) {
    const terrain = terrainFromSamples(gridSamples(frame, zAt), frame);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [],
      name: "Granite Peak",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain,
      canopyHits: hits,
      heightSample,
      includeFoliage: true,
    });
    return { terrain, built };
  }

  it("leaves foliage on the floor when relief is below the ski-hill gate", () => {
    const span = frame.north - frame.south;
    const spanLon = frame.east - frame.west;
    const lat = frame.south + span * 0.7;
    const lon = frame.west + spanLon * 0.4;
    const { terrain, built } = buildFoliage(
      (r, c, lon0, lat0) => 400 + ((lat0 - frame.south) / span) * 12,
      canopyHitsGrid(frame, lon, lat, { pct: 80 }),
      () => 14.2
    );
    assert.ok(terrain.reliefM < LIFT_RELIEF_M);
    assert.equal(siteWarrantsLift(terrain), false);
    assert.equal(built.stats.foliageLifted, 0);
    assert.equal(built.stats.includeFoliage, true);
    const areas = built.openintent.floorplans[0].attenuation_areas;
    assert.ok(areas.length >= 1);
    for (const area of areas) {
      assert.equal(area.area_material.name, "Foliage - Heavy 14.2");
      assert.equal("bottom_height" in area.area_material, false);
      assert.equal(area.area_material.top_height, 14.2);
    }
    const zone = built.clipboard.attenuatingZones[0];
    const type = built.clipboard.attenuatingZoneTypes.find((t) => t.id === zone.typeId);
    assert.equal(type.id.indexOf("foliage-m-"), 0);
    assert.equal(type.bottomEdge, 3.5);
    assert.equal(type.topEdge, 14.2);
    assert.equal(built.openintent.area_materials.slice(0, 4).some((m) => "bottom_height" in m), false);
  });

  it("sets foliage bottom height from floor to the slope top and top height to bottom plus canopy height", () => {
    const span = frame.north - frame.south;
    const spanLon = frame.east - frame.west;
    const valleyHits = canopyHitsGrid(frame, frame.west + spanLon * 0.2, frame.south + span * 0.05, { pct: 40 });
    const stockHill = canopyHitsGrid(frame, frame.west + spanLon * 0.25, frame.south + span * 0.78, { pct: 40 });
    const measuredHill = canopyHitsGrid(frame, frame.west + spanLon * 0.7, frame.south + span * 0.78, { pct: 80 });
    const { terrain, built } = buildFoliage(
      (r, c, lon, lat) => {
        const t = (lat - frame.south) / span;
        return t < 0.35 ? 300 : 300 + ((t - 0.35) / 0.65) * 180;
      },
      valleyHits.concat(stockHill, measuredHill),
      (lon, lat) => {
        if ((lat - frame.south) / span < 0.35) return 14.2;
        return (lon - frame.west) / spanLon < 0.45 ? 6 : 14.2;
      }
    );
    assert.ok(terrain.reliefM >= LIFT_RELIEF_M);
    assert.equal(siteWarrantsLift(terrain), true);
    const areas = built.openintent.floorplans[0].attenuation_areas;
    const valley = areas.filter((a) => a.area_material.name === "Foliage - Heavy 14.2");
    const hill = areas.filter((a) => String(a.area_material.name).indexOf("Foliage - Light @ ") === 0);
    const thick = areas.filter((a) => String(a.area_material.name).indexOf("Foliage - Heavy 14.2 @ ") === 0);
    assert.ok(valley.length >= 1, "valley canopy stays on the floor");
    assert.ok(hill.length >= 1, "uphill stock canopy is lifted");
    assert.ok(thick.length >= 1, "uphill measured canopy is lifted");
    for (const area of valley) {
      assert.equal("bottom_height" in area.area_material, false);
      assert.equal(area.area_material.top_height, 14.2);
    }
    const stockTop = 19.68 / 3.280839895;
    const hillMat = hill[0].area_material;
    assert.ok(hillMat.bottom_height >= 50, "bottom " + hillMat.bottom_height);
    assert.equal(hillMat.top_height, Math.round((hillMat.bottom_height + stockTop) * 10) / 10);
    assert.equal(hillMat.name, "Foliage - Light @ " + hillMat.bottom_height.toFixed(1));
    assert.deepEqual(Object.keys(hillMat), ["name", "rf_properties", "top_height", "bottom_height", "display_color"]);
    assert.equal(hillMat.rf_properties.attenuation_per_m, 1);
    assert.equal(hillMat.display_color, "#6FA84A");
    const gold = built.openintent.area_materials.slice(0, 4).map((m) => m.name);
    assert.deepEqual(gold, ["Building - One Floor", "Building - Two Floor", "Building - Five Floor", "Building - Ten Floor"]);
    assert.ok(built.openintent.area_materials.some((m) => m.name === hillMat.name));
    const hillZone = built.clipboard.attenuatingZones.find((z) => String(z.typeId).indexOf("foliage-light-b") === 0);
    const hillType = built.clipboard.attenuatingZoneTypes.find((t) => t.id === hillZone.typeId);
    assert.equal(hillType.bottomEdge, hillMat.bottom_height);
    assert.equal(hillType.topEdge, hillMat.top_height);
    assert.ok(hillType.topEdge > hillType.bottomEdge);
    assert.equal(hillType.transparencyEnabled, true);
    const stockLight = built.clipboard.attenuatingZoneTypes.find((t) => t.id === "foliage-light");
    assert.equal(stockLight, undefined);
    const thickMat = thick[0].area_material;
    assert.ok(thickMat.bottom_height >= 50);
    assert.equal(thickMat.top_height, Math.round((thickMat.bottom_height + 14.2) * 10) / 10);
    assert.equal(thickMat.name, "Foliage - Heavy 14.2 @ " + thickMat.bottom_height.toFixed(1));
    assert.equal(thickMat.rf_properties.attenuation_per_m, 2);
    const thickZone = built.clipboard.attenuatingZones.find((z) => String(z.typeId).indexOf("foliage-m-14_2-b") === 0);
    const thickType = built.clipboard.attenuatingZoneTypes.find((t) => t.id === thickZone.typeId);
    assert.equal(thickType.bottomEdge, thickMat.bottom_height);
    assert.equal(thickType.topEdge, thickMat.top_height);
    const valleyZone = built.clipboard.attenuatingZones.find((z) => z.typeId === "foliage-m-14_2");
    const valleyType = built.clipboard.attenuatingZoneTypes.find((t) => t.id === valleyZone.typeId);
    assert.equal(valleyType.bottomEdge, 3.5);
    assert.equal(valleyType.topEdge, 14.2);
    assert.equal(built.stats.foliageLifted, hill.length + thick.length);
    assert.equal(built.stats.buildingsLifted, 0);
    assert.equal(JSON.stringify(built.openintent).includes("Foliage 14.2 m"), false);
  });
});

function metersBox(lat, widthM, lengthM, name, opts) {
  const mpdLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const west = -89.72;
  const south = lat;
  return geoFrame(
    {
      west,
      south,
      east: west + widthM / mpdLon,
      north: south + lengthM / 110540,
      name: name || "Box",
    },
    opts || {}
  );
}

describe("terrain resolution presets", () => {
  it("keeps Default at the v1.1.5 ski-hill lattice and sample count", () => {
    assert.equal(TARGET_CELL_M, 80);
    assert.equal(MAX_GRID, 12);
    assert.equal(SAMPLE_COUNT, 144);
    assert.deepEqual(TERRAIN_RESOLUTIONS.default, {
      id: "default",
      label: "Default",
      cellM: 80,
      maxGrid: 12,
      sampleCount: 144,
    });
    assert.equal(TERRAIN_RESOLUTIONS.fine.cellM, 40);
    assert.equal(TERRAIN_RESOLUTIONS.fine.maxGrid, 16);
    assert.equal(TERRAIN_RESOLUTIONS.fine.sampleCount, 324);
    assert.equal(TERRAIN_RESOLUTIONS.finest.cellM, 25);
    assert.equal(TERRAIN_RESOLUTIONS.finest.maxGrid, 20);
    assert.equal(TERRAIN_RESOLUTIONS.finest.sampleCount, 576);
    assert.ok(TERRAIN_RESOLUTIONS.finest.maxGrid <= PASTE_SOFT_GRID);
    assert.ok(TERRAIN_RESOLUTIONS.finest.sampleCount <= ABSOLUTE_MAX_SAMPLES);
    assert.equal(PASTE_SOFT_GRID, 20);
    assert.equal(ABSOLUTE_MAX_GRID, 500);
    assert.equal(ABSOLUTE_MAX_SAMPLES, 2500);
    assert.equal(normalizeTerrainResolution(undefined).id, "auto");
    assert.equal(normalizeTerrainResolution("").id, "auto");
    assert.equal(normalizeTerrainResolution(" AUTO ").id, "auto");
    assert.equal(normalizeTerrainResolution(" FINE ").id, "fine");
    assert.equal(normalizeTerrainResolution("nope").id, "auto");
    assert.equal(normalizeTerrainResolution("default").id, "default");
    assert.equal(normalizeTerrainResolution("20 m").id, "20");
    assert.equal(normalizeTerrainResolution("1m").id, "1");
    assert.equal(TERRAIN_RESOLUTIONS.auto.maxGrid, PASTE_SOFT_GRID);
    assert.equal(TERRAIN_RESOLUTIONS.auto.cellM, null);
    for (const id of ["20", "15", "10", "5", "1"]) {
      const preset = TERRAIN_RESOLUTIONS[id];
      assert.equal(preset.experimental, true);
      assert.equal(preset.cellM, Number(id));
      assert.ok(preset.maxGrid > PASTE_SOFT_GRID);
      assert.ok(preset.maxGrid <= ABSOLUTE_MAX_GRID);
    }
    for (const id of ["20", "15", "10", "5"]) {
      assert.ok(TERRAIN_RESOLUTIONS[id].maxGrid * TERRAIN_RESOLUTIONS[id].cellM >= 2500);
    }
    assert.equal(TERRAIN_RESOLUTIONS["1"].maxGrid, ABSOLUTE_MAX_GRID);
  });

  it("leaves flat, mild, and medium ladders unchanged at every preset", () => {
    const frame = metersBox(44.91, 900, 700, "Mild");
    for (const id of [undefined, "auto", "default", "fine", "finest", "20", "15", "10", "5", "1"]) {
      assert.deepEqual(chooseGrid(0.4, frame, id), [2, 2]);
      assert.deepEqual(chooseGrid(5, frame, id), [4, 3]);
      assert.deepEqual(chooseGrid(15, frame, id), [6, 5]);
    }
  });

  it("densifies only the ski-hill lattice, and caps a huge draw at 20×20", () => {
    const legacy = (frame) => {
      const width = frame && frame.widthM > 0 ? frame.widthM : 800;
      const length = frame && frame.lengthM > 0 ? frame.lengthM : 800;
      return [
        Math.max(6, Math.min(12, Math.round(width / 80))),
        Math.max(6, Math.min(12, Math.round(length / 80))),
      ];
    };
    const wide = metersBox(44.91, 1800, 1400, "Wide hill");
    assert.deepEqual(chooseGrid(200, wide, "default"), legacy(wide));
    assert.deepEqual(chooseGrid(200, wide, "default"), [12, 12]);
    assert.deepEqual(chooseGrid(200, wide, "fine"), [16, 16]);
    assert.deepEqual(chooseGrid(200, wide, "finest"), [20, 20]);
    assert.deepEqual(chooseGrid(200, null, "default"), legacy(null));
    const small = metersBox(44.91, 480, 480, "Small hill");
    const [dC, dR] = chooseGrid(200, small, "default");
    const [fC, fR] = chooseGrid(200, small, "fine");
    const [xC, xR] = chooseGrid(200, small, "finest");
    assert.ok(fC * fR > dC * dR);
    assert.ok(xC * xR > fC * fR);
    assert.ok(xC <= 20 && xR <= 20);
    const capped = metersBox(44.91, 2400, 2400, "Cap");
    const [cC, cR] = chooseGrid(200, capped, "finest");
    assert.deepEqual([cC, cR], [20, 20]);
    assert.ok(cC * cR <= ABSOLUTE_MAX_GRID * ABSOLUTE_MAX_GRID);
  });

  it("builds a denser paste for Fine and Finest and keeps solid floors", () => {
    const frame = metersBox(44.91, 1800, 1400, "Granite Peak");
    const zAt = (r, c, lon, lat) => 300 + ((lat - frame.south) / (frame.north - frame.south)) * 200;
    const samples = gridSamples(frame, zAt);
    const coarse = terrainFromSamples(samples, frame, { terrainResolution: "default" });
    const fine = terrainFromSamples(samples, frame, { terrainResolution: "fine" });
    const finest = terrainFromSamples(samples, frame, { terrainResolution: "finest" });
    assert.equal(coarse.terrainResolution, "default");
    assert.deepEqual([coarse.gridCols, coarse.gridRows], [12, 12]);
    assert.equal(coarse.raised + coarse.sloped, 12 * 12);
    assert.equal(fine.terrainResolution, "fine");
    assert.equal(fine.raised + fine.sloped, 16 * 16);
    assert.equal(finest.terrainResolution, "finest");
    assert.equal(finest.raised + finest.sloped, 20 * 20);
    assert.ok(finest.sloped > fine.sloped);
    assert.ok(fine.sloped > coarse.sloped);
    for (const terrain of [coarse, fine, finest]) {
      assert.ok(terrain.reliefM >= LIFT_RELIEF_M);
      const zones = terrain.clipboard.raisedFloorZones.concat(terrain.clipboard.slopedFloors);
      assert.ok(zones.length <= ABSOLUTE_MAX_GRID * ABSOLUTE_MAX_GRID);
      assert.ok(zones.every((z) => z.slabOnly === false));
      for (const z of terrain.clipboard.slopedFloors) assertSlopedRamp(z.area.coordinates[0]);
    }
    const fields = terrainBundleFields(finest, []);
    assert.match(fields.terrainStatus, /Finest ~25 m/);
    assert.match(fields.terrainStatus, /Copy terrain/);
    const flat = terrainFromSamples(gridSamples(frame, () => 214.2), frame, { terrainResolution: "finest" });
    assert.equal(flat.raised, 4);
    assert.equal(flat.sloped, 0);
    assert.match(terrainBundleFields(flat, []).terrainStatus, /keeps the coarse mesh/);
    const mild = terrainFromSamples(
      gridSamples(frame, (r, c, lon, lat) => 200 + ((lat - frame.south) / (frame.north - frame.south)) * 4),
      frame,
      { terrainResolution: "finest" }
    );
    assert.ok(mild.reliefM < 8);
    assert.equal(mild.raised + mild.sloped, 4 * 3);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [],
      name: "Resolution",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain: finest,
      terrainResolution: "finest",
    });
    const readme = unzipStore(built.zip)["README.txt"].toString();
    assert.match(readme, /about 40 m quads, at most 16×16/);
    assert.match(readme, /about 25 m quads, at most 20×20/);
    assert.match(readme, /^terrainResolution: finest$/m);
    assert.match(readme, /slabOnly is false/);
    const clip = JSON.parse(unzipStore(built.zip)["terrain-clipboard.json"].toString());
    assert.equal(clip.slopedFloors.length + clip.raisedFloorZones.length, 20 * 20);
    assert.ok(clip.slopedFloors.concat(clip.raisedFloorZones).every((z) => z.slabOnly === false));
  });

  it("requests a denser DEM sample count for Fine and Finest", async () => {
    const frame = metersBox(44.91, 600, 500, "Samples");
    const seen = [];
    const fetchFn = async (url) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ samples: [] }) };
    };
    await fetchDemSamples(frame, fetchFn);
    await fetchDemSamples(frame, fetchFn, { terrainResolution: "default" });
    await fetchDemSamples(frame, fetchFn, { terrainResolution: "fine" });
    await fetchDemSamples(frame, fetchFn, { terrainResolution: "finest" });
    await fetchDemSamples(frame, fetchFn, { terrainResolution: "ultra" });
    assert.match(seen[0], /sampleCount=576(?:&|$)/);
    assert.match(seen[1], /sampleCount=144(?:&|$)/);
    assert.match(seen[2], /sampleCount=324(?:&|$)/);
    assert.match(seen[3], /sampleCount=576(?:&|$)/);
    assert.match(seen[4], /sampleCount=576(?:&|$)/);
    for (const url of seen) {
      const n = Number(new URL(url).searchParams.get("sampleCount"));
      assert.ok(n <= ABSOLUTE_MAX_SAMPLES);
      assert.ok(n >= 144);
    }
  });

  it("sizes Auto from the draw and keeps manuals as fixed overrides", () => {
    const box20 = metersBox(44.91, 20, 20, "Tiny hill", { minSpanM: 1 });
    const [c20, r20] = chooseGrid(200, box20, "auto");
    assert.deepEqual([c20, r20], [20, 20]);
    const cell20 = (box20.widthM / c20 + box20.lengthM / r20) / 2;
    assert.ok(cell20 >= 0.95 && cell20 <= 1.2, "20 m cell " + cell20);
    assert.ok(c20 * r20 <= ABSOLUTE_MAX_GRID * ABSOLUTE_MAX_GRID);

    const box40 = metersBox(44.91, 40, 40, "Small hill", { minSpanM: 1 });
    const [c40, r40] = chooseGrid(200, box40, "auto");
    assert.deepEqual([c40, r40], [20, 20]);
    const cell40 = (box40.widthM / c40 + box40.lengthM / r40) / 2;
    assert.ok(cell40 >= 1.8 && cell40 <= 2.2, "40 m cell " + cell40);

    const box200 = metersBox(44.91, 200, 200, "200");
    const [c200, r200] = chooseGrid(200, box200, "auto");
    assert.deepEqual([c200, r200], [20, 20]);
    const cell200 = box200.widthM / c200;
    assert.ok(Math.abs(cell200 - 10) < 0.6, "200 m cell " + cell200);

    const box800 = metersBox(44.91, 800, 800, "800");
    const [c800, r800] = chooseGrid(200, box800, "auto");
    assert.deepEqual([c800, r800], [20, 20]);
    assert.ok(Math.abs(box800.widthM / c800 - 40) < 1, "800 m cell " + box800.widthM / c800);

    const wide = metersBox(44.91, 1800, 1400, "Granite Peak");
    const [cW, rW] = chooseGrid(200, wide, "auto");
    assert.deepEqual([cW, rW], [20, 20]);
    assert.ok(wide.widthM / cW > 80);
    assert.ok(cW <= ABSOLUTE_MAX_GRID && rW <= ABSOLUTE_MAX_GRID);

    const tiny = metersBox(44.91, 4, 4, "Too small for 6", { minSpanM: 1 });
    const [tC, tR] = chooseGrid(200, tiny, "auto");
    assert.ok(tC < 6 && tR < 6, "tiny grid " + tC + "x" + tR);
    assert.ok(tiny.widthM / tC >= MIN_CELL_M - 0.05);
    assert.ok(tC * tR <= ABSOLUTE_MAX_GRID * ABSOLUTE_MAX_GRID);

    assert.deepEqual(chooseGrid(0.2, box20, "auto"), [2, 2]);
    assert.deepEqual(chooseGrid(4, box40, "auto"), [4, 3]);
    assert.deepEqual(chooseGrid(12, wide, "auto"), [6, 5]);
    assert.deepEqual(chooseGrid(200, box40, "default"), [6, 6]);
    assert.deepEqual(chooseGrid(200, box40, "finest"), [6, 6]);

    const zAt = (r, c, lon, lat) => 300 + ((lat - box40.south) / (box40.north - box40.south)) * 80;
    const autoTerrain = terrainFromSamples(gridSamples(box40, zAt), box40);
    assert.equal(autoTerrain.terrainResolution, "auto");
    assert.deepEqual([autoTerrain.gridCols, autoTerrain.gridRows], [20, 20]);
    assert.ok(autoTerrain.cellM >= 1.8 && autoTerrain.cellM <= 2.2);
    const zones = autoTerrain.clipboard.raisedFloorZones.concat(autoTerrain.clipboard.slopedFloors);
    assert.equal(zones.length, 20 * 20);
    assert.ok(zones.every((z) => z.slabOnly === false));
    assert.match(terrainBundleFields(autoTerrain, []).terrainStatus, /Auto ~2 m/);

    const flat = terrainFromSamples(gridSamples(box800, () => 214.2), box800);
    assert.equal(flat.terrainResolution, "auto");
    assert.equal(flat.raised, 4);
    assert.equal(flat.sloped, 0);
    assert.ok(flat.clipboard.raisedFloorZones.every((z) => z.slabOnly === false));
    assert.match(terrainBundleFields(flat, []).terrainStatus, /Auto \(relief under 20 m keeps the coarse mesh\)/);

    const manual = terrainFromSamples(gridSamples(wide, (r, c, lon, lat) => 300 + ((lat - wide.south) / (wide.north - wide.south)) * 200), wide, {
      terrainResolution: "default",
    });
    assert.equal(manual.terrainResolution, "default");
    assert.deepEqual([manual.gridCols, manual.gridRows], [12, 12]);
    assert.match(terrainBundleFields(manual, []).terrainStatus, /Default ~80 m/);

    const largeAuto = terrainFromSamples(
      gridSamples(wide, (r, c, lon, lat) => 300 + ((lat - wide.south) / (wide.north - wide.south)) * 200),
      wide
    );
    assert.equal(largeAuto.terrainResolution, "auto");
    assert.deepEqual([largeAuto.gridCols, largeAuto.gridRows], [20, 20]);
    assert.ok(largeAuto.cellM > 70);
    assert.match(terrainBundleFields(largeAuto, []).terrainStatus, /Auto ~/);
    assert.ok(largeAuto.clipboard.slopedFloors.concat(largeAuto.clipboard.raisedFloorZones).every((z) => z.slabOnly === false));
  });

  it("scales Auto's 3DEP sample count with the mesh and leaves manuals fixed", async () => {
    const seen = [];
    const fetchFn = async (url) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ samples: [] }) };
    };
    const small = metersBox(44.91, 8, 8, "8 m", { minSpanM: 1 });
    const [cols, rows] = chooseGrid(LIFT_RELIEF_M, small, "auto");
    assert.ok(cols < PASTE_SOFT_GRID);
    await fetchDemSamples(small, fetchFn, { terrainResolution: "auto" });
    await fetchDemSamples(small, fetchFn, { terrainResolution: "default" });
    const autoN = Number(new URL(seen[0]).searchParams.get("sampleCount"));
    const defaultN = Number(new URL(seen[1]).searchParams.get("sampleCount"));
    assert.equal(defaultN, 144);
    assert.ok(autoN > (cols + 1) * (rows + 1), "denser than paste nodes");
    assert.ok(autoN < 576, "smaller mesh than a full 20×20 Auto box");
    assert.ok(autoN <= ABSOLUTE_MAX_SAMPLES);
  });

  it("keeps a fine paste that fits and coarsens one that would not", () => {
    const peak = metersBox(44.91, 1800, 1400, "Granite Peak");
    assert.deepEqual(chooseGrid(200, peak, "20"), [90, 70]);
    assert.deepEqual(chooseGrid(200, peak, "15"), [120, 93]);
    assert.deepEqual(chooseGrid(200, peak, "10"), [180, 140]);
    assert.deepEqual(chooseGrid(200, peak, "5"), [360, 280]);
    assert.deepEqual(chooseGrid(200, peak, "1"), [500, 500]);
    assert.ok(180 * 140 > PASTE_SOFT_GRID * PASTE_SOFT_GRID);
    assert.ok(360 <= ABSOLUTE_MAX_GRID && 280 <= ABSOLUTE_MAX_GRID);
    assert.ok(180 * 140 > PASTE_BUILD_MAX_QUADS);
    assert.ok(90 * 70 <= PASTE_BUILD_MAX_QUADS);
    const fit10 = fitPasteAxes(180, 140, PASTE_BUILD_MAX_QUADS);
    const fit1 = fitPasteAxes(500, 500, PASTE_BUILD_MAX_QUADS);
    assert.ok(fit1[0] * fit1[1] <= PASTE_BUILD_MAX_QUADS);
    assert.ok(fit1[0] < 500 && fit1[1] < 500);
    assert.ok(fit10[0] * fit10[1] <= PASTE_BUILD_MAX_QUADS);
    assert.ok((fit10[0] + 1) * fit10[1] > PASTE_BUILD_MAX_QUADS);
    assert.ok(fit10[0] * (fit10[1] + 1) > PASTE_BUILD_MAX_QUADS);
    assert.ok(Math.abs(fit10[0] / fit10[1] - 180 / 140) < 0.05);
    const campus = metersBox(44.91, 2140, 1780, "Campus");
    assert.deepEqual(chooseGrid(200, campus, "10"), [214, 178]);
    const fitCampus = fitPasteAxes(214, 178, PASTE_BUILD_MAX_QUADS);
    assert.ok(fitCampus[0] * fitCampus[1] <= PASTE_BUILD_MAX_QUADS);
    assert.ok(fitCampus[0] < 214 && fitCampus[1] < 178);

    const zAt = (r, c, lon, lat) => 300 + ((lat - peak.south) / (peak.north - peak.south)) * 200;
    const samples = gridSamples(peak, zAt);
    const m20 = terrainFromSamples(samples, peak, { terrainResolution: "20" });
    assert.equal(m20.pasteOmitted, undefined);
    assert.equal(m20.pasteReduced, undefined);
    assert.deepEqual([m20.gridCols, m20.gridRows], [90, 70]);
    assert.equal(m20.raised + m20.sloped, 90 * 70);
    assert.ok(Math.abs(m20.cellM - ((1800 / 90 + 1400 / 70) / 2)) < 1.5);
    assert.ok(m20.clipboard.slopedFloors.concat(m20.clipboard.raisedFloorZones).every((z) => z.slabOnly === false));
    const notes20 = terrainResolutionNotes(m20, peak);
    assert.match(notes20.join("\n"), /past the 20×20/);
    assert.equal(/not 20 m/.test(notes20.join("\n")), false);
    assert.equal(/reduced from/.test(notes20.join("\n")), false);
    assert.match(terrainBundleFields(m20, []).terrainStatus, /20 m ~/);
    assert.match(terrainBundleFields(m20, []).terrainStatus, /past 20×20/);
    assert.match(terrainBundleFields(m20, []).terrainStatus, /Copy terrain/);

    const m15 = terrainFromSamples(samples, peak, { terrainResolution: "15" });
    assert.equal(m15.pasteOmitted, undefined);
    assert.ok(m15.clipboard);
    assert.ok(JSON.stringify(m15.clipboard).length <= TERRAIN_PASTE_JSON_MAX);
    assert.match(terrainBundleFields(m15, []).terrainStatus, /Copy terrain/);
    const m15Json = JSON.stringify(m15.clipboard);
    if (m15.pasteReduced) {
      assert.ok(m15.gridCols * m15.gridRows < 120 * 93);
      assert.match(terrainBundleFields(m15, []).terrainStatus, /reduced from 120×93/);
    } else {
      assert.deepEqual([m15.gridCols, m15.gridRows], [120, 93]);
    }
    assert.ok(estimateBundlePayload(200 * 1024 + m15Json.length, m15Json) <= EXPORT_PAYLOAD_BUDGET);

    function assertFittedPaste(terrain, frame, fromCols, fromRows) {
      assert.equal(terrain.pasteOmitted, undefined);
      assert.equal(terrain.pasteReduced, true);
      assert.ok(terrain.clipboard);
      assert.deepEqual([terrain.requestedGridCols, terrain.requestedGridRows], [fromCols, fromRows]);
      assert.ok(terrain.gridCols * terrain.gridRows < fromCols * fromRows);
      assert.ok(terrain.gridCols * terrain.gridRows <= PASTE_BUILD_MAX_QUADS);
      assert.equal(terrain.raised + terrain.sloped, terrain.gridCols * terrain.gridRows);
      const json = JSON.stringify(terrain.clipboard);
      assert.ok(json.length <= TERRAIN_PASTE_JSON_MAX);
      assert.ok(estimateBundlePayload(200 * 1024 + json.length, json) <= EXPORT_PAYLOAD_BUDGET);
      assert.ok(terrain.clipboard.slopedFloors.concat(terrain.clipboard.raisedFloorZones).every((z) => z.slabOnly === false));
      const note = "reduced from " + fromCols + "×" + fromRows + " to " + terrain.gridCols + "×" + terrain.gridRows;
      const notes = terrainResolutionNotes(terrain, frame).join("\n");
      assert.match(notes, new RegExp(note));
      assert.match(notes, /OpenIntent zip is unchanged/);
      const status = terrainBundleFields(terrain, []).terrainStatus;
      assert.match(status, new RegExp(note));
      assert.match(status, /OpenIntent zip is unchanged/);
      assert.match(status, /Copy terrain/);
      assert.equal(status.includes("omitted"), false);
    }

    const m10 = terrainFromSamples(samples, peak, { terrainResolution: "10" });
    assertFittedPaste(m10, peak, 180, 140);
    assert.ok(m10.cellM > 10);
    const warnings = [];
    noteMissingTerrain(m10, warnings);
    assert.equal(warnings.length, 0);

    const campusSamples = gridSamples(campus, (r, c, lon, lat) => 200 + ((lat - campus.south) / (campus.north - campus.south)) * 80);
    const campus10 = terrainFromSamples(campusSamples, campus, { terrainResolution: "10" });
    assertFittedPaste(campus10, campus, 214, 178);
    const uncapped = terrainFromSamples(campusSamples, campus, {
      terrainResolution: "10",
      pasteJsonMax: 3500000,
    });
    const fat = JSON.stringify(uncapped.clipboard);
    assert.ok(uncapped.gridCols * uncapped.gridRows > campus10.gridCols * campus10.gridRows);
    assert.ok(estimateBundlePayload(900000 + fat.length, fat) > LAMBDA_SYNC_PAYLOAD_MAX);
    const aerialMax = maxPasteJsonForCompanion(900000);
    const withAerial = terrainFromSamples(campusSamples, campus, {
      terrainResolution: "10",
      pasteJsonMax: aerialMax,
    });
    const aerialJson = JSON.stringify(withAerial.clipboard);
    assert.ok(withAerial.clipboard);
    assert.ok(aerialJson.length <= aerialMax);
    assert.ok(estimateBundlePayload(900000 + aerialJson.length, aerialJson) <= EXPORT_PAYLOAD_BUDGET);
    const heavyMax = maxPasteJsonForCompanion(4200000);
    assert.ok(heavyMax < TERRAIN_PASTE_JSON_MAX);
    const heavy = terrainFromSamples(campusSamples, campus, {
      terrainResolution: "10",
      pasteJsonMax: heavyMax,
    });
    assert.equal(heavy.pasteOmitted, undefined);
    assert.ok(heavy.clipboard);
    const heavyJson = JSON.stringify(heavy.clipboard);
    assert.ok(heavyJson.length <= heavyMax);
    assert.ok(estimateBundlePayload(4200000 + heavyJson.length, heavyJson) <= EXPORT_PAYLOAD_BUDGET);
    assert.match(terrainBundleFields(heavy, []).terrainStatus, /Copy terrain/);
    assert.match(terrainBundleFields(heavy, []).terrainStatus, /reduced from 214×178/);

    const m1 = terrainFromSamples(samples, peak, { terrainResolution: "1" });
    assertFittedPaste(m1, peak, 500, 500);
    const notes1 = terrainResolutionNotes(m1, peak);
    assert.match(notes1.join("\n"), /not 1 m/);
    assert.match(notes1.join("\n"), /covers about 500×500 m/);
    assert.equal(typeof m1.elevationAt, "function");
    assert.ok(m1.reliefM >= LIFT_RELIEF_M);

    const hill = metersBox(44.91, 30, 30, "1 m hill", { minSpanM: 1 });
    const fineHill = terrainFromSamples(
      gridSamples(hill, (r, c, lon, lat) => 400 + ((lat - hill.south) / (hill.north - hill.south)) * 40),
      hill,
      { terrainResolution: "1" }
    );
    assert.equal(fineHill.pasteOmitted, undefined);
    assert.equal(fineHill.pasteReduced, undefined);
    assert.deepEqual([fineHill.gridCols, fineHill.gridRows], [30, 30]);
    assert.ok(fineHill.cellM >= 0.9 && fineHill.cellM <= 1.2);
    assert.match(terrainResolutionNotes(fineHill, hill).join("\n"), /30×30/);
    assert.equal(/reduced from/.test(terrainResolutionNotes(fineHill, hill).join("\n")), false);
    assert.equal(fineHill.clipboard.slopedFloors.length + fineHill.clipboard.raisedFloorZones.length, 30 * 30);

    const wide = metersBox(44.91, 2500, 2500, "Max draw");
    assert.deepEqual(chooseGrid(200, wide, "5"), [500, 500]);
    assert.deepEqual(chooseGrid(200, wide, "10"), [250, 250]);
    assert.ok(chooseGrid(200, wide, "auto")[0] <= PASTE_SOFT_GRID);
  });

  it("steps experimental DEM samples down when the budget is short", async () => {
    const peak = metersBox(44.91, 1800, 1400, "Granite Peak");
    const seen = [];
    const fetchFn = async (url) => {
      seen.push(String(url));
      const samples = [];
      for (let i = 0; i < 4; i++) {
        samples.push({
          location: {
            x: peak.west + ((i % 2) + 0.5) * (peak.east - peak.west) * 0.5,
            y: peak.south + (Math.floor(i / 2) + 0.5) * (peak.north - peak.south) * 0.5,
          },
          value: 300 + i * 40,
        });
      }
      return { ok: true, json: async () => ({ samples }) };
    };
    await fetchDemSamples(peak, fetchFn, { terrainResolution: "10", budgetMs: 8000 });
    await fetchDemSamples(peak, fetchFn, { terrainResolution: "10", budgetMs: 5000 });
    await fetchDemSamples(peak, fetchFn, { terrainResolution: "10", budgetMs: 900 });
    await fetchDemSamples(peak, fetchFn, { terrainResolution: "default", budgetMs: 900 });
    assert.equal(new URL(seen[0]).searchParams.get("sampleCount"), "2500");
    assert.equal(new URL(seen[1]).searchParams.get("sampleCount"), "1024");
    assert.equal(new URL(seen[2]).searchParams.get("sampleCount"), "16");
    assert.equal(new URL(seen[3]).searchParams.get("sampleCount"), "144");
    const pack = await fetchTerrainDem(peak, fetchFn, { terrainResolution: "10", budgetMs: 8000 });
    assert.equal(pack.kind, "bare-earth");
    const fitted = fitPasteAxes(180, 140, PASTE_BUILD_MAX_QUADS);
    assert.match(pack.notes.join("\n"), /stepped down to 4/);
    assert.match(pack.notes.join("\n"), new RegExp(fitted[0] + "×" + fitted[1]));
    assert.equal(/180×140/.test(pack.notes.join("\n")), false);
  });
});

describe("Copernicus GLO-30 when 3DEP misses", () => {
  const frame = geoFrame({
    west: -0.13,
    south: 51.506,
    east: -0.126,
    north: 51.51,
    name: "Trafalgar",
  });

  function demFetch(body) {
    return async () => ({ ok: true, json: async () => body });
  }

  function gloGeotiff(zAt) {
    const urls = [];
    return {
      urls,
      geotiff: {
        fromUrl: async (url) => {
          urls.push(String(url));
          const m = String(url).match(/_([NS])(\d{2})_00_([EW])(\d{3})_00_DEM\.tif$/);
          if (!m) throw new Error("bad tile url " + url);
          const latSw = (m[1] === "S" ? -1 : 1) * Number(m[2]);
          const lonSw = (m[3] === "W" ? -1 : 1) * Number(m[4]);
          const resX = 1 / 2400;
          const resY = -1 / 3600;
          const width = 2400;
          const height = 3600;
          const origin = [lonSw, latSw + 1, 0];
          return {
            getImage: async () => ({
              getOrigin: () => origin,
              getResolution: () => [resX, resY, 0],
              getWidth: () => width,
              getHeight: () => height,
              getGDALNoData: () => null,
              readRasters: async ({ window }) => {
                const [left, top, right, bottom] = window;
                const w = right - left;
                const h = bottom - top;
                const data = new Float32Array(w * h);
                for (let y = 0; y < h; y++) {
                  for (let x = 0; x < w; x++) {
                    const lon = origin[0] + (left + x + 0.5) * resX;
                    const lat = origin[1] + (top + y + 0.5) * resY;
                    data[y * w + x] = zAt(lon, lat);
                  }
                }
                data.width = w;
                data.height = h;
                return data;
              },
            }),
          };
        },
      },
    };
  }

  it("names the public AWS tiles for London, Helsinki, and a southern point", () => {
    const { glo30TileUrlForPoint, glo30TilesForFrame } = require("../netlify/lib/copernicus-dem");
    const london = glo30TileUrlForPoint(51.508, -0.128);
    assert.match(london, /Copernicus_DSM_COG_10_N51_00_W001_00_DEM\/Copernicus_DSM_COG_10_N51_00_W001_00_DEM\.tif$/);
    assert.match(london, /^https:\/\/copernicus-dem-30m\.s3\.eu-central-1\.amazonaws\.com\//);
    const helsinki = glo30TileUrlForPoint(60.17, 24.952);
    assert.match(helsinki, /Copernicus_DSM_COG_10_N60_00_E024_00_DEM\.tif$/);
    const sydney = glo30TileUrlForPoint(-33.87, 151.21);
    assert.match(sydney, /Copernicus_DSM_COG_10_S34_00_E151_00_DEM\.tif$/);
    const across = glo30TilesForFrame({ west: -0.002, south: 51.2, east: 0.002, north: 51.21 });
    assert.equal(across.length, 2);
    assert.ok(across.some((u) => u.includes("N51_00_W001_00")));
    assert.ok(across.some((u) => u.includes("N51_00_E000_00")));
  });

  it("keeps a 3DEP grid and does not open a GLO-30 COG", async () => {
    const glo = gloGeotiff(() => 40);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      samples.push({
        location: {
          x: frame.west + ((i % 2) + 0.5) * 0.002,
          y: frame.south + (Math.floor(i / 2) + 0.5) * 0.002,
        },
        value: String(200 + i),
      });
    }
    const pack = await fetchTerrainDem(frame, demFetch({ samples }), {
      allowSurfaceFallback: true,
      geotiff: glo.geotiff,
      terrainResolution: "default",
    });
    assert.equal(pack.kind, "bare-earth");
    assert.equal(pack.attribution, "USGS 3DEP");
    assert.equal(pack.samples.length, 4);
    assert.equal(glo.urls.length, 0);
    const terrain = terrainFromSamples(pack.samples, frame, { kind: pack.kind });
    assert.equal(terrain.kind, "bare-earth");
    assert.match(terrainBundleFields(terrain, []).terrainStatus, /USGS 3DEP bare-earth/);
    assert.equal(/Copernicus/.test(terrainBundleFields(terrain, []).terrainStatus), false);
  });

  it("reads GLO-30 samples when 3DEP returns an error, and only on the dev gate", async () => {
    const span = frame.north - frame.south;
    const zAt = (lon, lat) => 15 + ((lat - frame.south) / span) * 80;
    const glo = gloGeotiff(zAt);
    const fail = demFetch({ error: { message: "Invalid or missing input parameters" } });
    await assert.rejects(
      () => fetchTerrainDem(frame, fail, { geotiff: glo.geotiff, terrainResolution: "default" }),
      /3DEP/
    );
    assert.equal(glo.urls.length, 0);

    const pack = await fetchTerrainDem(frame, fail, {
      allowSurfaceFallback: true,
      geotiff: glo.geotiff,
      terrainResolution: "default",
    });
    assert.equal(pack.kind, "surface");
    assert.equal(pack.attribution, GLO30_CREDIT);
    assert.equal(pack.samples.length, 144);
    assert.equal(glo.urls.length, 1);
    assert.match(glo.urls[0], /Copernicus_DSM_COG_10_N51_00_W001_00_DEM\.tif$/);
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const s of pack.samples) {
      assert.ok(s.lon > frame.west && s.lon < frame.east);
      assert.ok(s.lat > frame.south && s.lat < frame.north);
      assert.equal(Object.keys(s).sort().join(","), "lat,lon,z");
      if (s.z < minZ) minZ = s.z;
      if (s.z > maxZ) maxZ = s.z;
    }
    assert.ok(maxZ - minZ > 50, "relief " + (maxZ - minZ));

    const surface = terrainFromSamples(pack.samples, frame, {
      kind: pack.kind,
      attribution: pack.attribution,
      terrainResolution: "default",
    });
    assert.equal(surface.kind, "surface");
    assert.ok(surface.reliefM >= LIFT_RELIEF_M);
    assert.equal(siteWarrantsLift(surface), false);
    const bare = terrainFromSamples(pack.samples, frame, { kind: "bare-earth" });
    assert.equal(siteWarrantsLift(bare), true);

    const dLon = (frame.east - frame.west) * 0.08;
    const dLat = span * 0.08;
    const hill = squareFeature(
      frame.west + (frame.east - frame.west) * 0.4,
      frame.south + span * 0.72,
      frame.west + (frame.east - frame.west) * 0.4 + dLon,
      frame.south + span * 0.72 + dLat,
      { height: 6.4 }
    );
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [hill] },
      treePoints: [],
      name: "Trafalgar",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain: surface,
    });
    assert.equal(siteWarrantsLift(surface), false);
    assert.equal(typeof demUnderFootprint(surface), "function");
    assert.equal(built.stats.buildingsLifted, 1);
    assert.equal(built.stats.demKind, "surface");
    const hillRing = hill.geometry.coordinates[0];
    const expectedBottom = slopeTopUnderRing(surface, hillRing);
    assert.ok(expectedBottom >= 20, "slope top " + expectedBottom);
    assert.notEqual(expectedBottom, LIFT_RELIEF_M);
    const area = built.openintent.floorplans[0].attenuation_areas[0];
    const stockTwo = 7.620092660326749;
    assert.equal(area.area_material.bottom_height, expectedBottom);
    assert.equal(area.area_material.top_height, Math.round((expectedBottom + stockTwo) * 10) / 10);
    assert.equal(area.area_material.name, "Building - Two Floor " + expectedBottom.toFixed(1));
    const zone = built.clipboard.attenuatingZones[0];
    const type = built.clipboard.attenuatingZoneTypes.find((t) => t.id === zone.typeId);
    assert.equal(type.bottomEdge, expectedBottom);
    assert.equal(type.topEdge, Math.round((expectedBottom + 6.4) * 10) / 10);
    const readme = unzipStore(built.zip)["README.txt"].toString();
    assert.match(readme, /Copernicus DEM GLO-30/);
    assert.match(readme, /EGM2008/);
    assert.match(readme, new RegExp(GLO30_CREDIT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(readme, /20 m ski-hill gate does not apply/);
    assert.equal(/omit bottom_height even when relief is at least 20 m/.test(readme), false);
    assert.match(readme, /^demKind: surface$/m);
    assert.match(terrainBundleFields(surface, []).terrainStatus, /Copernicus DEM GLO-30 surface/);
    assert.equal(/3DEP/.test(terrainBundleFields(surface, []).terrainStatus), false);
    const lifted = buildClutter({
      frame,
      footprintsGeojson: { features: [hill] },
      treePoints: [],
      name: "Trafalgar",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain: bare,
    });
    assert.equal(lifted.stats.buildingsLifted, 1);
    assert.ok(lifted.openintent.floorplans[0].attenuation_areas[0].area_material.bottom_height >= 20);
  });

  it("places buildings and foliage on a surface slope, including relief under 20 m", () => {
    const frame = geoFrame({ west: -89.7, south: 44.91, east: -89.684, north: 44.926, name: "Hamina slope" });
    const span = frame.north - frame.south;
    const spanLon = frame.east - frame.west;
    const zMild = (r, c, lon, lat) => 400 + ((lat - frame.south) / span) * 12;
    const samples = gridSamples(frame, zMild);
    const surface = terrainFromSamples(samples, frame, { kind: "surface", attribution: GLO30_CREDIT });
    const bare = terrainFromSamples(samples, frame);
    assert.ok(surface.reliefM < LIFT_RELIEF_M, "relief " + surface.reliefM);
    assert.equal(surface.kind, "surface");
    assert.equal(siteWarrantsLift(surface), false);
    assert.equal(siteWarrantsLift(bare), false);
    assert.equal(demUnderFootprint(bare), null);
    assert.equal(typeof demUnderFootprint(surface), "function");

    const dLat = span * 0.012;
    const dLon = spanLon * 0.012;
    const valley = squareFeature(
      frame.west + spanLon * 0.2,
      frame.south + span * 0.02,
      frame.west + spanLon * 0.2 + dLon,
      frame.south + span * 0.02 + dLat
    );
    const hillLon = frame.west + spanLon * 0.4;
    const hillLat = frame.south + span * 0.7;
    const hill = squareFeature(hillLon, hillLat, hillLon + dLon, hillLat + dLat, { height: 6.4 });
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [valley, hill] },
      treePoints: [],
      name: "Hamina slope",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain: surface,
      includeFoliage: true,
      canopyHits: canopyHitsGrid(frame, hillLon + spanLon * 0.2, hillLat, { pct: 80 }).concat(
        canopyHitsGrid(frame, frame.west + spanLon * 0.15, frame.south + span * 0.02, { pct: 80 })
      ),
      heightSample: () => 14.2,
    });
    const bareBuilt = buildClutter({
      frame,
      footprintsGeojson: { features: [valley, hill] },
      treePoints: [],
      name: "Hamina slope",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain: bare,
    });
    assert.equal(bareBuilt.stats.buildingsLifted, 0);
    assert.equal(
      bareBuilt.openintent.floorplans[0].attenuation_areas.some((a) => "bottom_height" in a.area_material),
      false
    );

    const areas = built.openintent.floorplans[0].attenuation_areas;
    const valleyArea = areas.find((a) => a.area_material.name === "Building - One Floor");
    const hillArea = areas.find((a) => String(a.area_material.name).indexOf("Building - Two Floor ") === 0);
    assert.ok(valleyArea, "valley building stays on the floor");
    assert.equal("bottom_height" in valleyArea.area_material, false);
    assert.equal(valleyArea.area_material.top_height, 4.5);
    const expected = slopeTopUnderRing(surface, hill.geometry.coordinates[0]);
    assert.ok(expected >= 1 && expected < LIFT_RELIEF_M, "bottom " + expected);
    assert.equal(hillArea.area_material.bottom_height, expected);
    assert.equal(hillArea.area_material.top_height, Math.round((expected + 7.620092660326749) * 10) / 10);
    const hillZone = built.clipboard.attenuatingZones.find((z) => String(z.typeId).indexOf("bldg-m-") === 0);
    const hillType = built.clipboard.attenuatingZoneTypes.find((t) => t.id === hillZone.typeId);
    assert.equal(hillType.bottomEdge, expected);
    assert.equal(hillType.topEdge, Math.round((expected + 6.4) * 10) / 10);
    assert.ok(hillType.topEdge > hillType.bottomEdge);

    const foliage = areas.filter((a) => String(a.area_material.name).indexOf("Foliage - Heavy 14.2 @ ") === 0);
    const foliageFloor = areas.filter((a) => a.area_material.name === "Foliage - Heavy 14.2");
    assert.ok(foliage.length >= 1, "uphill canopy sits on the DEM");
    assert.ok(foliageFloor.length >= 1, "valley canopy stays on the floor");
    const folMat = foliage[0].area_material;
    assert.ok(folMat.bottom_height >= 1 && folMat.bottom_height < LIFT_RELIEF_M);
    assert.equal(folMat.top_height, Math.round((folMat.bottom_height + 14.2) * 10) / 10);
    const folZone = built.clipboard.attenuatingZones.find((z) => String(z.typeId).indexOf("foliage-m-14_2-b") === 0);
    const folType = built.clipboard.attenuatingZoneTypes.find((t) => t.id === folZone.typeId);
    assert.equal(folType.bottomEdge, folMat.bottom_height);
    assert.equal(folType.topEdge, folMat.top_height);
    assert.equal(built.stats.demKind, "surface");
    assert.equal(built.stats.buildingsLifted, 1);
    assert.equal(built.stats.foliageLifted, foliage.length);
    assert.equal(siteWarrantsLift(surface), false);
  });

  it("treats the dev badge host as the only fallback gate", () => {
    assert.equal(isDevDemHost({ headers: { host: "dev--openclutter.netlify.app" } }), true);
    assert.equal(isDevDemHost({ headers: { host: "deploy-preview-50--openclutter.netlify.app" } }), true);
    assert.equal(isDevDemHost({ headers: { Host: "dev--openclutter.netlify.app" } }), true);
    assert.equal(isDevDemHost({ path: "/dev", headers: {} }), true);
    assert.equal(isDevDemHost({ headers: { host: "openclutter.netlify.app" } }), false);
    assert.equal(isDevDemHost({ headers: {} }), false);
    assert.equal(isDevDemHost(undefined), false);
  });
});

describe("Finland terrain does not wait on 3DEP", () => {
  const hamina = geoFrame({
    west: 27.18,
    south: 60.565,
    east: 27.2,
    north: 60.578,
    name: "Hamina",
  });
  const helsinki = geoFrame({
    west: 24.93,
    south: 60.16,
    east: 24.96,
    north: 60.18,
    name: "Helsinki",
  });
  const vegas = geoFrame({
    west: -115.1735,
    south: 36.1205,
    east: -115.1488,
    north: 36.1355,
    name: "Wynn",
  });

  function gloGeotiff(zAt) {
    const urls = [];
    return {
      urls,
      geotiff: {
        fromUrl: async (url) => {
          urls.push(String(url));
          const m = String(url).match(/_([NS])(\d{2})_00_([EW])(\d{3})_00_DEM\.tif$/);
          if (!m) throw new Error("bad tile url " + url);
          const latSw = (m[1] === "S" ? -1 : 1) * Number(m[2]);
          const lonSw = (m[3] === "W" ? -1 : 1) * Number(m[4]);
          const resX = 1 / 2400;
          const resY = -1 / 3600;
          const width = 2400;
          const height = 3600;
          const origin = [lonSw, latSw + 1, 0];
          return {
            getImage: async () => ({
              getOrigin: () => origin,
              getResolution: () => [resX, resY, 0],
              getWidth: () => width,
              getHeight: () => height,
              getGDALNoData: () => null,
              readRasters: async ({ window }) => {
                const [left, top, right, bottom] = window;
                const w = right - left;
                const h = bottom - top;
                const data = new Float32Array(w * h);
                for (let y = 0; y < h; y++) {
                  for (let x = 0; x < w; x++) {
                    const lon = origin[0] + (left + x + 0.5) * resX;
                    const lat = origin[1] + (top + y + 0.5) * resY;
                    data[y * w + x] = zAt(lon, lat);
                  }
                }
                data.width = w;
                data.height = h;
                return data;
              },
            }),
          };
        },
      },
    };
  }

  function hangUntilAbort(seen) {
    return (url, init) => {
      if (seen) seen.push(String(url));
      return new Promise((resolve, reject) => {
        const signal = init && init.signal;
        const fail = () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal && signal.aborted) fail();
        else if (signal) signal.addEventListener("abort", fail, { once: true });
        else {
          const timer = setTimeout(fail, 20000);
          if (timer.unref) timer.unref();
        }
      });
    };
  }

  it("treats Finland as outside 3DEP and the US as inside", () => {
    assert.equal(frameHas3dep(hamina), false);
    assert.equal(frameHas3dep(helsinki), false);
    assert.equal(frameHas3dep(vegas), true);
    assert.equal(
      frameHas3dep(geoFrame({ west: -87.91, south: 42.89, east: -87.9, north: 42.9, name: "Oak Creek" })),
      true
    );
    assert.equal(DEP3_PROBE_SAMPLES, 4);
  });

  it("returns a surface grid for Hamina without waiting on a slow 3DEP", async () => {
    const seen = [];
    const span = hamina.north - hamina.south;
    const zAt = (lon, lat) => 8 + ((lat - hamina.south) / span) * 12;
    const glo = gloGeotiff(zAt);
    const t0 = Date.now();
    const pack = await fetchTerrainDem(hamina, hangUntilAbort(seen), {
      allowSurfaceFallback: true,
      geotiff: glo.geotiff,
      terrainResolution: "default",
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1200, "elapsed " + elapsed);
    assert.equal(seen.length, 1);
    assert.equal(new URL(seen[0]).searchParams.get("sampleCount"), "4");
    assert.equal(pack.kind, "surface");
    assert.equal(pack.attribution, GLO30_CREDIT);
    assert.equal(pack.samples.length, 144);
    assert.equal(glo.urls.length, 1);
    assert.match(glo.urls[0], /Copernicus_DSM_COG_10_N60_00_E027_00_DEM\.tif$/);
    const surface = terrainFromSamples(pack.samples, hamina, {
      kind: pack.kind,
      attribution: pack.attribution,
      terrainResolution: "default",
    });
    assert.equal(surface.kind, "surface");
    assert.equal(siteWarrantsLift(surface), false);
    assert.equal(typeof demUnderFootprint(surface), "function");
    assert.ok(surface.reliefM > 10 && surface.reliefM < LIFT_RELIEF_M, "relief " + surface.reliefM);
    const dLon = (hamina.east - hamina.west) * 0.08;
    const dLat = span * 0.08;
    const hill = squareFeature(
      hamina.west + (hamina.east - hamina.west) * 0.55,
      hamina.south + span * 0.7,
      hamina.west + (hamina.east - hamina.west) * 0.55 + dLon,
      hamina.south + span * 0.7 + dLat,
      { height: 6.4 }
    );
    const built = buildClutter({
      frame: hamina,
      footprintsGeojson: { features: [hill] },
      treePoints: [],
      name: "Hamina",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain: surface,
    });
    const bottom = built.openintent.floorplans[0].attenuation_areas[0].area_material.bottom_height;
    assert.equal(bottom, slopeTopUnderRing(surface, hill.geometry.coordinates[0]));
    assert.ok(bottom >= 1 && bottom < LIFT_RELIEF_M, "bottom " + bottom);
    assert.equal(built.stats.demKind, "surface");
    assert.equal(built.stats.buildingsLifted, 1);
    assert.match(terrainBundleFields(surface, []).terrainStatus, /Copernicus DEM GLO-30 surface/);
  });

  it("still prefers a US 3DEP grid over GLO-30", async () => {
    const glo = gloGeotiff(() => 40);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      samples.push({
        location: {
          x: vegas.west + ((i % 2) + 0.5) * (vegas.east - vegas.west) * 0.5,
          y: vegas.south + (Math.floor(i / 2) + 0.5) * (vegas.north - vegas.south) * 0.5,
        },
        value: String(600 + i * 10),
      });
    }
    const seen = [];
    const fetchFn = async (url) => {
      seen.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ok: true, json: async () => ({ samples }) };
    };
    const t0 = Date.now();
    const pack = await fetchTerrainDem(vegas, fetchFn, {
      allowSurfaceFallback: true,
      geotiff: glo.geotiff,
      terrainResolution: "finest",
    });
    assert.ok(Date.now() - t0 >= 200);
    assert.equal(pack.kind, "bare-earth");
    assert.equal(pack.attribution, "USGS 3DEP");
    assert.equal(glo.urls.length, 0);
    assert.equal(new URL(seen[0]).searchParams.get("sampleCount"), "576");
    const terrain = terrainFromSamples(pack.samples, vegas, { kind: pack.kind });
    assert.equal(terrain.kind, "bare-earth");
    assert.ok(terrain.reliefM >= LIFT_RELIEF_M);
    assert.equal(siteWarrantsLift(terrain), true);
  });

  it("uses a coarser GLO-30 lattice when little time remains, and the full count when it does not", async () => {
    const zAt = (lon, lat) => 5 + (lat - hamina.south) * 800;
    const short = gloGeotiff(zAt);
    const fail = async () => ({ ok: true, json: async () => ({ error: { message: "outside" } }) });
    const coarse = await fetchTerrainDem(hamina, fail, {
      allowSurfaceFallback: true,
      geotiff: short.geotiff,
      terrainResolution: "finest",
      budgetMs: 900,
    });
    assert.equal(coarse.kind, "surface");
    assert.ok(coarse.samples.length >= 4, "samples " + coarse.samples.length);
    assert.ok(coarse.samples.length <= 16, "samples " + coarse.samples.length);
    const mesh = terrainFromSamples(coarse.samples, hamina, { kind: "surface", terrainResolution: "finest" });
    assert.ok(mesh && mesh.clipboard);
    assert.equal(mesh.kind, "surface");
    assert.equal(siteWarrantsLift(mesh), false);

    const full = gloGeotiff(zAt);
    const fine = await fetchTerrainDem(hamina, fail, {
      allowSurfaceFallback: true,
      geotiff: full.geotiff,
      terrainResolution: "finest",
      budgetMs: 8000,
    });
    assert.equal(fine.samples.length, 576);
    assert.equal(fine.kind, "surface");
  });

  it("rejects with a timeout only after GLO-30 is aborted too", async () => {
    const ctrl = new AbortController();
    let gloStarted = 0;
    const geotiff = {
      fromUrl: async (url, _opts, signal) => {
        gloStarted += 1;
        await new Promise((resolve, reject) => {
          const fail = () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal && signal.aborted) fail();
          else if (signal) signal.addEventListener("abort", fail, { once: true });
          else setTimeout(fail, 5000);
        });
        throw new Error("unreachable " + url);
      },
    };
    const job = fetchTerrainDem(hamina, hangUntilAbort(), {
      allowSurfaceFallback: true,
      geotiff,
      signal: ctrl.signal,
      terrainResolution: "default",
    });
    setTimeout(() => ctrl.abort(), 900);
    await assert.rejects(job, /abort|timeout/i);
    assert.equal(gloStarted, 1);

    const miss = gloGeotiff(() => 1);
    miss.geotiff.fromUrl = async () => {
      throw new Error("HTTP 404");
    };
    await assert.rejects(
      () =>
        fetchTerrainDem(hamina, hangUntilAbort(), {
          allowSurfaceFallback: true,
          geotiff: miss.geotiff,
          terrainResolution: "default",
        }),
      /did not return a usable grid/
    );
  });
});
