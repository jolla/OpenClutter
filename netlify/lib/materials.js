"use strict";

/**
 * Buildings keep Hamina's gold outdoor objects (Jerry's export).
 * Trees use a few custom materials with that same object shape:
 *   name, rf_properties.attenuation_per_m, top_height, display_color
 * No itu_material_type, no bottom_height, no per-metre name.
 *
 * Shapes that emptied every attenuation_area: Foliage - Heavy, Foliage - Light,
 * Tree Trunk, Foliage N.N m, Tree Trunk N.N m, Building N.N m, Hotel podium,
 * and any material whose top_height differed from its catalog entry.
 * Those names stay on the clipboard only. OpenIntent canopy is Tree Foliage /
 * Tall Tree Foliage; trunks are Tree Wood. compatibilityMode is custom-vegetation.
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

/**
 * Fixed vegetation objects. Two canopy bins plus one trunk — not one material
 * per measured metre. Field set matches the gold building objects.
 */
const OI_VEGETATION_TYPES = [
  {
    id: "tree-foliage",
    name: "Tree Foliage",
    color: "#509D33",
    topEdge: 9,
    attenuationDbPerMeter: 1,
  },
  {
    id: "tall-tree-foliage",
    name: "Tall Tree Foliage",
    color: "#3F7D2A",
    topEdge: 15,
    attenuationDbPerMeter: 2,
  },
  {
    id: "tree-wood",
    name: "Tree Wood",
    color: "#937E75",
    topEdge: 8,
    attenuationDbPerMeter: 10,
  },
];

const OI_VEGETATION_BY_ID = Object.fromEntries(OI_VEGETATION_TYPES.map((t) => [t.id, t]));
const OI_VEGETATION_NAMES = OI_VEGETATION_TYPES.map((t) => t.name);

/** Names that previously emptied a whole OpenIntent import. Never emit these. */
const POISONED_OI_NAMES = [
  "Foliage - Heavy",
  "Foliage - Light",
  "Tree Trunk",
  "Hotel podium",
];

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

const COMPATIBILITY_MODE = "custom-vegetation";

function isPoisonedOiName(name) {
  if (!name) return true;
  if (POISONED_OI_NAMES.indexOf(name) >= 0) return true;
  if (/^Foliage \d/.test(name)) return true;
  if (/^Tree Trunk \d/.test(name)) return true;
  if (/^Building \d/.test(name)) return true;
  return false;
}

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
 * Canopy and trunk rings. kind "trunk" is always Tree Wood. Canopy under 12 m
 * is Tree Foliage; 12 m and up is Tall Tree Foliage. The returned object is
 * the catalog entry, not a per-tree height.
 */
function materialForVegetation(heightM, kind) {
  if (kind === "trunk") return oiMaterialFromType(OI_VEGETATION_BY_ID["tree-wood"]);
  const h = roundHeightM(heightM);
  const id = h >= 12 ? "tall-tree-foliage" : "tree-foliage";
  return oiMaterialFromType(OI_VEGETATION_BY_ID[id]);
}

function stockMaterials() {
  return ZONE_TYPES.map((t) => oiMaterialFromType(t));
}

function buildingCatalog() {
  return OI_BUILDING_TYPES.map((t) => oiMaterialFromType(t));
}

/** Allowed OpenIntent materials: gold buildings, then the fixed vegetation set. */
function catalogMaterials() {
  return buildingCatalog().concat(OI_VEGETATION_TYPES.map((t) => oiMaterialFromType(t)));
}

/**
 * Document catalog. Buildings are always present (the known-good prefix).
 * A vegetation material is included only when an area uses it, so a
 * buildings-only zip stays the four gold objects.
 */
function documentMaterials(areas) {
  const used = new Set();
  for (const a of areas || []) {
    const mat = a && a.area_material;
    const name = typeof mat === "string" ? mat : mat && mat.name;
    if (name) used.add(name);
  }
  return buildingCatalog().concat(
    OI_VEGETATION_TYPES.filter((t) => used.has(t.name)).map((t) => oiMaterialFromType(t))
  );
}

module.exports = {
  roundHeightM,
  buildingColor,
  measuredBuildingMaterial,
  measuredFoliageMaterial,
  measuredTrunkMaterial,
  materialForBuilding,
  materialForVegetation,
  isPoisonedOiName,
  pickOiBuildingTypeId,
  stockMaterials,
  catalogMaterials,
  documentMaterials,
  buildingCatalog,
  OI_BUILDING_TYPES,
  OI_BUILDING_NAMES,
  OI_VEGETATION_TYPES,
  OI_VEGETATION_NAMES,
  POISONED_OI_NAMES,
  COMPATIBILITY_MODE,
};
