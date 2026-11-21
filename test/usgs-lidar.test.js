"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  projectYear,
  rankProjects,
  gpsDay,
  gridFromPoints,
  canopyCellM,
  canopyRaster,
  applyLidarSample,
  storageYards,
  lidarStatusLine,
  fetchUsgsLidar,
  finishPartialLidar,
  mercator,
  HEIGHT_SOURCE,
  km2Of,
  getBuf,
  getJson,
  setLidarCacheDir,
  setLidarCacheLimits,
  pruneLidarCache,
  fetchTimeoutMs,
  TILE_FETCH_MS,
  TILE_FETCH_CONCURRENCY,
  LIDAR_CACHE_MAX_BYTES,
  LIDAR_CACHE_TTL_MS,
} = require("../netlify/lib/usgs-lidar");

const frame = { west: -115.17, south: 36.12, east: -115.16, north: 36.13 };
const CELL = 10;

function origin() {
  return mercator(frame.west, frame.south);
}

function corner(ix, iy) {
  const o = origin();
  const x = o[0] + ix * CELL;
  const y = o[1] + iy * CELL;
  const R = 20037508.342789244;
  const lon = (x * 180) / R;
  const lat = (Math.atan(Math.sinh((y * Math.PI) / R)) * 180) / Math.PI;
  return [lon, lat];
}

function pt(ix, iy, z, cls, extra) {
  const o = origin();
  return Object.assign(
    {
      x: o[0] + (ix + 0.5) * CELL,
      y: o[1] + (iy + 0.5) * CELL,
      z,
      cls,
      ret: 1,
      nret: 1,
    },
    extra || {}
  );
}

function ringAround(x0, y0, x1, y1) {
  const ring = [corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1)];
  ring.push(ring[0]);
  return ring;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    if (yi > lat === yj > lat) continue;
    const x = ((ring[j][0] - ring[i][0]) * (lat - yi)) / (yj - yi) + ring[i][0];
    if (lon < x) inside = !inside;
  }
  return inside;
}

