"use strict";

/**
 * HaminaClipboard schema matching the working Wynn geo paste
 * (header, empty collections, zone types with ituRModelEnabled /
 * transparencyEnabled, stock Hamina names).
 */

function uuid() {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Stock Hamina attenuating-zone types. Do not invent names. */
const ZONE_TYPES = [
  {
    id: "foliage-heavy",
    name: "Foliage - Heavy",
    color: "#3F7D2A",
    shortcutKey: "o",
    topEdge: 12.0,
    bottomEdge: 3.5,
    attenuationDbPerMeter: 2.0,
    ituRModelEnabled: true,
    transparencyEnabled: true,
  },
  {
    id: "foliage-light",
    name: "Foliage - Light",
    color: "#6FA84A",
    shortcutKey: "f",
    topEdge: 9.0,
    bottomEdge: 3.0,
    attenuationDbPerMeter: 1.0,
    ituRModelEnabled: true,
    transparencyEnabled: true,
  },
  {
    id: "tree-trunk",
    name: "Tree Trunk",
    color: "#8B6B4F",
    shortcutKey: "z",
    topEdge: 8.0,
    bottomEdge: null,
    attenuationDbPerMeter: 10.0,
    ituRModelEnabled: true,
    transparencyEnabled: false,
  },
  {
    id: "bldg-one",
    name: "Building - One Floor",
    color: "#C4C4C4",
    shortcutKey: "v",
    topEdge: 4.5,
    bottomEdge: null,
    attenuationDbPerMeter: 5.0,
    ituRModelEnabled: true,
    transparencyEnabled: false,
  },
  {
    id: "bldg-five",
    name: "Building - Five Floor",
    color: "#9A9A9A",
    shortcutKey: "b",
    topEdge: 16.0,
    bottomEdge: null,
    attenuationDbPerMeter: 5.0,
    ituRModelEnabled: true,
    transparencyEnabled: false,
  },
  {
    id: "hotel",
    name: "Hotel podium",
    color: "#8B6914",
    shortcutKey: "h",
    topEdge: 55.0,
    bottomEdge: null,
    attenuationDbPerMeter: 2.0,
    ituRModelEnabled: true,
    transparencyEnabled: false,
  },
];

const CLIPBOARD_COLLECTION_KEYS = [
  "walls",
  "wallEndpoints",
  "wallTypes",
  "cableTrays",
  "cableTrayEndpoints",
  "scopeZones",
  "capacityZones",
  "holeInFloorZones",
  "accessPoints",
  "mapNotes",
  "tiePoints",
  "cableRisers",
  "clientDevices",
  "networkInfraDevices",
  "raisedFloorZones",
  "slopedFloors",
];

function emptyClipboard(id) {
  const clip = {
    header: { type: "HaminaClipboard", version: [1, 0, 0], id: id || uuid() },
    walls: [],
    wallEndpoints: [],
    wallTypes: [],
    cableTrays: [],
    cableTrayEndpoints: [],
    attenuatingZones: [],
    attenuatingZoneTypes: ZONE_TYPES.map((t) => ({ ...t })),
    scopeZones: [],
    capacityZones: [],
    holeInFloorZones: [],
    accessPoints: [],
    mapNotes: [],
    tiePoints: [],
    cableRisers: [],
    clientDevices: [],
    networkInfraDevices: [],
    raisedFloorZones: [],
    slopedFloors: [],
  };
  return clip;
}

function oiMaterialFromType(type, topHeight) {
  const m = {
    name: type.name,
    display_color: type.color,
    top_height: topHeight != null ? +topHeight : type.topEdge,
    rf_properties: { attenuation_per_m: type.attenuationDbPerMeter },
  };
  if (type.bottomEdge != null) m.bottom_height = type.bottomEdge;
  return m;
}

const TYPE_BY_ID = Object.fromEntries(ZONE_TYPES.map((t) => [t.id, t]));

function pickBuildingTypeId(areaM2, heightM) {
  const h =
    heightM > 2
      ? heightM
      : areaM2 >= 6000
        ? 55
        : areaM2 >= 1200
          ? 16
          : 4.5;
  if (h >= 24) return "hotel";
  if (h >= 10) return "bldg-five";
  return "bldg-one";
}

function roundRingM(ring) {
  return ring.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
}

function clipZone(typeId, ringM) {
  const coords = roundRingM(ringM);
  if (coords.length < 4) return null;
  const a = coords[0];
  const b = coords[coords.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) coords.push([...a]);
  if (coords.length < 4) return null;
  return { typeId, area: { type: "Polygon", coordinates: [coords] } };
}

module.exports = {
  uuid,
  ZONE_TYPES,
  TYPE_BY_ID,
  CLIPBOARD_COLLECTION_KEYS,
  emptyClipboard,
  oiMaterialFromType,
  pickBuildingTypeId,
  clipZone,
  roundRingM,
};
