"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { fetchCopernicusDemSamples } = require("../netlify/lib/copernicus-dem");

// GLO-30 overviews carry no geo tags. geotiff.js throws on getOrigin() and on
// getResolution() without a reference image, as the real COGs do.
function cogWithOverviews(zAt) {
  const reads = [];
  const geotiff = {
    fromUrl: async (url) => {
      const m = String(url).match(/_([NS])(\d{2})_00_([EW])(\d{3})_00_DEM\.tif$/);
      if (!m) throw new Error("bad tile url " + url);
      const latSw = (m[1] === "S" ? -1 : 1) * Number(m[2]);
      const lonSw = (m[3] === "W" ? -1 : 1) * Number(m[4]);
      const side = 3600;
      const origin = [lonSw, latSw + 1, 0];
      const fullRes = [1 / side, -1 / side, 0];
      const make = (level) => {
        const w = side >> level;
        const res = [fullRes[0] * (side / w), fullRes[1] * (side / w), 0];
        const img = {
          getWidth: () => w,
          getHeight: () => w,
          getGDALNoData: () => -32767,
          getOrigin: () => {
            if (level) throw new Error("The image does not have an affine transformation.");
            return origin;
          },
          getResolution: (ref) => {
            if (!level) return fullRes;
            if (!ref) throw new Error("The image does not have an affine transformation.");
            const [rx, ry] = ref.getResolution();
            return [(rx * ref.getWidth()) / w, (ry * ref.getHeight()) / w, 0];
          },
          readRasters: async ({ window }) => {
            reads.push({ level, window });
            const [left, top, right, bottom] = window;
            const ww = right - left;
            const hh = bottom - top;
            const data = new Float32Array(ww * hh);
            for (let y = 0; y < hh; y++) {
              for (let x = 0; x < ww; x++) {
                const lon = origin[0] + (left + x + 0.5) * res[0];
                const lat = origin[1] + (top + y + 0.5) * res[1];
                data[y * ww + x] = zAt(lon, lat);
              }
            }
            data.width = ww;
            data.height = hh;
            return data;
          },
        };
        return img;
      };
      const images = [make(0), make(1), make(2), make(3)];
      return {
        getImageCount: async () => images.length,
        getImage: async (i = 0) => images[i],
      };
    },
  };
  return { geotiff, reads };
}

describe("GLO-30 overviews (feedback #10, Kalgoorlie Super Pit)", () => {
  // The drawn box from the report: about 2.5 x 4.2 km, past the 128 px
  // full-resolution window, so the read steps to an overview.
  const frame = { west: 121.49022, south: -30.79379, east: 121.51632, north: -30.75605 };
  const zAt = (lon, lat) => 300 + (lat + 30.79) * 2000 + (lon - 121.49) * 1000;

  it("reads an overview without its own geo tags and keeps the right place", async () => {
    const cog = cogWithOverviews(zAt);
    const samples = await fetchCopernicusDemSamples(frame, {
      geotiff: cog.geotiff,
      sampleCount: 400,
      maxRasterSide: 128,
    });
    assert.equal(samples.length, 400);
    assert.ok(cog.reads.some((r) => r.level > 0), "stepped to an overview");
    for (const s of samples) {
      assert.ok(Math.abs(s.z - zAt(s.lon, s.lat)) < 5, "z matches the surface at " + s.lon + "," + s.lat);
    }
  });

  it("a small draw still reads full resolution", async () => {
    const cog = cogWithOverviews(zAt);
    const small = { west: 121.5, south: -30.78, east: 121.505, north: -30.775 };
    const samples = await fetchCopernicusDemSamples(small, {
      geotiff: cog.geotiff,
      sampleCount: 100,
      maxRasterSide: 128,
    });
    assert.equal(samples.length, 100);
    assert.ok(cog.reads.every((r) => r.level === 0));
  });
});
