"use strict";

/**
 * Buildings keep Hamina's gold outdoor objects (Jerry's export).
 * Canopy uses the stock outdoor foliage objects from the Attenuating Objects
 * picker, with the same four keys as those buildings:
 *   name, rf_properties.attenuation_per_m, top_height, display_color
 * No itu_material_type, no bottom_height (OpenIntent rejected both).
 *
 * Picker (2026-09): Foliage - Heavy is 19.68 ft / 2 dB/m, Foliage - Light is
 * 19.68 ft / 1 dB/m. There is no Tree type, so OpenIntent does not emit trunks.
 * A measured or CHM height that is not that stock height becomes
 * "Foliage - Heavy 14.2" / "Foliage - Light 7.5": same color and dB/m, real
 * top_height. That is not "Foliage 14.2 m".
 * Still off OpenIntent: Tree Trunk, Hotel podium, "Foliage N.N m",
 * "Tree Trunk N.N m", "Building N.N m".
 * compatibilityMode is stock-foliage.
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
 * Hamina displays feet as metres × 3.280839895, two decimals (gold: 32 m → 104.99 ft).
 * 19.68 / that factor is the metre value that displays as 19.68 ft.
 */
const FT_PER_M = 3.280839895;
const OI_FOLIAGE_TOP_M = 19.68 / FT_PER_M;
const STOCK_HEIGHT_TOL_M = 0.25;
const FOLIAGE_HEAVY_NAME = "Foliage - Heavy";
const FOLIAGE_LIGHT_NAME = "Foliage - Light";
const FOLIAGE_HEAVY_COLOR = "#3F7D2A";
const FOLIAGE_LIGHT_COLOR = "#6FA84A";

const OI_VEGETATION_NAMES = [FOLIAGE_HEAVY_NAME, FOLIAGE_LIGHT_NAME];

/** Names that previously emptied a whole OpenIntent import. Never emit these. */
const POISONED_OI_NAMES = ["Tree Trunk", "Hotel podium"];

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

const COMPATIBILITY_MODE = "stock-foliage";

function cloneMaterial(material) {
  return JSON.parse(JSON.stringify(material));
}

const FOLIAGE_HEAVY = oiMaterial(FOLIAGE_HEAVY_NAME, FOLIAGE_HEAVY_COLOR, OI_FOLIAGE_TOP_M, 2);
const FOLIAGE_LIGHT = oiMaterial(FOLIAGE_LIGHT_NAME, FOLIAGE_LIGHT_COLOR, OI_FOLIAGE_TOP_M, 1);
const STOCK_FOLIAGE_BY_NAME = {
  [FOLIAGE_HEAVY_NAME]: FOLIAGE_HEAVY,
  [FOLIAGE_LIGHT_NAME]: FOLIAGE_LIGHT,
};

function isPoisonedOiName(name) {
  if (!name) return true;
  if (POISONED_OI_NAMES.indexOf(name) >= 0) return true;
  if (/^Foliage \d/.test(name)) return true;
  if (/^Tree Trunk \d/.test(name)) return true;
  if (/^Building \d/.test(name)) return true;
  return false;
}

function isStockFoliageName(name) {
  return name === FOLIAGE_HEAVY_NAME || name === FOLIAGE_LIGHT_NAME;
}

/**
 * Stock "Foliage - Heavy" / "Foliage - Light", or "Foliage - Heavy 14.2".
 * Not the poisoned "Foliage N.N m" form.
 */
function isVegetationOiName(name) {
  if (!name || isPoisonedOiName(name)) return false;
  if (isStockFoliageName(name)) return true;
  return /^Foliage - (?:Heavy|Light) \d+\.\d$/.test(name);
}

function foliageTier(heightM, kind) {
  if (kind === "heavy" || kind === "light") return kind;
  const h = roundHeightM(heightM);
  if (h >= 12) return "heavy";
  if (h > 2) return "light";
  return "heavy";
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
 * Stock Foliage - Heavy / Light when height is missing or within 0.25 m of
 * the picker height (19.68 ft). Otherwise a custom with that stock color and
 * dB/m and the measured top_height (0.1 m). The same inputs always yield the
 * same object, so the area deep-equals its catalog entry.
 */
function materialForVegetation(heightM, kind) {
  const tier = foliageTier(heightM, kind);
  const heavy = tier === "heavy";
  const stock = heavy ? FOLIAGE_HEAVY : FOLIAGE_LIGHT;
  const h = roundHeightM(heightM);
  if (!h || Math.abs(h - OI_FOLIAGE_TOP_M) <= STOCK_HEIGHT_TOL_M) return cloneMaterial(stock);
  const name = (heavy ? FOLIAGE_HEAVY_NAME : FOLIAGE_LIGHT_NAME) + " " + h.toFixed(1);
  if (!isVegetationOiName(name)) return null;
  return oiMaterial(name, heavy ? FOLIAGE_HEAVY_COLOR : FOLIAGE_LIGHT_COLOR, h, heavy ? 2 : 1);
}

/** Exact picker object. kind is "heavy" or "light". */
function stockFoliageMaterial(kind) {
  return cloneMaterial(kind === "light" ? FOLIAGE_LIGHT : FOLIAGE_HEAVY);
}

/**
 * Gold building object, exact stock foliage, or the canonical measured custom.
 * A drifted top_height or a poisoned name returns null so that ring is omitted.
 */
function canonicalAreaMaterial(material) {
  if (!material || typeof material !== "object" || Array.isArray(material)) return null;
  if ("itu_material_type" in material || "bottom_height" in material) return null;
  const name = material.name;
  if (OI_BUILDING_NAMES.includes(name)) {
    const cat = buildingCatalog().find((m) => m.name === name);
    if (!cat || JSON.stringify(material) !== JSON.stringify(cat)) return null;
    return cloneMaterial(cat);
  }
  if (isStockFoliageName(name)) {
    const cat = STOCK_FOLIAGE_BY_NAME[name];
    if (!cat || JSON.stringify(material) !== JSON.stringify(cat)) return null;
    return cloneMaterial(cat);
  }
  if (!isVegetationOiName(name)) return null;
  const kind = name.indexOf(FOLIAGE_HEAVY_NAME) === 0 ? "heavy" : "light";
  const canon = materialForVegetation(material.top_height, kind);
  if (!canon || JSON.stringify(material) !== JSON.stringify(canon)) return null;
  return cloneMaterial(canon);
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
  if (name === FOLIAGE_HEAVY_NAME) return "0000000";
  if (name === FOLIAGE_LIGHT_NAME) return "1000000";
  const m = /^Foliage - (Heavy|Light) (\d+\.\d)$/.exec(name || "");
  if (!m) return String(name || "");
  return (m[1] === "Heavy" ? "0" : "1") + Number(m[2]).toFixed(1).padStart(6, "0");
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
  stockFoliageMaterial,
  canonicalAreaMaterial,
  isVegetationOiName,
  isStockFoliageName,
  isPoisonedOiName,
  pickOiBuildingTypeId,
  stockMaterials,
  catalogMaterials,
  documentMaterials,
  buildingCatalog,
  OI_BUILDING_TYPES,
  OI_BUILDING_NAMES,
  OI_VEGETATION_NAMES,
  OI_FOLIAGE_TOP_M,
  FOLIAGE_HEAVY_NAME,
  FOLIAGE_LIGHT_NAME,
  POISONED_OI_NAMES,
  COMPATIBILITY_MODE,
};