describe("USGS lidar", () => {
  it("reads a project year from the EPT name", () => {
    assert.equal(projectYear("NV_ClarkCo_2_B22"), 2022);
    assert.equal(projectYear("NV_Southern_5_D23"), 2023);
    assert.equal(projectYear("USGS_LPC_NV_LasVegas_QL1_2016_LAS_2018"), 2018);
    assert.equal(projectYear("WI_StWide_8_Marathon_2021"), 2021);
  });

  it("turns adjusted GPS seconds into the flight day", () => {
    assert.equal(gpsDay(342964556.433), "2022-07-27");
  });

  it("picks a Nevada project for the Wynn box and a Wisconsin project for Granite Peak", () => {
    const wynn = rankProjects({ west: -115.16942, south: 36.120084, east: -115.153863, north: 36.131185 });
    assert.ok(wynn.length);
    assert.match(wynn[0][0], /^NV_/);
    const granite = rankProjects({ west: -89.7, south: 44.91, east: -89.684, north: 44.926 });
    assert.ok(granite.length);
    assert.match(granite[0][0], /^WI_/);
    const montreal = rankProjects({ west: -73.57, south: 45.5, east: -73.565, north: 45.5035 });
    assert.equal(montreal.length, 0);
  });

  it("skips downtown Montreal without calling the network", async () => {
    let called = 0;
    const sample = await fetchUsgsLidar(
      { west: -73.57, south: 45.5, east: -73.565, north: 45.5035 },
      {
        fetchImpl() {
          called++;
          throw new Error("network");
        },
      }
    );
    assert.equal(called, 0);
    assert.equal(sample.skipped, "outside-3dep");
    assert.match(sample.warning, /Quebec open lidar/);
    assert.ok(km2Of(sample.frame) > 0);
  });

  it("builds canopy height from first returns minus ground and leaves a roof out", () => {
    const points = [];
    for (let ix = 2; ix <= 6; ix++) {
      for (let iy = 2; iy <= 6; iy++) {
        points.push(pt(ix, iy, 5, 2));
        points.push(pt(ix, iy, 5.2, 2));
        points.push(pt(ix, iy, 18, 5));
        points.push(pt(ix, iy, 16, 4));
      }
    }
    points.push(pt(8, 8, 5, 2), pt(8, 8, 5.1, 2), pt(8, 8, 30, 6), pt(8, 8, 29, 6));
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    let crown = null;
    for (const rec of grid.cells.values()) {
      if (rec.ix === 4 && rec.iy === 4) crown = canopyCellM(grid, rec);
      if (rec.ix === 8 && rec.iy === 8) assert.equal(canopyCellM(grid, rec), null);
    }
    assert.ok(crown > 12 && crown < 14, crown);
    const lone = gridFromPoints([pt(1, 1, 5, 2), pt(1, 1, 5, 2), pt(1, 1, 22, 5)], frame, { cellM: CELL, spacingM: 2 });
    for (const rec of lone.cells.values()) {
      if (rec.fc) assert.equal(canopyCellM(lone, rec), null);
    }
    const raster = canopyRaster(grid);
    assert.equal(raster.source, "lidar");
    assert.ok(raster.nonzero >= 20);
  });

  it("sets a footprint height from the 90th percentile of class 6 minus ground", () => {
    const points = [];
    for (let ix = 2; ix <= 6; ix++) {
      for (let iy = 2; iy <= 6; iy++) points.push(pt(ix, iy, 5, 2));
    }
    const roofs = [18, 18, 18, 18, 18, 18, 18, 19, 40];
    for (let i = 0; i < roofs.length; i++) points.push(pt(3 + (i % 3), 3 + Math.floor(i / 3), roofs[i], 6));
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const feature = {
      type: "Feature",
      properties: { height: 9, heightSource: "overture" },
      geometry: { type: "Polygon", coordinates: [ringAround(2, 2, 8, 8)] },
    };
    const applied = applyLidarSample([feature], [], grid);
    assert.equal(applied.heights, 1);
    assert.equal(applied.features[0].properties.heightSource, HEIGHT_SOURCE);
    assert.equal(applied.features[0].properties.height, 14);
    assert.equal(applied.added, 0);
  });

  it("adds an L-shaped roof the street map missed and leaves vegetation out", () => {
    const points = [];
    for (let ix = 8; ix <= 18; ix++) {
      for (let iy = 8; iy <= 18; iy++) points.push(pt(ix, iy, 4, 2));
    }
    for (let ix = 10; ix <= 15; ix++) {
      for (let iy = 10; iy <= 12; iy++) points.push(pt(ix, iy, 16, 6));
    }
    for (let ix = 10; ix <= 12; ix++) {
      for (let iy = 13; iy <= 16; iy++) points.push(pt(ix, iy, 16, 6));
    }
    for (let ix = 14; ix <= 15; ix++) {
      for (let iy = 14; iy <= 16; iy++) points.push(pt(ix, iy, 20, 5, { nret: 3, ret: 1 }));
    }
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const applied = applyLidarSample([], [], grid);
    assert.equal(applied.added, 1);
    const ring = applied.features[0].geometry.coordinates[0];
    assert.ok(ring.length >= 5);
    assert.equal(applied.features[0].properties.heightSource, HEIGHT_SOURCE);
    assert.ok(applied.features[0].properties.height >= 10);
    const notch = corner(14.5, 15.5);
    assert.equal(pointInRing(notch[0], notch[1], ring), false);
    const bar = corner(13.5, 11.5);
    assert.equal(pointInRing(bar[0], bar[1], ring), true);
  });

  it("does not replace a tower with a low coarse sample", () => {
    const points = [];
    for (let ix = 2; ix <= 6; ix++) {
      for (let iy = 2; iy <= 6; iy++) points.push(pt(ix, iy, 5, 2));
    }
    for (let i = 0; i < 8; i++) points.push(pt(3 + (i % 3), 3, 20, 6));
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const feature = {
      type: "Feature",
      properties: { height: 174, heightSource: "overture" },
      geometry: { type: "Polygon", coordinates: [ringAround(2, 2, 8, 8)] },
    };
    const applied = applyLidarSample([feature], [], grid);
    assert.equal(applied.heights, 0);
    assert.equal(applied.features[0].properties.height, 174);
    assert.equal(applied.features[0].properties.heightSource, "overture");
  });

  it("does not turn a bumpy unclassified crown into a building", () => {
    const points = [];
    for (let ix = 20; ix <= 28; ix++) {
      for (let iy = 20; iy <= 26; iy++) {
        points.push(pt(ix, iy, 5, 2));
        points.push(pt(ix, iy, 8, 1));
        points.push(pt(ix, iy, 14, 1));
        points.push(pt(ix, iy, 22, 1));
      }
    }
    for (let ix = 30; ix <= 36; ix++) {
      for (let iy = 20; iy <= 26; iy++) {
        points.push(pt(ix, iy, 5, 2));
        points.push(pt(ix, iy, 14, 1));
        points.push(pt(ix, iy, 14.4, 1));
        points.push(pt(ix, iy, 14.8, 1));
      }
    }
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const applied = applyLidarSample([], [], grid);
    assert.equal(applied.added, 1);
    const ring = applied.features[0].geometry.coordinates[0];
    const crown = corner(24.5, 23.5);
    const roof = corner(33.5, 23.5);
    assert.equal(pointInRing(crown[0], crown[1], ring), false);
    assert.equal(pointInRing(roof[0], roof[1], ring), true);
    assert.ok(applied.features[0].properties.height > 8);
    assert.ok(applied.features[0].properties.height < 12);
  });

  it("updates a tree from high vegetation and leaves a building height alone when the cloud is only trees", () => {
    const points = [];
    for (let ix = 2; ix <= 5; ix++) points.push(pt(ix, 2, 6, 2));
    points.push(pt(3, 3, 22, 5, { nret: 3, ret: 1 }));
    points.push(pt(3, 3, 21, 5, { nret: 3, ret: 2 }));
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const tree = { lon: corner(3.5, 3.5)[0], lat: corner(3.5, 3.5)[1], heightM: 8 };
    const building = {
      type: "Feature",
      properties: { height: 11, heightSource: "overture" },
      geometry: { type: "Polygon", coordinates: [ringAround(2, 2, 6, 6)] },
    };
    const applied = applyLidarSample([building], [tree], grid);
    assert.equal(applied.heights, 0);
    assert.equal(applied.features[0].properties.height, 11);
    assert.equal(applied.canopy, 1);
    assert.equal(applied.trees[0].heightSource, HEIGHT_SOURCE);
    assert.ok(applied.trees[0].heightM > 10);
  });

  it("reads a stacked yard beside a warehouse and leaves the roof alone", () => {
    const points = [];
    for (let ix = 0; ix <= 30; ix++) {
      for (let iy = 0; iy <= 24; iy++) points.push(pt(ix, iy, 280, 2));
    }
    for (let ix = 8; ix <= 22; ix++) {
      for (let iy = 0; iy <= 4; iy++) {
        points.push(pt(ix, iy, 283.6, 1));
        points.push(pt(ix, iy, 284.0, 1));
        points.push(pt(ix, iy, 284.4, 1));
      }
    }
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const host = {
      type: "Feature",
      properties: { height: 12, heightSource: "warehouse" },
      geometry: { type: "Polygon", coordinates: [ringAround(4, 6, 28, 22)] },
    };
    const applied = applyLidarSample([host], [], grid);
    assert.equal(applied.added, 0);
    assert.ok(applied.yards && applied.yards.length >= 1, "yards " + (applied.yards && applied.yards.length));
    const yard = applied.yards[0];
    assert.equal(yard.kind, "storage");
    assert.ok(yard.heightM >= 2.1 && yard.heightM <= 8, "height " + yard.heightM);
    assert.equal(applied.features[0].properties.heightSource, "warehouse");
  });

  it("does not turn canopy vegetation into a stacked yard", () => {
    const points = [];
    for (let ix = 0; ix <= 30; ix++) {
      for (let iy = 0; iy <= 24; iy++) points.push(pt(ix, iy, 280, 2));
    }
    for (let ix = 8; ix <= 22; ix++) {
      for (let iy = 0; iy <= 4; iy++) {
        points.push(pt(ix, iy, 286, 5));
        points.push(pt(ix, iy, 284, 5));
      }
    }
    const grid = gridFromPoints(points, frame, { cellM: CELL, spacingM: 2 });
    const host = ringAround(4, 6, 28, 22);
    const yards = storageYards(grid, [host]);
    assert.equal(yards.length, 0);
  });

  it("says whether lidar heights were used", () => {
    assert.equal(lidarStatusLine(null), "Lidar heights not used.");
    assert.equal(lidarStatusLine({ skipped: "outside" }), "Lidar heights not used.");
    assert.equal(lidarStatusLine({ heights: 0, added: 0 }), "Lidar heights not used.");
    assert.equal(lidarStatusLine({ heights: 4, added: 0 }), "Lidar heights used.");
    assert.equal(lidarStatusLine({ heights: 0, added: 2 }), "Lidar heights used.");
    assert.equal(lidarStatusLine({ skipped: "outside", heights: 4 }), "Lidar heights not used.");
  });

  it("does not rerun a lidar read that already finished", async () => {
    let calls = 0;
    const first = { partial: false, points: 100, skipped: null };
    const out = await finishPartialLidar(first, frame, {
      fetchLidar: async () => {
        calls++;
        return { partial: false, points: 999 };
      },
    });
    assert.equal(calls, 0);
    assert.equal(out, first);
  });

  it("retries a partial lidar read once the export is no longer busy", async () => {
    let calls = 0;
    const first = { partial: true, points: 285011, skipped: null };
    const fuller = { partial: false, points: 2320204, skipped: null };
    const out = await finishPartialLidar(first, frame, {
      fetchLidar: async () => {
        calls++;
        return fuller;
      },
    });
    assert.equal(calls, 1);
    assert.equal(out, fuller);
  });

  it("keeps the first lidar read when the retry is not fuller", async () => {
    const first = { partial: true, points: 400, skipped: null };
    const out = await finishPartialLidar(first, frame, {
      fetchLidar: async () => ({ partial: true, points: 100, skipped: null }),
    });
    assert.equal(out, first);
  });

  it("clips a hung lidar server to 8 s, or to the time left on the stage cap", () => {
    assert.equal(TILE_FETCH_MS, 8000);
    assert.equal(TILE_FETCH_CONCURRENCY, 4);
    assert.equal(fetchTimeoutMs(0), 8000);
    assert.equal(fetchTimeoutMs(Date.now() - 10), 0);
    const left = fetchTimeoutMs(Date.now() + 1500);
    assert.ok(left >= 250 && left <= 1500, left);
  });

  it("reuses a cached lidar tile so a second read does not hit the network", async () => {
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "oc-lidar-cache-"));
    setLidarCacheDir(dir);
    let calls = 0;
    const prev = global.fetch;
    global.fetch = async () => {
      calls++;
      return {
        ok: true,
        arrayBuffer: async () => Buffer.from("LAZDATA"),
        text: async () => "{\"ok\":true}",
      };
    };
    try {
      const first = await getBuf("https://example.test/tile.laz");
      const second = await getBuf("https://example.test/tile.laz");
      assert.equal(calls, 1);
      assert.equal(first.toString(), "LAZDATA");
      assert.equal(second.toString(), "LAZDATA");
      const jsonA = await getJson("https://example.test/ept.json");
      const jsonB = await getJson("https://example.test/ept.json");
      assert.equal(calls, 2);
      assert.deepEqual(jsonA, { ok: true });
      assert.deepEqual(jsonB, { ok: true });
    } finally {
      global.fetch = prev;
      setLidarCacheDir(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not use the disk cache when a test supplies its own fetch", async () => {
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "oc-lidar-cache-"));
    setLidarCacheDir(dir);
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: true, arrayBuffer: async () => Buffer.from("X") };
    };
    try {
      await getBuf("https://example.test/no-cache.laz", fetchImpl);
      await getBuf("https://example.test/no-cache.laz", fetchImpl);
      assert.equal(calls, 2);
    } finally {
      setLidarCacheDir(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops an expired lidar cache tile and evicts the oldest when the size cap is reached", async () => {
    assert.equal(LIDAR_CACHE_MAX_BYTES, 512 * 1024 * 1024);
    assert.equal(LIDAR_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "oc-lidar-cache-"));
    setLidarCacheDir(dir);
    setLidarCacheLimits({ maxBytes: 12, ttlMs: 60 * 1000 });
    const prev = global.fetch;
    let calls = 0;
    global.fetch = async (url) => {
      calls++;
      const body = String(url).indexOf("a.laz") >= 0 ? "AAAA" : String(url).indexOf("b.laz") >= 0 ? "BBBB" : "CCCC";
      return { ok: true, arrayBuffer: async () => Buffer.from(body) };
    };
    try {
      await getBuf("https://example.test/a.laz");
      await getBuf("https://example.test/b.laz");
      const stale = path.join(dir, require("crypto").createHash("sha1").update("https://example.test/a.laz").digest("hex").slice(0, 2));
      // Expire A by backdating its cache file.
      function findFile(root, skipTmp) {
        const names = fs.readdirSync(root);
        for (const name of names) {
          const full = path.join(root, name);
          const st = fs.statSync(full);
          if (st.isDirectory()) {
            const got = findFile(full, skipTmp);
            if (got) return got;
          } else if (!skipTmp || name.indexOf(".tmp") < 0) return full;
        }
        return null;
      }
      // Re-read A so it exists, then expire it.
      const firstA = await getBuf("https://example.test/a.laz");
      assert.equal(firstA.toString(), "AAAA");
      const aFile = findFile(dir, true);
      assert.ok(aFile);
      const old = new Date(Date.now() - 120 * 1000);
      fs.utimesSync(aFile, old, old);
      const missed = await getBuf("https://example.test/a.laz");
      assert.equal(missed.toString(), "AAAA");
      assert.ok(calls >= 2, "expired tile must be fetched again, calls=" + calls);

      setLidarCacheLimits({ maxBytes: 6, ttlMs: 60 * 60 * 1000 });
      await getBuf("https://example.test/b.laz");
      await getBuf("https://example.test/c.laz");
      const pruned = await pruneLidarCache();
      assert.ok(pruned.bytes <= 6, "bytes " + pruned.bytes);
      // The cache must stay under the cap; at least one of the 4-byte tiles is gone.
      let total = 0;
      function walk(root) {
        for (const name of fs.readdirSync(root)) {
          const full = path.join(root, name);
          const st = fs.statSync(full);
          if (st.isDirectory()) walk(full);
          else if (name.indexOf(".tmp") < 0) total += st.size;
        }
      }
      walk(dir);
      assert.ok(total <= 6, "on-disk " + total);
    } finally {
      global.fetch = prev;
      setLidarCacheLimits(undefined);
      setLidarCacheDir(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends lidar from the Advanced toggle, off unless checked", () => {
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const clutter = fs.readFileSync(path.join(__dirname, "../netlify/functions/clutter.js"), "utf8");
    const toml = fs.readFileSync(path.join(__dirname, "../netlify.toml"), "utf8");
    assert.match(html, /id="include-lidar"/);
    assert.equal(/id="include-lidar"[^>]*checked/.test(html), false);
    assert.match(html, />\s*Lidar heights\s*</);
    // Info tip: a small (i) beside the toggle; hover shows the title, a tap opens the hint below.
    const tipAt = html.indexOf('id="lidar-tip-btn"');
    assert.ok(tipAt > html.indexOf('id="include-lidar"'));
    assert.match(html, /<button type="button" class="info-tip" id="lidar-tip-btn"[^>]*aria-controls="lidar-tip"[^>]*title="Uses USGS 3DEP lidar/);
    assert.match(html, /<p id="lidar-tip" class="hint" hidden>Uses USGS 3DEP lidar/);
    assert.equal(/\u2014/.test(html), false);
    assert.match(app, /lidarTip\.hidden = !lidarTip\.hidden/);
    assert.match(app, /function lidarEnabled\(\)/);
    assert.match(app, /get\("lidar"\)/);
    assert.match(app, /raw === "1"/);
    assert.match(app, /include-lidar/);
    assert.match(app, /Lidar heights \(used\|not used\)/);
    assert.equal(app.split("lidar: lidarEnabled()").length, 3);
    assert.match(clutter, /devHost && \(body\.lidar === true/);
    assert.match(clutter, /lidarStatusLine\(lidar\)/);
    assert.match(clutter, /Lidar heights not used\./);
    assert.match(toml, /external_node_modules = \["laz-perf"\]/);
  });
});
