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
// /dev hosts from 1.2.18 and every host since 1.2.41 (production batch 1).
let siteTypes = true;

function setSiteTypes(on) {
  siteTypes = !!on;
}

function isSiteTypes() {
  return siteTypes;
}

// RVs and trailers as four walls plus a roof slab (1.2.25). On for every
// host since 1.2.41 unless the request sends rvShell:false. Off by default
// so nothing else turns it on.
let rvShell = false;

function setRvShell(on) {
  rvShell = !!on;
}

function isRvShell() {
  return rvShell;
}

/** Shell on every host since 1.2.41 unless the request says rvShell:false. */
function rvShellWanted(testHost, body) {
  return !(body && body.rvShell === false);
}

// Worst-case pads learn the pad pattern from the whole mapped park, read on
// a second photo past the draw (1.2.26). On for every host since 1.2.41
// unless the request sends parkContext:false.
let parkContext = false;

function setParkContext(on) {
  parkContext = !!on;
}

function isParkContext() {
  return parkContext;
}

/** Park context on every host since 1.2.41 unless the request says parkContext:false. */
function parkContextWanted(testHost, body) {
  return !(body && body.parkContext === false);
}

// Hamina import budget (1.2.29): 5.8 MB of OpenIntent JSON and at most
// 9.7 MB of JSON plus map image. On for every host since 1.2.41 (before
// that production kept the 4.9 MB JSON-only budget).
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
// are cleared. On for every host since 1.2.41.
let photoCanopy = false;

function setPhotoCanopy(on) {
  photoCanopy = !!on;
}

function isPhotoCanopy() {
  return photoCanopy;
}

// Lidar tree crowns shaped on the current photo (1.2.39): inside the zones
// the photo canopy check reads, each crown up to one tree or a small group
// takes the outline of its own leaves, merged crowns split into trees, and
// a crown with no leaves today is left out, where enough crowns have no
// leaves on the photo to show the flight is out of date. Elsewhere crowns
// keep their lidar outline and only a leafless crown on roof or open ground
// is left out. On for /dev hosts only; production keeps lidar crowns
// (the 1.2.37 photo canopy check runs there from 1.2.41).
let photoCrowns = false;

function setPhotoCrowns(on) {
  photoCrowns = !!on;
}

function isPhotoCrowns() {
  return photoCrowns;
}

// Building outlines left on empty RV pads: a small
// footprint inside an RV park, campground or mobile-home park that the
// photo shows as bare pad, with no height in the lidar or no shadow where
// the photo has clear sun, is left out. On for /dev hosts only.
let staleFootprints = false;

function setStaleFootprints(on) {
  staleFootprints = !!on;
}

function isStaleFootprints() {
  return staleFootprints;
}

// Trailers whose light roof breaks up on a pale pad: a
// roof group of RV width that casts a tall shadow along the photo's sun
// direction counts as a unit even without the vent pattern. On for /dev
// hosts only; carried to CPU worker threads with each task.
let shadowTrailers = false;

function setShadowTrailers(on) {
  shadowTrailers = !!on;
}

function isShadowTrailers() {
  return shadowTrailers;
}

module.exports = {
  setStaleFootprints,
  isStaleFootprints,
  setShadowTrailers,
  isShadowTrailers,
  setPhotoCrowns,
  isPhotoCrowns,
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
