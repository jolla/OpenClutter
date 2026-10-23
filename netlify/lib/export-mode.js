"use strict";

/**
 * Per-export switch for the resilient fetch paths (Overpass retries and
 * fallback, the sharper-plate wait). The Fly worker and each Netlify
 * function run one export at a time, so a module flag set when the export
 * starts is read by every source module of that export. Every host runs
 * the resilient paths; legacyFetch:true on a /dev host turns them off.
 */

let resilient = false;

function setResilient(on) {
  resilient = !!on;
}

function isResilient() {
  return resilient;
}

// RV park and marina rules from 1.2.18 (road RVs only on photo roofs,
// marinas and piers kept from the map read, the wider boat scan). On for
// /dev hosts; production keeps the 1.2.17 rules until it is promoted.
let siteTypes = true;

function setSiteTypes(on) {
  siteTypes = !!on;
}

function isSiteTypes() {
  return siteTypes;
}

// RVs and trailers as four walls plus a roof slab (1.2.25). On for /dev
// hosts unless the request sends rvShell:false; production keeps the
// 1.2.17 solid block. Off by default so nothing else turns it on.
let rvShell = false;

function setRvShell(on) {
  rvShell = !!on;
}

function isRvShell() {
  return rvShell;
}

/** Shell on /dev hosts unless the request says rvShell:false. Never on production. */
function rvShellWanted(testHost, body) {
  return !!testHost && !(body && body.rvShell === false);
}

module.exports = { setResilient, isResilient, setSiteTypes, isSiteTypes, setRvShell, isRvShell, rvShellWanted };
