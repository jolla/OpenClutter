"use strict";

const {
  llToPx,
  pxToLl,
  pxToClipboard,
  applyAffine,
  publicFrame,
  CLIPBOARD_ORIGIN,
} = require("./geo-frame");
const {
  uuid,
  emptyClipboard,
  clipZone,
} = require("./hamina-clipboard");
const {
  materialForBuilding,
  measuredExceedsStock,
  liftPickedBuilding,
  asPodium,
  isPodiumName,
  isLiftedPodiumName,
  canonicalAreaMaterial,
  documentMaterials,
  isTrunkOiName,
  OI_BUILDING_NAMES,
  COMPATIBILITY_MODE,
} = require("./materials");
const { isParkingClass, planOutdoor, fitOutdoorBudget } = require("./outdoor-clutter");
const { treePairsFromPoints } = require("./vegetation");
const { dedupeStackedFootprints } = require("./conflate");
const { footprintRings } = require("./building-shape");
const polygonClipping = require("polygon-clipping");
const { piecesForFeature } = require("./roof-form");
const { zipUnderLimit } = require("./zip-store");
const { demUnderFootprint, depressWaterBasins, normalizeTerrainResolution, GLO30_CREDIT, LIFT_LOCAL_M } = require("./terrain");
const { version: OPENCLUTTER_VERSION } = require("./version");
const { applyNlsBuildingHeights, NLS_CREDIT, HEIGHT_SOURCE } = require("./nls-building-height");

const MIN_AREA_M2 = 25;
const MAX_AREA_M2 = 40000;
const MAX_BUILDINGS = 2000;
/** OpenIntent 2.0.1 coordinate_xyz.x/y minimum is 0; Hamina historically dropped *all* areas if one ring was invalid. */
const MIN_OI_SPAN_PX = 4;
/** A stem under this is a collapsed point. It is not the 4 px building floor. */
const TRUNK_OI_SPAN_PX = 0.02;
/**
 * Buildings and canopy masses stay at least ~3 m on a coarse plate.
 * Discrete trunks do not use this floor: stretching a 1 m stem up to 3 m,
 * or up to 4 px, made the stem as wide as the crown.
 */
const MIN_OI_SPAN_M = 3;
/**
 * Last Hamina import that showed clutter was 982 areas (PR #12, stock names).
 * Buildings fill the cap first. Tree rings use stock Foliage - Heavy / Light,
 * or a measured-height custom of that shape, and take whatever slots remain.
 */
const MAX_ATTENUATION_AREAS = 982;
/** Same byte ceiling as export-jobs ZIP_DOWNLOAD_MAX. A stored zip past this is deflated. */
const ZIP_DOWNLOAD_MAX = 4400000;
const AREA_CAP_MAX = 5000;
/**
 * Hamina posts the OpenIntent JSON to /graphql. 982 areas at the old
 * triple encoding was 3,858,995 bytes and imported. 1500 areas was
 * 5,471,504 bytes and returned 413. Stay just under the known-good file.
 * A dev page may raise this up to JSON_BUDGET_MAX to probe the ceiling.
 */
const OPENINTENT_JSON_BUDGET = 3800000;
const JSON_BUDGET_MAX = 5000000;
/** In-bounds pixel vertices. Two decimals is 0.01 px. Meters and feet are not repeated. */
const OI_PIXEL_DECIMALS = 2;
const OPENINTENT_VERSION = "2.0.1";
const STOCK_MATERIAL_NAMES = OI_BUILDING_NAMES.slice();

const ZIP_README =
  "Import this zip in Hamina (Projects → Import → OpenIntent).\n" +
  "OpenIntent carries the map image and building attenuation_areas.\n" +
  "Include foliage is off by default: the zip is buildings only, with no tree attenuation_areas.\n" +
  "When Include foliage was checked, canopy extent and height come from the\n" +
  "Meta/WRI canopy-height model: each polygon is a traced canopy outline, not a grid square,\n" +
  "not a circle, and not a percent-to-height bucket. US tree-canopy percent can add a cell\n" +
  "only where that cover is denser and a measured height is already known.\n" +
  "If the canopy-height read times out, foliage is left out of this zip and\n" +
  "the status says so. Buildings still export.\n" +
  "Materials are Foliage - Heavy / Foliage - Light, or Foliage - Heavy H.H /\n" +
  "Foliage - Light H.H at the measured height.\n" +
  "A compact measured crown is one tree: a stem under the crown, the crown bottom above the ground,\n" +
  "and the crown top at the measured height. A continuous canopy stays one mass on the ground.\n" +
  "Tree points are not turned into trees. The names Tree Trunk and Foliage N.N m stay off OpenIntent.\n" +
  "Buildings use Hamina's outdoor Building - One/Two/Five/Ten Floor materials.\n" +
  "Canopy cells on building footprints and on pavement or roads are cleared, and rings are cut around footprints (4 m buffer) and water, so foliage does not cover roofs, parking, or ponds.\n" +
  "hamina-clipboard.json matches the toggle: buildings only when foliage is off, or the same canopy polygons when it is on.\n" +
  "Schema: OpenIntent 2.0.1, one in-bounds pixel vertex, isotropic meter/pixel aspect.\n" +
  "(Optional) Unzip and open alignment-overlay.svg next to images/ to check rooftops and, when foliage is on, canopy.\n";

const LIFT_BARE_EARTH =
  "Flat sites omit bottom_height, so bottom height from floor stays the floor (about 0)\n" +
  "and top height from floor stays the building or canopy height. Do not write bottom_height: 0.\n" +
  "When a terrain mesh is pasted, a building sets bottom_height to the downhill\n" +
  "ground under that piece and top_height to that bottom plus the building height.\n" +
  "The uphill side of the piece is cut into the ramp. Canopy still uses the uphill\n" +
  "slope under that canopy. A hill under 20 m is included.\n" +
  "Ground under 1 m omits bottom_height.\n";

const LIFT_SURFACE =
  "This export used Copernicus DEM GLO-30, a surface model.\n" +
  "A building sets bottom_height to the downhill ground under that piece and\n" +
  "top_height to that bottom plus the building height. Canopy still uses the\n" +
  "uphill slope under that canopy, plus the foliage height.\n" +
  "The 20 m ski-hill gate does not apply. Ground under 1 m omits bottom_height.\n" +
  "Do not write bottom_height: 0.\n";

const ZIP_TROUBLESHOOT =
  "\nTroubleshooting if Hamina shows the map but no attenuating objects:\n" +
  "If VERIFY.txt attenuation_areas > 0, generation succeeded. Hamina then either dropped the import\n" +
  "or failed to render (WebGL). Do this in order:\n" +
  "  1. Unzip and confirm VERIFY.txt attenuation_areas (same as openIntent_*.json length).\n" +
  "     openIntentBuildingAreas + openIntentTreeAreas equals that count.\n" +
  "  2. Open alignment-overlay.svg next to images/. Rooftops (red) should sit on the JPEG.\n" +
  "     When Include foliage was on, canopy polygons (green) should sit on the woods, not as a spray of dots.\n" +
  "  3. In Hamina, check the Attenuating Objects sidebar count.\n" +
  "     0 = OpenIntent import dropped the areas. >0 = they imported but did not draw.\n" +
  "  4. Optional: paste hamina-clipboard.json. It has buildings only unless Include foliage was on,\n" +
  "     in which case it has the same canopy polygons. A discrete tree also has its stem.\n" +
  "  5. Console WebGL texSubImage2D / Rive warnings can hide objects after a successful import.\n" +
  "     Try Hamina’s 2D map view, and turn hardware acceleration off, then zoom the full extent.\n" +
  "Floorplan dimensions.height is Hamina outdoor 2.5 m (8.202 ft); meters match JPEG pixel aspect.\n" +
  "Building materials are the gold One/Two/Five/Ten Floor objects.\n" +
  "Tree materials, only when Include foliage was on, are stock Foliage - Heavy / Light,\n" +
  "or Foliage - Heavy H.H / Foliage - Light H.H at the measured height.\n" +
  "Buildings are name + rf_properties + top_height + display_color.\n" +
  "Foliage and tree objects set transparencyEnabled true (Hamina Transparent in 3D).\n" +
  "Buildings omit that key. Turn on Transparency effects in Hamina settings to see through canopy.\n" +
  LIFT_BARE_EARTH +
  "The names Tree Trunk and Foliage N.N m stay off OpenIntent. A discrete tree uses Foliage - Trunk H.H.\n" +
  "Each ring vertex is one in-bounds pixel coordinate. Materials omit itu_material_type.\n" +
  "Rings thinner than 4 px on one axis, or over the Hamina vertex cap, are omitted from OpenIntent\n" +
  "(VERIFY.txt warning) so one bad ring cannot drop the import. Those shapes stay on the clipboard.\n";

/**
 * Skip Microsoft campus-merge blobs (one giant wrong polygon). Do NOT use a
 * fraction of the drawn map — a tight commercial bbox makes a 2 ha big-box
 * roof look like “half the site” (Oak Creek white roof).
 *
 * Size is measured after clipping the ring to the imagery frame. Off-map MS
 * hulls (Wynn SE blob) become empty/tiny instead of “mega”.
 *
 * Coarse rings above MEGA_CAMPUS_M2 are still dropped. Detailed outlines
 * (USA Structures / high-vertex roofs) may reach HOTEL_MEGA_M2 so casino and
 * convention podiums (Wynn ~185k m²) are kept. Anything larger is always mega.
 */
const MEGA_CAMPUS_M2 = 150000;
const HOTEL_MEGA_M2 = 400000;
/** After simplify, coarse MS hulls stay ~20–32 verts; real large roofs keep ≥40. */
const MEGA_MIN_DETAIL_VERTS = 40;
/**
 * Hamina outdoor OpenIntent rings top out near 21 vertices. A project
 * re-exported after clipboard paste tops out near 41. Emit at most this many
 * open vertices so one dense Overture ring cannot invalidate the import.
 * Mega classification still uses the detailed simplify (#24 budgets, including
 * 56 for large roofs) before this cap: the podium is kept, then simplified
 * under the import ceiling.
 */
const MAX_OI_RING_VERTS = 40;
/** Image-edge rounding shaves ~0.002 px; do not treat that as a sub-4 px sliver. */
const OI_SPAN_SLACK_PX = 0.005;
/**
 * A short side under half the minimum is a sliver: drop it from OpenIntent.
 * A nearer miss (coarse pixels, a 3 px wing) is expanded out to the floor so
 * the ring stays valid without inventing a wide wall from a 1 px edge.
 */
const OI_SLIVER_FRACTION = 0.5;

function megaCampusLimitM2() {
  return HOTEL_MEGA_M2;
}

function ringVertexCount(ring) {
  if (!ring || ring.length < 3) return 0;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  return closed ? ring.length - 1 : ring.length;
}

/**
 * @param {number} areaM2 area of the ring already clipped to the map
 * @param {number} [vertCount] vertex count of the simplified (pre-clip) ring
 */
function isMegaCampus(areaM2, vertCount) {
  if (!(areaM2 > MEGA_CAMPUS_M2)) return false;
  if (areaM2 > HOTEL_MEGA_M2) return true;
  const verts = vertCount == null ? 0 : +vertCount;
  return !(verts >= MEGA_MIN_DETAIL_VERTS);
}

function pxRingAreaM2(pts, mpuX, mpuY) {
  if (!pts || pts.length < 3) return 0;
  const mx = mpuX > 0 ? mpuX : 1;
  const my = mpuY > 0 ? mpuY : mx;
  return ringAreaPx(pts) * mx * my;
}

function coverageStats(stats) {
  const s = stats || {};
  return {
    buildingsKept: s.buildings || 0,
    treesKept: s.trees || 0,
    treesSource: s.treesSource || "none",
    fetched: s.fetched != null ? s.fetched : s.buildings || 0,
    droppedMega: s.droppedMega || 0,
    droppedTiny: s.droppedTiny || 0,
    droppedClip: s.droppedClip || 0,
    droppedCap: s.droppedCap || 0,
    droppedInvalid: s.droppedInvalid || 0,
    droppedSpan: s.droppedSpan || 0,
    droppedVerts: s.droppedVerts || 0,
    droppedPavement: s.droppedPavement || 0,
    droppedAreasCap: s.droppedAreasCap || 0,
    droppedNested: s.droppedNested || 0,
    droppedTreeAreas: s.droppedTreeAreas || 0,
    treesMeasured: s.treesMeasured || 0,
    discreteTrees: s.discreteTrees || 0,
    attenuationAreasEmitted: s.attenuationAreasEmitted != null ? s.attenuationAreasEmitted : s.areas || 0,
    globalFootprints: s.globalFootprints || 0,
    arcgisFootprints: s.arcgisFootprints || 0,
    usaFootprints: s.usaFootprints || 0,
    imageryRoofs: s.imageryRoofs || 0,
    medianTrees: s.medianTrees || 0,
    measuredBuildings: s.measuredBuildings || 0,
    overtureFootprints: s.overtureFootprints || 0,
    overtureAdded: s.overtureAdded || 0,
    msHeights: s.msHeights || 0,
    overtureHeights: s.overtureHeights || 0,
    femaHeights: s.femaHeights || 0,
    floorHeights: s.floorHeights || 0,
    chmTrees: s.chmTrees || 0,
    terrainRaised: s.terrainRaised || 0,
    terrainSloped: s.terrainSloped || 0,
    terrainResolution: normalizeTerrainResolution(s.terrainResolution).id,
    terrainStyle: s.terrainStyle === "sloped" ? "sloped" : s.terrainStyle === "raised" ? "raised" : "",
    demKind: s.demKind === "surface" ? "surface" : s.demKind === "bare-earth" ? "bare-earth" : "",
    buildingsLifted: s.buildingsLifted || 0,
    podiumAreas: s.podiumAreas || 0,
    foliageLifted: s.foliageLifted || 0,
    areaMaterials: s.areaMaterials != null ? s.areaMaterials : STOCK_MATERIAL_NAMES.length,
    openIntentBuildingAreas: s.openIntentBuildingAreas || 0,
    openIntentTreeAreas: s.openIntentTreeAreas || 0,
    compatibilityMode: s.compatibilityMode || COMPATIBILITY_MODE,
    exactBuildingHeights: s.exactBuildingHeights || 0,
    exactFoliageHeights: s.exactFoliageHeights || 0,
    nlsHeights: s.nlsHeights || 0,
    nlsHeightMin: s.nlsHeightMin || 0,
    nlsHeightMax: s.nlsHeightMax || 0,
    includeFoliage: s.includeFoliage === true,
    foliageOmitted: s.foliageOmitted || "",
    waterMaskRings: s.waterMaskRings || 0,
    pavementMaskRings: s.pavementMaskRings || 0,
    foliageGeometry: s.foliageGeometry || "none",
    openintentVersion: s.openintentVersion || OPENINTENT_VERSION,
    openclutterVersion: s.openclutterVersion || OPENCLUTTER_VERSION,
    coordinateUnit: s.coordinateUnit || "pixels",
    coordinateOrigin: s.coordinateOrigin || "Y-up from SW",
    warnings: Array.isArray(s.warnings) ? s.warnings.filter(Boolean).map(String) : [],
  };
}

function coverageSummary(stats) {
  const c = coverageStats(stats);
  const drops = [];
  if (c.droppedMega) drops.push("mega " + c.droppedMega);
  if (c.droppedTiny) drops.push("tiny " + c.droppedTiny);
  if (c.droppedClip) drops.push("clip " + c.droppedClip);
  if (c.droppedCap) drops.push("cap " + c.droppedCap);
  if (c.droppedInvalid) drops.push("invalid " + c.droppedInvalid);
  if (c.droppedSpan) drops.push("span " + c.droppedSpan);
  if (c.droppedVerts) drops.push("verts " + c.droppedVerts);
  if (c.droppedPavement) drops.push("pavement " + c.droppedPavement);
  if (c.droppedAreasCap) drops.push("areas-cap " + c.droppedAreasCap);
  if (c.droppedNested) drops.push("nested " + c.droppedNested);
  const dropTxt = drops.length ? `; dropped ${drops.join(", ")}` : "";
  const foliage = c.foliageOmitted ? "omitted (canopy height timed out)" : c.includeFoliage ? "on" : "off";
  const measured = c.treesMeasured > c.treesKept ? c.treesMeasured : 0;
  const ofBit = measured ? " of " + measured : "";
  const stemBit = c.discreteTrees > 0 ? c.discreteTrees + " stems, " : "";
  let line =
    `Buildings ${c.buildingsKept} kept (${c.fetched} fetched${dropTxt}). ` +
    (c.podiumAreas > 0 ? `Podiums ${c.podiumAreas}. ` : "") +
    `Foliage ${foliage}. Trees ${c.treesKept} kept${ofBit} (${stemBit}${c.treesSource}). ` +
    `attenuation_areas ${c.attenuationAreasEmitted}.`;
  if (stats && stats.includeOutdoor) {
    const bits = [];
    if (stats.includeWater) bits.push("Water " + (stats.waterAreas || 0));
    if (stats.includeParking) bits.push("Parking " + (stats.parkingAreas || 0));
    if (stats.includeWalls) bits.push("Walls " + (stats.wallAreas || 0));
    if (stats.includePoles) bits.push("Poles " + (stats.poleAreas || 0));
    if (stats.includeRvs) bits.push("RVs " + (stats.rvAreas || 0));
    if (bits.length) line += " " + bits.join(". ") + ".";
  }
  if (stats && stats.includeGuideways) {
    line += " Guideways " + (stats.guidewayAreas || 0) + ".";
  }
  if (stats && stats.includeBridges) {
    line += " Bridges " + (stats.bridgeAreas || 0) + ".";
  }
  const cap = stats && stats.areaCap > 0 ? stats.areaCap | 0 : MAX_ATTENUATION_AREAS;
  line +=
    stats && stats.areaCapOverride
      ? " Area cap " + cap + " (test override)."
      : " Area cap " + cap + ".";
  const largeNotes = stats && Array.isArray(stats.largeDropNotes) ? stats.largeDropNotes : [];
  if (largeNotes.length) line += " " + largeNotes.join(" ");
  if (stats && stats.openIntentJsonBytes > 0) {
    const bytes = stats.openIntentJsonBytes;
    const size = bytes >= 100000 ? (bytes / 1e6).toFixed(2) + " MB" : Math.max(1, Math.round(bytes / 1000)) + " KB";
    line += " OpenIntent JSON " + size + ".";
    if (stats.stoppedBy === "bytes") {
      const budget = stats.jsonBudget > 0 ? stats.jsonBudget : OPENINTENT_JSON_BUDGET;
      line += " Stopped at the " + (budget / 1e6).toFixed(2) + " MB byte budget.";
    } else if (stats.stoppedBy === "count") {
      line += " Stopped at area cap " + cap + ".";
    } else {
      line += " Every area fit.";
    }
  }
  return line;
}

