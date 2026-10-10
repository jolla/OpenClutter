"use strict";

const { llToClipboard } = require("./geo-frame");

/**
 * HaminaClipboard mapNotes item, as written by Hamina Clipboard Tools
 * (clipboard.potatofi.com) when it generates a note grid:
 *   { x, y, text, color, icon: "NOTICE_OUTLINE" }
 * x and y are clipboard meters. OpenIntent reference_markers can carry
 * text, and Hamina's OpenIntent matrix marks Map Notes as not implemented
 * for import, so these stay on the paste.
 */
const MAP_NOTE_COLOR = "#db6921";
const MAP_NOTE_ICON = "NOTICE_OUTLINE";

function round4(n) {
  return +(+n).toFixed(4);
}

function metersBetween(aLon, aLat, bLon, bLat) {
  const lat = ((aLat + bLat) / 2) * (Math.PI / 180);
  const dx = (bLon - aLon) * 111320 * Math.cos(lat);
  const dy = (bLat - aLat) * 110540;
  return Math.hypot(dx, dy);
}

function nearAny(lon, lat, list, sepM) {
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (metersBetween(lon, lat, p.lon, p.lat) < sepM) return true;
  }
  return false;
}

function elementCoords(el) {
  if (!el) return [];
  if (el.type === "node") {
    const lon = +el.lon;
    const lat = +el.lat;
    return Number.isFinite(lon) && Number.isFinite(lat) ? [[lon, lat]] : [];
  }
  if (el.type === "relation") {
    const members = el.members || [];
    for (let i = 0; i < members.length; i++) {
      const role = members[i] && members[i].role;
      if (role && role !== "outer") continue;
      const coords = geometryCoords(members[i] && members[i].geometry);
      if (coords.length >= 3) return coords;
    }
  }
  return geometryCoords(el.geometry);
}

function geometryCoords(geometry) {
  if (!Array.isArray(geometry)) return [];
  const out = [];
  for (let i = 0; i < geometry.length; i++) {
    const g = geometry[i];
    if (Array.isArray(g)) {
      const lon = +g[0];
      const lat = +g[1];
      if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
    } else if (g) {
      const lon = +(g.lon != null ? g.lon : g.x);
      const lat = +(g.lat != null ? g.lat : g.y);
      if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
    }
  }
  return out;
}

function centroid(coords) {
  if (!coords || !coords.length) return null;
  let end = coords.length;
  if (
    end > 1 &&
    coords[0][0] === coords[end - 1][0] &&
    coords[0][1] === coords[end - 1][1]
  ) {
    end -= 1;
  }
  if (!end) return null;
  let lon = 0;
  let lat = 0;
  for (let i = 0; i < end; i++) {
    lon += coords[i][0];
    lat += coords[i][1];
  }
  return [lon / end, lat / end];
}

function areaM2(coords) {
  if (!coords || coords.length < 3) return 0;
  const lat = coords[0][1] * (Math.PI / 180);
  const mx = 111320 * Math.max(0.2, Math.cos(lat));
  const my = 110540;
  let a = 0;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    a += coords[j][0] * mx * coords[i][1] * my - coords[i][0] * mx * coords[j][1] * my;
  }
  return Math.abs(a / 2);
}

function placeName(tags) {
  const name = tags && tags.name ? String(tags.name).trim() : "";
  if (!name || name === "yes") return "";
  return name.slice(0, 60);
}

