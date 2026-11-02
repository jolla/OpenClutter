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

// Towers the lidar flight predates (1.2.57): a source height of 45 m or
// more that the lidar under the roof reads at under 45% of it is kept, not
// lowered (Block 185 in Austin, 181 m, read 6.6 m in a 2017 flight). On for
// /dev hosts only until the weekly release turns it on for every host.
// Tall canopy kept by the photo canopy check (1.3.5, feedback #11): inside
// an RV park, campground or mobile home park, a lidar canopy cell or crown
// piece at least 12 m tall that the photo shows dark (no lit pad, gravel or
// roof) stays. No vehicle, awning or park model stands that tall, and a tree
// cut since the flight leaves lit ground; a dark reading there is a leaf-off
// or shaded crown over leaf litter. It keeps lidar canopy the photo check
// used to clear. On every host from 1.3.13 (clutter.js passes true;
// tallCanopyKeep:false or ?tallCanopyKeep=0 turns it off);
// setTallCanopyKeep(false) is the 1.3.4 behaviour.
let tallCanopyKeep = false;

function setTallCanopyKeep(on) {
  tallCanopyKeep = !!on;
}

function isTallCanopyKeep() {
  return tallCanopyKeep;
}

function tallCanopyKeepWanted(testHost, body) {
  if (!testHost) return false;
  const v = body && body.tallCanopyKeep;
  return !(v === false || v === 0 || v === "0" || v === "false");
}

// Feedback #12 and #13 (1.3.8): pool decks and mapped ponds. The roadside RV
// finder skips light strips around a dark covered pool, and foliage is cut
// around the photo pond grown from each mapped water outline. Both only
// remove geometry. On every host from 1.3.13 (clutter.js passes true;
// waterEdges:false or ?waterEdges=0 turns it off); setWaterEdges(false) is the 1.3.7 behaviour. Carried to CPU worker threads
// with each task.
let waterEdges = false;

function setWaterEdges(on) {
  waterEdges = !!on;
}

function isWaterEdges() {
  return waterEdges;
}

function waterEdgesWanted(testHost, body) {
  if (!testHost) return false;
  const v = body && body.waterEdges;
  return !(v === false || v === 0 || v === "0" || v === "false");
}

// Feedback #14: a map note at each light pole the export shipped (merged on
// a lamp-lined street, at most 40 pole notes). Paste only; the OpenIntent is
// unchanged. /dev hosts only (poleNotes:false or ?poleNotes=0 turns it off
// there) until a weekly release turns it on for every host.
let poleNotes = false;

function setPoleNotes(on) {
  poleNotes = !!on;
}

function isPoleNotes() {
  return poleNotes;
}

function poleNotesWanted(testHost, body, query) {
  if (!testHost) return false;
  const raw = body && body.poleNotes != null ? body.poleNotes : query && query.poleNotes != null ? query.poleNotes : null;
  if (raw == null || raw === "") return true;
  return !(raw === false || raw === 0 || raw === "0" || raw === "false");
}

// Feedback #15 (Williams AZ KOA): a campground mapped only as a point
// (tourism=caravan_site or camp_site node, no outline) got no RV read at all.
// campNodes gives such a point a read-only park circle; the photo decides
// each RV, and only a dense cluster near the point is kept. /dev hosts on
// (campNodes:false or ?campNodes=0 turns it off there); production off.
let campNodes = false;

function setCampNodes(on) {
  campNodes = !!on;
}

function isCampNodes() {
  return campNodes;
}

function campNodesWanted(testHost, body) {
  if (!testHost) return false;
  const v = body && body.campNodes;
  return !(v === false || v === 0 || v === "0" || v === "false");
}

// seaWater: the sea from coastlines, and a large river or lake whose
// multipolygon outline mostly lies outside the draw, become water areas (the
// side with far fewer roads and buildings; unclear sides are left out).
// /dev hosts only (seaWater:false or ?seaWater=0 turns it off there).
// Read on the main thread only (street-map parse).
let seaWater = false;

function setSeaWater(on) {
  seaWater = !!on;
}

function isSeaWater() {
  return seaWater;
}

function seaWaterWanted(testHost, body) {
  if (!testHost) return false;
  const v = body && body.seaWater;
  return !(v === false || v === 0 || v === "0" || v === "false");
}

let staleTowers = false;

function setStaleTowers(on) {
  staleTowers = !!on;
}

function isStaleTowers() {
  return staleTowers;
}

// Adaptive terrain (1.3.2, /dev): the DEM is read at its native posting
// (GLO-30 full resolution, a 3DEP raster beside getSamples) and the Copy
// terrain mesh spends its floor budget where that DEM is steep or curved
// (pit walls, ski runs) instead of on a fixed 20x20 lattice. Same 1500 floor
// and 400 KB paste caps. Off by default; on for /dev hosts unless the
// request sends adaptiveTerrain:false (?adaptiveTerrain=0 on the page).
// Production stays off until the weekly release turns it on.
let adaptiveTerrain = false;

function setAdaptiveTerrain(on) {
  adaptiveTerrain = !!on;
}

function isAdaptiveTerrain() {
  return adaptiveTerrain;
}