/**
 * Dev-only JSON byte budget. An integer from 3,800,000 through 5,000,000
 * is kept. Anything else stays at the 3.8 MB default. The count cap is
 * still an upper bound on top of this budget.
 */
function parseJsonBudgetOverride(value) {
  if (value == null || value === "" || typeof value === "boolean") return 0;
  const text = typeof value === "number" ? String(value) : String(value).trim();
  if (!/^\d+$/.test(text)) return 0;
  const n = Number(text);
  if (n < OPENINTENT_JSON_BUDGET || n > JSON_BUDGET_MAX) return 0;
  return n;
}

/**
 * Dev-only area cap from the page query or the export body.
 * An integer from 982 through 5000 is kept. Anything else is ignored
 * so the export stays at 982. 6000 is not clamped down to 5000.
 */
function parseAreaCapOverride(value) {
  if (value == null || value === "" || typeof value === "boolean") return 0;
  const text = typeof value === "number" ? String(value) : String(value).trim();
  if (!/^\d+$/.test(text)) return 0;
  const n = Number(text);
  if (n < MAX_ATTENUATION_AREAS || n > AREA_CAP_MAX) return 0;
  return n;
}

/**
 * Ways and segments to keep when the test cap is above 982.
 * The default 40-way / 80-segment caps would starve a larger deck hold.
 * 0 means those defaults stay in place.
 */
function raisedDeckCap(areaCap) {
  if (!(areaCap > MAX_ATTENUATION_AREAS)) return 0;
  const extra = areaCap - MAX_ATTENUATION_AREAS;
  return Math.min(800, Math.max(160, Math.floor(extra * 0.2)));
}

/**
 * Slots above 982 are split before buildings take them.
 * About 15 percent of the extra (at least 96 when decks exist) is held
 * for guideways and bridges. About 35 percent is held for trees.
 * Water and parking take a small prefix of the extra. Buildings keep
 * the original 982 plus whatever extra is left. Unfilled holds go back
 * to trees, then decks, then buildings, so a higher cap still fills.
 */
function raisedAreaHolds(areaCap, counts) {
  const base = MAX_ATTENUATION_AREAS;
  const extra = Math.max(0, (areaCap | 0) - base);
  const buildings = counts && counts.buildings > 0 ? counts.buildings | 0 : 0;
  const treeAreas = counts && counts.treeAreas > 0 ? counts.treeAreas | 0 : 0;
  const deckCount = counts && counts.deckCount > 0 ? counts.deckCount | 0 : 0;
  const waterParking = counts && counts.waterParking > 0 ? counts.waterParking | 0 : 0;
  const rvCount = counts && counts.rvCount > 0 ? counts.rvCount | 0 : 0;
  let waterHold = Math.min(waterParking, extra);
  let rest = extra - waterHold;
  const deckWant = Math.max(96, Math.floor(extra * 0.15));
  let deckHold = Math.min(deckCount, rest, deckWant);
  rest -= deckHold;
  let rvHold = Math.min(rvCount, rest);
  rest -= rvHold;
  const treeWant = Math.floor(extra * 0.35);
  let treeHold = Math.min(treeAreas, rest, treeWant);
  rest -= treeHold;
  let buildingLimit = Math.min(buildings, base + rest);
  let spare = (areaCap | 0) - (buildingLimit + treeHold + deckHold + waterHold);
  if (spare > 0) {
    const addTrees = Math.min(spare, Math.max(0, treeAreas - treeHold));
    treeHold += addTrees;
    spare -= addTrees;
  }
  if (spare > 0) {
    const addRvs = Math.min(spare, Math.max(0, rvCount - rvHold));
    rvHold += addRvs;
    spare -= addRvs;
  }
  if (spare > 0) {
    const addDecks = Math.min(spare, Math.max(0, deckCount - deckHold));
    deckHold += addDecks;
    spare -= addDecks;
  }
  if (spare > 0) {
    const addWater = Math.min(spare, Math.max(0, waterParking - waterHold));
    waterHold += addWater;
    spare -= addWater;
  }
  if (spare > 0) {
    buildingLimit += Math.min(spare, Math.max(0, buildings - buildingLimit));
  }
  return { buildingLimit, treeHold, deckHold, waterHold, rvHold };
}

const TERRAIN_README =
  "\nOptional Planner Plus terrain (not part of the OpenIntent import):\n" +
  "USGS 3DEP bare-earth elevations become a Planner Plus paste on the same meter frame.\n" +
  "Sloped is the default: open ramps, one quad per cell. Raised layers is the alternate:\n" +
  "each cell uses its high corner, quantized to a height band (1 m, coarser only when\n" +
  "the stack would pass 400 floors). A band covers every cell that reaches that height,\n" +
  "merged into rectangles, so higher plates sit on lower ones. Flat ground in that\n" +
  "mode is one pad. The page offers both when Terrain is on.\n" +
  "Auto is the default. It fills the paste budget on either style: about 1 m cells, at most 20×20 quads,\n" +
  "including a mild hill. A larger draw is coarser because that cap is the limit\n" +
  "Planner Plus accepts, not because relief under 20 m drops to 6×5. Raised layers\n" +
  "keep that same plan and only coarsen the height band when the stack would pass\n" +
  "400 floors. Hidden named presets still use a coarser ladder below 20 m of relief.\n" +
  "Auto's 3DEP sample count is denser than the mesh and stays at most 576. Default is about 80 m quads, at most 12×12\n" +
  "(144 DEM samples). Fine is about 40 m quads, at most 16×16 (324 samples).\n" +
  "Finest is about 25 m quads, at most 20×20 (576 samples). Stops at 20, 15, 10, 5,\n" +
  "and 1 m may paste a denser grid so a draw about 2.5 km on a side can still use\n" +
  "about 5–10 m cells (mesh cap 500 quads on a side). The older Hamina paste\n" +
  "expectation is about 20×20. A paste past that size is named in export-warnings.json.\n" +
  "A mesh that will not fit beside the zip in one response is coarsened until\n" +
  "Copy terrain still returns with the download. That reduction is named in\n" +
  "export-warnings.json. If it still cannot, terrain-clipboard.json is left out\n" +
  "and the OpenIntent zip still exports.\n" +
  "DEM samples for those stops step down when the export budget is short.\n" +
  "OpenIntent does not support raised or sloped floors. On the OpenClutter page,\n" +
  "Copy terrain pastes this JSON into Planner Plus. The same JSON is\n" +
  "terrain-clipboard.json in this zip when the DEM returned a grid. Do not import\n" +
  "that file as OpenIntent.\n" +
  "raisedFloorZones are flat pads (open xy quads, NE origin, same frame as hamina-clipboard.json).\n" +
  "height is meters above the lowest DEM sample. slabOnly is false, so Planner Plus\n" +
  "draws a solid floor rather than a thin slab. attenuationDbPerMeter is 0\n" +
  "so the solid floor is not a second clutter wall.\n" +
  "slopedFloors are open xyz quads. z is meters above the lowest DEM sample,\n" +
  "and a larger z is higher ground. The pit floor is the smaller z. The first\n" +
  "edge is that low side, and both corners of that edge share it. The opposite\n" +
  "edge shares the higher z. A quad with a different z on every corner is\n" +
  "rejected. The ring is not closed.\n" +
  "If terrain-clipboard.json is absent, the DEM request did not return a usable grid.\n" +
  "Building attenuating objects stay in this OpenIntent zip. When this mesh is pasted,\n" +
  "bottom_height is bottom height from floor (the downhill ground under that piece,\n" +
  "including a hill under 20 m) and top_height is top height from floor (that bottom\n" +
  "plus the building height). The uphill side of the piece is cut into the ramp.\n" +
  "With Include foliage on, canopy polygons use the same pair: bottom_height is the\n" +
  "slope top under that canopy, and top_height is that bottom plus the foliage height.\n" +
  "Clipboard zone types use the same pair as bottomEdge and topEdge. Flat ground\n" +
  "omits bottom_height so the bottom stays on the floor.\n" +
  "A footprint that climbs more than about 2.5 m is split. Each piece meets the\n" +
  "downhill ground under that piece, and its top is that ground plus the building\n" +
  "height, so the roof stays at the measured height and the downhill face does not\n" +
  "hang above the ramp. A taller plan inside a shorter one is two objects:\n" +
  "the lower footprint up to its height, then the upper footprint from that height\n" +
  "to the taller top. A single simple box stays one object.\n" +
  "Retest Granite Peak: Import this zip (Projects → Import → OpenIntent), Copy terrain,\n" +
  "paste it in Planner Plus, then check 3D. Buildings should sit on the pasted terrain\n" +
  "(sloped ramps, or stacked raised layers when that style was selected).\n" +
  "With Include foliage on, import again and Copy terrain: canopy should sit on that surface.\n";

const TERRAIN_README_SURFACE =
  "\nOptional Planner Plus terrain (not part of the OpenIntent import):\n" +
  "Copernicus DEM GLO-30 surface elevations (EGM2008) become a Planner Plus paste on the same meter frame.\n" +
  "Sloped is the default: open ramps, one quad per cell. Raised layers is the alternate:\n" +
  "each cell uses its high corner, quantized to a height band (1 m, coarser only when\n" +
  "the stack would pass 400 floors). A band covers every cell that reaches that height,\n" +
  "merged into rectangles, so higher plates sit on lower ones. Flat ground in that\n" +
  "mode is one pad. The page offers both when Terrain is on.\n" +
  GLO30_CREDIT +
  ".\n" +
  "This is a digital surface model, not bare earth. Roofs and canopy are in the mesh.\n" +
  "Auto fills the paste budget: about 1 m cells, at most 20×20 quads, including a\n" +
  "mild hill. A larger draw is coarser because that cap is the limit Planner Plus\n" +
  "accepts. At high latitude (Finland) those quads are square in ground meters, on\n" +
  "the same frame as the aerial, so a long draw hits 20 on the long side. Sub-30 m\n" +
  "cells are interpolated from GLO-30. The status shows the cell size that pastes.\n" +
  "Raised layers keep that plan and only coarsen the height band past 400 floors.\n" +
  "Auto's DEM sample count is denser than the mesh and stays at most 576. Default is about 80 m quads, at most 12×12\n" +
  "(144 DEM samples). Fine is about 40 m quads, at most 16×16 (324 samples).\n" +
  "Finest is about 25 m quads, at most 20×20 (576 samples). Stops at 20, 15, 10, 5,\n" +
  "and 1 m may paste a denser grid so a draw about 2.5 km on a side can still use\n" +
  "about 5–10 m cells (mesh cap 500 quads on a side). The older Hamina paste\n" +
  "expectation is about 20×20. A paste past that size is named in export-warnings.json.\n" +
  "A mesh that will not fit beside the zip in one response is coarsened until\n" +
  "Copy terrain still returns with the download. That reduction is named in\n" +
  "export-warnings.json. If it still cannot, terrain-clipboard.json is left out\n" +
  "and the OpenIntent zip still exports.\n" +
  "DEM samples for those stops step down when the export budget is short.\n" +
  "OpenIntent does not support raised or sloped floors. On the OpenClutter page,\n" +
  "Copy terrain pastes this JSON into Planner Plus. The same JSON is\n" +
  "terrain-clipboard.json in this zip when the DEM returned a grid. Do not import\n" +
  "that file as OpenIntent.\n" +
  "raisedFloorZones are flat pads (open xy quads, NE origin, same frame as hamina-clipboard.json).\n" +
  "height is meters above the lowest DEM sample. slabOnly is false, so Planner Plus\n" +
  "draws a solid floor rather than a thin slab. attenuationDbPerMeter is 0\n" +
  "so the solid floor is not a second clutter wall.\n" +
  "slopedFloors are open xyz quads. z is meters above the lowest DEM sample,\n" +
  "and a larger z is higher ground. The pit floor is the smaller z. The first\n" +
  "edge is that low side, and both corners of that edge share it. The opposite\n" +
  "edge shares the higher z. A quad with a different z on every corner is\n" +
  "rejected. The ring is not closed.\n" +
  "If terrain-clipboard.json is absent, the DEM request did not return a usable grid.\n" +
  "Building attenuating objects stay in this OpenIntent zip. They are cut into this DEM:\n" +
  "bottom_height is the downhill ground under that piece, and top_height is that\n" +
  "bottom plus the building height. The uphill side of the piece is in the ramp.\n" +
  "Canopy polygons still use the uphill slope under that canopy, plus the foliage\n" +
  "height. The bare-earth 20 m ski-hill gate does not apply here.\n" +
  "A footprint whose ground is under 1 m omits bottom_height. Do not write bottom_height: 0.\n" +
  "A footprint that climbs more than about 2.5 m is split. Each piece meets the\n" +
  "downhill ground under that piece, and its top is that ground plus the building\n" +
  "height, so the roof stays at the measured height and the downhill face does not\n" +
  "hang above the ramp. A taller plan inside a shorter one is two objects:\n" +
  "the lower footprint up to its height, then the upper footprint from that height\n" +
  "to the taller top. A single simple box stays one object.\n" +
  "Retest: Import this zip (Projects → Import → OpenIntent), Copy terrain,\n" +
  "paste it in Planner Plus, then check 3D. Buildings should sit on the pasted terrain\n" +
  "(sloped ramps, or stacked raised layers when that style was selected), not under it.\n";

function terrainReadme(stats) {
  if (stats && stats.demKind === "surface") return TERRAIN_README_SURFACE;
  return TERRAIN_README;
}

function zipTroubleshoot(stats) {
  if (!stats || stats.demKind !== "surface") return ZIP_TROUBLESHOOT;
  return ZIP_TROUBLESHOOT.replace(LIFT_BARE_EARTH, LIFT_SURFACE);
}

function zipReadme(stats) {
  const c = coverageStats(stats);
  return (
    ZIP_README +
    "\nCoverage — compare buildingsKept / treesKept / attenuationAreasEmitted to Hamina’s sidebar.\n" +
    coverageSummary(stats) +
    "\n" +
    terrainReadme(c) +
    nlsZipCredit(c) +
    "\n" +
    `buildingsKept: ${c.buildingsKept}\n` +
    `includeFoliage: ${c.includeFoliage ? "true" : "false"}\n` +
    `terrainResolution: ${c.terrainResolution}\n` +
    `terrainStyle: ${c.terrainStyle || "none"}\n` +
    `demKind: ${c.demKind || "none"}\n` +
    `treesKept: ${c.treesKept}\n` +
    `treesSource: ${c.treesSource}\n` +
    `attenuationAreasEmitted: ${c.attenuationAreasEmitted}\n` +
    `openclutter_version: ${c.openclutterVersion}\n` +
    `openintent_version: ${c.openintentVersion}\n` +
    `fetched: ${c.fetched}\n` +
    `droppedMega: ${c.droppedMega}\n` +
    `droppedTiny: ${c.droppedTiny}\n` +
    `droppedClip: ${c.droppedClip}\n` +
    `droppedCap: ${c.droppedCap}\n` +
    `droppedInvalid: ${c.droppedInvalid}\n` +
    `droppedSpan: ${c.droppedSpan}\n` +
    `droppedVerts: ${c.droppedVerts}\n` +
    `droppedAreasCap: ${c.droppedAreasCap}\n` +
    zipTroubleshoot(c)
  );
}

