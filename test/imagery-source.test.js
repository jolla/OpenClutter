"use strict";

const test = require("node:test");
const assert = require("node:assert");
const S = require("../netlify/lib/imagery-source");

const VEGAS = { west: -115.1735, south: 36.1195, east: -115.1655, north: 36.1255 };
const AMSTERDAM = { west: 4.889, south: 52.369, east: 4.899, north: 52.375 };
const TOKYO = { west: 139.76, south: 35.68, east: 139.77, north: 35.69 };
const FRAME = { west: 4.889, south: 52.369, east: 4.899, north: 52.375, imgW: 64, imgH: 64 };

test("imagery source router", async (t) => {
  await t.test("Esri is the default and unknown values fall back to it", () => {
    assert.equal(S.normalizeChoice(undefined), "esri");
    assert.equal(S.normalizeChoice("bogus"), "esri");
    const ctx = S.createImageryContext(undefined, VEGAS);
    assert.equal(ctx.source.id, "esri");
  });

  await t.test("Auto picks NAIP in the lower 48 and a national source in Europe", () => {
    assert.equal(S.createImageryContext("auto", VEGAS, { fetch: async () => ({ ok: false, status: 500 }) }).source.id, "naip");
    assert.equal(S.createImageryContext("auto", AMSTERDAM).source.id, "pdok-nl");
    assert.equal(S.createImageryContext("auto", TOKYO).source.id, "esri");
  });

  await t.test("NLS needs its key; without it Finland is not routed there", () => {
    const fi = { west: 24.935, south: 60.167, east: 24.95, north: 60.173 };
    assert.equal(S.createImageryContext("national", fi, { env: {} }).source.id, "esri");
    assert.equal(S.createImageryContext("national", fi, { env: { NLS_API_KEY: "x" } }).source.id, "nls-fi");
  });

  await t.test("a source that does not cover the area hands the plate to Esri and says why", async () => {
    const ctx = S.createImageryContext("naip", TOKYO);
    const buf = await S.fetchPlateWith(ctx, FRAME, 10000, null, async () => Buffer.from("esri"));
    assert.equal(String(buf), "esri");
    const info = S.imageryInfo(ctx);
    assert.equal(info.id, "esri");
    assert.equal(info.fallback, true);
    assert.match(S.imageryLine(info), /Asked for NAIP, used Esri: NAIP covers the lower 48 US only\./);
  });

  await t.test("a failing national service falls back to Esri", async () => {
    const ctx = S.createImageryContext("national", AMSTERDAM, { fetch: async () => ({ ok: false, status: 503 }) });
    const buf = await S.fetchPlateWith(ctx, FRAME, 10000, null, async () => Buffer.from("esri"));
    assert.equal(String(buf), "esri");
    const info = S.imageryInfo(ctx);
    assert.equal(info.fallback, true);
    assert.match(info.reason, /PDOK failed \(HTTP 503\)/);
  });

  await t.test("WMS 1.3.0 asks lat,lon order and 1.1.1 lon,lat", () => {
    const ign = S.NATIONAL.find((p) => p.id === "ign-fr");
    const pdok = S.NATIONAL.find((p) => p.id === "pdok-nl");
    const ext = { west: 2, south: 48, east: 3, north: 49 };
    assert.match(S.wmsUrl(ign, ext, 10, 10), /CRS=EPSG:4326&BBOX=48,2,49,3/);
    assert.match(S.wmsUrl(pdok, ext, 10, 10), /SRS=EPSG:4326&BBOX=2,48,3,49/);
  });

  await t.test("NAIP item coverage tests every window corner", () => {
    const item = { geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } };
    assert.equal(S.itemCovers(item, { west: 0.1, south: 0.1, east: 0.9, north: 0.9 }), true);
    assert.equal(S.itemCovers(item, { west: 0.1, south: 0.1, east: 1.1, north: 0.9 }), false);
  });
});
