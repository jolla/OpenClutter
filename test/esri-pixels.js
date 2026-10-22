"use strict";

/**
 * Esri World Imagery crops for the detector tests that were calibrated on
 * Esri pixels (pavement, deck and warehouse rules, eval gate). The repo is
 * public and Esri's terms do not allow redistributing its imagery, so the
 * committed fixtures are USDA NAIP crops on the same extent and pixel size.
 * `npm run fixtures:esri` restores the Esri crops into test/fixtures-esri/
 * (gitignored) for local runs; without them those assertions are skipped.
 */
const fs = require("node:fs");
const path = require("node:path");

const ESRI_DIR = path.join(__dirname, "fixtures-esri");
const SKIP_NOTE = "Esri-calibrated pixels: run npm run fixtures:esri to check this locally";

/** Esri crop for test/fixtures/<rel>, or null when it was not restored. */
function esriPixels(rel) {
  const p = path.join(ESRI_DIR, rel);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

module.exports = { ESRI_DIR, SKIP_NOTE, esriPixels };