function heightM(tags) {
  const raw = tags && (tags.height || tags["building:height"]);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function isOffice(tags, name) {
  const building = String((tags && tags.building) || "").toLowerCase();
  const amenity = String((tags && tags.amenity) || "").toLowerCase();
  const lower = name.toLowerCase();
  if (building === "office" || amenity === "office" || amenity === "clubhouse" || building === "clubhouse") {
    return true;
  }
  return /\boffice\b|\bclubhouse\b|\bclub house\b/.test(lower);
}

function isClubhouse(tags, name) {
  const building = String((tags && tags.building) || "").toLowerCase();
  const amenity = String((tags && tags.amenity) || "").toLowerCase();
  return amenity === "clubhouse" || building === "clubhouse" || /\bclubhouse\b|\bclub house\b/.test(name.toLowerCase());
}

function landmarkKind(tags, name) {
  const amenity = String((tags && tags.amenity) || "").toLowerCase();
  const building = String((tags && tags.building) || "").toLowerCase();
  const lower = name.toLowerCase();
  if (amenity === "toilets" || building === "toilets" || /\bbathhouse\b|\bbath house\b|\brestroom\b/.test(lower)) {
    return "bathhouse";
  }
  if (/\bpavilion\b|\bpavillion\b|\bbingo\b/.test(lower)) return "hall";
  if (amenity === "community_centre" || amenity === "community_center") return "hall";
  return "";
}

function isTallKind(tags) {
  const made = String((tags && tags.man_made) || "").toLowerCase();
  return (
    made === "tower" ||
    made === "chimney" ||
    made === "mast" ||
    made === "crane" ||
    made === "silo" ||
    made === "water_tower" ||
    made === "communications_tower"
  );
}

/**
 * Planning places from one OSM payload. Pitches and the camp site are kept
 * so coverage notes can be placed. They are not one note per pitch.
 */
function placesFromElements(elements) {
  const list = Array.isArray(elements) ? elements : [];
  const places = [];
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    const tags = (el && el.tags) || {};
    const coords = elementCoords(el);
    const c = centroid(coords);
    if (!c) continue;
    const name = placeName(tags);
    const tourism = String(tags.tourism || "");
    const place = {
      lon: c[0],
      lat: c[1],
      name,
      heightM: heightM(tags),
      areaM2: areaM2(coords),
    };
    if (tourism === "camp_site" || tourism === "caravan_site") {
      if (place.areaM2 >= 400) {
        places.push(Object.assign({ role: "site", ring: coords }, place));
      }
      continue;
    }
    if (tourism === "camp_pitch") {
      places.push(Object.assign({ role: "pitch" }, place));
      continue;
    }
    if (tags.amenity === "parking" || tags.building === "parking") {
      if (String(tags.parking || "") === "underground" || String(tags.location || "") === "underground") continue;
      places.push(Object.assign({ role: "parking" }, place));
      continue;
    }
    if (isOffice(tags, name) && place.areaM2 < 8000) {
      places.push(Object.assign({ role: "office", clubhouse: isClubhouse(tags, name) }, place));
      continue;
    }
    const kind = landmarkKind(tags, name);
    if (kind && place.areaM2 < 8000) {
      places.push(Object.assign({ role: "landmark", kind }, place));
      continue;
    }
    if (isTallKind(tags)) {
      places.push(Object.assign({ role: "tall" }, place));
    }
  }
  return places;
}

function clipboardNote(lon, lat, frame, text) {
  const xy = llToClipboard(lon, lat, frame);
  if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) return null;
  return {
    x: round4(xy[0]),
    y: round4(xy[1]),
    text: String(text).slice(0, 120),
    color: MAP_NOTE_COLOR,
    icon: MAP_NOTE_ICON,
  };
}

function pushNote(out, placed, lon, lat, frame, text, sepM) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  if (nearAny(lon, lat, placed, sepM)) return;
  const note = clipboardNote(lon, lat, frame, text);
  if (!note) return;
  placed.push({ lon, lat });
  out.push(note);
}

function featureCentroid(feature) {
  const ring =
    feature &&
    feature.geometry &&
    feature.geometry.type === "Polygon" &&
    feature.geometry.coordinates &&
    feature.geometry.coordinates[0];
  return centroid(ring);
}

function extentOf(points) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < points.length; i++) {
    minLon = Math.min(minLon, points[i].lon);
    maxLon = Math.max(maxLon, points[i].lon);
    minLat = Math.min(minLat, points[i].lat);
    maxLat = Math.max(maxLat, points[i].lat);
  }
  if (!Number.isFinite(minLon)) return null;
  return { minLon, maxLon, minLat, maxLat };
}