function nlsZipCredit(c) {
  if (!c || !(c.nlsHeights > 0)) return "";
  const lo = Math.round(c.nlsHeightMin * 10) / 10;
  const hi = Math.round(c.nlsHeightMax * 10) / 10;
  return (
    "\nBuilding heights on this export: " +
    c.nlsHeights +
    " buildings, " +
    lo +
    "–" +
    hi +
    " m.\n" +
    NLS_CREDIT +
    "\n" +
    "Roof minus ground under each footprint. OpenIntent uses Building - H.H\n" +
    "at that thickness (not Building N.N m). On a slope the name is\n" +
    "Building - H.H @ B.B: H.H is the building height and B.B is bottom height\n" +
    "from floor. Unmeasured roofs stay on Building - One/Two/Five/Ten Floor.\n"
  );
}

function verifyTxt(stats) {
  const c = coverageStats(stats);
  return (
    `attenuation_areas: ${c.attenuationAreasEmitted}\n` +
    `openIntentBuildingAreas: ${c.openIntentBuildingAreas || 0}\n` +
    `openIntentTreeAreas: ${c.openIntentTreeAreas || 0}\n` +
    `includeFoliage: ${c.includeFoliage ? "true" : "false"}\n` +
    `openclutter_version: ${c.openclutterVersion}\n` +
    `openintent_version: ${c.openintentVersion}\n` +
    `coordinate_unit: ${c.coordinateUnit}\n` +
    `coordinate_origin: ${c.coordinateOrigin}\n` +
    `area_materials: ${c.areaMaterials != null ? c.areaMaterials : STOCK_MATERIAL_NAMES.length}\n` +
    `buildingsKept: ${c.buildingsKept}\n` +
    `treesKept: ${c.treesKept}\n` +
    `attenuationAreasEmitted: ${c.attenuationAreasEmitted}\n` +
    verifyOmitWarning(c)
  );
}

function verifyOmitWarning(c) {
  const span = c.droppedSpan || 0;
  const verts = c.droppedVerts || 0;
  if (!span && !verts) return "";
  return (
    `warning: omitted ${span} thin-span and ${verts} over-vertex ring(s) from OpenIntent so one invalid ring cannot drop the import\n`
  );
}

const ALIGNMENT = [
  "Exact alignment (repeatable, any site):",
  "1. Import this zip in Hamina (Projects → Import → OpenIntent).",
  "   Floorplan meters match the JPEG pixel aspect (unified mpu; Esri content grid).",
  "   dimensions.height is Hamina outdoor 2.5 m. OpenIntent areas are buildings.",
  "   Include foliage is off by default. Checked, it adds traced canopy polygons (CHM contours when the height model resolves them, otherwise NLCD polygons).",
  "   Buildings: Building - One / Two / Five / Ten Floor.",
  "   Canopy: Foliage - Heavy / Foliage - Light (19.68 ft). Measured heights use Foliage - Heavy H.H / Foliage - Light H.H.",
  "   A compact measured crown is a stem under a raised crown. A continuous canopy stays one mass. Tree points are not trees.",
  "2. The zip is the OpenIntent JSON and the aerial JPEG. Buildings are attenuation areas in that JSON.",
  "   Include foliage adds canopy polygons to the same file. Copy terrain is a separate paste.",
  "3. hamina-clipboard.json, terrain paste, and debug notes are not in the zip.",
  "Clipboard meters use that same widthM × lengthM. Origin: " + CLIPBOARD_ORIGIN,
  "Do NOT use a Google Earth screenshot as the map — Hamina auto-scale will not",
  "match lon/lat footprints. Dual-scale nudges are a legacy escape hatch only.",
  "Do NOT add OSM building or tree rings (Hamina dropped v8 attenuation_areas).",
].join("\n");

function ringAreaM2(ring, mpd) {
  if (!ring || ring.length < 3) return 0;
  const pts = ring.slice();
  const a0 = pts[0];
  const last = pts[pts.length - 1];
  if (a0[0] !== last[0] || a0[1] !== last[1]) pts.push(a0);
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const x0 = pts[i][0] * mpd.lon;
    const y0 = pts[i][1] * mpd.lat;
    const x1 = pts[i + 1][0] * mpd.lon;
    const y1 = pts[i + 1][1] * mpd.lat;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function dist2(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function perpDist2(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-24) return dist2(p, a);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return dist2(p, [a[0] + t * vx, a[1] + t * vy]);
}

function simplifyDP(pts, eps2) {
  if (pts.length <= 2) return pts;
  let maxI = 0;
  let maxD = 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist2(pts[i], a, b);
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD > eps2) {
    const left = simplifyDP(pts.slice(0, maxI + 1), eps2);
    const right = simplifyDP(pts.slice(maxI), eps2);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

function simplifyRing(ring, maxPts = 32, eps = 2.5e-6) {
  if (!ring || ring.length < 3) return ring;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  if (closed.length <= maxPts) {
    closed.push(closed[0]);
    return closed;
  }
  const tol = eps > 0 ? eps : 2.5e-6;
  let out = simplifyDP(closed, tol * tol);
  if (out.length > maxPts) {
    const step = Math.max(1, Math.ceil(out.length / maxPts));
    const thin = [];
    for (let i = 0; i < out.length; i += step) thin.push(out[i]);
    out = thin;
  }
  if (out.length < 3) return ring;
  out.push(out[0]);
  return out;
}

function xyz(x, y, unit, decimals) {
  const d = decimals == null ? 6 : decimals;
  return {
    coordinate_xyz: {
      x: +Math.max(0, x).toFixed(d),
      y: +Math.max(0, y).toFixed(d),
      unit: unit || "pixels",
    },
  };
}

/** One pixel vertex. Hamina's schema allows a single unit. The in-bounds pixel frame is the one that lines up with the JPEG. */
function emitPixelVertex(x, y, imgW, imgH) {
  const c = xyz(x, y, "pixels", OI_PIXEL_DECIMALS);
  const inset = 10 ** -OI_PIXEL_DECIMALS;
  if (imgW > 0 && c.coordinate_xyz.x >= imgW) {
    c.coordinate_xyz.x = +Math.max(0, imgW - inset).toFixed(OI_PIXEL_DECIMALS);
  }
  if (imgH > 0 && c.coordinate_xyz.y >= imgH) {
    c.coordinate_xyz.y = +Math.max(0, imgH - inset).toFixed(OI_PIXEL_DECIMALS);
  }
  return c;
}

/**
 * Hamina-native attenuation rings interleave pixels, meters, feet per vertex
 * (Jerry's gold OpenIntent export). Meters are Y-up from SW: x_m = x_px * mpu.
 */
function expandOiCoordTriples(pixelCoords, mpu) {
  const m = Number(mpu);
  if (!(m > 0) || !pixelCoords || !pixelCoords.length) return null;
  const out = [];
  for (const c of pixelCoords) {
    const p = c && c.coordinate_xyz;
    if (!p || p.unit !== "pixels") return null;
    const xm = p.x * m;
    const ym = p.y * m;
    out.push(xyz(p.x, p.y, "pixels"));
    out.push(xyz(xm, ym, "meters"));
    out.push(xyz(xm / 0.3048, ym / 0.3048, "feet"));
  }
  return out;
}

/** Pixel-only vertices from a Hamina triple ring or a legacy pixels-only ring. */
function oiPixelCoords(coords) {
  if (!coords || !coords.length) return [];
  const u0 = coords[0] && coords[0].coordinate_xyz && coords[0].coordinate_xyz.unit;
  if (u0 === "pixels" && coords.length >= 3) {
    const u1 = coords[1] && coords[1].coordinate_xyz && coords[1].coordinate_xyz.unit;
    if (u1 === "meters") {
      const out = [];
      if (coords.length % 3 !== 0) return [];
      for (let i = 0; i < coords.length; i += 3) {
        const p = coords[i] && coords[i].coordinate_xyz;
        const m = coords[i + 1] && coords[i + 1].coordinate_xyz;
        const f = coords[i + 2] && coords[i + 2].coordinate_xyz;
        if (!p || p.unit !== "pixels" || !m || m.unit !== "meters" || !f || f.unit !== "feet") return [];
        out.push(coords[i]);
      }
      return out;
    }
  }
  return coords.slice();
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function uniqueOpenRing(ring, eps = 0.0005) {
  const src =
    ring && ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : (ring || []).slice();
  const out = [];
  for (const p of src) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push([p[0], p[1]]);
  }
  if (out.length >= 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps) out.pop();
  }
  return out;
}

function ringAreaPx(ring) {
  const pts = uniqueOpenRing(ring);
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function ringBBox(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Keep a min-span square inside the image (shift inward at edges). */
function fitSquareInImage(cx, cy, span, imgW, imgH) {
  const hw = span / 2;
  let x0 = cx - hw;
  let y0 = cy - hw;
  let x1 = cx + hw;
  let y1 = cy + hw;
  if (x0 < 0) {
    x1 -= x0;
    x0 = 0;
  }
  if (y0 < 0) {
    y1 -= y0;
    y0 = 0;
  }
  if (x1 > imgW) {
    x0 -= x1 - imgW;
    x1 = imgW;
  }
  if (y1 > imgH) {
    y0 -= y1 - imgH;
    y1 = imgH;
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(imgW, x1);
  y1 = Math.min(imgH, y1);
  if (x1 - x0 < 1 || y1 - y0 < 1) return [];
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

function minOiSpanPx(mpuX) {
  return Math.max(MIN_OI_SPAN_PX, MIN_OI_SPAN_M / Math.max(mpuX || 1, 0.01));
}

/**
 * "ok" — both axes clear the floor.
 * "thin" — one axis is a sliver. Do not expand (that invents a building) and
 * do not emit (Hamina may drop every area if one ring is degenerate).
 * "collapsed" — both axes are tiny (tree-trunk scale). Expand to a square.
 */
function ringSpanClass(pts, minSpan) {
  if (!pts || pts.length < 3) return "collapsed";
  const span = minSpan == null ? MIN_OI_SPAN_PX : minSpan;
  const b = ringBBox(pts);
  const floor = span - OI_SPAN_SLACK_PX;
  const xOk = b.w >= floor;
  const yOk = b.h >= floor;
  if (xOk && yOk) return "ok";
  if (xOk || yOk) return "thin";
  return "collapsed";
}

function thinSliverDrop(pts, minSpan) {
  if (ringSpanClass(pts, minSpan) !== "thin") return false;
  const b = ringBBox(pts);
  const span = minSpan == null ? MIN_OI_SPAN_PX : minSpan;
  return Math.min(b.w, b.h) < span * OI_SLIVER_FRACTION;
}

/** Stretch only the short axis out to `span`, keeping the ring inside the image. */
function expandShortAxis(pts, imgW, imgH, span) {
  const b = ringBBox(pts);
  let minX = b.minX;
  let maxX = b.maxX;
  let minY = b.minY;
  let maxY = b.maxY;
  if (b.w < span) {
    const cx = (b.minX + b.maxX) / 2;
    minX = cx - span / 2;
    maxX = cx + span / 2;
    if (minX < 0) {
      maxX -= minX;
      minX = 0;
    }
    if (maxX > imgW) {
      minX -= maxX - imgW;
      maxX = imgW;
    }
    minX = Math.max(0, minX);
    maxX = Math.min(imgW, maxX);
  }
  if (b.h < span) {
    const cy = (b.minY + b.maxY) / 2;
    minY = cy - span / 2;
    maxY = cy + span / 2;
    if (minY < 0) {
      maxY -= minY;
      minY = 0;
    }
    if (maxY > imgH) {
      minY -= maxY - imgH;
      maxY = imgH;
    }
    minY = Math.max(0, minY);
    maxY = Math.min(imgH, maxY);
  }
  const floor = span - OI_SPAN_SLACK_PX;
  if (maxX - minX < floor || maxY - minY < floor) return [];
  const sx = b.w > 1e-9 ? (maxX - minX) / b.w : 1;
  const sy = b.h > 1e-9 ? (maxY - minY) / b.h : 1;
  const out = [];
  for (const p of pts) out.push([minX + (p[0] - b.minX) * sx, minY + (p[1] - b.minY) * sy]);
  return out;
}

/**
 * Sub-pixel tree trunks used to emit near-degenerate hexagons. After toFixed(3)
 * those can be duplicate/NaN-adjacent and Hamina then dropped every area.
 * Expand collapsed blobs and near-miss short sides. Drop one-axis slivers.
 * A collapsed building becomes a square. A canopy keeps its traced outline
 * and is scaled up to the span, so a crown on a coarse aerial is not a box.
 */
function ensureMinSpan(pts, imgW, imgH, minSpan, keepShape) {
  if (!pts || pts.length < 3) return pts;
  const span = minSpan == null ? MIN_OI_SPAN_PX : minSpan;
  const klass = ringSpanClass(pts, span);
  if (klass === "ok") return pts;
  if (klass === "thin" || (klass === "collapsed" && keepShape)) {
    if (klass === "thin" && thinSliverDrop(pts, span)) return [];
    return expandShortAxis(pts, imgW, imgH, span);
  }
  const b = ringBBox(pts);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const square = fitSquareInImage(cx, cy, Math.max(span, b.w, b.h), imgW, imgH);
  return square.length ? square : [];
}

function ccw(a, b, c) {
  return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
}

function segsIntersectProper(a, b, c, d) {
  if (a[0] === c[0] && a[1] === c[1]) return false;
  if (a[0] === d[0] && a[1] === d[1]) return false;
  if (b[0] === c[0] && b[1] === c[1]) return false;
  if (b[0] === d[0] && b[1] === d[1]) return false;
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

function oiSelfIntersects(coords) {
  const pixels = oiPixelCoords(coords);
  const n = pixels.length - 1;
  if (n < 4) return false;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p = pixels[i].coordinate_xyz;
    pts.push([p.x, p.y]);
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (segsIntersectProper(a, b, c, d)) return true;
    }
  }
  return false;
}

function signedAreaOi(coords) {
  const pixels = oiPixelCoords(coords);
  let a = 0;
  for (let i = 0; i < pixels.length - 1; i++) {
    const p = pixels[i].coordinate_xyz;
    const q = pixels[i + 1].coordinate_xyz;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Emitted rings are one in-bounds pixel vertex. A Hamina export may still
 * interleave pixels, meters, and feet. Validate the pixel vertices either way.
 */
function validateOiCoords(coords, imgW, imgH, spanFloorPx) {
  const pixels = oiPixelCoords(coords);
  if (!pixels || pixels.length < 4) return { ok: false, reason: "too-few" };
  if (coords.length !== pixels.length) {
    if (coords.length !== pixels.length * 3) return { ok: false, reason: "triple" };
  }
  for (const c of pixels) {
    const p = c && c.coordinate_xyz;
    if (!p) return { ok: false, reason: "missing-xyz" };
    if (p.unit !== "pixels") return { ok: false, reason: "unit" };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ok: false, reason: "nan" };
    if (p.x < 0 || p.y < 0 || p.x > imgW || p.y > imgH) return { ok: false, reason: "bounds" };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i].coordinate_xyz;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const requested = Number(spanFloorPx);
  const spanFloor = (requested > 0 ? requested : MIN_OI_SPAN_PX) - OI_SPAN_SLACK_PX;
  if (maxX - minX < spanFloor || maxY - minY < spanFloor) return { ok: false, reason: "span" };
  const first = pixels[0].coordinate_xyz;
  const last = pixels[pixels.length - 1].coordinate_xyz;
  if (first.x !== last.x || first.y !== last.y) return { ok: false, reason: "open" };
  const seen = new Set();
  for (let i = 0; i < pixels.length - 1; i++) {
    const p = pixels[i].coordinate_xyz;
    const q = pixels[i + 1].coordinate_xyz;
    if (p.x === q.x && p.y === q.y) return { ok: false, reason: "duplicate" };
    seen.add(p.x + "," + p.y);
  }
  if (seen.size < 3) return { ok: false, reason: "degenerate" };
  if (Math.abs(signedAreaOi(pixels)) < 1e-6) return { ok: false, reason: "zero-area" };
  if (oiSelfIntersects(pixels)) return { ok: false, reason: "self-intersect" };
  return { ok: true };
}

function oiAreaMaterialName(mat) {
  if (typeof mat === "string") return mat;
  return mat && mat.name ? mat.name : "";
}

/** Gold building clone, or the canonical measured vegetation object. Null if it would not match the catalog. */
function catalogMaterial(material) {
  return canonicalAreaMaterial(material);
}

function validateOiArea(area, imgW, imgH, spanFloorPx) {
  if (!area || !area.area || area.area_material == null) return { ok: false, reason: "shape" };
  const mat = area.area_material;
  // OpenIntent 2.0.1 attenuation_area.area_material is a material object.
  // A catalog name string fails the whole document ("Invalid OpenIntent format",
  // PR #18). The object must deep-equal its catalog entry: gold building, or
  // Stock Foliage - Heavy / Light, or a measured-height custom. No itu_material_type.
  // Poisoned names fail closed and that ring is omitted.
  if (typeof mat !== "object" || mat == null || Array.isArray(mat)) return { ok: false, reason: "material" };
  if ("itu_material_type" in mat) return { ok: false, reason: "material" };
  // bottom_height: 0 on a gold name is still rejected inside catalogMaterial.
  // A ski-hill building or canopy carries bottom_height (bottom height from floor)
  // and a raised top_height (top height from floor).
  const cat = catalogMaterial(mat);
  if (!cat || JSON.stringify(mat) !== JSON.stringify(cat)) return { ok: false, reason: "material" };
  let floor = Number(spanFloorPx);
  if (!(floor > 0) && isTrunkOiName(mat.name)) floor = TRUNK_OI_SPAN_PX;
  return validateOiCoords(area.area.coordinates, imgW, imgH, floor > 0 ? floor : undefined);
}

/** Round + drop consecutive duplicates *after* toFixed so Hamina never sees collapsed verts. */
function finalizeOiCoords(rawPts, imgW, imgH) {
  const pts = [];
  for (const p of rawPts || []) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const c = emitPixelVertex(Math.min(imgW, Math.max(0, p[0])), Math.min(imgH, Math.max(0, p[1])), imgW, imgH);
    // Rounding can land on imgW. A point on the far edge is outside a strict
    // < dimension check and one such ring drops the import.
    const xyzc = c.coordinate_xyz;
    if (!Number.isFinite(xyzc.x) || !Number.isFinite(xyzc.y)) continue;
    const last = pts[pts.length - 1];
    if (last && last.coordinate_xyz.x === xyzc.x && last.coordinate_xyz.y === xyzc.y) continue;
    pts.push(c);
  }
  if (pts.length < 3) return null;
  const a = pts[0].coordinate_xyz;
  const b = pts[pts.length - 1].coordinate_xyz;
  if (a.x !== b.x || a.y !== b.y) pts.push(pts[0]);
  if (pts.length < 4) return null;
  return pts;
}

/**
 * Clip a ring to the image rectangle. Vertex clamp (old path) collapsed
 * off-map edges onto the border and produced invalid rings — Hamina then
 * dropped every attenuation_area.
 */
function clipRingToRect(ring, w, h) {
  const edges = [
    [(p) => p[0] >= 0, (a, b) => lerp(a, b, (0 - a[0]) / (b[0] - a[0] || 1e-12))],
    [(p) => p[0] <= w, (a, b) => lerp(a, b, (w - a[0]) / (b[0] - a[0] || 1e-12))],
    [(p) => p[1] >= 0, (a, b) => lerp(a, b, (0 - a[1]) / (b[1] - a[1] || 1e-12))],
    [(p) => p[1] <= h, (a, b) => lerp(a, b, (h - a[1]) / (b[1] - a[1] || 1e-12))],
  ];
  let pts = uniqueOpenRing(ring);
  if (pts.length < 3) return [];
  for (const [inside, intersect] of edges) {
    const src = pts;
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i];
      const prev = src[(i + src.length - 1) % src.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur));
      }
    }
    pts = uniqueOpenRing(out);
    if (pts.length < 3) return [];
  }
  return pts;
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function convexHullOpen(points) {
  const pts = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts.slice();
  const lower = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function subsampleOpen(open, maxPts) {
  if (open.length <= maxPts) return open.slice();
  const step = Math.ceil(open.length / maxPts);
  const thin = [];
  for (let i = 0; i < open.length && thin.length < maxPts; i += step) thin.push(open[i]);
  return thin;
}

function ringCentroidPx(pts) {
  const open = uniqueOpenRing(pts);
  if (!open.length) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < open.length; i++) {
    sx += open[i][0];
    sy += open[i][1];
  }
  return [sx / open.length, sy / open.length];
}

function ringSelfIntersectsPx(pts) {
  const open = uniqueOpenRing(pts);
  const n = open.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = open[i];
    const b = open[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segsIntersectProper(a, b, open[j], open[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Metres of Douglas–Peucker error allowed on a building ring. A large roof
 * stays near half a metre so a pool notch is not pulled shut. A shed may
 * use a metre. The old cap walked epsilon up by 1.65 fourteen times, about
 * a hundred metres, and then a convex hull could cover the courtyard.
 */
function capTolerancePx(ring, mpuX) {
  const mpu = Number(mpuX) > 0 ? Number(mpuX) : 0.5;
  const areaM2 = ringAreaPx(ring) * mpu * mpu;
  const meters = areaM2 > 8000 ? 0.5 : 1;
  return Math.max(0.35, meters / mpu);
}

function ringCoversPoint(ring, pt) {
  if (!pt || pt.length < 2) return false;
  const closed =
    ring.length &&
    (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
      ? ring.concat([ring[0]])
      : ring;
  return pointInRing(pt, closed);
}

/**
 * OpenIntent vertex ceiling. Rings already under the budget are returned
 * unchanged (a bowtie stays a bowtie so validation can reject it). Longer
 * rings are Douglas–Peucker'd, then subsampled.
 *
 * A candidate that grows the roof by more than 8% is dropped. That is the
 * convex hull of a courtyard, and the coarse subsample that closes a pool
 * notch. Among the rings that stay on the roof, keep the one whose centroid
 * stays on the original. Area is the tie-break.
 *
 * `keepOutPx` are pool and courtyard points that must stay outside. Foliage
 * (`keepShape`) may still fall back to a hull when nothing else is valid,
 * because a crown is not a courtyard.
 */
/** Open ring in degrees or pixels. Does not merge points that are metres apart. */
function openDegRing(ring) {
  const src =
    ring && ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : (ring || []).slice();
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const p = src[i];
    if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) continue;
    const q = [+p[0], +p[1]];
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - q[0]) < 1e-8 && Math.abs(last[1] - q[1]) < 1e-8) continue;
    out.push(q);
  }
  if (out.length >= 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-8 && Math.abs(a[1] - b[1]) < 1e-8) out.pop();
  }
  return out;
}

function closeDegRing(open) {
  if (!open || open.length < 3) return null;
  return open.concat([[open[0][0], open[0][1]]]);
}

/**
 * Area of the triangle through the three vertices farthest from the centroid,
 * divided by the polygon area. Same coordinate units as the ring. A value
 * near 1 means the outline is already a triangle.
 */
function extremeTriRatio(ring) {
  const open = openDegRing(ring);
  if (open.length < 3) return 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < open.length; i++) {
    cx += open[i][0];
    cy += open[i][1];
  }
  cx /= open.length;
  cy /= open.length;
  const ranked = open.slice().sort((a, b) => {
    const da = (a[0] - cx) * (a[0] - cx) + (a[1] - cy) * (a[1] - cy);
    const db = (b[0] - cx) * (b[0] - cx) + (b[1] - cy) * (b[1] - cy);
    return db - da;
  });
  let best = 0;
  const n = Math.min(12, ranked.length);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const a = ranked[i];
        const b = ranked[j];
        const c = ranked[k];
        const t = Math.abs(a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])) / 2;
        if (t > best) best = t;
      }
    }
  }
  let poly = 0;
  for (let i = 0, j = open.length - 1; i < open.length; j = i++) {
    poly += open[j][0] * open[i][1] - open[i][0] * open[j][1];
  }
  poly = Math.abs(poly) / 2;
  return poly > 0 ? best / poly : 0;
}

