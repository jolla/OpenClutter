"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { gapQuery, GAP_DEADLINE_MS, STREET_OVERTURE_ATTEMPTS, capGapDeadline, fetchStreetMaps, resetForTests } = require("../netlify/lib/street-map");
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
});
