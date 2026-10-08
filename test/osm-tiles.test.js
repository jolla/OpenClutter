"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { planTiles, bboxSpanM, TILE_SPAN_M, MAX_TILES, fetchOsmMaps } = require("../netlify/lib/osm-tiles");
const { fetchBuildingDetail } = require("../netlify/lib/building-shape");
const { geoFrame } = require("../netlify/lib/geo-frame");

function vegasBox(km) {
  const lat = 36.14;
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const halfLon = (km * 500) / mLon;
  const halfLat = (km * 500) / 110540;
  return {
    west: -115.17 - halfLon,
    east: -115.17 + halfLon,
    south: lat - halfLat,
    north: lat + halfLat,
  };
}

function squareXml(west, south, east, north, id) {
  const lon0 = (west + east) / 2;
  const lat0 = (south + north) / 2;
  const dLon = Math.min(0.0004, (east - west) * 0.2);
  const dLat = Math.min(0.0004, (north - south) * 0.2);
  return [
    "<osm>",
    `<node id="${id}" lat="${lat0}" lon="${lon0}"/>`,
    `<node id="${id + 1}" lat="${lat0}" lon="${lon0 + dLon}"/>`,
    `<node id="${id + 2}" lat="${lat0 + dLat}" lon="${lon0 + dLon}"/>`,
    `<node id="${id + 3}" lat="${lat0 + dLat}" lon="${lon0}"/>`,
    `<way id="${id}">`,
    `<nd ref="${id}"/><nd ref="${id + 1}"/><nd ref="${id + 2}"/><nd ref="${id + 3}"/><nd ref="${id}"/>`,
    '<tag k="building:part" v="yes"/>',
    '<tag k="height" v="40"/>',
    "</way>",
    "</osm>",
  ].join("");
}

describe("OSM tiles for a large draw", () => {
  it("keeps a short draw as one request and a 10 km draw inside the tile cap", () => {
    const small = vegasBox(1);
    assert.equal(planTiles(small).length, 1);
    assert.ok(bboxSpanM(small).sideM < TILE_SPAN_M);
    const big = vegasBox(10);
    const tiles = planTiles(big);
    assert.ok(tiles.length > 1);
    assert.ok(tiles.length <= MAX_TILES);
    assert.ok(bboxSpanM(big).sideM > 9000 && bboxSpanM(big).sideM < 11000);
    const frame = geoFrame(big);
    assert.ok(frame.widthM > 9000 && frame.widthM < 11000);
    assert.ok(frame.lengthM > 9000 && frame.lengthM < 11000);
  });

  it("splits a tile that has too many nodes and does not query the whole box again", async () => {
    const big = vegasBox(10);
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      const parts = new URL(url).searchParams.get("bbox").split(",").map(Number);
      const span = bboxSpanM({ west: parts[0], south: parts[1], east: parts[2], north: parts[3] });
      if (span.sideM > 1800) {
        return { ok: false, status: 400, text: async () => "You requested too many nodes (limit is 50000)" };
      }
      const id = 100000 + calls.length * 10;
      return { ok: true, status: 200, text: async () => squareXml(parts[0], parts[1], parts[2], parts[3], id) };
    };
    const maps = await fetchOsmMaps(big, { tile: true, fetchImpl, ua: "test" });
    assert.ok(maps.xmls.length >= 4, "xmls " + maps.xmls.length);
    assert.equal(calls.some((u) => u.includes("overpass")), false);
    assert.match(maps.notes.join(" "), /street map was left out/);
    const detail = await fetchBuildingDetail(big, { tile: true, fetchImpl, ua: "test", timeoutMs: 20000 });
    assert.equal(detail.ok, true);
    assert.ok(detail.parts.length >= 1);
    const overpass = calls.filter((u) => u.includes("overpass"));
    assert.equal(overpass.length, 0);
  });

  it("leaves a large short-path draw alone instead of one huge Overpass query", async () => {
    const big = vegasBox(8);
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return { ok: false, status: 400, text: async () => "You requested too many nodes" };
    };
    const detail = await fetchBuildingDetail(big, { tile: false, fetchImpl, ua: "test", timeoutMs: 20000 });
    assert.equal(detail.ok, true);
    assert.equal(detail.parts.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes("openstreetmap.org"), true);
  });
});