function capOiRingPx(ring, maxPts, opts) {
  const limit = Math.max(3, maxPts | 0);
  const open = uniqueOpenRing(ring);
  if (open.length < 3) return [];
  if (open.length <= limit) return open.concat([open[0]]);
  const keepShape = !!(opts && opts.keepShape);
  const maxEps = opts && Number(opts.maxEpsPx) > 0 ? Number(opts.maxEpsPx) : keepShape ? 80 : 2;
  const sourceTri = extremeTriRatio(open);
  const maxGrow = opts && Number(opts.maxGrow) > 0 ? Number(opts.maxGrow) : 1.08;
  const keepOut = (opts && opts.keepOutPx) || [];
  const candidates = [];
  let eps = Math.min(0.35, maxEps);
  for (let i = 0; i < 10; i++) {
    const simplified = simplifyRing(open.concat([open[0]]), limit, eps);
    const next = uniqueOpenRing(simplified);
    if (next.length >= 3 && next.length <= limit && next.length < open.length) candidates.push(next);
    if (eps >= maxEps - 1e-9) break;
    const grown = eps * 1.45;
    eps = grown > maxEps ? maxEps : grown;
  }
  candidates.push(subsampleOpen(open, limit));
  if (open.length > limit) {
    const step = Math.ceil(open.length / limit);
    const shifted = [];
    for (let i = Math.floor(step / 2); i < open.length && shifted.length < limit; i += step) shifted.push(open[i]);
    if (shifted.length >= 3) candidates.push(shifted);
  }
  // A building must not fall back to the convex hull. That hull is the
  // courtyard-filling wedge. Foliage may still use it: a crown is one mass.
  if (keepShape) {
    const hull = convexHullOpen(open);
    if (hull.length >= 3) candidates.push(hull.length > limit ? subsampleOpen(hull, limit) : hull);
  }
  const origin = ringCentroidPx(open);
  const area0 = ringAreaPx(open);
  let best = null;
  let fallback = null;
  for (const c of candidates) {
    if (c.length < 3 || c.length > limit || ringAreaPx(c) <= 1e-4 || ringSelfIntersectsPx(c)) continue;
    let covered = false;
    for (let k = 0; k < keepOut.length; k++) {
      if (ringCoversPoint(c, keepOut[k])) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    const cc = ringCentroidPx(c);
    const drift = origin && cc ? Math.hypot(cc[0] - origin[0], cc[1] - origin[1]) : 0;
    const area = ringAreaPx(c);
    const areaErr = area0 > 1e-6 ? Math.abs(area - area0) / area0 : 0;
    const score = drift + areaErr * 6;
    const grows = area0 > 1e-6 && area > area0 * maxGrow;
    // Subsampling a concave roof chords across the bays and leaves a triangle.
    // That candidate is not a simpler copy of the building.
    if (!keepShape && sourceTri < 0.8 && extremeTriRatio(c) >= 0.9) continue;
    const pick = { c, score };
    if (!grows && (!best || score < best.score - 1e-6 || (Math.abs(score - best.score) <= 1e-6 && c.length > best.c.length))) {
      best = pick;
    }
    if (keepShape && (!fallback || score < fallback.score - 1e-6)) fallback = pick;
  }
  const chosen = best || (keepShape ? fallback : null);
  return chosen ? chosen.c.concat([chosen.c[0]]) : [];
}

function ringToOi(pts, imgW, imgH, mpuX, opts) {
  if (!pts || pts.length < 3) return null;
  let clipped = clipRingToRect(pts, imgW, imgH);
  if (clipped.length < 3) return null;
  const custom = opts && Number(opts.minSpanPx);
  const span = custom > 0 ? custom : minOiSpanPx(mpuX);
  if (thinSliverDrop(clipped, span)) return null;
  clipped = ensureMinSpan(clipped, imgW, imgH, span, !!(opts && opts.keepShape));
  if (!clipped || clipped.length < 3) return null;
  if (ringSpanClass(clipped, span) !== "ok") return null;
  const capOpts = {
    keepShape: !!(opts && opts.keepShape),
    maxEpsPx: opts && opts.keepShape ? 0 : capTolerancePx(clipped, mpuX),
    keepOutPx: (opts && opts.keepOutPx) || [],
  };
  clipped = capOiRingPx(clipped, MAX_OI_RING_VERTS, capOpts);
  if (!clipped || ringVertexCount(clipped) < 3 || ringVertexCount(clipped) > MAX_OI_RING_VERTS) return null;
  if (ringAreaPx(clipped) < 1e-6) return null;
  const pixels = finalizeOiCoords(clipped, imgW, imgH);
  if (!pixels) return null;
  const floor = opts && Number(opts.spanFloorPx) > 0 ? Number(opts.spanFloorPx) : undefined;
  const check = validateOiCoords(pixels, imgW, imgH, floor);
  return check.ok ? pixels : null;
}

function makeOiArea(coords, material) {
  const mat = catalogMaterial(material);
  if (!coords || !mat) return null;
  return { area: { coordinates: coords }, area_material: mat };
}

function emitIfValid(area, imgW, imgH, spanFloorPx) {
  if (!area) return null;
  const check = validateOiArea(area, imgW, imgH, spanFloorPx);
  if (!check.ok) return null;
  // JSON.stringify turns NaN/Infinity into null — re-check the on-disk shape.
  try {
    const parsed = JSON.parse(JSON.stringify(area));
    if (!validateOiArea(parsed, imgW, imgH, spanFloorPx).ok) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Buildings first, then complete canopy+trunk pairs so a cap never splits a tree. */
function capAttenuationAreas(areas, buildingCount, max, opts) {
  const limit = max == null ? MAX_ATTENUATION_AREAS : max;
  const pairTail = !opts || opts.pairTail !== false;
  if (!areas || areas.length <= limit) return { areas: areas || [], dropped: 0 };
  const b = Math.min(buildingCount, limit);
  let rest = limit - b;
  if (pairTail) rest -= rest % 2;
  const kept = areas.slice(0, b + rest);
  return { areas: kept, dropped: areas.length - kept.length };
}

/**
 * Buildings fill the cap first. A crown group is the first band, every
 * inset layer after it, and the stem. A stem or an inset without that
 * first band is dropped, so the cap never leaves a piece of a tree.
 * `reserve` holds slots for water and parking so a crowd of crowns cannot
 * spend them. Poles and walls are not reserved.
 */
function capBuildingsAndTrees(buildings, trees, kinds, max, reserve) {
  const hard = max == null ? MAX_ATTENUATION_AREAS : max;
  const hold = reserve > 0 ? Math.min(reserve | 0, hard) : 0;
  const limit = Math.max(0, hard - hold);
  const srcB = buildings || [];
  const keptB = srcB.slice(0, Math.min(srcB.length, limit));
  const treeList = trees || [];
  const kindList = kinds || [];
  const groups = [];
  let i = 0;
  while (i < treeList.length) {
    if (kindList[i] === "trunk" || kindList[i] === "layer") {
      i++;
      continue;
    }
    // A crown is the full band plus the inset layers above it, then the stem.
    let j = i + 1;
    while (j < treeList.length && kindList[j] === "layer") j++;
    const discrete = j < treeList.length && kindList[j] === "trunk";
    if (discrete) j++;
    groups.push({ start: i, end: j, discrete, slope: kindList[i] === "slope" });
    i = j;
  }
  // Discrete trees take the slots that are left after buildings. A big
  // canopy outline does not spend those slots first. Poles and walls are
  // added later, so they drop before a tree does. A woods cut onto the
  // slope is not that one outline: it keeps about 60 percent of the
  // leftover so the hill still has canopy when stemmed trees are present.
  groups.sort((a, b) => (a.discrete === b.discrete ? 0 : a.discrete ? -1 : 1));
  const slopeGroups = [];
  const otherGroups = [];
  for (let g = 0; g < groups.length; g++) {
    if (groups[g].slope) slopeGroups.push(groups[g]);
    else otherGroups.push(groups[g]);
  }
  const room = Math.max(0, limit - keptB.length);
  let slopeNeed = 0;
  for (let g = 0; g < slopeGroups.length; g++) slopeNeed += slopeGroups[g].end - slopeGroups[g].start;
  const shareSlope = otherGroups.some((g) => g.discrete);
  const slopeCap = shareSlope ? Math.min(slopeNeed, Math.floor(room * 0.6)) : Math.min(slopeNeed, room);
  const order = [];
  const slopeLeft = [];
  let slopeUsed = 0;
  for (let g = 0; g < slopeGroups.length; g++) {
    const need = slopeGroups[g].end - slopeGroups[g].start;
    if (slopeUsed + need > slopeCap) {
      slopeLeft.push(slopeGroups[g]);
      continue;
    }
    order.push(slopeGroups[g]);
    slopeUsed += need;
  }
  for (let g = 0; g < otherGroups.length; g++) order.push(otherGroups[g]);
  for (let g = 0; g < slopeLeft.length; g++) order.push(slopeLeft[g]);
  const kept = [];
  const treeChunks = [];
  let treeGroups = 0;
  let discreteTrees = 0;
  for (let g = 0; g < order.length; g++) {
    const group = order[g];
    const need = group.end - group.start;
    if (keptB.length + kept.length + need > limit) continue;
    const slice = [];
    for (let t = group.start; t < group.end; t++) {
      kept.push(treeList[t]);
      slice.push(treeList[t]);
    }
    treeChunks.push({ areas: slice, discrete: group.discrete });
    treeGroups++;
    if (group.discrete) discreteTrees++;
  }
  return {
    areas: keptB.concat(kept),
    dropped: srcB.length + treeList.length - keptB.length - kept.length,
    droppedBuildings: srcB.length - keptB.length,
    droppedTrees: treeList.length - kept.length,
    treeGroups,
    discreteTrees,
    treeChunks,
  };
}

function closePixelRing(ring) {
  if (!ring || ring.length < 3) return null;
  const out = ring.slice();
  const a = out[0];
  const b = out[out.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  return out.length >= 4 ? out : null;
}

function clipMultiArea(geom) {
  if (!geom) return 0;
  let area = 0;
  for (let i = 0; i < geom.length; i++) {
    const poly = geom[i];
    if (poly && poly[0]) area += ringAreaPx(poly[0]);
  }
  return area;
}

/**
 * A second outline on the same ground as a larger roof is one volume drawn
 * twice. Drop that inner outline. A taller mass on the same ground is a tower:
 * its bottom moves up to the outer roof. A band that already starts at the
 * outer top (a dome step, a tower seated on its podium) stays.
 */
function dropNestedDuplicateRoofs(areas, zones) {
  const items = [];
  for (let i = 0; i < (areas || []).length; i++) {
    const area = areas[i];
    const pixels = oiPixelCoords(area && area.area && area.area.coordinates);
    const ring = closePixelRing(pixels.map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]));
    if (!ring) continue;
    const px = ringAreaPx(ring);
    if (!(px > 1)) continue;
    const mat = area.area_material || {};
    items.push({
      index: i,
      ring,
      area: px,
      bottom: Number(mat.bottom_height) > 0 ? Number(mat.bottom_height) : 0,
      top: Number(mat.top_height) > 0 ? Number(mat.top_height) : 0,
    });
  }
  items.sort((a, b) => b.area - a.area);
  const drop = new Set();
  const kept = [];
  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    let host = null;
    let hostCover = 0;
    for (let k = 0; k < kept.length; k++) {
      const outer = kept[k];
      if (item.bottom >= outer.top - 1.5) continue;
      if (Math.abs(item.bottom - outer.bottom) > 4) continue;
      let inter = 0;
      try {
        inter = clipMultiArea(polygonClipping.intersection([[item.ring]], [[outer.ring]]));
      } catch {
        continue;
      }
      const cover = item.area > 0 ? inter / item.area : 0;
      if (cover < 0.7) continue;
      if (!host || outer.top > host.top) {
        host = outer;
        hostCover = cover;
      }
    }
    if (!host || !(hostCover >= 0.7)) {
      kept.push(item);
      continue;
    }
    if (item.top >= host.top + 6 && item.bottom < host.top - 0.5) {
      const bottom = Math.round(host.top * 10) / 10;
      const mat = areas[item.index].area_material;
      if (mat && bottom < item.top - 1) {
        mat.bottom_height = bottom;
        const thick = Math.round((item.top - bottom) * 10) / 10;
        if (typeof mat.name === "string" && mat.name.indexOf(" @ ") > 0) {
          mat.name = "Building - " + thick.toFixed(1) + " @ " + bottom.toFixed(1);
        }
        item.bottom = bottom;
      }
      kept.push(item);
      continue;
    }
    drop.add(item.index);
  }
  if (!drop.size) return 0;
  const next = [];
  const nextZones = [];
  const paired = zones && zones.length === areas.length;
  for (let i = 0; i < areas.length; i++) {
    if (drop.has(i)) continue;
    next.push(areas[i]);
    if (paired) nextZones.push(zones[i]);
  }
  areas.length = 0;
  for (let i = 0; i < next.length; i++) areas.push(next[i]);
  if (paired) {
    zones.length = 0;
    for (let i = 0; i < nextZones.length; i++) zones.push(nextZones[i]);
  }
  return drop.size;
}

function siteName(raw) {
  const name = String(raw || "Site")
    .replace(/[^\w \-]/g, "")
    .trim()
    .slice(0, 60) || "Site";
  const slug = name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "Site";
  return { name, slug };
}

function lonLatToClip(lon, lat, frame, affine) {
  if (affine) return applyAffine(lon, lat, affine);
  return pxToClipboard(...llToPx(lon, lat, frame), frame);
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / ((yj - yi) || 1e-20) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function ringInside(inner, outer) {
  if (!inner || inner.length < 3 || !outer || outer.length < 3) return false;
  let hits = 0;
  const n = Math.min(inner.length - 1, 5);
  for (let i = 0; i < n; i++) {
    if (pointInRing(inner[i], outer)) hits++;
  }
  return hits >= Math.ceil(n * 0.6);
}

/**
 * Every exterior ring of a Polygon or MultiPolygon. Extra rings that are not
 * holes (Oak Creek: L-wing + white roof as sibling exteriors) are kept.
 */
function featureExteriorRings(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  const groups = [];
  if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates) groups.push(poly || []);
  } else if (geometry.type === "Polygon") {
    groups.push(geometry.coordinates);
  } else {
    return [];
  }
  const out = [];
  for (const rings of groups) {
    if (!rings || !rings.length) continue;
    const exterior = rings[0];
    if (exterior && exterior.length >= 4) out.push(exterior);
    for (let i = 1; i < rings.length; i++) {
      const r = rings[i];
      if (!r || r.length < 4) continue;
      if (ringInside(r, exterior)) continue;
      out.push(r);
    }
  }
  return out;
}

