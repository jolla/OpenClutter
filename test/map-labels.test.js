"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const LABELS = "Reference/World_Boundaries_and_Places";

function serverFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...serverFiles(p));
    else if (/\.(js|mjs|cjs|py)$/.test(ent.name)) out.push(p);
  }
  return out;
}

describe("place labels on the draw map", () => {
  it("uses Esri's keyless reference tiles with a credit", () => {
    const m = app.match(/L\.tileLayer\(\s*"([^"]*World_Boundaries_and_Places[^"]*)"/);
    assert.ok(m, "label layer present");
    assert.match(m[1], /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/Reference\/World_Boundaries_and_Places\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/);
    assert.equal(/token=|key=/i.test(m[1]), false);
    assert.match(app, /attribution: "Labels: Esri, HERE, Garmin, \(c\) OpenStreetMap contributors"/);
  });

  it("sits above the imagery and below the drawn box, and never takes clicks", () => {
    const z = Number((app.match(/labelPane\.style\.zIndex = "(\d+)"/) || [])[1]);
    assert.ok(z > 200 && z < 400, "between tilePane and overlayPane");
    assert.match(app, /labelPane\.style\.pointerEvents = "none"/);
    assert.match(app, /pane: "labels"/);
  });

  it("hides past the cap so shop and park names do not cover a site", () => {
    const cap = Number((app.match(/const MAP_LABEL_MAX_ZOOM = (\d+);/) || [])[1]);
    assert.ok(cap >= 10 && cap <= 16, "cap " + cap);
    assert.match(app, /maxZoom: MAP_LABEL_MAX_ZOOM/);
  });

  it("is never fetched by the export path", () => {
    for (const dir of ["netlify", "fly"]) {
      for (const f of serverFiles(path.join(root, dir))) {
        assert.equal(fs.readFileSync(f, "utf8").includes(LABELS), false, path.relative(root, f));
      }
    }
  });
});
