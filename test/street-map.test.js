"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { gapQuery, GAP_DEADLINE_MS, STREET_OVERTURE_ATTEMPTS, capGapDeadline, fetchStreetMaps, fetchGapOverpass, gapEmptyWarning, setGapCacheDir, setGapCacheLimits, GAP_MISS, GAP_CACHE_MAX_BYTES, GAP_CACHE_TTL_MS, resetForTests } = require("../netlify/lib/street-map");
const streetPersist = require("../netlify/lib/overture-street-cache");

const BOX = { west: -90.5276, south: 41.5786, east: -90.523, north: 41.5823 };

describe("street-map gap query", () => {
  it("caps the gap Overpass wait at 25 seconds so it does not gate a successful Overture read", () => {
    assert.equal(GAP_DEADLINE_MS, 25000);
    assert.equal(capGapDeadline(105000), 25000);
    assert.equal(capGapDeadline(90000), 25000);
    assert.equal(capGapDeadline(10000), 10000);
    assert.equal(capGapDeadline(0), 25000);
    assert.equal(capGapDeadline(undefined), 25000);
  });

  it("asks for camp, building parts, palms, moorings, and area:highway, not for ordinary roads or fences", () => {
    const q = gapQuery(BOX);
    assert.match(q, /building:part/);
    assert.match(q, /tourism"="caravan_site/);
    assert.match(q, /tourism"="camp_pitch/);
    assert.match(q, /area:highway/);
    assert.match(q, /mooring/);
    assert.match(q, /leaf_type"="palm/);
    assert.match(q, /natural"="coastline/);
    assert.doesNotMatch(q, /highway"~"\^\(motorway/);
    assert.doesNotMatch(q, /barrier"~/);
    assert.doesNotMatch(q, /railway"~/);
    assert.doesNotMatch(q, /natural"="wood/);
  });
});

describe("street-map coordinator", () => {
  beforeEach(() => {
    resetForTests();
    streetPersist.resetForTests();
    streetPersist.setStoreForTests(null);
  });
  afterEach(() => {
    resetForTests();
    streetPersist.resetForTests();
  });

  it("merges Overture elements with the gap Overpass answer and does not start a full map read", async () => {
    let full = 0;
    const got = await fetchStreetMaps(BOX, {
      fetchOvertureStreet: async () => ({
        ok: true,
        elements: [{ type: "way", id: "ov-1", tags: { highway: "service" }, geometry: [{ lon: -90.525, lat: 41.58 }] }],
        notes: [],
        themes: { segment: 1 },
      }),
      fetchGapOverpass: async () => ({
        ok: true,
        elements: [{ type: "way", id: 99, tags: { tourism: "caravan_site" }, geometry: [{ lon: -90.525, lat: 41.581 }, { lon: -90.524, lat: 41.581 }] }],
      }),
      fetchOsmMaps: async () => {
        full += 1;
        return { xmls: ["<osm/>"], elements: [], notes: [], tiled: false, incomplete: false };
      },
    });
    assert.equal(got.source, "overture");
    assert.equal(full, 0);
    assert.equal(got.xmls.length, 0);
    const ids = got.elements.map((e) => String(e.id)).sort();
    assert.deepEqual(ids, ["99", "ov-1"]);
    assert.equal(got.elements.find((e) => e.id === "ov-1").tags.highway, "service");
    assert.equal(got.elements.find((e) => e.id === 99).tags.tourism, "caravan_site");
  });

  it("falls back to the full Overpass path when Overture fails, and keeps the gap marina features", async () => {
    let full = 0;
    const marina = {
      type: "way",
      id: 77,
      tags: { leisure: "marina" },
      geometry: [
        { lon: -90.525, lat: 41.58 },
        { lon: -90.524, lat: 41.58 },
        { lon: -90.524, lat: 41.581 },
        { lon: -90.525, lat: 41.58 },
      ],
    };
    const road = { type: "way", id: 5, tags: { highway: "service" }, geometry: [{ lon: -90.525, lat: 41.58 }] };
    const got = await fetchStreetMaps(BOX, {
      fetchOvertureStreet: async () => ({ ok: false, elements: [], error: "timeout" }),
      fetchGapOverpass: async () => ({ ok: true, elements: [marina] }),
      fetchOsmMaps: async () => {
        full += 1;
        return { xmls: ["<osm></osm>"], elements: [road], notes: [], tiled: false, incomplete: false, source: "overpass" };
      },
    });
    assert.equal(full, 1);
    assert.equal(got.xmls[0], "<osm></osm>");
    assert.notEqual(got.source, "overture");
    assert.match((got.notes || []).join(" "), /Overture street-map read failed/);
    assert.equal(got.elements.find((e) => e.id === 77).tags.leisure, "marina");
    assert.equal(got.elements.find((e) => e.id === 5).tags.highway, "service");
  });

  it("retries a transient Overture failure once and keeps the Overture path", async () => {
    assert.equal(STREET_OVERTURE_ATTEMPTS, 2);
    let n = 0;
    let full = 0;
    const got = await fetchStreetMaps(BOX, {
      fetchOvertureStreet: async () => {
        n += 1;
        if (n === 1) return { ok: false, elements: [], error: "timed out after 30000ms" };
        return {
          ok: true,
          elements: [{ type: "way", id: "ov-retry", tags: { leisure: "marina" }, geometry: [{ lon: -90.525, lat: 41.58 }] }],
          notes: [],
          themes: { land_use: 1 },
        };
      },
      fetchGapOverpass: async () => ({ ok: true, elements: [] }),
      fetchOsmMaps: async () => {
        full += 1;
        return { xmls: ["<osm/>"], elements: [], notes: [], tiled: false, incomplete: false };
      },
    });
    assert.equal(n, 2);
    assert.equal(full, 0);
    assert.equal(got.source, "overture");
    assert.equal(got.elements[0].id, "ov-retry");
    assert.equal(got.elements[0].tags.leisure, "marina");
  });

  it("does not retry a non-transient Overture failure, and puts the error in the fallback note", async () => {
    let n = 0;
    const got = await fetchStreetMaps(BOX, {
      fetchOvertureStreet: async () => {
        n += 1;
        return { ok: false, elements: [], error: "bad overture street index" };
      },
      fetchGapOverpass: async () => ({ ok: true, elements: [] }),
      fetchOsmMaps: async () => ({ xmls: ["<osm></osm>"], elements: [], notes: [], source: "overpass" }),
    });
    assert.equal(n, 1);
    assert.equal(got.source, "overpass");
    assert.match((got.notes || []).join(" "), /Overture street-map read failed \(bad overture street index\)/);
  });

  it("does not let a long outdoor deadline stretch the gap Overpass wait past 25 seconds", async () => {
    let gapDeadline = null;
    await fetchStreetMaps(BOX, {
      deadlineMs: 105000,
      fetchOvertureStreet: async () => ({ ok: true, elements: [], notes: [], themes: {} }),
      fetchGapOverpass: async (_bbox, o) => {
        gapDeadline = o && o.deadlineMs;
        return { ok: true, elements: [] };
      },
      fetchOsmMaps: async () => ({ xmls: [], elements: [] }),
    });
    assert.equal(gapDeadline, 25000);
  });

  it("reuses one in-flight read for a second caller of the same box", async () => {
    let n = 0;
    const fetchOvertureStreet = async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, elements: [{ type: "node", id: "a", lon: -90.525, lat: 41.58, tags: { highway: "street_lamp" } }], notes: [], themes: {} };
    };
    const opts = { fetchOvertureStreet, fetchGapOverpass: async () => ({ ok: true, elements: [] }), fetchOsmMaps: async () => ({ xmls: [], elements: [] }) };
    const [a, b] = await Promise.all([fetchStreetMaps(BOX, opts), fetchStreetMaps(BOX, opts)]);
    assert.equal(n, 1);
    assert.equal(a.source, "overture");
    assert.equal(b.source, "overture");
    assert.equal(a.elements.length, 1);
  });

  it("reuses a saved Overture street map after both live attempts fail", async () => {
    const store = new Map();
    streetPersist.setStoreForTests(store);
    const marina = { type: "way", id: "ov-marina", tags: { leisure: "marina" }, geometry: [{ lon: -90.525, lat: 41.58 }] };
    let live = 0;
    let full = 0;
    const gap = { ok: true, elements: [{ type: "way", id: 99, tags: { mooring: "yes" }, geometry: [{ lon: -90.525, lat: 41.581 }] }] };
    const first = await fetchStreetMaps(BOX, {
      fetchOvertureStreet: async () => {
        live += 1;
        return { ok: true, elements: [marina], notes: [], themes: { land_use: 1 }, release: "2026-10-21.0" };
      },
      fetchGapOverpass: async () => gap,
      fetchOsmMaps: async () => {
        full += 1;
        return { xmls: ["<osm/>"], elements: [], notes: [], source: "overpass" };
      },
    });
    assert.equal(first.source, "overture");
    assert.equal(live, 1);
    assert.equal(full, 0);
    resetForTests();
    live = 0;
    const second = await fetchStreetMaps(BOX, {
      fetchOvertureStreet: async () => {
        live += 1;
        return { ok: false, elements: [], error: "fetch failed" };
      },
      fetchGapOverpass: async () => gap,
      fetchOsmMaps: async () => {
        full += 1;
        return { xmls: ["<osm/>"], elements: [{ type: "way", id: 5, tags: { highway: "service" } }], notes: [], source: "overpass" };
      },
    });
    assert.equal(live, 2);
    assert.equal(full, 0);
    assert.equal(second.source, "overture");
    assert.equal(second.elements.find((e) => e.id === "ov-marina").tags.leisure, "marina");
    assert.equal(second.elements.find((e) => e.id === 99).tags.mooring, "yes");
    assert.match((second.notes || []).join(" "), /saved Overture copy/);
  });

  it("does not reuse an expired Overture street copy", async () => {
    const store = new Map();
    streetPersist.setStoreForTests(store);
    await streetPersist.writeStreetCache(BOX, {
      elements: [{ type: "way", id: "old", tags: { leisure: "marina" }, geometry: [{ lon: -90.525, lat: 41.58 }] }],
      themes: {},
      release: "2026-10-21.0",
    });
    const key = [...store.keys()][0];
    const entry = store.get(key);
    entry.savedAt = Date.now() - streetPersist.STREET_TTL_MS - 1000;
    store.set(key, entry);
    let full = 0;
    const got = await fetchStreetMaps(BOX, {
      fetchOvertureStreet: async () => ({ ok: false, elements: [], error: "fetch failed" }),
      fetchGapOverpass: async () => ({ ok: true, elements: [] }),
      fetchOsmMaps: async () => {
        full += 1;
        return { xmls: ["<osm/>"], elements: [], notes: [], source: "overpass" };
      },
    });
    assert.equal(full, 1);
    assert.equal(got.source, "overpass");
    assert.equal((got.elements || []).some((e) => e.id === "old"), false);
  });

  it("warns clearly when the Overpass map fallback fails or the extract is too large", async () => {
    const failed = await fetchStreetMaps(BOX, {
      fetchOvertureStreet: async () => ({ ok: false, elements: [], error: "forced failure" }),
      fetchGapOverpass: async () => ({ ok: true, elements: [] }),
      fetchOsmMaps: async () => ({ xmls: [], elements: [], notes: [], incomplete: true, tooBig: false }),
    });
    assert.match((failed.notes || []).join(" "), /full Overpass path also failed/);
    const other = Object.assign({}, BOX, { west: BOX.west - 0.01 });
    const huge = await fetchStreetMaps(other, {
      fetchOvertureStreet: async () => ({ ok: false, elements: [], error: "forced failure" }),
      fetchGapOverpass: async () => ({ ok: true, elements: [] }),
      fetchOsmMaps: async () => ({
        xmls: [],
        elements: [],
        notes: ["OpenStreetMap map extract omitted: the area is too large to download in one request."],
        incomplete: true,
        tooBig: true,
      }),
    });
    assert.match((huge.notes || []).join(" "), /full Overpass map was too large for this draw/);
    assert.ok(!(huge.notes || []).join(" ").includes("used the full Overpass path"));
    const part = Object.assign({}, BOX, { west: BOX.west - 0.02 });
    const split = await fetchStreetMaps(part, {
      fetchOvertureStreet: async () => ({ ok: false, elements: [], error: "forced failure" }),
      fetchGapOverpass: async () => ({ ok: true, elements: [] }),
      fetchOsmMaps: async () => ({
        xmls: ["<osm></osm>"],
        elements: [],
        notes: ["OpenStreetMap map extract is incomplete: 1 of 4 map tiles did not load, so some roads, parking, or building outlines may be missing in those parts of the draw."],
        incomplete: true,
        tooBig: false,
      }),
    });
    const splitNotes = (split.notes || []).join(" ");
    assert.match(splitNotes, /used the full Overpass path/);
    assert.match(splitNotes, /incomplete: 1 of 4 map tiles did not load/);
    assert.ok(!splitNotes.includes("too large for this draw"));
    assert.ok(!splitNotes.includes("also failed"));
  });
});

describe("street-map gap miss and cache", () => {
  beforeEach(() => {
    resetForTests();
    streetPersist.resetForTests();
    streetPersist.setStoreForTests(null);
  });
  afterEach(() => {
    resetForTests();
    streetPersist.resetForTests();
  });

  it("warns when Overture succeeds but the gap Overpass read fails", async () => {
    const got = await fetchStreetMaps(BOX, {
      fetchOvertureStreet: async () => ({
        ok: true,
        elements: [{ type: "way", id: "ov-1", tags: { highway: "service" }, geometry: [{ lon: -90.525, lat: 41.58 }] }],
        notes: [],
      }),
      fetchGapOverpass: async () => ({ ok: false, elements: [] }),
      fetchOsmMaps: async () => ({ xmls: [], elements: [], notes: [], tiled: false, incomplete: false }),
    });
    assert.equal(got.source, "overture");
    assert.ok(got.notes.some((n) => /gap features did not return/i.test(n)));
    assert.match(gapEmptyWarning({ ok: false, elements: [] }), /Marina boats/);
    assert.equal(gapEmptyWarning({ ok: true, elements: [{ id: 1 }] }), "");
  });

  it("reuses a cached gap pack so a later failure does not drop marina features", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const overpass = require("../netlify/lib/overpass");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-gap-cache-"));
    setGapCacheDir(dir);
    setGapCacheLimits({ maxBytes: 1024 * 1024, ttlMs: 60 * 1000 });
    assert.equal(GAP_CACHE_MAX_BYTES, 64 * 1024 * 1024);
    assert.equal(GAP_CACHE_TTL_MS, 14 * 24 * 60 * 60 * 1000);
    const marina = {
      type: "way",
      id: 77,
      tags: { leisure: "marina" },
      geometry: [
        { lon: -90.525, lat: 41.581 },
        { lon: -90.524, lat: 41.581 },
      ],
    };
    let n = 0;
    const orig = overpass.requestJson;
    overpass.requestJson = async () => {
      n += 1;
      if (n > 1) throw new Error("cache should hit");
      return { elements: [marina] };
    };
    try {
      const first = await fetchGapOverpass(BOX, { diskCache: true });
      const second = await fetchGapOverpass(BOX, { diskCache: true });
      assert.equal(first.elements.length, 1);
      assert.equal(second.elements.length, 1);
      assert.equal(second.cached, true);
      assert.equal(n, 1);
      assert.equal(GAP_MISS.indexOf("Marina boats") >= 0, true);
    } finally {
      overpass.requestJson = orig;
      setGapCacheDir(undefined);
      setGapCacheLimits(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries a missing gap body only with time left in the same deadline", async () => {
    const overpass = require("../netlify/lib/overpass");
    let n = 0;
    const deadlines = [];
    const orig = overpass.requestJson;
    overpass.requestJson = async (_q, o) => {
      n += 1;
      deadlines.push(o && o.deadlineMs);
      if (n === 1) return null;
      return {
        elements: [{ type: "way", id: 1, tags: { leisure: "marina" }, geometry: [{ lon: -90.525, lat: 41.581 }] }],
      };
    };
    try {
      const got = await fetchGapOverpass(BOX, { deadlineMs: 5000, diskCache: false });
      assert.equal(n, 2);
      assert.ok(deadlines[1] <= deadlines[0], "retry leftover " + deadlines.join(","));
      assert.equal(got.ok, true);
      assert.equal(got.elements.length, 1);
    } finally {
      overpass.requestJson = orig;
    }
  });

  it("does not start a second gap Overpass read after the deadline is spent", async () => {
    const overpass = require("../netlify/lib/overpass");
    let n = 0;
    const orig = overpass.requestJson;
    overpass.requestJson = async (_q, o) => {
      n += 1;
      const wait = Math.max(0, ((o && o.deadlineMs) || 0) + 5);
      await new Promise((resolve) => setTimeout(resolve, wait));
      return null;
    };
    try {
      const got = await fetchGapOverpass(BOX, { deadlineMs: 40, diskCache: false });
      assert.equal(n, 1);
      assert.equal(got.ok, false);
    } finally {
      overpass.requestJson = orig;
    }
  });
});