function maxSlopeTop(slopeTop, rings) {
  if (typeof slopeTop !== "function" || !rings) return 0;
  let bottom = 0;
  for (let i = 0; i < rings.length; i++) {
    const z = Number(slopeTop(rings[i]));
    if (z > bottom) bottom = z;
  }
  return bottom;
}

/**
 * Downhill ground under the piece. Hamina draws the pasted floor as a ramp,
 * so a single bottom at the uphill end floats and the downhill face hangs
 * past the slope. The lowest seat is where the box meets the hill. The roof
 * stays the measured height above that ground.
 */
function slopeSeat(slopeTop, rings) {
  if (typeof slopeTop !== "function" || !rings) return 0;
  const seatFn = typeof slopeTop.seat === "function" ? slopeTop.seat : null;
  if (!seatFn) return maxSlopeTop(slopeTop, rings);
  let bottom = Infinity;
  let n = 0;
  for (let i = 0; i < rings.length; i++) {
    const z = Number(seatFn(rings[i]));
    if (!Number.isFinite(z)) continue;
    if (z < bottom) bottom = z;
    n++;
  }
  return n ? bottom : 0;
}

/** Source ring, the simplified ring, and the ring actually drawn on the image. */
function slopeRingsForEmit(source, simple, pixelRing, frame) {
  const rings = [];
  if (source && source.length >= 3) rings.push(source);
  if (simple && simple.length >= 4) rings.push(simple);
  if (pixelRing && pixelRing.length >= 3 && frame) {
    const ll = [];
    for (let i = 0; i < pixelRing.length; i++) {
      const p = pixelRing[i];
      if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) continue;
      ll.push(pxToLl(+p[0], +p[1], frame));
    }
    if (ll.length >= 3) {
      const a = ll[0];
      const b = ll[ll.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) ll.push([a[0], a[1]]);
      rings.push(ll);
    }
  }
  return rings;
}

function llFromOiPixels(pixelVerts, frame) {
  const ll = [];
  for (let i = 0; i < pixelVerts.length; i++) {
    const p = pixelVerts[i] && pixelVerts[i].coordinate_xyz;
    if (!p || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) continue;
    ll.push(pxToLl(+p.x, +p.y, frame));
  }
  if (ll.length < 3) return null;
  const a = ll[0];
  const b = ll[ll.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) ll.push([a[0], a[1]]);
  return ll;
}

function pickedForRing(rings, heightM, areaM2, slopeTop, heightSource, levelBase, shapePart, drawnRing, podium) {
  const base = levelBase > 0 ? levelBase : 0;
  // A stepped plan uses the band above the lower footprint, not the full height.
  const band = base > 0 ? Math.round((heightM - base) * 10) / 10 : heightM;
  const thickness = band > 2 ? band : heightM;
  // Gold One/Two/Five/Ten Floor stop at 32 m. A measured tower above that
  // is its own material. Nearby guesses stay in the stock buckets.
  // A dome band or a slope strip is a measured piece even when it is shorter
  // than Ten Floor, so the steps stay at the recorded metres.
  const measuredSource =
    heightSource === "overture" ||
    heightSource === "ms-global" ||
    heightSource === "fema" ||
    heightSource === "overture-floors" ||
    heightSource === HEIGHT_SOURCE;
  const picked = materialForBuilding(thickness, areaM2, {
    exactMetres:
      heightSource === HEIGHT_SOURCE ||
      heightSource === "static-caravan" ||
      base > 0 ||
      shapePart === true ||
      (measuredSource && measuredExceedsStock(thickness)),
  });
  // Each piece meets the downhill ground under its own ring and keeps the
  // measured height above that ground. A flat pad under 1 m omits the bottom.
  // The ring Hamina draws can drop a thin downhill nib that the source piece
  // still includes. Seating on that nib buries the box under the drawn floor.
  let bottom = slopeSeat(slopeTop, rings);
  if (drawnRing && slopeTop && typeof slopeTop.seat === "function") {
    const drawn = Number(slopeTop.seat(drawnRing));
    if (Number.isFinite(drawn) && drawn > bottom + 0.15) bottom = drawn;
  }
  bottom += base;
  const seated = bottom >= LIFT_LOCAL_M ? liftPickedBuilding(picked, bottom) : picked;
  return podium ? asPodium(seated) : seated;
}

function dpDegRing(ring, eps) {
  const open = openDegRing(ring);
  if (open.length < 3) return null;
  if (!(eps > 0) || open.length <= 3) return closeDegRing(open);
  const out = simplifyDP(open, eps * eps);
  if (!out || out.length < 3) return null;
  return closeDegRing(out);
}

/** A subsample turned a concave roof into a triangle. The source was not one. */
function collapsedWedge(source, candidate, mpd) {
  if (ringAreaM2(source, mpd) < 5000) return false;
  return extremeTriRatio(source) < 0.8 && extremeTriRatio(candidate) >= 0.9;
}

/**
 * Cut a ring in half along the long axis. Each piece must be shorter on that
 * axis than the source, so a bad clip cannot recurse forever.
 */
function splitRingHalf(ring) {
  const open = openDegRing(ring);
  if (open.length < 4) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let area = 0;
  for (let i = 0, j = open.length - 1; i < open.length; j = i++) {
    const p = open[i];
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
    area += open[j][0] * p[1] - p[0] * open[j][1];
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (!(spanX > 0) || !(spanY > 0)) return [];
  const vertical = spanX >= spanY;
  const mid = vertical ? (minX + maxX) / 2 : (minY + maxY) / 2;
  const span = vertical ? spanX : spanY;
  const pad = Math.max(spanX, spanY);
  const box = (low) => {
    if (vertical) {
      const x0 = low ? minX - pad : mid;
      const x1 = low ? mid : maxX + pad;
      return [
        [x0, minY - pad],
        [x1, minY - pad],
        [x1, maxY + pad],
        [x0, maxY + pad],
        [x0, minY - pad],
      ];
    }
    const y0 = low ? minY - pad : mid;
    const y1 = low ? mid : maxY + pad;
    return [
      [minX - pad, y0],
      [maxX + pad, y0],
      [maxX + pad, y1],
      [minX - pad, y1],
      [minX - pad, y0],
    ];
  };
  const ordered = area < 0 ? open.slice().reverse() : open;
  const subject = closeDegRing(ordered);
  if (!subject) return [];
  let raw = [];
  try {
    const a = polygonClipping.intersection([[subject]], [box(true)]);
    const b = polygonClipping.intersection([[subject]], [box(false)]);
    const multis = [a, b];
    for (let m = 0; m < multis.length; m++) {
      const multi = multis[m] || [];
      for (let p = 0; p < multi.length; p++) {
        const outer = multi[p] && multi[p][0];
        if (outer && outer.length >= 4) raw.push(outer);
      }
    }
  } catch {
    return [];
  }
  const kept = [];
  for (let i = 0; i < raw.length; i++) {
    const piece = openDegRing(raw[i]);
    if (piece.length < 3) continue;
    let s0 = Infinity;
    let s1 = -Infinity;
    for (let k = 0; k < piece.length; k++) {
      const v = vertical ? piece[k][0] : piece[k][1];
      if (v < s0) s0 = v;
      if (v > s1) s1 = v;
    }
    if (s1 - s0 >= span * 0.98) continue;
    const closed = closeDegRing(piece);
    if (closed) kept.push(closed);
  }
  return kept.length >= 2 ? kept : [];
}

/**
 * Douglas–Peucker down to the OpenIntent vertex cap, within about 2 m.
 * A ring that still has more corners is cut into pieces. It is never
 * replaced by a subsample or a convex hull.
 */
function wedgePieceOf(root, piece, mpd) {
  if (!root || !piece) return false;
  if (ringAreaM2(piece, mpd) < 5000) return false;
  return extremeTriRatio(root) < 0.8 && extremeTriRatio(piece) >= 0.9;
}

function ringsUnderVertexCap(ring, maxPts, eps, mpd, depth, root) {
  const rootRing = root || ring;
  const open = openDegRing(ring);
  if (open.length < 3) return [];
  const closed = closeDegRing(open);
  if (!closed) return [];
  if (ringAreaM2(closed, mpd) < MIN_AREA_M2) return [];
  if (open.length <= maxPts) {
    if (depth > 0 && wedgePieceOf(rootRing, closed, mpd)) return [];
    return [closed];
  }
  const simplified = dpDegRing(closed, eps);
  if (
    simplified &&
    ringVertexCount(simplified) >= 3 &&
    ringVertexCount(simplified) <= maxPts &&
    !collapsedWedge(closed, simplified, mpd) &&
    !wedgePieceOf(rootRing, simplified, mpd)
  ) {
    return [simplified];
  }
  if (depth >= 6) return [];
  const parts = splitRingHalf(closed);
  if (parts.length < 2) return [];
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const sub = ringsUnderVertexCap(parts[i], maxPts, eps, mpd, depth + 1, rootRing);
    for (let s = 0; s < sub.length; s++) out.push(sub[s]);
  }
  return out;
}

function emitBuilding(ring, heightM, frame, affine, buckets, slopeTop, heightSource, levelBase, shapePart, keepOut, keepSpanZone, keepThin, podium) {
  const px = [];
  for (let i = 0; i < ring.length; i++) {
    const xy = llToPx(ring[i][0], ring[i][1], frame);
    if (Number.isFinite(xy[0]) && Number.isFinite(xy[1])) px.push(xy);
  }
  if (px.length < 3) return "skip";
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < px.length; i++) {
    if (px[i][0] < minX) minX = px[i][0];
    if (px[i][1] < minY) minY = px[i][1];
    if (px[i][0] > maxX) maxX = px[i][0];
    if (px[i][1] > maxY) maxY = px[i][1];
  }
  if (maxX < 0 || maxY < 0 || minX > frame.imgW || minY > frame.imgH) return "clip";
  const clipped = clipRingToRect(px, frame.imgW, frame.imgH);
  if (!clipped || clipped.length < 3) return "clip";
  const am = pxRingAreaM2(clipped, frame.mpuX, frame.mpuY);
  if (!(am >= (keepThin ? 8 : MIN_AREA_M2))) return "tiny";
  // Mega uses the on-map area and the tight Douglas–Peucker count, not a
  // subsample. A coarse blob above 150,000 m² is still dropped. A concave
  // podium keeps its corners and is not classified as that blob. An outline
  // that misses the map is a clip, same as before.
  const tight = am > 80000 ? 1e-7 : am > 20000 ? 1e-6 : 2.5e-6;
  const detailed = dpDegRing(ring, tight) || ring;
  if (isMegaCampus(am, ringVertexCount(detailed))) return "mega";
  const tol = 2 / Math.min(frame.mpd.lon, frame.mpd.lat);
  const pieces = ringsUnderVertexCap(ring, MAX_OI_RING_VERTS, tol, frame.mpd, 0);
  if (!pieces.length) return ringVertexCount(ring) > MAX_OI_RING_VERTS ? "verts" : "skip";
  let sawKeep = false;
  let sawSpan = false;
  let lastFail = "skip";
  for (let i = 0; i < pieces.length; i++) {
    const result = emitBuildingSimplified(
      pieces[i],
      heightM,
      frame,
      affine,
      buckets,
      MAX_OI_RING_VERTS,
      tol,
      slopeTop,
      heightSource,
      levelBase,
      shapePart,
      keepOut,
      keepSpanZone,
      keepThin,
      podium
    );
    if (result === "keep") sawKeep = true;
    else if (result === "span") sawSpan = true;
    else if (result === "tiny") continue;
    else lastFail = result;
  }
  if (sawKeep) return "keep";
  if (sawSpan) return "span";
  return lastFail;
}

/** Overlay uses the detailed clip. Clipboard uses clipPx (exact sliver, or the OI ring on the keep path). */
function stashBuilding(buckets, frame, affine, clipRing, overlayPts, clipPx, picked) {
  if (picked.clipType) buckets.clipTypes.push(picked.clipType);
  if (picked.measured) buckets.measured++;
  const clipFromImage = [];
  if (!affine) {
    const open = uniqueOpenRing(clipPx);
    for (const p of open) {
      const m = pxToClipboard(p[0], p[1], frame);
      clipFromImage.push([
        Math.min(0, Math.max(-frame.widthM, m[0])),
        Math.min(0, Math.max(-frame.lengthM, m[1])),
      ]);
    }
  }
  const z = clipZone(picked.typeId, affine ? clipRing : clipFromImage);
  if (z) buckets.clipZones.push(z);
  const src = overlayPts && overlayPts.length ? overlayPts : clipPx;
  const cxs = src.map((p) => p[0]);
  const cys = src.map((p) => p[1]);
  buckets.aabbs.push({
    minX: Math.min(...cxs),
    maxX: Math.max(...cxs),
    minY: Math.min(...cys),
    maxY: Math.max(...cys),
  });
  buckets.overlayRings.push(src);
  buckets.overlayHeights.push(
    picked.buildingHeight || picked.exactHeight || (picked.material && picked.material.top_height) || 0
  );
}