function buildMapNotes(opts) {
  const frame = opts && opts.frame;
  const places = (opts && opts.places) || [];
  const features = (opts && opts.features) || [];
  const terrain = opts && opts.terrain;
  if (!frame || ![frame.west, frame.south, frame.east, frame.north, frame.widthM, frame.lengthM].every(Number.isFinite)) {
    return [];
  }
  const out = [];
  const placed = [];
  const offices = places.filter((p) => p.role === "office");
  const landmarks = places.filter((p) => p.role === "landmark");
  const parking = places.filter((p) => p.role === "parking");
  const pitches = places.filter((p) => p.role === "pitch");

  if (offices.length) {
    const gate = offices[0];
    const label = gate.clubhouse ? "clubhouse" : gate.name || "office";
    pushNote(out, placed, gate.lon, gate.lat, frame, "Suggested gateway, " + label, 8);
    for (let i = 1; i < offices.length && i < 4; i++) {
      const extra = offices[i];
      const extraLabel = extra.clubhouse ? "Clubhouse" : extra.name || "Office";
      pushNote(out, placed, extra.lon, extra.lat, frame, extraLabel, 12);
    }
  }

  for (let i = 0; i < landmarks.length && out.length < 10; i++) {
    const mark = landmarks[i];
    let text = "Suggested AP";
    if (mark.kind === "bathhouse") text = mark.name ? "Suggested AP, " + mark.name : "Suggested AP, bathhouse";
    else if (mark.name) text = "Suggested AP, " + mark.name;
    pushNote(out, placed, mark.lon, mark.lat, frame, text, 12);
  }

  if (parking.length) {
    let door = parking[0];
    for (let i = 1; i < parking.length; i++) {
      if (parking[i].lat < door.lat) door = parking[i];
    }
    const midLat = (frame.south + frame.north) / 2;
    if (door.lat <= midLat) {
      pushNote(out, placed, door.lon, door.lat, frame, "Suggested AP, entrance parking", 20);
    }
  }

  if (pitches.length >= 8) {
    const box = extentOf(pitches);
    const cellW = (box.maxLon - box.minLon) / 2;
    const cellH = (box.maxLat - box.minLat) / 2;
    if (cellW > 0 && cellH > 0) {
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 2; c++) {
          const c0 = box.minLon + c * cellW;
          const r0 = box.minLat + r * cellH;
          let n = 0;
          for (let i = 0; i < pitches.length; i++) {
            const p = pitches[i];
            if (p.lon >= c0 && p.lon <= c0 + cellW && p.lat >= r0 && p.lat <= r0 + cellH) n++;
          }
          if (n < 4) continue;
          pushNote(out, placed, c0 + cellW / 2, r0 + cellH / 2, frame, "Suggested AP", 45);
        }
      }
    }
  }

  const talls = [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const h = feature && feature.properties ? +feature.properties.height : 0;
    if (!(h >= 12)) continue;
    const c = featureCentroid(feature);
    if (!c) continue;
    talls.push({
      lon: c[0],
      lat: c[1],
      heightM: h,
      name: feature.properties.partName || "",
    });
  }
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    if (p.role !== "tall") continue;
    if (p.heightM && p.heightM < 12) continue;
    talls.push(p);
  }
  talls.sort((a, b) => (b.heightM || 0) - (a.heightM || 0));
  const trees = (opts && opts.trees) || [];
  const treePeaks = [];
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    const h = t && +t.heightM;
    if (!(h >= 15) || !Number.isFinite(+t.lon) || !Number.isFinite(+t.lat)) continue;
    treePeaks.push({ lon: +t.lon, lat: +t.lat, heightM: h, name: "tree" });
  }
  treePeaks.sort((a, b) => b.heightM - a.heightM);
  let treeKept = 0;
  for (let i = 0; i < treePeaks.length && treeKept < 2; i++) {
    const t = treePeaks[i];
    if (treeKept && metersBetween(t.lon, t.lat, treePeaks[0].lon, treePeaks[0].lat) < 60) continue;
    talls.push(t);
    treeKept++;
  }
  talls.sort((a, b) => (b.heightM || 0) - (a.heightM || 0));
  let tallKept = 0;
  for (let i = 0; i < talls.length && tallKept < 4; i++) {
    const t = talls[i];
    const meters = t.heightM ? ", " + Math.round(t.heightM) + " m" : "";
    const name = t.name ? ", " + t.name : "";
    const before = out.length;
    pushNote(out, placed, t.lon, t.lat, frame, "Tall obstruction" + meters + name, 18);
    if (out.length > before) tallKept++;
  }

  const samples = terrain && Array.isArray(terrain.samples) ? terrain.samples : [];
  const ranked = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!s || !Number.isFinite(+s.z) || !Number.isFinite(+s.lon) || !Number.isFinite(+s.lat)) continue;
    ranked.push({ lon: +s.lon, lat: +s.lat, z: +s.z });
  }
  ranked.sort((a, b) => b.z - a.z);
  if (ranked.length) {
    const sep = Math.max(40, Math.min(+frame.widthM || 0, +frame.lengthM || 0) * 0.18);
    const peaks = [];
    for (let i = 0; i < ranked.length && peaks.length < 3; i++) {
      const s = ranked[i];
      if (peaks.length && ranked[0].z - s.z > 8) break;
      let close = false;
      for (let p = 0; p < peaks.length; p++) {
        if (metersBetween(s.lon, s.lat, peaks[p].lon, peaks[p].lat) < sep) close = true;
      }
      if (close) continue;
      let dominated = false;
      if (peaks.length) {
        for (let j = 0; j < ranked.length; j++) {
          const other = ranked[j];
          if (other === s) continue;
          if (other.z <= s.z + 0.3) continue;
          if (metersBetween(s.lon, s.lat, other.lon, other.lat) < sep * 0.55) dominated = true;
        }
      }
      if (dominated) continue;
      peaks.push(s);
    }
    for (let i = 0; i < peaks.length; i++) {
      pushNote(
        out,
        placed,
        peaks[i].lon,
        peaks[i].lat,
        frame,
        "Terrain high point, " + Math.round(peaks[i].z) + " m",
        15
      );
    }
  }

  pushNote(
    out,
    placed,
    frame.west,
    frame.south,
    frame,
    "AFC GPS SW " + frame.south.toFixed(5) + ", " + frame.west.toFixed(5),
    1
  );
  pushNote(
    out,
    placed,
    frame.east,
    frame.north,
    frame,
    "AFC GPS NE " + frame.north.toFixed(5) + ", " + frame.east.toFixed(5),
    1
  );

  return out.slice(0, 24);
}

function stampMapNotes(clip, notes) {
  if (!clip) return clip;
  clip.mapNotes = Array.isArray(notes) ? notes : [];
  return clip;
}

module.exports = {
  MAP_NOTE_COLOR,
  MAP_NOTE_ICON,
  placesFromElements,
  buildMapNotes,
  stampMapNotes,
  clipboardNote,
};
