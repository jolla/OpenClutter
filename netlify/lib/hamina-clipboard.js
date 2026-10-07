"use strict";

const { llToClipboard } = require("./geo-frame");

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
    attenuationDbPerMeter: 1.5,
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
    attenuationDbPerMeter: 3.0,
    ituRModelEnabled: true,
    transparencyEnabled: true,
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

function round6(n) {
  return +(+n).toFixed(6);
}

/**
 * Two GPS anchors for the imported map. HaminaClipboard tiePoints, not
 * OpenIntent. Southwest then northeast. After an OpenIntent import the
 * northeast corner of that aerial is (0, 0) and the southwest corner is
 * (−widthM, −lengthM). lat/lon are those same corners.
 */
function gpsTiePoints(frame) {
  if (!frame) return [];
  const west = +frame.west;
  const south = +frame.south;
  const east = +frame.east;
  const north = +frame.north;
  if (![west, south, east, north, +frame.widthM, +frame.lengthM, +frame.mpuX, +frame.mpuY].every(Number.isFinite)) {
    return [];
  }
  if (!(east > west) || !(north > south)) return [];
  const sw = llToClipboard(west, south, frame);
  const ne = llToClipboard(east, north, frame);
  return [
    { lat: south, lon: west, x: round6(sw[0]), y: round6(sw[1]) },
    { lat: north, lon: east, x: round6(ne[0]), y: round6(ne[1]) },
  ];
}

/** Planner Plus paste that is only the two map-corner GPS points. */
function gpsClipboard(frame) {
  const clip = emptyClipboard();
  clip.header.isCut = false;
  clip.attenuatingZoneTypes = [];
  clip.tiePoints = gpsTiePoints(frame);
  return clip;
}

function stampGpsTiePoints(clip, frame) {
  if (!clip) return clip;
  const points = gpsTiePoints(frame);
  if (points.length >= 2) clip.tiePoints = points;
  return clip;
}

function emptyClipboard(id) {
  const clip = {
    header: { type: "HaminaClipboard", version: [1, 0, 0], id: id || uuid(), isCut: false },
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

/** OpenIntent material keys match Hamina-native exports: name, rf_properties,
 *  top_height, display_color. Do NOT emit itu_material_type or bottom_height —
 *  Jerry's Hamina gold sample omits itu; bottom_height was "Invalid OpenIntent format".
 *  Clipboard types still keep bottomEdge; that path is HaminaClipboard JSON. */
function oiMaterialFromType(type, topHeight) {
  return {
    name: type.name,
    rf_properties: { attenuation_per_m: type.attenuationDbPerMeter },
    top_height: topHeight != null ? +topHeight : type.topEdge,
    display_color: type.color,
  };
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
  gpsTiePoints,
  gpsClipboard,
  stampGpsTiePoints,
  oiMaterialFromType,
  pickBuildingTypeId,
  clipZone,
  roundRingM,
};