function emitBuildingSimplified(ring, heightM, frame, affine, buckets, maxPts, eps, slopeTop, heightSource, levelBase, shapePart, keepOut, keepSpanZone, keepThin, podium) {
  const simple = simplifyRing(ring, maxPts, eps);
  if (!simple || simple.length < 4) return "skip";
  const detailVerts = ringVertexCount(simple);
  const pts = [];
  const clipRing = [];
  for (const [lon, lat] of simple) {
    const [x, y] = llToPx(lon, lat, frame);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      pts.push([x, y]);
      clipRing.push(lonLatToClip(lon, lat, frame, affine));
    }
  }
  if (pts.length < 3) return "skip";
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX < 0 || maxY < 0 || minX > frame.imgW || minY > frame.imgH) return "clip";
  // Clip before size filters so off-map MS hulls are not counted as mega.
  const clippedPts = clipRingToRect(pts, frame.imgW, frame.imgH);
  if (!clippedPts || clippedPts.length < 3) return "clip";
  const am = pxRingAreaM2(clippedPts, frame.mpuX, frame.mpuY);
  if (isMegaCampus(am, detailVerts)) return "mega";
  // A static caravan is a real trailer, often narrower than the 3 m sliver floor.
  if (am < (keepThin ? 8 : MIN_AREA_M2)) return "tiny";
  const slopeRings = slopeRingsForEmit(ring, simple, clippedPts, frame);
  const minSpan = minOiSpanPx(frame.mpuX);
  if (!keepThin && am < 1000 && thinSliverDrop(clippedPts, minSpan)) {
    // Clipboard keeps a building that is only a sliver. A fragment cut off a
    // larger roof is not that building: OpenIntent drops it, and a second
    // clipboard zone would no longer match the area list. A static caravan
    // is the building, so it stays in the area list instead of this path.
    if (keepSpanZone === false) return "tiny";
    const pickedThin = pickedForRing(slopeRings, heightM, am, slopeTop, heightSource, levelBase, shapePart, null, podium);
    if (pickedThin.lifted) buckets.lifted++;
    stashBuilding(buckets, frame, affine, clipRing, clippedPts, clippedPts, pickedThin);
    return "span";
  }
  const keepOutPx = [];
  if (keepOut && keepOut.length && frame) {
    for (let k = 0; k < keepOut.length; k++) {
      const p = keepOut[k];
      if (!p) continue;
      const xy = llToPx(+p[0], +p[1], frame);
      if (Number.isFinite(xy[0]) && Number.isFinite(xy[1])) keepOutPx.push(xy);
    }
  }
  const oiOpts = { keepOutPx };
  if (keepThin) {
    const b = ringBBox(clippedPts);
    const drawn = Math.min(b.w, b.h);
    oiOpts.keepShape = true;
    oiOpts.minSpanPx = Math.max(drawn * 0.98, 0.05);
    oiOpts.spanFloorPx = Math.min(MIN_OI_SPAN_PX, Math.max(drawn * 0.5, 0.02));
  }
  const oiCoords = ringToOi(clippedPts, frame.imgW, frame.imgH, frame.mpuX, oiOpts);
  if (!oiCoords) {
    if (ringVertexCount(clippedPts) > MAX_OI_RING_VERTS) return "verts";
    return "clip";
  }
  const drawnRing = llFromOiPixels(oiPixelCoords(oiCoords), frame);
  let picked = pickedForRing(slopeRings, heightM, am, slopeTop, heightSource, levelBase, shapePart, drawnRing, podium);
  const area = emitIfValid(
    makeOiArea(oiCoords, picked.material),
    frame.imgW,
    frame.imgH,
    keepThin ? oiOpts.spanFloorPx : undefined
  );
  if (!area) return "invalid";
  buckets.oiAreas.push(area);
  if (picked.clipType) buckets.clipTypes.push(picked.clipType);
  if (picked.material) buckets.materials.push(picked.material);
  if (picked.measured) buckets.measured++;
  // Clipboard meters follow the clipped OpenIntent ring, not the raw lon/lat
  // polygon. Footprints that cross the JPEG were landing at x=+8.4, y=+38,
  // y=-1999 against a south edge of -1919.
  // Only the pixel vertices are an image grid. A Hamina triple export also
  // carries meters and feet. Treating those as pixels (PR #20) inflated
  // footprints and shoved them south/west of the aerial.
  const clipFromImage = [];
  if (!affine) {
    const pixelVerts = oiPixelCoords(oiCoords);
    const n = pixelVerts.length;
    const end =
      n > 1 &&
      pixelVerts[0].coordinate_xyz.x === pixelVerts[n - 1].coordinate_xyz.x &&
      pixelVerts[0].coordinate_xyz.y === pixelVerts[n - 1].coordinate_xyz.y
        ? n - 1
        : n;
    for (let i = 0; i < end; i++) {
      const p = pixelVerts[i].coordinate_xyz;
      const m = pxToClipboard(p.x, p.y, frame);
      clipFromImage.push([
        Math.min(0, Math.max(-frame.widthM, m[0])),
        Math.min(0, Math.max(-frame.lengthM, m[1])),
      ]);
    }
  }
  const z = clipZone(picked.typeId, affine ? clipRing : clipFromImage);
  if (!z) {
    buckets.oiAreas.pop();
    if (picked.clipType) buckets.clipTypes.pop();
    if (picked.material) buckets.materials.pop();
    if (picked.measured) buckets.measured--;
    return "clip";
  }
  buckets.clipZones.push(z);
  const cxs = clippedPts.map((p) => p[0]);
  const cys = clippedPts.map((p) => p[1]);
  buckets.aabbs.push({
    minX: Math.min(...cxs),
    maxX: Math.max(...cxs),
    minY: Math.min(...cys),
    maxY: Math.max(...cys),
  });
  buckets.overlayRings.push(clippedPts);
  buckets.overlayHeights.push(picked.buildingHeight || picked.exactHeight || picked.material.top_height);
  if (picked.lifted) buckets.lifted++;
  return "keep";
}

function ringCentroidLL(ring) {
  if (!ring || ring.length < 3) return null;
  const end =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < end; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return end ? [sx / end, sy / end] : null;
}

function sourceHeight(feature) {
  const props = (feature && feature.properties) || {};
  const h = Number(props.height || props.Height || props.HEIGHT || 0);
  return h > 2 && h < 400 ? h : 0;
}

/** Donors for a missing height stay under 80 m, so a tower is not copied onto a shed. */
function readHeight(feature) {
  const h = sourceHeight(feature);
  return h > 0 && h < 80 ? h : 0;
}

/**
 * Buildings with no measured height take the nearest measured height within 120 m.
 * A height already on the feature is kept, including a tower above 80 m.
 * Farther than 120 m, the stock area bins remain the fallback.
 */
function borrowNearbyHeights(features, frame) {
  if (!frame || !frame.mpd) return 0;
  const measured = [];
  for (const f of features || []) {
    const h = readHeight(f);
    if (!h) continue;
    const rings = featureExteriorRings(f.geometry);
    const c = rings[0] && ringCentroidLL(rings[0]);
    if (c) measured.push({ c, h });
  }
  if (!measured.length) return 0;
  const maxD = 120 * 120;
  let n = 0;
  for (const f of features || []) {
    if (sourceHeight(f)) continue;
    const rings = featureExteriorRings(f.geometry);
    const c = rings[0] && ringCentroidLL(rings[0]);
    if (!c) continue;
    let best = 0;
    let bestD = maxD;
    for (let i = 0; i < measured.length; i++) {
      const dx = (c[0] - measured[i].c[0]) * frame.mpd.lon;
      const dy = (c[1] - measured[i].c[1]) * frame.mpd.lat;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD) {
        bestD = d2;
        best = measured[i].h;
      }
    }
    if (!best) continue;
    if (!f.properties) f.properties = {};
    f.properties.height = best;
    if (!f.properties.heightSource) f.properties.heightSource = "nearby";
    n++;
  }
  return n;
}

/** Larger and taller roofs fill the 2000 and 982 caps first. */
function prioritizeRoofs(features, frame) {
  const list = features || [];
  const mpd = frame && frame.mpd;
  const scored = [];
  for (let i = 0; i < list.length; i++) {
    const feature = list[i];
    const rings = featureExteriorRings(feature && feature.geometry);
    let area = 0;
    if (mpd) {
      for (let r = 0; r < rings.length; r++) area += ringAreaM2(rings[r], mpd);
    }
    const height = sourceHeight(feature);
    scored.push({
      feature,
      i,
      area,
      height,
      score: area * Math.max(1, height / 10),
    });
  }
  scored.sort((a, b) => b.score - a.score || b.height - a.height || b.area - a.area || a.i - b.i);
  const out = [];
  for (let i = 0; i < scored.length; i++) out.push(scored[i].feature);
  return out;
}

const PODIUM_MAX_M = 30;
const PODIUM_TOWER_RATIO = 2.5;
const PODIUM_HEIGHT_FRACTION = 0.4;
const PODIUM_TOUCH_M = 2.5;
/** A roof cut off the base can miss the tower. A shed that only touches the base does not. */
const PODIUM_HOP_M2 = 800;

/** Same area bins as an unmeasured stock floor. A missing height is not a tower. */
function areaHeightM(areaM2) {
  if (areaM2 >= 6000) return 40;
  if (areaM2 >= 1200) return 16;
  if (areaM2 >= 400) return 8;
  return 4.5;
}

function boxGapM(a, b) {
  const dx = a.maxX < b.minX ? b.minX - a.maxX : b.maxX < a.minX ? a.minX - b.maxX : 0;
  const dy = a.maxY < b.minY ? b.minY - a.maxY : b.maxY < a.minY ? a.minY - b.maxY : 0;
  return Math.hypot(dx, dy);
}

function pointInMeterRings(pt, rings) {
  if (!pt) return false;
  for (let i = 0; i < rings.length; i++) {
    if (pointInRing(pt, rings[i])) return true;
  }
  return false;
}

function segmentDistance(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (!(len2 > 1e-8)) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function vertexGapM(from, into) {
  let best = Infinity;
  for (let i = 0; i < from.rings.length; i++) {
    const verts = from.rings[i];
    const step = verts.length > 80 ? Math.ceil(verts.length / 80) : 1;
    for (let v = 0; v < verts.length; v += step) {
      const p = verts[v];
      for (let j = 0; j < into.rings.length; j++) {
        const edge = into.rings[j];
        for (let e = 1; e < edge.length; e++) {
          const d = segmentDistance(p, edge[e - 1], edge[e]);
          if (d < best) best = d;
          if (best <= PODIUM_TOUCH_M) return best;
        }
      }
    }
  }
  return best;
}

function footprintContains(inner, outer) {
  if (inner.centroid && pointInMeterRings(inner.centroid, outer.rings)) return true;
  const samples = [];
  for (let i = 0; i < inner.rings.length; i++) {
    const verts = inner.rings[i];
    const step = verts.length > 16 ? Math.ceil(verts.length / 16) : 1;
    for (let v = 0; v < verts.length; v += step) samples.push(verts[v]);
  }
  if (!samples.length) return false;
  let inside = 0;
  for (let i = 0; i < samples.length; i++) {
    if (pointInMeterRings(samples[i], outer.rings)) inside++;
  }
  return inside >= Math.max(1, Math.ceil(samples.length * 0.5));
}

function footprintsMeet(a, b) {
  if (boxGapM(a.box, b.box) > PODIUM_TOUCH_M) return false;
  if (footprintContains(a, b) || footprintContains(b, a)) return true;
  return Math.min(vertexGapM(a, b), vertexGapM(b, a)) <= PODIUM_TOUCH_M;
}

function lowRiseUnderTower(heightM, towerM) {
  if (!(heightM > 2) || !(towerM > 0)) return false;
  if (!(towerM >= heightM * PODIUM_TOWER_RATIO - 1e-6)) return false;
  return heightM <= PODIUM_MAX_M || heightM < PODIUM_HEIGHT_FRACTION * towerM;
}

/**
 * A podium is a low roof that touches or contains a measured tower at least
 * 2.5 times as tall. The roof is low when it is about 30 m or less, or under
 * 40 percent of that tower. A second low piece of at least 800 m2 that only
 * touches that base (a roof cut out of the same complex) is included once.
 * A floating upper part is not a base. An unmeasured neighbor is not a tower.
 */
function markPodiumBases(features, frame) {
  const mpd = frame && frame.mpd;
  if (!mpd || !(mpd.lon > 0) || !(mpd.lat > 0)) return 0;
  const items = [];
  for (let i = 0; i < (features || []).length; i++) {
    const feature = features[i];
    if (!feature || !feature.geometry) continue;
    const props = feature.properties || {};
    if (props.shapePart === true) continue;
    const rings = featureExteriorRings(feature.geometry);
    if (!rings.length) continue;
    let area = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const meterRings = [];
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      area += ringAreaM2(ring, mpd);
      const meters = [];
      for (let k = 0; k < ring.length; k++) {
        const x = ring[k][0] * mpd.lon;
        const y = ring[k][1] * mpd.lat;
        meters.push([x, y]);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      meterRings.push(meters);
    }
    const c = ringCentroidLL(rings[0]);
    const measured = sourceHeight(feature);
    items.push({
      feature,
      rings: meterRings,
      area,
      measured,
      eff: measured > 2 ? measured : areaHeightM(area),
      levelBase: Number(props.levelBaseM) > 0 ? Number(props.levelBaseM) : 0,
      box: { minX, minY, maxX, maxY },
      centroid: c ? [c[0] * mpd.lon, c[1] * mpd.lat] : null,
      towerH: 0,
    });
  }
  function tag(item, towerH) {
    if (!item.feature.properties) item.feature.properties = {};
    item.feature.properties.podium = true;
    item.towerH = towerH;
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.levelBase > 2) continue;
    let towerH = 0;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const other = items[j];
      if (!(other.measured >= item.eff * PODIUM_TOWER_RATIO - 1e-6)) continue;
      if (!footprintsMeet(item, other)) continue;
      if (other.measured > towerH) towerH = other.measured;
    }
    if (!lowRiseUnderTower(item.eff, towerH)) continue;
    tag(item, towerH);
  }
  const direct = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].towerH > 0) direct.push(items[i]);
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.towerH > 0) continue;
    if (item.levelBase > 2) continue;
    if (!(item.area >= PODIUM_HOP_M2)) continue;
    let towerH = 0;
    for (let j = 0; j < direct.length; j++) {
      const other = direct[j];
      if (!footprintsMeet(item, other)) continue;
      if (other.towerH > towerH) towerH = other.towerH;
    }
    if (!lowRiseUnderTower(item.eff, towerH)) continue;
    tag(item, towerH);
  }
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].feature.properties && items[i].feature.properties.podium) n++;
  }
  return n;
}

