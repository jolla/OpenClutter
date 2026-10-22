"use strict";

/**
 * Colour levels for the photo checks when the map image is not Esri.
 *
 * The surface masks (water, paving, lawn) and the canopy colour tests were
 * tuned on Esri World Imagery, which is colour balanced with deep shadows.
 * NAIP and national orthophotos usually arrive flatter, with a blue haze
 * lifting the dark end. Under that haze a shaded crown reads as a pond and a
 * hazy lot as paving, so canopy gets cleared that is really there.
 *
 * Each channel is stretched linearly so its 1st and 99th percentiles land on
 * the typical Esri levels. That removes the haze offset per channel and
 * restores contrast, while keeping each scene's own colour order. Only the
 * pixels used for analysis change; the image in the zip is untouched.
 */

/** Median 1st / 99th percentile per channel (R, G, B) over the Esri bench sites. */
const TARGET_LO = [14, 23, 16];
const TARGET_HI = [233, 226, 212];
const LO_Q = 0.01;
const HI_Q = 0.99;
const SAMPLE_STEP = 7;
/** A channel this flat (a blank or tiny image) is left alone. */
const MIN_SPREAD = 24;

function percentiles(data, channel) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = channel; i < data.length; i += 4 * SAMPLE_STEP) {
    // Near-black nodata at a coverage edge is not part of the scene.
    if (data[i - channel] <= 4 && data[i - channel + 1] <= 4 && data[i - channel + 2] <= 4) continue;
    hist[data[i]]++;
    n++;
  }
  if (!n) return null;
  let lo = -1;
  let hi = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (lo < 0 && acc >= LO_Q * n) lo = v;
    if (acc >= HI_Q * n) {
      hi = v;
      break;
    }
  }
  return [Math.max(0, lo), hi];
}

/** Per-channel lookup tables, or null when the photo is too flat to stretch. */
function levelTables(image) {
  if (!image || !image.data || !image.data.length) return null;
  const tables = [];
  for (let c = 0; c < 3; c++) {
    const p = percentiles(image.data, c);
    if (!p || p[1] - p[0] < MIN_SPREAD) return null;
    const [lo, hi] = p;
    const scale = (TARGET_HI[c] - TARGET_LO[c]) / (hi - lo);
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      const t = TARGET_LO[c] + (v - lo) * scale;
      lut[v] = t <= 0 ? 0 : t >= 255 ? 255 : Math.round(t);
    }
    tables.push(lut);
  }
  return tables;
}

/**
 * A levelled copy of a decoded RGBA image ({data, width, height}).
 * Returns the input unchanged when it cannot be levelled.
 */
function normalizeAerial(image) {
  const tables = levelTables(image);
  if (!tables) return image;
  const src = image.data;
  const out = new Uint8Array(src.length);
  const [lr, lg, lb] = tables;
  for (let i = 0; i < src.length; i += 4) {
    out[i] = lr[src[i]];
    out[i + 1] = lg[src[i + 1]];
    out[i + 2] = lb[src[i + 2]];
    out[i + 3] = src[i + 3];
  }
  return { ...image, data: out, levelled: true };
}

module.exports = { normalizeAerial, levelTables, TARGET_LO, TARGET_HI };
