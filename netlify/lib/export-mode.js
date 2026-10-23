"use strict";

/**
 * Per-export switches for the fetch paths that are on trial on /dev.
 * The Fly worker and each Netlify function run one export at a time, so a
 * module flag set when the export starts is read by every source module
 * of that export. Production (openclutter.com) keeps the earlier paths
 * until the trial is promoted.
 */

let resilient = false;

function setResilient(on) {
  resilient = !!on;
}

function isResilient() {
  return resilient;
}

module.exports = { setResilient, isResilient };