/** /dev and preview hosts only; a request can still opt out. */
function adaptiveTerrainWanted(testHost, body) {
  if (!testHost) return false;
  const v = body && body.adaptiveTerrain;
  return !(v === false || v === 0 || v === "0" || v === "false");
}

// Prototypes for feedback #9 (wide stands read as a grid of 50 m squares).
// Off by default and never on production. /dev hosts pick one with
// forestMode (below); scrubGaps only with OC_SCRUB_GAPS=1 in a local run.
// canopyBands: a wide stand is cut along its canopy height bands.
let canopyBands = false;

function setCanopyBands(on) {
  canopyBands = !!on;
}

function isCanopyBands() {
  return canopyBands;
}

// mergeTiles: neighbouring 50 m tiles whose heights agree ship as one piece.
let mergeTiles = false;

function setMergeTiles(on) {
  mergeTiles = !!on;
}

function isMergeTiles() {
  return mergeTiles;
}

// scrubGaps (with canopyBands): open ground inside a stand is left out.
let scrubGaps = false;

function setScrubGaps(on) {
  scrubGaps = !!on;
}

function isScrubGaps() {
  return scrubGaps;
}

// crownStyle (forest=crowns, with canopyBands): every stemmed tree ships as
// stacked faceted crowns on one axis, sized from its own measured outline.
let crownStyle = false;

function setCrownStyle(on) {
  crownStyle = !!on;
}

function isCrownStyle() {
  return crownStyle;
}

// Understory look under forest=crowns. Default "tuck": shade green, stepped
// 1.5 m back under the crown from open ground. OC_UNDERSTORY=off (or slab)
// gives the 1.3.7 pale slab; shade or patch pick the other prototypes.
// Empty outside crowns, so /dev default (bands) and production never change.
function understoryStyle() {
  if (!crownStyle) return "";
  const v = String(process.env.OC_UNDERSTORY || "").toLowerCase();
  if (v === "off" || v === "slab") return "";
  return ["shade", "tuck", "patch"].includes(v) ? v : "tuck";
}

/** Forest cut on a /dev host when the request does not pick one. */
const DEV_FOREST_DEFAULT = "bands";
/** Forest cut on a production host (1.3.13, forest fix A). */
const PROD_FOREST_DEFAULT = "bands";
const FOREST_MODES = ["bands", "merge", "crowns", "off"];

/**
 * Which feedback #9 forest cut runs: "bands" (canopyBands), "merge"
 * (mergeTiles), "crowns" (canopyBands plus crownStyle) or "off" (the 1.3.1 blocks).
 * Production (from 1.3.13) runs "bands", or "off" when body.forest is "off".
 * A /dev host takes body.forest (the page sends ?forest=bands|merge|crowns|off),
 * then OC_FOREST_CROWNS=1, OC_CANOPY_BANDS=1 or OC_MERGE_TILES=1 in a local run, then
 * DEV_FOREST_DEFAULT.
 */
function forestMode(testHost, body) {
  const asked = body && typeof body.forest === "string" ? body.forest.toLowerCase() : "";
  if (!testHost) return asked === "off" ? "off" : PROD_FOREST_DEFAULT;
  if (FOREST_MODES.includes(asked)) return asked;
  if (process.env.OC_FOREST_CROWNS === "1") return "crowns";
  if (process.env.OC_CANOPY_BANDS === "1") return "bands";
  if (process.env.OC_MERGE_TILES === "1") return "merge";
  return DEV_FOREST_DEFAULT;
}

/**
 * trueMetres (1.3.11): OpenIntent meters match the ground at every latitude.
 * /dev hosts on (trueMetres:false or ?trueMetres=0 turns it off there,
 * ?trueMetres=1 forces it on); production stays off until a release says so.
 */
function trueMetresWanted(testHost, body, query) {
  if (!testHost) return false;
  const raw = body && body.trueMetres != null ? body.trueMetres : query && query.trueMetres != null ? query.trueMetres : null;
  if (raw == null || raw === "") return true;
  return !(raw === false || raw === 0 || raw === "0" || raw === "false");
}

/** A prototype switch: only on /dev hosts, and only when asked for. */
function protoWanted(testHost, body, key, envKey) {
  if (!testHost) return false;
  return !!((body && body[key] === true) || process.env[envKey] === "1");
}

module.exports = {
  setPoleNotes,
  isPoleNotes,
  poleNotesWanted,
  setCampNodes,
  isCampNodes,
  campNodesWanted,
  setSeaWater,
  isSeaWater,
  seaWaterWanted,
  trueMetresWanted,
  setWaterEdges,
  isWaterEdges,
  waterEdgesWanted,
  setTallCanopyKeep,
  isTallCanopyKeep,
  tallCanopyKeepWanted,
  setAdaptiveTerrain,
  isAdaptiveTerrain,
  adaptiveTerrainWanted,
  setCanopyBands,
  isCanopyBands,
  setMergeTiles,
  isMergeTiles,
  setScrubGaps,
  isScrubGaps,
  setCrownStyle,
  isCrownStyle,
  understoryStyle,
  protoWanted,
  forestMode,
  DEV_FOREST_DEFAULT,
  PROD_FOREST_DEFAULT,
  setStaleTowers,
  isStaleTowers,
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
