"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { runBackgroundExport, setFetchOvertureForTests, setFetchTerrainDemForTests, setFetchChmGridForTests, setFetchWorldCoverForTests } = require("../netlify/functions/clutter");

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(120, 1), Buffer.from([0xff, 0xd9])]);

function tallBox() {
  const mpdLon = 111320 * Math.cos((40 * Math.PI) / 180);
  return {
    west: -90,
    south: 40,
    east: -90 + 450 / mpdLon,
    north: 40 + 580 / 110540,
    name: "Tall plate",
  };
}

function sideOf(url) {
  const match = /size=(\d+),(\d+)/.exec(String(url));
  if (!match) return 0;
  return Math.max(+match[1], +match[2]);
}

describe("imagery stepdown", () => {
  const prev = global.fetch;

  afterEach(() => {
    global.fetch = prev;
    setFetchOvertureForTests(null);
    setFetchTerrainDemForTests(null);
    setFetchChmGridForTests(null);
    setFetchWorldCoverForTests(null);
  });

  it("keeps the next finer plate when the pixel-capped plate does not return", async () => {
    setFetchOvertureForTests(async () => ({ features: [] }));
    setFetchTerrainDemForTests(async () => null);
    setFetchChmGridForTests(async () => null);
    setFetchWorldCoverForTests(async () => null);
    const images = [];
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("World_Imagery") && u.includes("f=image")) {
        const side = sideOf(u);
        images.push(side);
        if (side > 3000) return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
        return { ok: true, arrayBuffer: async () => jpeg };
      }
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return { ok: true, json: async () => ({ width: 64, height: 64 }) };
      }
      return { ok: true, json: async () => ({ features: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const res = await runBackgroundExport(
      {
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({
          ...tallBox(),
          includeFoliage: false,
          includeTerrain: false,
          includeRvs: false,
          format: "bundle",
          legacyFetch: true,
        }),
      },
      () => {}
    );
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
    const body = JSON.parse(res.body);
    // The sharp plate is refused with HTTP 500, so /dev reports the finest imagery there.
    const note = (body.warnings || []).find((line) => /^Map (stepped down|image \d+ px.*finest)/.test(String(line))) || "";
    const stepped = /stepped down to (\d+) px from (\d+) px/.exec(note) || /Map image (\d+) px.*sharper plates up to (\d+) px/.exec(note);
    assert.ok(stepped, note || (body.warnings || []).join(" | "));
    const kept = +stepped[1];
    const asked = +stepped[2];
    assert.ok(asked > 3000, "asked " + asked);
    assert.ok(kept > 1800 && kept < asked, "kept " + kept + " from " + asked);
    const big = images.filter((side) => side > 3000);
    assert.equal(new Set(big).size, big.length > 0 ? 1 : 0);
    assert.ok(images.some((side) => side === kept || (side > 1800 && side < 3000)), images.join(","));
  });

  it("resilient /dev path tiles the next plate and keeps it", async () => {
    const jpegJs = require("jpeg-js");
    setFetchOvertureForTests(async () => ({ features: [] }));
    setFetchTerrainDemForTests(async () => null);
    setFetchChmGridForTests(async () => null);
    setFetchWorldCoverForTests(async () => null);
    const images = [];
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("World_Imagery") && u.includes("f=image")) {
        const m = /size=(\d+),(\d+)/.exec(u);
        const w = +m[1];
        const h = +m[2];
        images.push(Math.max(w, h));
        // Esri answers 500 "Error: bytes" for a pitch finer than it holds.
        const bb = /bbox=([^&]+)/.exec(u)[1].split(",").map(Number);
        if (((bb[3] - bb[1]) * 110540) / h < 0.25) return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
        const data = Buffer.alloc(w * h * 4, 90);
        const buf = Buffer.from(jpegJs.encode({ data, width: w, height: h }, 50).data);
        return { ok: true, arrayBuffer: async () => buf };
      }
      if (u.includes("World_Imagery") && u.includes("f=json")) {
        return { ok: true, json: async () => ({ width: 64, height: 64 }) };
      }
      return { ok: true, json: async () => ({ features: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const res = await runBackgroundExport(
      {
        httpMethod: "POST",
        headers: { host: "dev--openclutter.netlify.app" },
        body: JSON.stringify({
          ...tallBox(),
          includeFoliage: false,
          includeTerrain: false,
          includeRvs: false,
          format: "bundle",
        }),
      },
      () => {}
    );
    assert.equal(res.statusCode, 200, String(res.body).slice(0, 400));
    const body = JSON.parse(res.body);
    // The sharp plate is refused with HTTP 500, so /dev reports the finest imagery there.
    const note = (body.warnings || []).find((line) => /^Map (stepped down|image \d+ px.*finest)/.test(String(line))) || "";
    const stepped = /stepped down to (\d+) px from (\d+) px/.exec(note) || /Map image (\d+) px.*sharper plates up to (\d+) px/.exec(note);
    assert.ok(stepped, note || (body.warnings || []).join(" | "));
    assert.ok(+stepped[1] > 1800 && +stepped[1] < +stepped[2], note);
    assert.ok(images.some((side) => side < 2000 && side > 900), images.join(","));
  });
});
