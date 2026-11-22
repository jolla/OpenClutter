"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { planTiles, bboxSpanM, TILE_SPAN_M, MAX_TILES, MAP_XML_CAP, fetchOsmMaps, splitTile } = require("../netlify/lib/osm-tiles");
const { fetchBuildingDetail } = require("../netlify/lib/building-shape");
const { fetchOutdoorClutter } = require("../netlify/lib/outdoor-clutter");
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

function squareElement(west, south, east, north, id) {
  const lon0 = (west + east) / 2;
  const lat0 = (south + north) / 2;
  const dLon = Math.min(0.0004, (east - west) * 0.2);
  const dLat = Math.min(0.0004, (north - south) * 0.2);
  return {
    type: "way",
    id,
    tags: { "building:part": "yes", height: "40" },
    geometry: [
      { lon: lon0, lat: lat0 },
      { lon: lon0 + dLon, lat: lat0 },
      { lon: lon0 + dLon, lat: lat0 + dLat },
      { lon: lon0, lat: lat0 + dLat },
      { lon: lon0, lat: lat0 },
    ],
  };
}

function queryBox(body) {
  const decoded = decodeURIComponent(String(body || "").replace(/^data=/, ""));
  const m = decoded.match(/\(([-0-9.]+,[-0-9.]+,[-0-9.]+,[-0-9.]+)\)/);
  if (!m) return null;
  const parts = m[1].split(",").map(Number);
  return { south: parts[0], west: parts[1], north: parts[2], east: parts[3] };
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

  it("asks Overpass per tile and does not download the map extract", async () => {
    const big = vegasBox(10);
    const calls = [];
    const bodies = [];
    const fetchImpl = async (url, init) => {
      calls.push(String(url) + " " + ((init && init.method) || "GET"));
      bodies.push(String((init && init.body) || ""));
      assert.equal(String(url).includes("openstreetmap.org"), false);
      const box = queryBox(init && init.body);
      assert.ok(box, "overpass bbox");
      const id = 100000 + calls.length * 10;
      return {
        ok: true,
        status: 200,
        json: async () => ({ elements: [squareElement(box.west, box.south, box.east, box.north, id)] }),
      };
    };
    const maps = await fetchOsmMaps(big, { tile: true, fetchImpl, ua: "test" });
    assert.equal(maps.xmls.length, 0);
    assert.ok(maps.elements.length >= 4, "elements " + maps.elements.length);
    assert.equal(maps.elements.length, planTiles(big).length);
    assert.equal(calls.length, planTiles(big).length);
    assert.ok(calls.every((u) => u.includes("overpass") && u.includes("POST")));
    const firstBody = decodeURIComponent(bodies[0]);
    assert.match(firstBody, /way\["highway"\]\["bridge"/);
    assert.match(firstBody, /way\["highway"\]\["layer"/);
    const before = calls.length;
    const detail = await fetchBuildingDetail(big, { tile: true, fetchImpl, ua: "test", timeoutMs: 20000 });
    assert.equal(detail.ok, true);
    assert.ok(detail.parts.length >= 1);
    assert.equal(calls.length, before, "building detail reuses the tiled read");
    const outdoor = await fetchOutdoorClutter(
      big,
      { water: true, parking: true, walls: true, poles: true },
      { tile: true, fetchImpl, ua: "test", timeoutMs: 20000 }
    );
    assert.equal(outdoor.ok, true);
    assert.equal(calls.length, before, "outdoor clutter reuses the tiled read");
  });

  it("keeps a road bridge from a tiled street-map read", async () => {
    const big = vegasBox(6);
    big.west += 0.2;
    big.east += 0.2;
    const fetchImpl = async (url, init) => {
      const box = queryBox(init && init.body);
      const midLat = (box.south + box.north) / 2;
      const span = (box.east - box.west) * 0.4;
      const lon0 = (box.west + box.east) / 2 - span / 2;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          elements: [
            squareElement(box.west, box.south, box.east, box.north, 7),
            {
              type: "way",
              id: 88001,
              tags: { highway: "primary", bridge: "viaduct", lanes: "3", layer: "1" },
              geometry: [
                { lon: lon0, lat: midLat },
                { lon: lon0 + span, lat: midLat },
              ],
            },
          ],
        }),
      };
    };
    const detail = await fetchBuildingDetail(big, { tile: true, fetchImpl, ua: "test", timeoutMs: 20000 });
    assert.equal(detail.ok, true);
    assert.ok(detail.bridges.length >= 1);
    assert.equal(detail.bridges[0].kind, "bridge");
    assert.ok(detail.bridges[0].widthM > 11 && detail.bridges[0].widthM < 14);
    assert.equal(detail.bridges[0].deckM, 6.5);
  });

  it("says when a street-map tile does not return", async () => {
    const big = vegasBox(10);
    const tiles = planTiles(big);
    const doomed = tiles[0];
    const fetchImpl = async (url, init) => {
      const box = queryBox(init && init.body);
      const miss =
        box &&
        Math.abs(box.west - doomed.west) < 1e-4 &&
        Math.abs(box.south - doomed.south) < 1e-4 &&
        Math.abs(box.east - doomed.east) < 1e-4 &&
        Math.abs(box.north - doomed.north) < 1e-4;
      if (miss) return { ok: false, status: 504, text: async () => "down" };
      const id = Math.round(Math.abs(box.west) * 1e5) * 1000 + Math.round(Math.abs(box.south) * 1e5);
      return {
        ok: true,
        status: 200,
        json: async () => ({ elements: [squareElement(box.west, box.south, box.east, box.north, id)] }),
      };
    };
    const maps = await fetchOsmMaps(big, { tile: true, fetchImpl, ua: "test" });
    assert.match(maps.notes.join(" "), /street map was left out/);
    assert.equal(maps.elements.length, tiles.length - 1);
  });

  it("does not parse a map extract that is too large to scan", async () => {
    const small = vegasBox(1);
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => "<osm>" + "x".repeat(MAP_XML_CAP + 1) + "</osm>",
    });
    const maps = await fetchOsmMaps(small, { tile: false, fetchImpl, ua: "test" });
    assert.equal(maps.xmls.length, 0);
    assert.equal(maps.elements.length, 0);
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
    // A 400 too-many-nodes answer now splits into map tiles; it still
    // never falls back to the OSM editing API.
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((u) => u.includes("/api/map?bbox=")));
    assert.equal(calls.some((u) => u.includes("openstreetmap.org/api/0.6")), false);
  });
});

