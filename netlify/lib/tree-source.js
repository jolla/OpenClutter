"use strict";

/**
 * Shared tree source (NLCD canopy + imagery RGB). Canonical implementation
 * lives in public/tree-detect.js so the browser primary path and Node tests
 * cannot drift.
 */
module.exports = require("../../public/tree-detect");
