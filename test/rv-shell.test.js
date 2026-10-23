"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { shellRvAreas, shellLossDb, RV_WALL_DB, RV_ROOF_DB, RV_ROOF_DB_PER_M, RV_ROOF_M } = require("../netlify/lib/rv-shell");

function ring(pts) {
  const c = pts.map(([x, y]) => ({ coordinate_xyz: { x, y, unit: "pixels" } }));
  c.push(c[0]);
  return { coordinates: c };
}

const rv = (name, top, bottom) => ({
  area: ring([[10, 10], [50, 16], [48, 28], [8, 22]]),
  area_material: Object.assign(
    { name, rf_properties: { attenuation_per_m: 9 }, top_height: top, display_color: "#8A9098" },
    bottom != null ? { bottom_height: bottom } : {},
  ),
});
const bldg = {
  area: ring([[100, 100], [140, 100], [140, 140], [100, 140]]),
  area_material: { name: "Building - 4.0", rf_properties: { attenuation_per_m: 5 }, top_height: 4, display_color: "#B4BAC0" },
};

describe("RV shell", () => {
  it("turns an RV block into four walls and a roof slab on the same footprint", () => {
    const out = shellRvAreas([bldg, rv("RV 3.5", 3.5)]);
    assert.equal(out.shells, 1);
    assert.equal(out.walls.length, 4);
    assert.equal(out.areas.length, 2);
    assert.equal(out.areas[0], bldg);
    const roof = out.areas[1];
    assert.equal(roof.area.coordinates.length, 5);
    assert.equal(roof.area_material.name, "RV roof 3.5");
    assert.equal(roof.area_material.top_height, 3.5);
    assert.equal(roof.area_material.bottom_height, 3.3);
    assert.equal(out.wallMaterials.length, 1);
    const wm = out.wallMaterials[0];
    assert.equal(wm.name, "RV shell 3.5");
    assert.equal(wm.rf_properties.attenuation_flat, RV_WALL_DB);
    assert.equal(wm.top_height, 3.5);
    assert.ok(!("bottom_height" in wm));
    for (const w of out.walls) assert.equal(w.wall_type, wm.name);
    // Closed loop on the ring's own vertices.
    assert.deepEqual(out.walls[0].start_point, { x: 10, y: 10 });
    assert.deepEqual(out.walls[3].end_point, { x: 10, y: 10 });
  });

  it("keeps the terrain seat on walls and roof", () => {
    const out = shellRvAreas([rv("RV 3.5 @ 6.0", 9.5, 6)]);
    const wm = out.wallMaterials[0];
    assert.equal(wm.name, "RV shell 3.5 @ 6.0");
    assert.equal(wm.bottom_height, 6);
    assert.equal(wm.top_height, 9.5);
    const rm = out.areas[0].area_material;
    assert.equal(rm.bottom_height, 9.3);
    assert.equal(rm.top_height, 9.5);
  });

  it("leaves semis and boats as solid blocks", () => {
    const semi = rv("Semi 4.1", 4.1);
    const out = shellRvAreas([semi]);
    assert.equal(out.shells, 0);
    assert.equal(out.walls.length, 0);
    assert.equal(out.areas[0], semi);
  });

  it("gives 24 dB through the body in any direction and 6 dB straight down through the roof", () => {
    assert.equal(shellLossDb(2, 0), 24);
    assert.equal(shellLossDb(0, RV_ROOF_M), RV_ROOF_DB);
    assert.equal(RV_ROOF_DB, 6);
    assert.equal(RV_ROOF_DB_PER_M, 30);
  });

  it("takes a roof value for test exports", () => {
    const out = shellRvAreas([rv("RV 3.5", 3.5)], { roofDb: 12 });
    assert.equal(out.areas[0].area_material.rf_properties.attenuation_per_m, 60);
  });

  it("is off until an export turns it on", () => {
    const mode = require("../netlify/lib/export-mode");
    assert.equal(mode.isRvShell(), false);
  });

  it("is the default on /dev hosts and never on production", () => {
    const { rvShellWanted } = require("../netlify/lib/export-mode");
    assert.equal(rvShellWanted(true, {}), true);
    assert.equal(rvShellWanted(true, { rvShell: true }), true);
    assert.equal(rvShellWanted(true, { rvShell: false }), false);
    assert.equal(rvShellWanted(false, {}), false);
    assert.equal(rvShellWanted(false, { rvShell: true }), false);
  });

  it("shells worst-case pad RVs the same way", () => {
    const pad = rv("RV 3.5 @ 2.4", 5.9, 2.4);
    const out = shellRvAreas([pad, rv("Trailer 3.2", 3.2)]);
    assert.equal(out.shells, 2);
    assert.equal(out.walls.length, 8);
    assert.deepEqual(out.wallMaterials.map((m) => m.name).sort(), ["RV shell 3.5 @ 2.4", "Trailer shell 3.2"]);
    assert.equal(out.areas[1].area_material.name, "Trailer roof 3.2");
    assert.equal(out.areas[1].area_material.bottom_height, 3);
  });
});