function mapBox(url) {
  const m = String(url).match(/[?&]bbox=([^&]+)/);
  if (!m) return null;
  const p = m[1].split(",").map(Number);
  return { west: p[0], south: p[1], east: p[2], north: p[3] };
}

function sameBox(a, b) {
  if (!a || !b) return false;
  return (
    Math.abs(a.west - b.west) < 1e-9 &&
    Math.abs(a.south - b.south) < 1e-9 &&
    Math.abs(a.east - b.east) < 1e-9 &&
    Math.abs(a.north - b.north) < 1e-9
  );
}

function tinyMapXml(id, tags) {
  const lon = -115.17;
  const lat = 36.14;
  const tagMap = tags || { highway: "residential" };
  const tagXml = Object.keys(tagMap)
    .map((k) => '<tag k="' + k + '" v="' + tagMap[k] + '"/>')
    .join("");
  return (
    '<osm version="0.6">' +
    '<node id="' + id + '1" lat="' + lat + '" lon="' + lon + '"/>' +
    '<node id="' + id + '2" lat="' + lat + '" lon="' + (lon + 0.0002) + '"/>' +
    '<node id="' + id + '3" lat="' + (lat + 0.0002) + '" lon="' + (lon + 0.0002) + '"/>' +
    '<node id="' + id + '4" lat="' + (lat + 0.0002) + '" lon="' + lon + '"/>' +
    '<way id="' + id + '"><nd ref="' + id + '1"/><nd ref="' + id + '2"/><nd ref="' + id + '3"/><nd ref="' + id + '4"/><nd ref="' + id + '1"/>' +
    tagXml +
    "</way></osm>"
  );
}

function hugeMap() {
  return "<osm>" + "x".repeat(MAP_XML_CAP + 1) + "</osm>";
}

