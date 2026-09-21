"use strict";

/**
 * Measured heights become their own OpenIntent materials.
 * Hamina accepts a unique name + top_height + attenuation_per_m.
 * Do not emit bottom_height (rejected as Invalid OpenIntent format).
 * itu_material_type stays ITU_R_UNKNOWN. Stock names remain the fallback
 * when no measured height is available.
 */

const { ZONE_TYPES, TYPE_BY_ID, oiMaterialFromType, pickBuildingTypeId } = require("./hamina-clipboard");

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
    display_color: color,
    top_height: top,
    itu_material_type: "ITU_R_UNKNOWN",
    rf_properties: { attenuation_per_m: dbPerM },
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

/** Real height when present; otherwise the stock area heuristic. */
function materialForBuilding(heightM, areaM2) {
  const measured = measuredBuildingMaterial(heightM);
  if (measured) return measured;
  const typeId = pickBuildingTypeId(areaM2, 0);
  const type = TYPE_BY_ID[typeId];
  return {
    material: oiMaterialFromType(type),
    clipType: null,
    typeId,
    measured: false,
  };
}

function stockMaterials() {
  return ZONE_TYPES.map((t) => oiMaterialFromType(t));
}

function catalogMaterials(extra) {
  const mats = stockMaterials();
  const names = new Set(mats.map((m) => m.name));
  for (const m of extra || []) {
    if (!m || !m.name || names.has(m.name)) continue;
    names.add(m.name);
    mats.push(m);
  }
  return mats;
}

module.exports = {
  roundHeightM,
  buildingColor,
  measuredBuildingMaterial,
  measuredFoliageMaterial,
  measuredTrunkMaterial,
  materialForBuilding,
  stockMaterials,
  catalogMaterials,
};