function footprintsToClutter(features, frame, affine, slopeTop, opts) {
  const buildingCeiling = opts && opts.buildingCeiling > 0 ? opts.buildingCeiling | 0 : MAX_BUILDINGS;
  const separated = dedupeStackedFootprints(features || []);
  const list = prioritizeRoofs(separated.features, frame);
  borrowNearbyHeights(list, frame);
  markPodiumBases(list, frame);
  const oiAreas = [];
  const clipZones = [];
  const aabbs = [];
  const overlayRings = [];
  const parkingRings = [];
  const stats = {
    fetched: (features || []).length,
    droppedStacked: separated.dropped,
    cutStacked: separated.cut,
    mergedStacked: separated.merged,
    buildings: 0,
    droppedMega: 0,
    droppedTiny: 0,
    droppedClip: 0,
    droppedCap: 0,
    droppedInvalid: 0,
    droppedSpan: 0,
    droppedVerts: 0,
    largeDropNotes: [],
    podiumAreas: 0,
    nlsHeights: 0,
    nlsHeightMin: 0,
    nlsHeightMax: 0,
  };
  const buckets = {
    oiAreas,
    clipZones,
    aabbs,
    overlayRings,
    overlayHeights: [],
    clipTypes: [],
    materials: [],
    measured: 0,
    lifted: 0,
  };
  for (const f of list) {
    // Dome rings and slope strips are built after dedupe. Concentric copies
    // fed through dedupe would be merged back into one slab.
    const shaped = piecesForFeature(f);
    for (let s = 0; s < shaped.length; s++) {
      const piece = shaped[s];
      const g = piece.geometry;
      if (!g) continue;
      const props = piece.properties || {};
      const heightM = Number(props.height || props.Height || props.HEIGHT || 0) || 0;
      const heightSource = props.heightSource || "";
      const levelBase = Number(props.levelBaseM) > 0 ? Number(props.levelBaseM) : 0;
      const shapePart = props.shapePart === true;
      const rings = footprintRings(g);
      if (!rings.length) continue;
      if (isParkingClass(props) || isParkingClass(f && f.properties)) {
        const tagged = Number(props.height || props.Height || props.HEIGHT || 0);
        for (let ri = 0; ri < rings.length; ri++) {
          parkingRings.push({ ring: rings[ri], heightM: tagged > 2 ? tagged : 0 });
        }
      }
      const keepOut = Array.isArray(props.keepOut) ? props.keepOut : [];
      const keepThin = props.staticCaravan === true;
      const podium = props.podium === true;
      for (const ring of rings) {
        const parts = slopeTop && typeof slopeTop.split === "function" ? slopeTop.split(ring) : [ring];
        for (let p = 0; p < parts.length; p++) {
          if (oiAreas.length >= buildingCeiling) {
            stats.droppedCap++;
            continue;
          }
          const result = emitBuilding(
            parts[p],
            heightM,
            frame,
            affine,
            buckets,
            slopeTop,
            heightSource,
            levelBase,
            shapePart,
            keepOut,
            parts.length === 1,
            keepThin,
            podium
          );
          if (result === "keep") {
            stats.buildings++;
            if (heightSource === HEIGHT_SOURCE && heightM > 2) {
              stats.nlsHeights++;
              if (!stats.nlsHeightMin || heightM < stats.nlsHeightMin) stats.nlsHeightMin = heightM;
              if (heightM > stats.nlsHeightMax) stats.nlsHeightMax = heightM;
            }
          } else if (result === "mega") stats.droppedMega++;
          else if (result === "tiny") stats.droppedTiny++;
          else if (result === "clip") stats.droppedClip++;
          else if (result === "invalid") stats.droppedInvalid++;
          else if (result === "span") stats.droppedSpan++;
          else if (result === "verts") stats.droppedVerts++;
          if (result !== "keep") {
            const droppedArea = ringAreaM2(parts[p], frame.mpd);
            if (droppedArea >= 1000) {
              const why =
                result === "mega"
                  ? "outline was too large"
                  : result === "tiny"
                    ? "outline was too small"
                    : result === "clip"
                      ? "outline missed the map"
                      : result === "invalid"
                        ? "outline was not a valid area"
                        : result === "span"
                          ? "outline was a sliver"
                          : result === "verts"
                            ? "outline had too many corners"
                            : "outline was not a closed area";
              stats.largeDropNotes.push(
                "Dropped building " + Math.round(droppedArea) + " m2: " + why + "."
              );
            }
          }
        }
      }
    }
  }
  stats.droppedNested = dropNestedDuplicateRoofs(oiAreas, clipZones);
  stats.buildings = oiAreas.length;
  stats.podiumAreas = 0;
  for (let i = 0; i < oiAreas.length; i++) {
    const name = oiAreas[i] && oiAreas[i].area_material && oiAreas[i].area_material.name;
    if (isPodiumName(name) || isLiftedPodiumName(name)) stats.podiumAreas++;
  }
  stats.measuredBuildings = buckets.measured;
  stats.buildingsLifted = buckets.lifted;
  return {
    oiAreas,
    clipZones,
    aabbs,
    overlayRings,
    parkingRings,
    overlayHeights: buckets.overlayHeights,
    clipTypes: buckets.clipTypes,
    materials: buckets.materials,
    stats,
  };
}

function treesToOi(oiTreeAreas, imgW, imgH, mpuX) {
  const areas = [];
  const kinds = [];
  let droppedInvalid = 0;
  for (const t of oiTreeAreas || []) {
    const opts = { keepShape: true };
    if (t.kind === "trunk") {
      // Hold the drawn ~1 m circle. The shared 3 m / 4 px floor used to
      // stretch it, and a collapsed blob was replaced with a square.
      const b = ringBBox(t.ringPx);
      const drawn = Math.min(b.w, b.h);
      const hold = Math.max(drawn * 0.98, 0.05);
      opts.minSpanPx = hold;
      opts.spanFloorPx = Math.min(MIN_OI_SPAN_PX, Math.max(drawn * 0.5, 0.02));
    }
    const coords = ringToOi(t.ringPx, imgW, imgH, mpuX, opts);
    const area = emitIfValid(makeOiArea(coords, t.material), imgW, imgH, opts.spanFloorPx);
    if (!area) {
      droppedInvalid++;
      continue;
    }
    areas.push(area);
    kinds.push(
      t.kind === "trunk" ? "trunk" : t.kind === "layer" ? "layer" : t.kind === "slope" ? "slope" : "canopy"
    );
  }
  return { areas, kinds, droppedInvalid };
}

function outdoorToOi(items, imgW, imgH, mpuX) {
  const areas = [];
  const kinds = [];
  const droppedByKind = {};
  for (const t of items || []) {
    const opts = { keepShape: true };
    if (t.thin) {
      // Hold the drawn width. The 3 m / 4 px floor would turn a fence into a road.
      const b = ringBBox(t.ringPx);
      const drawn = Math.min(b.w, b.h);
      opts.minSpanPx = Math.max(drawn * 0.98, 0.05);
      opts.spanFloorPx = Math.min(MIN_OI_SPAN_PX, Math.max(drawn * 0.5, 0.02));
    }
    const coords = ringToOi(t.ringPx, imgW, imgH, mpuX, opts);
    const area = emitIfValid(makeOiArea(coords, t.material), imgW, imgH, opts.spanFloorPx);
    if (!area) {
      droppedByKind[t.kind] = (droppedByKind[t.kind] || 0) + 1;
      continue;
    }
    areas.push(area);
    kinds.push(t.kind);
  }
  return { areas, kinds, droppedByKind };
}

/** Hamina outdoor OpenIntent floorplan height (gold export + after-paste re-export). */
const OI_FLOORPLAN_HEIGHT_M = 2.5;
const OI_FLOORPLAN_HEIGHT_FT = 8.202;

function buildOpenIntent(frame, name, imgName, areas, materials) {
  const mpu = frame.mpuX || frame.mpu || frame.widthM / frame.imgW;
  return {
    floorplans: [
      {
        name,
        project_name: name + " Clutter",
        floor_id: uuid(),
        rotation: 0,
        map_uri: "file://images/" + imgName,
        dimensions: [
          {
            width: frame.imgW,
            length: frame.imgH,
            height: OI_FLOORPLAN_HEIGHT_M / mpu,
            unit: "pixels",
          },
          {
            width: frame.widthM,
            length: frame.lengthM,
            height: OI_FLOORPLAN_HEIGHT_M,
            unit: "meters",
          },
          {
            width: frame.widthM / 0.3048,
            length: frame.lengthM / 0.3048,
            height: OI_FLOORPLAN_HEIGHT_FT,
            unit: "feet",
          },
        ],
        attenuation_areas: areas,
        coverage_areas: [],
        reference_markers: [],
        closets: [],
      },
    ],
    wall_materials: [],
    switches: [],
    area_materials: documentMaterials(areas),
    openintent_version: OPENINTENT_VERSION,
  };
}

/**
 * Keep a priority-ordered prefix of chunks inside the JSON byte budget.
 * A chunk is one building, one tree (crown, layers, and stem), or one
 * outdoor area. The next chunk is omitted whole when it would pass the budget.
 */
function fitChunksToJsonBudget(frame, name, imgName, chunks, budget) {
  const limit = budget > 0 ? budget : OPENINTENT_JSON_BUDGET;
  const src = [];
  for (let i = 0; i < (chunks || []).length; i++) {
    const chunk = chunks[i];
    if (chunk && chunk.areas && chunk.areas.length) src.push(chunk);
  }
  const flat = [];
  const ends = [];
  for (let i = 0; i < src.length; i++) {
    const areas = src[i].areas;
    for (let j = 0; j < areas.length; j++) flat.push(areas[j]);
    ends.push(flat.length);
  }
  const sizeAt = (n) => Buffer.byteLength(JSON.stringify(buildOpenIntent(frame, name, imgName, flat.slice(0, n))));
  if (!ends.length) {
    return { areas: [], chunks: [], bytes: sizeAt(0), trimmed: false };
  }
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (sizeAt(ends[mid - 1]) <= limit) lo = mid;
    else hi = mid - 1;
  }
  const n = lo === 0 ? 0 : ends[lo - 1];
  return {
    areas: flat.slice(0, n),
    chunks: src.slice(0, lo),
    bytes: sizeAt(n),
    trimmed: lo < src.length,
  };
}