describe("OSM map split when the extract is too large", () => {
  it("keeps a fitting extract as one request", async () => {
    const small = vegasBox(1);
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => tinyMapXml(10) };
    };
    const maps = await fetchOsmMaps(small, { tile: false, fetchImpl, ua: "test" });
    assert.equal(calls.length, 1);
    assert.equal(maps.xmls.length, 1);
    assert.equal(maps.tiled, false);
    assert.equal(maps.incomplete, false);
    assert.equal(maps.tooBig, false);
    assert.equal(maps.notes.length, 0);
  });

  it("splits a too-large extract into quadrants and keeps the small tiles", async () => {
    const small = vegasBox(1);
    const calls = [];
    const fetchImpl = async (url) => {
      const box = mapBox(url);
      calls.push(box);
      if (sameBox(box, small)) {
        return { ok: true, status: 200, text: async () => hugeMap() };
      }
      const id = 1000 + calls.length;
      return { ok: true, status: 200, text: async () => tinyMapXml(id) };
    };
    const maps = await fetchOsmMaps(small, { tile: false, fetchImpl, ua: "test" });
    assert.equal(calls.length, 5);
    assert.equal(maps.xmls.length, 4);
    assert.equal(maps.elements.length, 0);
    assert.equal(maps.tiled, true);
    assert.equal(maps.incomplete, false);
    assert.equal(maps.tooBig, false);
    assert.equal(maps.notes.length, 0);
    assert.ok(maps.xmls.every((xml) => xml.length < MAP_XML_CAP));
    const ways = maps.xmls.map((xml) => (xml.match(/<way id="(\d+)"/) || [])[1]);
    assert.equal(new Set(ways).size, 4);
  });

  it("recurses one level when a quadrant is still too large", async () => {
    const small = vegasBox(1);
    const doomed = splitTile(small)[0];
    const calls = [];
    const fetchImpl = async (url) => {
      const box = mapBox(url);
      calls.push(box);
      if (sameBox(box, small) || sameBox(box, doomed)) {
        return { ok: true, status: 200, text: async () => hugeMap() };
      }
      const id = 2000 + calls.length;
      return { ok: true, status: 200, text: async () => tinyMapXml(id) };
    };
    const maps = await fetchOsmMaps(small, { tile: false, fetchImpl, ua: "test" });
    assert.equal(calls.length, 9);
    assert.equal(maps.xmls.length, 7);
    assert.equal(maps.tiled, true);
    assert.equal(maps.incomplete, false);
    assert.equal(maps.tooBig, false);
    assert.equal(maps.notes.length, 0);
  });

  it("warns only when some split tiles still fail", async () => {
    const small = vegasBox(1);
    const missed = splitTile(small)[1];
    const fetchImpl = async (url) => {
      const box = mapBox(url);
      if (sameBox(box, small)) return { ok: true, status: 200, text: async () => hugeMap() };
      if (sameBox(box, missed)) return { ok: false, status: 504, text: async () => "busy" };
      return { ok: true, status: 200, text: async () => tinyMapXml(3000 + Math.round(Math.abs(box.west) * 1e5)) };
    };
    const maps = await fetchOsmMaps(small, { tile: false, fetchImpl, ua: "test" });
    assert.equal(maps.xmls.length, 3);
    assert.equal(maps.incomplete, true);
    assert.equal(maps.tooBig, false);
    assert.match(maps.notes.join(" "), /incomplete: 1 of 4 map tiles did not load/);
  });

  it("still omits the extract when every tile stays over the cap", async () => {
    const small = vegasBox(1);
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => hugeMap(),
    });
    const maps = await fetchOsmMaps(small, { tile: false, fetchImpl, ua: "test" });
    assert.equal(maps.xmls.length, 0);
    assert.equal(maps.elements.length, 0);
    assert.equal(maps.tooBig, true);
    assert.match(maps.notes.join(" "), /too large to download in one request/);
  });

  it("merges overlapping tiles without duplicate building rings", async () => {
    const small = vegasBox(1);
    const shared = tinyMapXml(44, { building: "yes", height: "12" });
    const fetchImpl = async (url) => {
      const box = mapBox(url);
      if (sameBox(box, small)) return { ok: true, status: 200, text: async () => hugeMap() };
      return { ok: true, status: 200, text: async () => shared };
    };
    const detail = await fetchBuildingDetail(small, { tile: false, fetchImpl, ua: "test", timeoutMs: 20000 });
    assert.equal(detail.ok, true);
    assert.equal((detail.buildings || []).length, 1);
  });
});
