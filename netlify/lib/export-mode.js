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

// Worst-case pads learn the pad pattern from the whole mapped park, read on
// a second photo past the draw (1.2.26). On for /dev hosts unless the request
// sends parkContext:false; production never reads past the draw.
let parkContext = false;

function setParkContext(on) {
  parkContext = !!on;
}

function isParkContext() {
  return parkContext;
}

/** Park context on /dev hosts unless the request says parkContext:false. Never on production. */
function parkContextWanted(testHost, body) {
  return !!testHost && !(body && body.parkContext === false);
}

// Hamina import budget (1.2.29): 5.8 MB of OpenIntent JSON and at most
// 9.7 MB of JSON plus map image. On for /dev hosts; production keeps the
// 1.2.17 4.9 MB JSON-only budget until it is promoted.
let bigBudget = false;

function setBigBudget(on) {
  bigBudget = !!on;
}

function isBigBudget() {
  return bigBudget;
}

// Large-draw street-map reads (1.2.31): one shared window across the
// Overpass tiles, two tiles at a time, a 20 s slow-fail to the next server
// and the last resort, a retry pass and a 2x2 split for missing tiles, and a
// plain note naming what is missing. Off by default; set per export (on for
// every host since 1.2.32; the tile stat stays on /dev hosts).
let tiledOsm = false;

function setTiledOsm(on) {
  tiledOsm = !!on;
}

function isTiledOsm() {
  return tiledOsm;
}

/** Hosts that get the tiled street-map reads: every host since 1.2.32. */
function tiledOsmWanted(testHost) {
  return true;
}

// Lidar canopy checked on the current photo (1.2.37): cells lower than a
// vehicle or on bare ground and roofs, with no foliage on a leaf-on photo,
// are cleared. On for /dev hosts; production keeps the 1.2.17 canopy until
// it is promoted.
let photoCanopy = false;

function setPhotoCanopy(on) {
  photoCanopy = !!on;
}

function isPhotoCanopy() {
  return photoCanopy;
}

module.exports = {
  setPhotoCanopy,
  isPhotoCanopy,
  setTiledOsm,
  isTiledOsm,
  tiledOsmWanted,
  setBigBudget,
  isBigBudget,
  setResilient,
  isResilient,
  setSiteTypes,
  isSiteTypes,
  setRvShell,
  isRvShell,
  rvShellWanted,
  setParkContext,
  isParkContext,
  parkContextWanted,
};
