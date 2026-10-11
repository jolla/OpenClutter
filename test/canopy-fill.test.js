"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { classifyPixel, coniferPixel, openGroundPixel } = require("../netlify/lib/surface-mask");
const { fillCanopyGaps } = require("../netlify/lib/canopy-fill");
const { worldcoverTile, TREE, GRASS, SHRUB } = require("../netlify/lib/worldcover");
const { forestFromElements } = require("../netlify/lib/slope-forest");
const { geoFrame } = require("../netlify/lib/geo-frame");

describe("dark conifer canopy", () => {
  it("keeps a spruce pixel out of the water mask", () => {
    assert.equal(coniferPixel(49, 78, 44), true);
    assert.equal(classifyPixel(49, 78, 44, 4), 0);
    assert.equal(classifyPixel(38, 55, 23, 12), 0);
  });

  it("still reads a dark blue pond as water", () => {
    assert.equal(coniferPixel(22, 32, 36), false);
    assert.equal(classifyPixel(22, 32, 36, 1), 1);
  });

  it("does not read a charcoal roof as water or canopy", () => {
    assert.equal(coniferPixel(16, 19, 22), false);
    assert.equal(classifyPixel(16, 19, 22, 1), 0);
  });

  it("fills an empty height cell from a dark crown and from WorldCover trees", () => {
    const frame = geoFrame(
      { west: -71.55, south: 44.467, east: -71.543, north: 44.473 },
      { maxSide: 80, metersPerPx: 8 }
    );
    const w = frame.imgW;
    const h = frame.imgH;
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const dark = x < w * 0.35;
        const n = (x * 3 + y * 5) % 7;
        data[i] = dark ? 32 + n * 4 : 176;
        data[i + 1] = dark ? 58 + n * 5 : 198;
        data[i + 2] = dark ? 18 + n * 3 : 120;
        data[i + 3] = 255;
        if (!dark && x > w * 0.6 && y < h * 0.4) {
          data[i] = 36 + n * 4;
          data[i + 1] = 78 + n * 5;
          data[i + 2] = 28 + (n % 3) * 4;
        }
      }
    }
    const cover = {
      sample(lon, lat) {
        const x = (lon - frame.west) / (frame.east - frame.west);
        const y = (frame.north - lat) / (frame.north - frame.south);
        if (x > 0.6 && y < 0.4) return TREE;
        if (x > 0.5 && x < 0.65 && y >= 0.4) return GRASS;
        return 0;
      },
    };
    const grid = {
      west: frame.west,
      south: frame.south,
      east: frame.east,
      north: frame.north,
      width: 12,
      height: 16,
      values: new Uint8Array(12 * 16),
      nonzero: 0,
    };
    grid.values[0] = 14;
    grid.values[2 * 12 + 8] = 18;
    const filled = fillCanopyGaps(grid, { frame, image: { data, width: w, height: h }, worldcover: cover });
    assert.ok(filled.filled > 8, "filled " + filled.filled);
    assert.ok(filled.values[1] >= 3, "west conifer");
    let eastTrees = 0;
    let grass = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 12; x++) {
        const lon = frame.west + ((x + 0.5) / 12) * (frame.east - frame.west);
        const lat = frame.north - ((y + 0.5) / 16) * (frame.north - frame.south);
        const cls = cover.sample(lon, lat);
        const v = filled.values[y * 12 + x];
        if (cls === TREE && v >= 3) eastTrees++;
        if (cls === GRASS && v >= 3) grass++;
      }
    }
    assert.ok(eastTrees > 0, "worldcover trees");
    assert.equal(grass, 0);
    assert.equal(filled.values[2 * 12 + 8], 18);
  });

  it("leaves a lawn, a pitch, and a road open when the map calls them trees", () => {
    assert.equal(openGroundPixel(176, 198, 120, 2), "lawn");
    assert.equal(openGroundPixel(160, 130, 80, 3), "pitch");
    assert.equal(openGroundPixel(140, 140, 138, 2), "road");
    assert.equal(openGroundPixel(40, 70, 28, 2), "");
    const frame = { west: 0, south: 0, east: 1, north: 1 };
    const paints = [
      [176, 198, 120],
      [160, 130, 80],
      [148, 148, 146],
    ];
    for (let p = 0; p < paints.length; p++) {
      const w = 24;
      const h = 24;
      const data = Buffer.alloc(w * h * 4, 255);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = paints[p][0];
        data[i + 1] = paints[p][1];
        data[i + 2] = paints[p][2];
      }
      const grid = {
        west: 0,
        south: 0,
        east: 1,
        north: 1,
        width: 6,
        height: 4,
        values: new Uint8Array(24),
        nonzero: 1,
      };
      grid.values[1 * 6 + 1] = 16;
      const filled = fillCanopyGaps(grid, {
        frame,
        image: { data, width: w, height: h },
        worldcover: { sample: () => TREE },
      });
      assert.equal(filled.values[1 * 6 + 1], 0, "a spike on smooth open ground is not a crown");
      let grown = 0;
      for (let i = 0; i < filled.values.length; i++) if (filled.values[i] >= 3) grown++;
      assert.equal(grown, 0, "open ground " + p + " does not grow a crown");
    }
  });

  it("fills a spruce stand that WorldCover calls grass", () => {
    const frame = { west: 0, south: 0, east: 1, north: 1 };
    const w = 24;
    const h = 24;
    const data = Buffer.alloc(w * h * 4, 255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const spruce = x < 12;
        const n = (x * 3 + y * 5) % 7;
        data[i] = spruce ? 32 + n * 4 : 168;
        data[i + 1] = spruce ? 58 + n * 5 : 186;
        data[i + 2] = spruce ? 18 + n * 3 : 110;
      }
    }
    const grid = {
      west: 0,
      south: 0,
      east: 1,
      north: 1,
      width: 4,
      height: 4,
      values: new Uint8Array(16),
      nonzero: 1,
    };
    grid.values[0] = 14;
    const cover = { sample: () => GRASS };
    const filled = fillCanopyGaps(grid, { frame, image: { data, width: w, height: h }, worldcover: cover });
    assert.equal(filled.values[0], 14, "measured spruce stays");
    assert.ok(filled.values[1] >= 3, "spruce beside the measured crown");
    assert.equal(filled.values[3], 0, "bright field");
  });

  it("fills a dark stand the height model missed and leaves a speck empty", () => {
    const frame = { west: 0, south: 0, east: 1, north: 1 };
    const w = 48;
    const h = 48;
    const data = Buffer.alloc(w * h * 4, 255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const n = (x * 3 + y * 5) % 7;
        data[i] = 30 + n * 4;
        data[i + 1] = 62 + n * 5;
        data[i + 2] = 20 + (n % 3) * 3;
      }
    }
    const grid = {
      west: 0,
      south: 0,
      east: 1,
      north: 1,
      width: 16,
      height: 16,
      values: new Uint8Array(256),
      nonzero: 0,
    };
    const filled = fillCanopyGaps(grid, {
      frame,
      image: { data, width: w, height: h },
      worldcover: { sample: () => 0 },
    });
    let trees = 0;
    for (let i = 0; i < filled.values.length; i++) if (filled.values[i] >= 3) trees++;
    assert.ok(trees > 80, "a dark woods is a crown, filled " + trees);
    const speck = {
      west: 0,
      south: 0,
      east: 1,
      north: 1,
      width: 8,
      height: 8,
      values: new Uint8Array(64),
      nonzero: 0,
    };
    const speckImg = Buffer.alloc(32 * 32 * 4, 255);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        const dark = x < 6 && y < 6;
        const n = (x * 3 + y * 5) % 7;
        speckImg[i] = dark ? 30 + n * 4 : 176;
        speckImg[i + 1] = dark ? 62 + n * 5 : 198;
        speckImg[i + 2] = dark ? 20 : 120;
      }
    }
    const missed = fillCanopyGaps(speck, {
      frame,
      image: { data: speckImg, width: 32, height: 32 },
      worldcover: { sample: () => 0 },
    });
    let specks = 0;
    for (let i = 0; i < missed.values.length; i++) if (missed.values[i] >= 3) specks++;
    assert.equal(specks, 0, "a shadow speck is not a woods");
  });

  it("fills a WorldCover tree gap beside a measured crown", () => {
    const frame = { west: 0, south: 0, east: 1, north: 1 };
    const w = 24;
    const h = 24;
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const lawn = x >= 18 && y >= 18;
        const n = (x * 3 + y * 5) % 7;
        if (lawn) {
          data[i] = 176;
          data[i + 1] = 198;
          data[i + 2] = 120;
        } else {
          data[i] = 36 + n * 4;
          data[i + 1] = 78 + n * 5;
          data[i + 2] = 28 + (n % 3) * 4;
        }
        data[i + 3] = 255;
      }
    }
    const grid = {
      west: 0,
      south: 0,
      east: 1,
      north: 1,
      width: 8,
      height: 8,
      values: new Uint8Array(64),
      nonzero: 1,
    };
    grid.values[3 * 8 + 3] = 16;
    const filled = fillCanopyGaps(grid, {
      frame,
      image: { data, width: w, height: h },
      worldcover: { sample: () => TREE },
    });
    assert.equal(filled.values[3 * 8 + 3], 16);
    assert.ok(filled.values[0] >= 3, "mapped trees beside the crown");
    assert.equal(filled.values[7 * 8 + 7], 0, "a smooth lawn the map calls trees stays open");
    const shrub = fillCanopyGaps(grid, {
      frame,
      image: { data, width: w, height: h },
      worldcover: { sample: () => SHRUB },
    });
    assert.equal(shrub.values[3 * 8 + 3], 16);
    assert.equal(shrub.values[0], 0, "shrub label does not fill the flat");
  });

  it("does not paint a shrub desert or a textured meadow", () => {
    const frame = { west: 0, south: 0, east: 1, north: 1 };
    const w = 32;
    const h = 32;
    const data = Buffer.alloc(w * h * 4, 255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const n = (x * 5 + y * 3) % 9;
        if (x < 16) {
          data[i] = 70 + n * 6;
          data[i + 1] = 118 + (n % 3) * 8;
          data[i + 2] = 48 + n * 2;
        } else {
          data[i] = 186;
          data[i + 1] = 164;
          data[i + 2] = 120;
        }
      }
    }
    const grid = {
      west: 0,
      south: 0,
      east: 1,
      north: 1,
      width: 4,
      height: 4,
      values: new Uint8Array(16),
      nonzero: 0,
    };
    const shrub = fillCanopyGaps(grid, {
      frame,
      image: { data, width: w, height: h },
      worldcover: { sample: () => SHRUB },
    });
    assert.equal(shrub.values[1], 0, "creosote is not a crown");
    assert.equal(shrub.values[2], 0, "sand beside the bush");
    assert.equal(shrub.values[3], 0, "bare shrub ground");
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * w + x) * 4;
        const n = (x * 3 + y * 5) % 7;
        data[i] = 32 + n * 4;
        data[i + 1] = 58 + n * 5;
        data[i + 2] = 18 + n * 3;
      }
    }
    const spruce = fillCanopyGaps(grid, {
      frame,
      image: { data, width: w, height: h },
      worldcover: { sample: () => SHRUB },
    });
    assert.equal(spruce.values[0], 0, "spruce color on shrub land is not a woods");
    const meadow = fillCanopyGaps(grid, {
      frame,
      image: { data, width: w, height: h },
      worldcover: { sample: () => GRASS },
    });
    assert.equal(meadow.values[1], 0, "broadleaf color on grass");
    assert.equal(meadow.values[3], 0, "sand on grass");
  });

  it("keeps a measured tree on a ski run and does not grow a crown there", () => {
    const frame = { west: 0, south: 0, east: 1, north: 1 };
    const w = 24;
    const h = 24;
    const data = Buffer.alloc(w * h * 4, 255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const n = (x * 3 + y * 5) % 7;
        data[i] = 32 + n * 4;
        data[i + 1] = 58 + n * 5;
        data[i + 2] = 18 + n * 3;
      }
    }
    const grid = {
      west: 0,
      south: 0,
      east: 1,
      north: 1,
      width: 4,
      height: 4,
      values: new Uint8Array(16),
      nonzero: 1,
    };
    grid.values[0] = 16;
    const run = [
      [0, 0],
      [0.5, 0],
      [0.5, 1],
      [0, 1],
      [0, 0],
    ];
    const filled = fillCanopyGaps(grid, {
      frame,
      image: { data, width: w, height: h },
      worldcover: { sample: () => GRASS },
      openRuns: [run],
    });
    assert.equal(filled.values[0], 16, "measured crown on the run stays");
    assert.equal(filled.values[1], 0, "the run does not grow a new crown");
    const woods = fillCanopyGaps(grid, {
      frame,
      image: { data, width: w, height: h },
      worldcover: { sample: () => GRASS },
    });
    assert.ok(woods.values[1] >= 3 || woods.filled > 0, "spruce off the run still fills");
  });

  it("names the Lancaster WorldCover tile", () => {
    assert.equal(worldcoverTile(44.47, -71.55), "N42W072");
  });

  it("keeps a small wood and simplifies a large one", () => {
    const bbox = { west: -71.55, south: 44.466, east: -71.542, north: 44.474 };
    const hedge = [
      [-71.547, 44.468],
      [-71.5466, 44.468],
      [-71.5466, 44.4684],
      [-71.547, 44.4684],
      [-71.547, 44.468],
    ];
    const big = [[-71.5495, 44.467]];
    for (let i = 0; i < 80; i++) {
      const t = i / 80;
      big.push([-71.5495 + t * 0.004, 44.467 + Math.sin(t * 12) * 0.0004]);
    }
    big.push([-71.5455, 44.472], [-71.5495, 44.472], [-71.5495, 44.467]);
    const parsed = forestFromElements(
      {
        elements: [
          {
            type: "way",
            tags: { natural: "wood" },
            geometry: hedge.map((p) => ({ lon: p[0], lat: p[1] })),
          },
          {
            type: "way",
            tags: { landuse: "forest", height: "16" },
            geometry: big.map((p) => ({ lon: p[0], lat: p[1] })),
          },
        ],
      },
      bbox
    );
    assert.equal(parsed.wood.length, 2);
    const large = parsed.wood[0].areaM2 >= parsed.wood[1].areaM2 ? parsed.wood[0] : parsed.wood[1];
    assert.ok(large.ringLonLat.length <= 38, "verts " + large.ringLonLat.length);
    assert.equal(large.heightM, 16);
    assert.ok(large.areaM2 > 1000);
  });
});
