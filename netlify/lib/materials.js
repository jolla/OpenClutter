"use strict";

/**
 * Buildings keep Hamina's gold outdoor objects (Jerry's export).
 * Trees use custom materials with that same object shape:
 *   name, rf_properties.attenuation_per_m, top_height, display_color
 * No itu_material_type, no bottom_height.
 *
 * When a measured or CHM height exists, top_height is that height (0.1 m).
 * The name is "Tree Foliage 14.2" / "Tree Wood 14.2" so each catalog entry is
 * unique and still deep-equals the area. Those are not the strings that
 * emptied imports: Foliage - Heavy, Foliage - Light, Tree Trunk,
 * "Foliage N.N m", "Tree Trunk N.N m", "Building N.N m", Hotel podium.
 * compatibilityMode is custom-vegetation.
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

/** Family labels. The emitted name appends the measured height in metres. */
const TREE_FOLIAGE_NAME = "Tree Foliage";
const TREE_WOOD_NAME = "Tree Wood";
const TRUNK_COLOR = "#937E75";
const TRUNK_DB_PER_M = 10;

const OI_VEGETATION_NAMES = [TREE_FOLIAGE_NAME, TREE_WOOD_NAME];

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

/** "Tree Foliage 14.2" / "Tree Wood 8.0". Not the poisoned "Foliage N.N m" form. */
function isVegetationOiName(name) {
  if (!name || isPoisonedOiName(name)) return false;
  return /^Tree Foliage \d+\.\d$/.test(name) || /^Tree Wood \d+\.\d$/.test(name);
}

function hexByte(n) {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

/** Young canopy toward #6FA84A, tall canopy toward #245C28. Never a building gray/pink. */
function foliageColor(heightM) {
  const t = Math.max(0, Math.min(1, (Number(heightM) - 4) / 22));
  const r = 0x6f + (0x24 - 0x6f) * t;
  const g = 0xa8 + (0x5c - 0xa8) * t;
  const b = 0x4a + (0x28 - 0x4a) * t;
  return "#" + hexByte(r) + hexByte(g) + hexByte(b);
}

/** Broadleaf foliage is about 0.8–2.2 dB/m. Taller, denser crowns sit at the top of that range. */
function foliageDbPerM(heightM) {
  const t = Math.max(0, Math.min(1, (Number(heightM) - 4) / 22));
  return Math.round((0.8 + t * 1.4) * 10) / 10;
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
 * Canopy and trunk rings. top_height is the measured/CHM/NLCD height rounded
 * to 0.1 m. The same height always yields the same object, so the area
 * deep-equals its catalog entry.
 */
function materialForVegetation(heightM, kind) {
  const h = roundHeightM(heightM);
  if (!h) return null;
  const trunk = kind === "trunk";
  const name = (trunk ? TREE_WOOD_NAME : TREE_FOLIAGE_NAME) + " " + h.toFixed(1);
  if (!isVegetationOiName(name)) return null;
  return oiMaterial(name, trunk ? TRUNK_COLOR : foliageColor(h), h, trunk ? TRUNK_DB_PER_M : foliageDbPerM(h));
}

/**
 * Gold building object, or the canonical vegetation object for this height.
 * A drifted top_height or a poisoned name returns null so that ring is omitted.
 */
function canonicalAreaMaterial(material) {
  if (!material || typeof material !== "object" || Array.isArray(material)) return null;
  if ("itu_material_type" in material || "bottom_height" in material) return null;
  const name = material.name;
  if (OI_BUILDING_NAMES.includes(name)) {
    const cat = buildingCatalog().find((m) => m.name === name);
    if (!cat || JSON.stringify(material) !== JSON.stringify(cat)) return null;
    return JSON.parse(JSON.stringify(cat));
  }
  if (!isVegetationOiName(name)) return null;
  const kind = name.indexOf(TREE_WOOD_NAME) === 0 ? "trunk" : "canopy";
  const canon = materialForVegetation(material.top_height, kind);
  if (!canon || JSON.stringify(material) !== JSON.stringify(canon)) return null;
  return JSON.parse(JSON.stringify(canon));
}

function stockMaterials() {
  return ZONE_TYPES.map((t) => oiMaterialFromType(t));
}

function buildingCatalog() {
  return OI_BUILDING_TYPES.map((t) => oiMaterialFromType(t));
}

/** Gold building objects. Vegetation entries are added per measured height by documentMaterials. */
function catalogMaterials() {
  return buildingCatalog();
}

/**
 * Document catalog. Buildings are always the gold prefix.
 * Each measured vegetation object is included only when an area uses it, so a
 * buildings-only zip stays the four gold objects.
 */
function vegetationSortKey(name) {
  const m = /^(Tree Foliage|Tree Wood) (\d+\.\d)$/.exec(name || "");
  if (!m) return String(name || "");
  return (m[1] === "Tree Foliage" ? "0" : "1") + Number(m[2]).toFixed(1).padStart(6, "0");
}

function documentMaterials(areas) {
  const veg = new Map();
  for (const a of areas || []) {
    const mat = a && a.area_material;
    if (!mat || typeof mat !== "object" || !isVegetationOiName(mat.name)) continue;
    if (!veg.has(mat.name)) veg.set(mat.name, JSON.parse(JSON.stringify(mat)));
  }
  const extra = Array.from(veg.values()).sort((a, b) => {
    const ka = vegetationSortKey(a.name);
    const kb = vegetationSortKey(b.name);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return buildingCatalog().concat(extra);
}

module.exports = {
  roundHeightM,
  buildingColor,
  measuredBuildingMaterial,
  measuredFoliageMaterial,
  measuredTrunkMaterial,
  materialForBuilding,
  materialForVegetation,
  canonicalAreaMaterial,
  foliageColor,
  foliageDbPerM,
  isVegetationOiName,
  isPoisonedOiName,
  pickOiBuildingTypeId,
  stockMaterials,
  catalogMaterials,
  documentMaterials,
  buildingCatalog,
  OI_BUILDING_TYPES,
  OI_BUILDING_NAMES,
  OI_VEGETATION_NAMES,
  TREE_FOLIAGE_NAME,
  TREE_WOOD_NAME,
  POISONED_OI_NAMES,
  COMPATIBILITY_MODE,
};