function buildClutter({
  frame,
  footprintsGeojson,
  treePoints,
  affine,
  name: rawName,
  imgBuf,
  treesSource,
  footprintMeta,
  terrain,
  warnings,
  canopyHits,
  heightSample,
  maskRings,
  maskPolygons,
  includeFoliage,
  chmGrid,
  terrainResolution,
  nlsHeights,
  omitFoliage,
  chmRequired,
  maxFoliagePolygons,
  woodRings,
  outdoorFeatures,
  outdoorNotes,
  includeWater,
  includeParking,
  includeWalls,
  includePoles,
  includeRvs,
  outdoorMiss,
  guidewayFeatures,
  includeGuideways,
  bridgeFeatures,
  includeBridges,
  maxAttenuationAreas,
  areaCapOverride,
  jsonBudget,
}) {
  const featureList = footprintsGeojson?.features || [];
  if (Array.isArray(warnings)) {
    for (let i = warnings.length - 1; i >= 0; i--) {
      if (
        /left out to stay inside the area budget|not a valid shape|Kept the largest canopy outlines|Kept the \d+ largest/.test(
          String(warnings[i])
        )
      ) {
        warnings.splice(i, 1);
      }
    }
  }
  if (nlsHeights) {
    const nls = applyNlsBuildingHeights(featureList);
    if (nls && nls.omitted && Array.isArray(warnings)) {
      warnings.push(
        "Finland building heights omitted: the laser grid could not be read. OpenIntent zip is unchanged."
      );
    }
  }
  const { name, slug } = siteName(rawName);
  const imgName = `${slug}.jpg`;
  if (includeWater === true && terrain && outdoorFeatures && outdoorFeatures.length) {
    const waterRings = [];
    for (let i = 0; i < outdoorFeatures.length; i++) {
      const feat = outdoorFeatures[i];
      if (feat && feat.kind === "water" && feat.coords && feat.coords.length >= 4) waterRings.push(feat.coords);
    }
    if (waterRings.length) depressWaterBasins(terrain, waterRings);
  }
  const slopeTop = demUnderFootprint(terrain);
  const areaCap = maxAttenuationAreas > 0 ? maxAttenuationAreas | 0 : MAX_ATTENUATION_AREAS;
  const jsonByteBudget = jsonBudget > 0 ? jsonBudget | 0 : OPENINTENT_JSON_BUDGET;
  const capIsOverride = areaCapOverride === true;
  const buildingCeiling =
    areaCap > MAX_ATTENUATION_AREAS ? Math.max(MAX_BUILDINGS, areaCap) : MAX_BUILDINGS;
  const fp = footprintsToClutter(featureList, frame, affine, slopeTop, { buildingCeiling });
  const foliageOn = includeFoliage === true;
  const veg = foliageOn
    ? treePairsFromPoints(treePoints || [], frame, fp.aabbs, affine, {
        canopyHits,
        heightSample,
        chmGrid,
        buildingRings: fp.overlayRings,
        maskRings,
        maskPolygons,
        slopeTop,
        omitFoliage: omitFoliage === true,
        chmRequired: chmRequired === true,
        maxPolygons: maxFoliagePolygons,
        woodRings,
      })
    : {
        oiAreas: [],
        clipZones: [],
        clipTypes: [],
        materials: [],
        count: 0,
        foliageLifted: 0,
        foliageGeometry: omitFoliage ? "omitted" : "none",
        foliageCoarsened: false,
        polygons: 0,
        overlayPoints: [],
        overlayRings: [],
      };
  if (foliageOn && veg.foliageCoarsened && Array.isArray(warnings)) {
    const cap = maxFoliagePolygons > 0 ? maxFoliagePolygons | 0 : 720;
    const dropped = veg.foliageDropped | 0;
    let line =
      cap >= 720
        ? "Kept the largest canopy outlines, then measured crowns, up to " + cap + "."
        : "Kept the largest canopy outlines so this zip can download.";
    if (dropped > 0) line += " " + dropped + " more canopy outlines did not fit.";
    if (warnings.indexOf(line) < 0) warnings.push(line);
  }
  // A poisoned or drifted vegetation material fails makeOiArea and that ring
  // is omitted, so it cannot empty the buildings.
  const treeOi = treesToOi(veg.oiAreas, frame.imgW, frame.imgH, frame.mpuX);
  const deckCap = raisedDeckCap(areaCap);
  let waterAreas = 0;
  let parkingAreas = 0;
  let wallAreas = 0;
  let poleAreas = 0;
  let guidewayAreas = 0;
  let bridgeAreas = 0;
  let rvAreas = 0;
  const outdoorOn =
    includeWater === true ||
    includeParking === true ||
    includeWalls === true ||
    includePoles === true ||
    includeRvs === true;
  const guideIn = [];
  const outdoorRest = [];
  const rawOutdoor = outdoorFeatures || [];
  for (let i = 0; i < rawOutdoor.length; i++) {
    const feat = rawOutdoor[i];
    if (feat && feat.kind === "guideway") guideIn.push(feat);
    else outdoorRest.push(feat);
  }
  const explicitGuides = Array.isArray(guidewayFeatures) ? guidewayFeatures : [];
  const guides = explicitGuides.length ? explicitGuides : guideIn;
  const explicitBridges = Array.isArray(bridgeFeatures) ? bridgeFeatures : [];
  const bridges = explicitBridges;
  let planned = null;
  let converted = null;
  const planGuides = guides.length > 0 || bridges.length > 0;
  if ((outdoorOn && outdoorMiss !== true) || planGuides) {
    const buildings = [];
    if (includeParking === true && outdoorOn && outdoorMiss !== true) {
      for (let i = 0; i < fp.oiAreas.length; i++) {
        buildings.push({
          index: i,
          ringPx: fp.overlayRings[i],
          material: fp.oiAreas[i] && fp.oiAreas[i].area_material,
        });
      }
    }
    const features = (outdoorOn && outdoorMiss !== true ? outdoorRest : []).concat(guides, bridges);
    planned = planOutdoor({
      features,
      frame,
      slopeTop,
      buildings,
      parkingRings: includeParking === true && outdoorOn && outdoorMiss !== true ? fp.parkingRings : [],
      segmentCaps:
        deckCap > 0
          ? { guideway: deckCap, bridge: deckCap, footbridge: Math.max(12, Math.floor(deckCap / 5)) }
          : undefined,
    });
    converted = outdoorToOi(planned.items, frame.imgW, frame.imgH, frame.mpuX);
  }
  // Water, the rail, and road decks are held before crowns fill the 982
  // cap. Poles and walls are not, so they drop before a tree does. The
  // rail stays ahead of a road deck, and both stay ahead of light poles.
  let waterParking = 0;
  let deckCount = 0;
  let rvCount = 0;
  const outdoorKinds = converted ? converted.kinds : [];
  for (let i = 0; i < outdoorKinds.length; i++) {
    const kind = outdoorKinds[i];
    if (kind === "water" || kind === "parking") waterParking++;
    else if (kind === "guideway" || kind === "bridge") deckCount++;
    else if (kind === "rv") rvCount++;
  }
  // Trees used to take every slot the buildings left. A dense campus then
  // reported Guideways 0. Hold the rail and the road decks first, then water.
  // Above 982, that leftover is zero because buildings fill the cap, so the
  // extra slots are reserved before the buildings take them.
  const DECK_HOLD_MAX = 96;
  let reserveFit = 0;
  let outdoorFront = null;
  let deckHold = 0;
  let waterHold = 0;
  let rvHold = 0;
  let capped;
  let buildingInput = fp.oiAreas;
  let slicedOff = 0;
  if (areaCap > MAX_ATTENUATION_AREAS) {
    const holds = raisedAreaHolds(areaCap, {
      buildings: fp.oiAreas.length,
      treeAreas: treeOi.areas.length,
      deckCount,
      waterParking,
      rvCount,
    });
    buildingInput = fp.oiAreas.slice(0, holds.buildingLimit);
    slicedOff = fp.oiAreas.length - buildingInput.length;
    capped = capBuildingsAndTrees(
      buildingInput,
      treeOi.areas,
      treeOi.kinds,
      holds.buildingLimit + holds.treeHold,
      0
    );
    outdoorFront = holds.waterHold;
    deckHold = holds.deckHold;
    waterHold = holds.waterHold;
    rvHold = holds.rvHold;
  } else {
    const buildingSlots = Math.min(fp.oiAreas.length, areaCap);
    const leftover = Math.max(0, areaCap - buildingSlots);
    deckHold = Math.min(deckCount, DECK_HOLD_MAX, leftover);
    waterHold = Math.min(waterParking, Math.max(0, leftover - deckHold));
    rvHold = Math.min(rvCount, Math.max(0, leftover - deckHold - waterHold));
    reserveFit = deckHold + waterHold + rvHold;
    capped = capBuildingsAndTrees(fp.oiAreas, treeOi.areas, treeOi.kinds, areaCap, reserveFit);
  }
  const buildingsBeforeBytes = buildingInput.length - capped.droppedBuildings;
  const roofsLeftByCount = slicedOff + capped.droppedBuildings;
  const treeEmittedBefore = capped.areas.length - buildingsBeforeBytes;
  let areas = capped.areas;
  let outdoorKeptKinds = [];
  let outdoorLeft = 0;
  if (planned && converted) {
    for (let i = 0; i < planned.updates.length; i++) {
      const u = planned.updates[i];
      if (u.index < buildingsBeforeBytes && areas[u.index]) areas[u.index].area_material = u.material;
    }
    const room = Math.max(0, areaCap - areas.length);
    const rvList = [];
    const otherAreas = [];
    const otherKinds = [];
    for (let i = 0; i < converted.kinds.length; i++) {
      if (converted.kinds[i] === "rv") rvList.push(converted.areas[i]);
      else {
        otherAreas.push(converted.areas[i]);
        otherKinds.push(converted.kinds[i]);
      }
    }
    // Decks and water keep the slots already held for them. RVs take the
    // rest of that room before walls, and trees were already held back.
    const protectedOutdoor = Math.min(room, deckHold + waterHold);
    const rvRoom = Math.min(rvList.length, Math.max(0, room - protectedOutdoor));
    const rvTake = rvList.slice(0, rvRoom);
    const fit = fitOutdoorBudget(
      otherAreas,
      otherKinds,
      room - rvTake.length,
      outdoorFront == null ? undefined : { front: outdoorFront }
    );
    outdoorKeptKinds = fit.kinds.concat(rvTake.map(function () { return "rv"; }));
    outdoorLeft = converted.areas.length - fit.items.length - rvTake.length;
    areas = areas.concat(fit.items, rvTake);
    const drop = converted.droppedByKind || {};
    const wallDrop =
      (drop.wall || 0) + (drop.fence || 0) + (drop.retaining || 0) + (drop.hedge || 0);
    const notes = (outdoorNotes || []).concat(planned.notes || [], fit.notes || []);
    const shapeNote = (n, label) =>
      n + " " + label + (n === 1 ? " was" : "s were") + " not a valid shape.";
    if (wallDrop) notes.push(shapeNote(wallDrop, "wall"));
    if (drop.pole) notes.push(shapeNote(drop.pole, "light pole"));
    if (drop.guideway) notes.push(shapeNote(drop.guideway, "guideway"));
    if (drop.bridge) notes.push(shapeNote(drop.bridge, "bridge"));
    if (drop.footbridge) notes.push(shapeNote(drop.footbridge, "footbridge"));
    if (drop.water) notes.push(shapeNote(drop.water, "water area"));
    if (drop.parking) notes.push(shapeNote(drop.parking, "parking area"));
    if (drop.rv) notes.push(shapeNote(drop.rv, "RV"));
    if (Array.isArray(warnings)) {
      for (let i = 0; i < notes.length; i++) {
        if (notes[i] && warnings.indexOf(notes[i]) < 0) warnings.push(notes[i]);
      }
    }
  }
  const chunks = [];
  for (let i = 0; i < buildingsBeforeBytes; i++) chunks.push({ role: "building", areas: [areas[i]] });
  let cursor = buildingsBeforeBytes;
  const treePieces = [];
  const treeChunkList = capped.treeChunks || [];
  let treeChunkAreas = 0;
  for (let g = 0; g < treeChunkList.length; g++) treeChunkAreas += treeChunkList[g].areas.length;
  if (treeChunkAreas === treeEmittedBefore) {
    for (let g = 0; g < treeChunkList.length; g++) {
      const group = treeChunkList[g];
      const n = group.areas.length;
      treePieces.push({ role: "tree", discrete: group.discrete, areas: areas.slice(cursor, cursor + n) });
      cursor += n;
    }
  } else {
    while (cursor < buildingsBeforeBytes + treeEmittedBefore) {
      treePieces.push({ role: "tree", discrete: false, areas: [areas[cursor]] });
      cursor++;
    }
  }
  const deckPieces = [];
  const waterPieces = [];
  const rvPieces = [];
  const latePieces = [];
  for (let i = 0; i < outdoorKeptKinds.length; i++) {
    const kind = outdoorKeptKinds[i];
    const piece = { role: "outdoor", kind, areas: [areas[cursor]] };
    cursor++;
    if (kind === "guideway" || kind === "bridge" || kind === "footbridge") deckPieces.push(piece);
    else if (kind === "water" || kind === "parking") waterPieces.push(piece);
    else if (kind === "rv") rvPieces.push(piece);
    else latePieces.push(piece);
  }
  // Buildings, then water and parking, then the rail and road decks, then RVs.
  // Trees follow RVs. Walls and poles are last. A byte trim drops that tail first.
  for (let i = 0; i < waterPieces.length; i++) chunks.push(waterPieces[i]);
  for (let i = 0; i < deckPieces.length; i++) chunks.push(deckPieces[i]);
  for (let i = 0; i < rvPieces.length; i++) chunks.push(rvPieces[i]);
  for (let i = 0; i < treePieces.length; i++) chunks.push(treePieces[i]);
  for (let i = 0; i < latePieces.length; i++) chunks.push(latePieces[i]);
  const fitted = fitChunksToJsonBudget(frame, name, imgName, chunks, jsonByteBudget);
  areas = fitted.areas;
  let buildingEmitted = 0;
  let treeEmitted = 0;
  let treeGroupsKept = 0;
  let discreteKept = 0;
  waterAreas = 0;
  parkingAreas = 0;
  wallAreas = 0;
  poleAreas = 0;
  guidewayAreas = 0;
  bridgeAreas = 0;
  rvAreas = 0;
  for (let i = 0; i < fitted.chunks.length; i++) {
    const chunk = fitted.chunks[i];
    if (chunk.role === "building") buildingEmitted++;
    else if (chunk.role === "tree") {
      treeEmitted += chunk.areas.length;
      treeGroupsKept++;
      if (chunk.discrete) discreteKept++;
    } else if (chunk.kind === "water") waterAreas++;
    else if (chunk.kind === "parking") parkingAreas++;
    else if (chunk.kind === "pole") poleAreas++;
    else if (chunk.kind === "guideway") guidewayAreas++;
    else if (chunk.kind === "bridge" || chunk.kind === "footbridge") bridgeAreas++;
    else if (chunk.kind === "rv") rvAreas++;
    else wallAreas++;
  }
  if (planned) {
    for (let i = 0; i < planned.updates.length; i++) {
      if (planned.updates[i].index < buildingEmitted) parkingAreas++;
    }
  }
  const roofsLeftOut = fp.oiAreas.length - buildingEmitted;
  let stoppedBy = "areas";
  if (fitted.trimmed) stoppedBy = "bytes";
  else if (roofsLeftByCount > 0 || capped.droppedTrees > 0 || outdoorLeft > 0) stoppedBy = "count";
  if (roofsLeftOut > 0 && Array.isArray(warnings)) {
    const why =
      buildingsBeforeBytes > buildingEmitted ? "OpenIntent byte budget" : areaCap + " area budget";
    warnings.push(
      "Kept the " +
        buildingEmitted +
        " largest, tallest roofs. " +
        roofsLeftOut +
        " more did not fit in the " +
        why +
        "."
    );
    // Name the large roofs the budget left out. Small rings stay in the count above.
    const rings = fp.overlayRings || [];
    let named = 0;
    for (let i = buildingEmitted; i < fp.oiAreas.length; i++) {
      const ring = rings[i];
      if (!ring || ring.length < 3) continue;
      const ll = [];
      for (let k = 0; k < ring.length; k++) ll.push(pxToLl(ring[k][0], ring[k][1], frame));
      const m2 = ringAreaM2(ll, frame.mpd);
      if (!(m2 >= 1000)) continue;
      named++;
      if (named > 24) continue;
      warnings.push("Dropped building " + Math.round(m2) + " m2: " + why + ".");
    }
    if (named > 24) {
      warnings.push("Dropped " + (named - 24) + " more buildings over 1000 m2: " + why + ".");
    }
  }
  const clip = emptyClipboard();
  const seenTypes = new Set(clip.attenuatingZoneTypes.map((t) => t.id));
  for (const t of (fp.clipTypes || []).concat(veg.clipTypes || [])) {
    if (t && t.id && !seenTypes.has(t.id)) {
      seenTypes.add(t.id);
      clip.attenuatingZoneTypes.push(t);
    }
  }
  // Buildings always. Foliage zones only when Include foliage emitted canopy.
  // Drop unused foliage and trunk types so a buildings-only paste cannot
  // reintroduce them.
  clip.attenuatingZones = fp.clipZones.concat(veg.clipZones);
  const usedZoneTypes = new Set(clip.attenuatingZones.map((z) => z && z.typeId));
  clip.attenuatingZoneTypes = clip.attenuatingZoneTypes.filter((t) => {
    if (!t || !t.id) return false;
    const vegType = t.id === "tree-trunk" || t.id.indexOf("foliage") === 0 || t.id.indexOf("trunk") === 0;
    if (!vegType) return true;
    return usedZoneTypes.has(t.id);
  });
  const materials = documentMaterials(areas);
  let exactBuildingHeights = 0;
  let exactFoliageHeights = 0;
  for (const t of clip.attenuatingZoneTypes) {
    if (t.id && String(t.id).indexOf("bldg-m-") === 0) exactBuildingHeights++;
    if (t.id && String(t.id).indexOf("foliage-m-") === 0) exactFoliageHeights++;
  }
  const oi = buildOpenIntent(frame, name, imgName, areas, materials);
  const oiJson = JSON.stringify(oi);
  const stats = {
    ...fp.stats,
    trees: treeGroupsKept,
    treesMeasured: veg.count,
    discreteTrees: discreteKept,
    treesSource: omitFoliage
      ? "none"
      : foliageOn
        ? treesSource && treesSource !== "none"
          ? treesSource
          : veg.count
            ? "canopy"
            : "none"
        : "none",
    includeFoliage: foliageOn,
    foliageLifted: veg.foliageLifted || 0,
    foliageGeometry: omitFoliage ? "omitted" : foliageOn ? veg.foliageGeometry || "none" : "none",
    foliageOmitted: omitFoliage ? "canopy-height-timeout" : "",
    foliageCoarsened: foliageOn && veg.foliageCoarsened ? 1 : 0,
    zones: clip.attenuatingZones.length,
    areas: areas.length,
    droppedInvalid: fp.stats.droppedInvalid || 0,
    droppedTreeRings: treeOi.droppedInvalid,
    droppedAreasCap: roofsLeftOut,
    droppedTreeAreas: treeOi.areas.length - treeEmitted,
    attenuationAreasEmitted: areas.length,
    openIntentBuildingAreas: buildingEmitted,
    openIntentTreeAreas: treeEmitted,
    includeOutdoor: outdoorOn && outdoorMiss !== true,
    includeWater: includeWater === true,
    includeParking: includeParking === true,
    includeWalls: includeWalls === true,
    includePoles: includePoles === true,
    includeRvs: includeRvs === true,
    includeGuideways: includeGuideways === true || guides.length > 0,
    includeBridges: includeBridges === true || bridges.length > 0,
    outdoorMiss: outdoorMiss === true,
    waterAreas,
    parkingAreas,
    wallAreas,
    poleAreas,
    guidewayAreas,
    bridgeAreas,
    rvAreas,
    areaCap,
    areaCapOverride: capIsOverride,
    openIntentJsonBytes: Buffer.byteLength(oiJson),
    jsonBudget: jsonByteBudget,
    stoppedBy,
    openintentVersion: OPENINTENT_VERSION,
    openclutterVersion: OPENCLUTTER_VERSION,
    coordinateUnit: "pixels",
    coordinateOrigin: "Y-up from SW",
    calibrated: Boolean(affine),
    summary: "",
    buildingsKept: 0,
    treesKept: 0,
    globalFootprints: footprintMeta && footprintMeta.globalFootprints ? footprintMeta.globalFootprints : 0,
    arcgisFootprints: footprintMeta && footprintMeta.arcgisFootprints ? footprintMeta.arcgisFootprints : 0,
    usaFootprints: footprintMeta && footprintMeta.usaFootprints ? footprintMeta.usaFootprints : 0,
    imageryRoofs: footprintMeta && footprintMeta.imageryRoofs ? footprintMeta.imageryRoofs : 0,
    droppedPavement: footprintMeta && footprintMeta.droppedPavement ? footprintMeta.droppedPavement : 0,
    medianTrees: footprintMeta && footprintMeta.medianTrees ? footprintMeta.medianTrees : 0,
    overtureFootprints: footprintMeta && footprintMeta.overtureFootprints ? footprintMeta.overtureFootprints : 0,
    overtureAdded: footprintMeta && footprintMeta.overtureAdded ? footprintMeta.overtureAdded : 0,
    msHeights: footprintMeta && footprintMeta.msHeights ? footprintMeta.msHeights : 0,
    overtureHeights: footprintMeta && footprintMeta.overtureHeights ? footprintMeta.overtureHeights : 0,
    femaHeights: footprintMeta && footprintMeta.femaHeights ? footprintMeta.femaHeights : 0,
    floorHeights: footprintMeta && footprintMeta.floorHeights ? footprintMeta.floorHeights : 0,
    chmTrees: footprintMeta && footprintMeta.chmTrees ? footprintMeta.chmTrees : 0,
    terrainRaised: terrain && terrain.raised ? terrain.raised : 0,
    terrainSloped: terrain && terrain.sloped ? terrain.sloped : 0,
    demKind: terrain && terrain.kind === "surface" ? "surface" : terrain && terrain.kind ? "bare-earth" : "",
    terrainResolution: normalizeTerrainResolution(
      terrainResolution || (terrain && terrain.terrainResolution)
    ).id,
    terrainStyle: terrain && terrain.terrainStyle === "raised" ? "raised" : terrain ? "sloped" : "",
    areaMaterials: materials.length,
    compatibilityMode: COMPATIBILITY_MODE,
    exactBuildingHeights,
    exactFoliageHeights,
    waterMaskRings: (maskRings || []).length,
    pavementMaskRings: (maskPolygons || []).length,
    warnings: (warnings || []).filter(Boolean).map(String),
  };
  const shapedNotes =
    footprintMeta && Array.isArray(footprintMeta.largeDropNotes) ? footprintMeta.largeDropNotes : [];
  const emitNotes = fp.stats && Array.isArray(fp.stats.largeDropNotes) ? fp.stats.largeDropNotes : [];
  stats.largeDropNotes = shapedNotes.concat(emitNotes);
  stats.buildings = buildingEmitted;
  stats.summary = coverageSummary(stats);
  Object.assign(stats, coverageStats(stats));
  let zip = null;
  if (imgBuf) {
    // Hamina OpenIntent import reads the JSON and the aerial. Clipboard JSON,
    // the terrain paste, and the debug notes stay out of this zip.
    zip = zipUnderLimit(
      [
        { name: `openIntent_${slug}.json`, data: Buffer.from(oiJson) },
        { name: "images/" + imgName, data: imgBuf },
      ],
      ZIP_DOWNLOAD_MAX
    );
  }
  return {
    name,
    slug,
    imgName,
    openintent: oi,
    clipboard: clip,
    terrain: terrain || null,
    zip,
    stats,
    frame: publicFrame(frame),
    alignment: ALIGNMENT,
  };
}

module.exports = {
  ALIGNMENT,
  ZIP_README,
  ZIP_TROUBLESHOOT,
  MIN_AREA_M2,
  MAX_AREA_M2,
  MAX_BUILDINGS,
  MAX_ATTENUATION_AREAS,
  AREA_CAP_MAX,
  OPENINTENT_JSON_BUDGET,
  JSON_BUDGET_MAX,
  OI_PIXEL_DECIMALS,
  ZIP_DOWNLOAD_MAX,
  parseAreaCapOverride,
  parseJsonBudgetOverride,
  raisedDeckCap,
  raisedAreaHolds,
  MIN_OI_SPAN_PX,
  MIN_OI_SPAN_M,
  OPENINTENT_VERSION,
  OI_FLOORPLAN_HEIGHT_M,
  OI_FLOORPLAN_HEIGHT_FT,
  STOCK_MATERIAL_NAMES,
  MEGA_CAMPUS_M2,
  HOTEL_MEGA_M2,
  MEGA_MIN_DETAIL_VERTS,
  MAX_OI_RING_VERTS,
  megaCampusLimitM2,
  isMegaCampus,
  ringVertexCount,
  pxRingAreaM2,
  coverageStats,
  coverageSummary,
  zipReadme,
  verifyTxt,
  featureExteriorRings,
  ringAreaM2,
  simplifyRing,
  footprintsToClutter,
  buildClutter,
  siteName,
  simplifyDP,
  clipRingToRect,
  ringToOi,
  ringAreaPx,
  validateOiCoords,
  validateOiArea,
  oiAreaMaterialName,
  oiPixelCoords,
  expandOiCoordTriples,
  emitPixelVertex,
  fitChunksToJsonBudget,
  emitIfValid,
  capAttenuationAreas,
  capBuildingsAndTrees,
  dropNestedDuplicateRoofs,
  ensureMinSpan,
  minOiSpanPx,
  capOiRingPx,
  ringSpanClass,
};
