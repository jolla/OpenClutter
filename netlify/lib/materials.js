"use strict";

/**
 * OpenIntent area_materials must match Hamina's outdoor building stock.
 * Jerry's gold Hamina export only catalogs:
 *   Building - One / Two / Five / Ten Floor
 * Those four objects import. Names outside that set — Foliage - Heavy,
 * Foliage - Light, Tree Trunk, Foliage N.N m, Tree Trunk N.N m, Hotel podium,
 * Building N.N m — silently drop every attenuation_area. The docs clipboard
 * example "Tree Foliage" is not in the gold export or the Hamina client
 * bundle, so it is not emitted either.
 * Tree rings reuse the gold object for their height bucket (same keys:
 * name, rf_properties, top_height, display_color). Exact foliage names and
 * measured metres stay on hamina-clipboard.json (optional legacy paste).
 * compatibilityMode is "stock-openintent".
 */

const { ZONE_TYPES, TYPE_BY_ID, oiMaterialFromType, pickBuildingTypeId } = require("./hamina-clipboard");

/** Hamina-native outdoor building materials (from Jerry's gold OpenIntent zip). */
const OI_BUILDING_TYPES = [
  {
    id: "bldg-one",
    name: "Building - One Floor",
    color: "#9AA5AC",
    topEdge: 4.5,
    attenuationDbPerMeter: 5,
  },
  {
    id: "bldg-two",
    name: "Building - Two Floor",
    color: "#9A4159",
    topEdge: 7.620092660326749,
    attenuationDbPerMeter: 5,
  },
  {
    id: "bldg-five",
    name: "Building - Five Floor",
    color: "#9AA5AC",
    topEdge: 15.240185320653499,
    attenuationDbPerMeter: 5,
  },
  {
    id: "bldg-ten",
    name: "Building - Ten Floor",
    color: "#9AA5AC",
    topEdge: 32,
    attenuationDbPerMeter: 5,
  },
];

const OI_BUILDING_BY_ID = Object.fromEntries(OI_BUILDING_TYPES.map((t) => [t.id, t]));
const OI_BUILDING_NAMES = OI_BUILDING_TYPES.map((t) => t.name);

function roundHeightM(heightM) {
  const n = Number(heightM);
  if (!(n > 2 && n < 80)) return 0;
  return Math.round(n * 10) / 10;
}

function buildingColor(h) {
  const t = Math.max(0, Math.min(1, (h - 3) / 18));
  const v = Math.round(198 - t * 78);
  const hex = v.toString(16).padStart(2, "0");
  return "#" + hex + hex + hex;
}

function idFor(prefix, h) {
  return prefix + h.toFixed(1).replace(".", "_");
}

function oiMaterial(name, color, top, dbPerM) {
  return {
    name,
    rf_properties: { attenuation_per_m: dbPerM },
    top_height: top,
    display_color: color,
  };
}

function clipType(id, name, color, top, dbPerM, opts) {
  return {
    id,
    name,
    color,
    shortcutKey: "",
    topEdge: top,
    bottomEdge: opts && opts.bottomEdge != null ? opts.bottomEdge : null,
    attenuationDbPerMeter: dbPerM,
    ituRModelEnabled: true,
    transparencyEnabled: !!(opts && opts.transparent),
  };
}

function measuredBuildingMaterial(heightM) {
  const h = roundHeightM(heightM);
  if (!h) return null;
  const name = "Building " + h.toFixed(1) + " m";
  const color = buildingColor(h);
  return {
    material: oiMaterial(name, color, h, 5),
    clipType: clipType(idFor("bldg-m-", h), name, color, h, 5),
    typeId: idFor("bldg-m-", h),
    measured: true,
  };
}

function measuredFoliageMaterial(heightM) {
  const h = roundHeightM(heightM);
  if (!h) return null;
  const name = "Foliage " + h.toFixed(1) + " m";
  const color = h >= 12 ? "#3F7D2A" : "#6FA84A";
  const db = h >= 12 ? 2 : 1;
  return {
    material: oiMaterial(name, color, h, db),
    clipType: clipType(idFor("foliage-m-", h), name, color, h, db, {
      bottomEdge: h >= 12 ? 3.5 : 3,
      transparent: true,
    }),
    typeId: idFor("foliage-m-", h),
    measured: true,
  };
}

function measuredTrunkMaterial(heightM) {
  const h = roundHeightM(heightM);
  if (!h) return null;
  const name = "Tree Trunk " + h.toFixed(1) + " m";
  return {
    material: oiMaterial(name, "#8B6B4F", h, 10),
    clipType: clipType(idFor("trunk-m-", h), name, "#8B6B4F", h, 10),
    typeId: idFor("trunk-m-", h),
    measured: true,
  };
}

const COMPATIBILITY_MODE = "stock-openintent";

/**
 * Bucket measured/estimated height into Hamina's four outdoor building materials.
 * Clipboard still uses ZONE_TYPES (incl. foliage / Hotel podium) via pickBuildingTypeId.
 */
function pickOiBuildingTypeId(areaM2, heightM) {
  const h =
    heightM > 2
      ? heightM
      : areaM2 >= 6000
        ? 40
        : areaM2 >= 1200
          ? 16
          : areaM2 >= 400
            ? 8
            : 4.5;
  if (h >= 24) return "bldg-ten";
  if (h >= 11) return "bldg-five";
  if (h >= 6) return "bldg-two";
  return "bldg-one";
}

/**
 * OpenIntent material is always one of the four Hamina Building-* types.
 * Measured height only picks the bucket and is copied onto the clipboard type.
 */
function materialForBuilding(heightM, areaM2) {
  const exact = measuredBuildingMaterial(heightM);
  const h = exact ? exact.material.top_height : 0;
  const oiId = pickOiBuildingTypeId(areaM2, h);
  const oiType = OI_BUILDING_BY_ID[oiId];
  const clipTypeId = pickBuildingTypeId(areaM2, h);
  return {
    material: oiMaterialFromType(oiType),
    clipType: exact ? exact.clipType : null,
    typeId: exact ? exact.typeId : clipTypeId,
    measured: !!exact,
    exactHeight: exact ? exact.material.top_height : 0,
  };
}

/**
 * Canopy and trunk rings in OpenIntent. Height only picks a gold Building-*
 * bucket. Returning a foliage name here would empty the whole import.
 */
function materialForVegetation(heightM) {
  const h = roundHeightM(heightM);
  const oiId = pickOiBuildingTypeId(0, h || 9);
  return oiMaterialFromType(OI_BUILDING_BY_ID[oiId]);
}

function stockMaterials() {
  return ZONE_TYPES.map((t) => oiMaterialFromType(t));
}

/** OpenIntent catalog: Hamina outdoor Building-* set only. */
function catalogMaterials() {
  return OI_BUILDING_TYPES.map((t) => oiMaterialFromType(t));
}

module.exports = {
  roundHeightM,
  buildingColor,
  measuredBuildingMaterial,
  measuredFoliageMaterial,
  measuredTrunkMaterial,
  materialForBuilding,
  materialForVegetation,
  pickOiBuildingTypeId,
  stockMaterials,
  catalogMaterials,
  OI_BUILDING_TYPES,
  OI_BUILDING_NAMES,
  COMPATIBILITY_MODE,
};
