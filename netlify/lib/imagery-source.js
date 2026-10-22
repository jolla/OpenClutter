"use strict";

/**
 * Aerial source router. The export frame is a lon/lat plate (imageSR 4326)
 * whose extent is the Esri content extent of the request. Every source here
 * renders that same extent at the same pixel size, so the frame snap,
 * footprints, and OpenIntent math downstream do not change with the source.
 *
 * Sources:
 *   esri      Esri World Imagery export (the default, and the fallback).
 *   naip      USDA NAIP, lower 48 US, public domain. Read through the
 *             Microsoft Planetary Computer data API (anonymous): STAC search
 *             for the newest item(s) over the box, then one bbox render per
 *             item in EPSG:4326. Only the export window is read.
 *   national  An open national orthophoto where one covers the box:
 *             swisstopo SWISSIMAGE, PDOK (NL), NLS (FI, needs NLS_API_KEY),
 *             IGN Geoplateforme (FR).
 *   auto      NAIP in the US, else national, else Esri.
 *
 * A source that does not cover the box, errors, or runs out of time hands
 * the plate back to Esri. The caller records what was used.
 */

const jpeg = require("jpeg-js");
const { esriContentExtent } = require("./geo-frame");

const UA = "OpenClutter/1.0 (+https://openclutter.com)";
const PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
const PC_DATA = "https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/";
const STAC_TIMEOUT_MS = 6000;
const JPEG_QUALITY = 86;

const ESRI = {
  id: "esri",
  name: "Esri World Imagery",
  short: "Esri",
  attribution: "Esri, Vantor, Earthstar Geographics, and the GIS User Community",
  license: "Esri terms of use",
};

/**
 * World Imagery's citation layer: one polygon per source mosaic with its
 * capture date (SRC_DATE2), vendor (NICE_DESC), and product (NICE_NAME).
 * It answers in well under a second and is read beside the map, never in
 * front of it, so a slow or missing answer only leaves the date out.
 */
const ESRI_CITATION_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/0/query";
const ESRI_CITATION_MS = 2500;

/** Web Mercator level whose ground pixel matches the export's meters per pixel. */
function esriLevelFor(bbox, mPerPx) {
  const lat = ((+bbox.south + +bbox.north) / 2) * (Math.PI / 180);
  const m = +mPerPx > 0 ? +mPerPx : 1;
  const z = Math.round(Math.log2((156543.03392 * Math.cos(lat)) / m));
  return Math.max(0, Math.min(23, z));
}

function esriCitationUrl(bbox) {
  const q = new URLSearchParams({
    where: "1=1",
    outFields: "SRC_DATE2,NICE_NAME,NICE_DESC,SRC_RES,MinMapLevel,MaxMapLevel",
    geometry: [bbox.west, bbox.south, bbox.east, bbox.north].map(Number).join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    f: "json",
  });
  return ESRI_CITATION_URL + "?" + q.toString();
}

function isoDay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toISOString().slice(0, 10);
}

/** Dates and vendors of the World Imagery mosaics drawn at the export's level. */
function parseEsriCitation(body, level) {
  const rows = body && Array.isArray(body.features) ? body.features.map((f) => f && f.attributes).filter(Boolean) : [];
  const atLevel = rows.filter((a) => {
    const lo = Number(a.MinMapLevel);
    const hi = Number(a.MaxMapLevel);
    if (!Number.isFinite(level) || !Number.isFinite(lo) || !Number.isFinite(hi)) return true;
    return level >= lo && level <= hi;
  });
  const use = atLevel.length ? atLevel : rows;
  const dates = Array.from(new Set(use.map((a) => isoDay(a.SRC_DATE2)).filter(Boolean))).sort();
  const providers = Array.from(
    new Set(
      use
        .map((a) => [String(a.NICE_DESC || "").trim(), String(a.NICE_NAME || "").trim()].filter(Boolean).join(" "))
        .filter(Boolean)
    )
  );
  return { dates, providers };
}

/** Never throws. Null when the citation layer did not answer in time. */
async function fetchEsriCitation(bbox, opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || fetch;
  try {
    const r = await fetchImpl(esriCitationUrl(bbox), {
      headers: { "user-agent": UA },
      signal: o.signal || AbortSignal.timeout(ESRI_CITATION_MS),
    });
    if (!r || !r.ok) return null;
    const got = parseEsriCitation(await r.json(), o.level);
    return got.dates.length || got.providers.length ? got : null;
  } catch (e) {
    return null;
  }
}

/** Start the citation read for an export context; the result lands on ctx.esriCitation. */
function readEsriCitation(ctx, bbox, opts) {
  if (!ctx || !bbox) return Promise.resolve(null);
  ctx.esriCitationJob = fetchEsriCitation(bbox, opts).then((got) => {
    ctx.esriCitation = got;
    return got;
  });
  return ctx.esriCitationJob;
}

const NAIP = {
  id: "naip",
  name: "USDA NAIP",
  short: "NAIP",
  attribution: "USDA Farm Production and Conservation Business Center, NAIP (public domain), via Microsoft Planetary Computer",
  license: "Public domain",
  // Lower 48 only. Alaska and Hawaii are not on the NAIP cycle.
  box: [-125.0, 24.4, -66.8, 49.5],
};

/** Order matters: a small country inside a larger bounding box goes first. */
const NATIONAL = [
  {
    id: "swisstopo",
    name: "swisstopo SWISSIMAGE",
    short: "swisstopo",
    attribution: "Federal Office of Topography swisstopo",
    license: "OGD, free commercial use with attribution",
    box: [5.9, 45.8, 10.5, 47.9],
    kind: "wms",
    url: "https://wms.geo.admin.ch/",
    layer: "ch.swisstopo.swissimage",
    version: "1.1.1",
    maxSide: 2048,
  },
  {
    id: "pdok-nl",
    name: "PDOK Luchtfoto (Netherlands)",
    short: "PDOK",
    attribution: "Beeldmateriaal Nederland / PDOK, CC BY 4.0",
    license: "CC BY 4.0",
    box: [3.2, 50.7, 7.3, 53.6],
    kind: "wms",
    url: "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0",
    layer: "Actueel_orthoHR",
    version: "1.1.1",
    maxSide: 2048,
  },
  {
    id: "nls-fi",
    name: "NLS Finland orthophoto",
    short: "NLS",
    attribution: "National Land Survey of Finland, CC BY 4.0",
    license: "CC BY 4.0",
    box: [19.0, 59.6, 31.6, 70.1],
    kind: "wmts-merc",
    url: "https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/ortokuva/default/WGS84_Pseudo-Mercator/",
    maxZoom: 18,
    keyEnv: "NLS_API_KEY",
  },
  {
    id: "ign-fr",
    name: "IGN BD ORTHO (France)",
    short: "IGN",
    attribution: "IGN, Licence Ouverte Etalab 2.0",
    license: "Licence Ouverte 2.0",
    box: [-5.3, 41.3, 9.7, 51.2],
    kind: "wms",
    url: "https://data.geopf.fr/wms-r/wms",
    layer: "ORTHOIMAGERY.ORTHOPHOTOS",
    version: "1.3.0",
    maxSide: 2048,
  },
];

const CHOICES = ["esri", "auto", "naip", "national"];

function normalizeChoice(v) {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  return CHOICES.includes(s) ? s : "esri";
}

function inBox(box, bbox) {
  const lon = (bbox.west + bbox.east) / 2;
  const lat = (bbox.south + bbox.north) / 2;
  return lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3];
}

function nationalFor(bbox, env) {
  const e = env || process.env;
  for (const p of NATIONAL) {
    if (!inBox(p.box, bbox)) continue;
    if (p.keyEnv && !String(e[p.keyEnv] || "").trim()) continue;
    return p;
  }
  return null;
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function linkSignals(signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, ms));
  if (typeof timer.unref === "function") timer.unref();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

async function getBuffer(url, signal, fetchImpl) {
  const r = await (fetchImpl || fetch)(url, { headers: { "user-agent": UA }, signal });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, type: String(r.headers.get("content-type") || "") };
}

function decodeJpeg(buf) {
  if (!buf || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("not jpeg");
  return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 80 });
}

/** Pixels a service paints where it has no photo: flat white or flat black. */
function blankPixel(d, i) {
  const r = d[i], g = d[i + 1], b = d[i + 2];
  return (r >= 250 && g >= 250 && b >= 250) || (r <= 6 && g <= 6 && b <= 6);
}

function blankShare(img) {
  const d = img.data;
  const n = img.width * img.height;
  let blank = 0;
  let k = 0;
  for (let p = 0; p < n; p += 11) {
    if (blankPixel(d, p * 4)) blank++;
    k++;
  }
  return k ? blank / k : 1;
}

function encodeRgba(data, width, height) {
  return Buffer.from(jpeg.encode({ data, width, height }, JPEG_QUALITY).data);
}

function plateExtent(frame) {
  return esriContentExtent(frame, frame.imgW, frame.imgH);
}

/* ---------------------------------------------------------------- WMS */

function wmsUrl(p, ext, w, h) {
  const q =
    p.version === "1.3.0"
      ? `VERSION=1.3.0&CRS=EPSG:4326&BBOX=${ext.south},${ext.west},${ext.north},${ext.east}`
      : `VERSION=1.1.1&SRS=EPSG:4326&BBOX=${ext.west},${ext.south},${ext.east},${ext.north}`;
  return (
    p.url +
    (p.url.includes("?") ? "&" : "?") +
    `SERVICE=WMS&REQUEST=GetMap&LAYERS=${encodeURIComponent(p.layer)}&STYLES=&FORMAT=image/jpeg&` +
    q +
    `&WIDTH=${w}&HEIGHT=${h}`
  );
}

async function renderWms(p, frame, signal, fetchImpl) {
  const ext = plateExtent(frame);
  const W = frame.imgW;
  const H = frame.imgH;
  const max = p.maxSide || 2048;
  const cols = Math.ceil(W / max);
  const rows = Math.ceil(H / max);
  const pieces = [];
  for (let r = 0; r < rows; r++) {
    const y0 = Math.round((r * H) / rows);
    const y1 = Math.round(((r + 1) * H) / rows);
    for (let c = 0; c < cols; c++) {
      const x0 = Math.round((c * W) / cols);
      const x1 = Math.round(((c + 1) * W) / cols);
      pieces.push({
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
        ext: {
          west: ext.west + (x0 / W) * (ext.east - ext.west),
          east: ext.west + (x1 / W) * (ext.east - ext.west),
          north: ext.north - (y0 / H) * (ext.north - ext.south),
          south: ext.north - (y1 / H) * (ext.north - ext.south),
        },
      });
    }
  }
  const got = await Promise.all(
    pieces.map(async (pc) => {
      const { buf, type } = await getBuffer(wmsUrl(p, pc.ext, pc.w, pc.h), signal, fetchImpl);
      if (!/jpe?g/i.test(type)) throw new Error(p.short + " returned " + (type || "no image"));
      const img = decodeJpeg(buf);
      if (img.width !== pc.w || img.height !== pc.h) throw new Error(p.short + " size mismatch");
      return { buf, img };
    })
  );
  let blank = 0;
  for (const g of got) blank += blankShare(g.img) * g.img.width * g.img.height;
  if (blank / (W * H) > 0.03) throw Object.assign(new Error(p.short + " does not cover this area"), { coverage: true });
  if (got.length === 1) return got[0].buf;
  const out = new Uint8Array(W * H * 4);
  pieces.forEach((pc, i) => {
    const src = got[i].img.data;
    for (let row = 0; row < pc.h; row++) {
      out.set(src.subarray(row * pc.w * 4, (row + 1) * pc.w * 4), ((pc.y + row) * W + pc.x) * 4);
    }
  });
  return encodeRgba(out, W, H);
}

/* ------------------------------------------------- WMTS (Web Mercator) */

function lonToX(lon, n) {
  return ((lon + 180) / 360) * n;
}
function latToY(lat, n) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n;
}

async function renderWmtsMerc(p, frame, signal, fetchImpl, env) {
  const key = String((env || process.env)[p.keyEnv] || "").trim();
  if (p.keyEnv && !key) throw Object.assign(new Error(p.short + " key not set"), { coverage: true });
  const ext = plateExtent(frame);
  const W = frame.imgW;
  const H = frame.imgH;
  // Tile pixels per output pixel close to 1, capped at the service's top zoom
  // and at a tile count one export can afford.
  const outPerDegLon = W / (ext.east - ext.west);
  let z = Math.min(p.maxZoom || 18, Math.max(1, Math.ceil(Math.log2((outPerDegLon * 360) / 256))));
  let tx0, tx1, ty0, ty1;
  for (; z > 1; z--) {
    const n = 2 ** z;
    tx0 = Math.floor(lonToX(ext.west, n));
    tx1 = Math.floor(lonToX(ext.east, n));
    ty0 = Math.floor(latToY(ext.north, n));
    ty1 = Math.floor(latToY(ext.south, n));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 400) break;
  }
  const n = 2 ** z;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push({ tx, ty });
  const tiles = new Map();
  let next = 0;
  let failed = null;
  async function worker() {
    while (!failed && next < jobs.length) {
      const j = jobs[next++];
      if (signal && signal.aborted) throw abortError();
      const url = p.url + z + "/" + j.ty + "/" + j.tx + ".jpg" + (key ? "?api-key=" + encodeURIComponent(key) : "");
      try {
        const { buf } = await getBuffer(url, signal, fetchImpl);
        tiles.set(j.tx + "," + j.ty, decodeJpeg(buf));
      } catch (err) {
        if (signal && signal.aborted) throw abortError();
        // A missing tile is a coverage hole, counted below.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker));
  // One more pass for tiles that failed (a busy server drops a few).
  const missed = jobs.filter((j) => !tiles.has(j.tx + "," + j.ty));
  if (missed.length && missed.length <= jobs.length / 4) {
    jobs.length = 0;
    for (const j of missed) jobs.push(j);
    next = 0;
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  }
  const out = new Uint8Array(W * H * 4);
  const colX = new Float64Array(W);
  for (let c = 0; c < W; c++) colX[c] = lonToX(ext.west + ((c + 0.5) / W) * (ext.east - ext.west), n);
  let miss = 0;
  // Bilinear inside a tile; a sample on a tile edge clamps to that tile.
  for (let r = 0; r < H; r++) {
    const fy = latToY(ext.north - ((r + 0.5) / H) * (ext.north - ext.south), n);
    const ty = Math.floor(fy);
    for (let c = 0; c < W; c++) {
      const fx = colX[c];
      const tx = Math.floor(fx);
      const img = tiles.get(tx + "," + ty);
      const d = (r * W + c) * 4;
      if (!img) {
        miss++;
        out[d + 3] = 255;
        continue;
      }
      const px = Math.min(img.width - 1.001, Math.max(0, (fx - tx) * img.width - 0.5));
      const py = Math.min(img.height - 1.001, Math.max(0, (fy - ty) * img.height - 0.5));
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const ax = px - x0, ay = py - y0;
      const s00 = (y0 * img.width + x0) * 4;
      const s10 = s00 + 4;
      const s01 = s00 + img.width * 4;
      const s11 = s01 + 4;
      const id = img.data;
      for (let ch = 0; ch < 3; ch++) {
        out[d + ch] =
          (id[s00 + ch] * (1 - ax) + id[s10 + ch] * ax) * (1 - ay) + (id[s01 + ch] * (1 - ax) + id[s11 + ch] * ax) * ay;
      }
      out[d + 3] = 255;
    }
  }
  const img = { data: out, width: W, height: H };
  if (miss > 0 || blankShare(img) > 0.03) {
    throw Object.assign(new Error(p.short + " does not cover this area"), { coverage: true });
  }
  return encodeRgba(out, W, H);
}

/* --------------------------------------------------------------- NAIP */

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function itemCovers(item, ext) {
  const g = item && item.geometry;
  if (!g) return false;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const corners = [
    [ext.west, ext.south],
    [ext.east, ext.south],
    [ext.east, ext.north],
    [ext.west, ext.north],
  ];
  return polys.some((poly) => corners.every(([x, y]) => pointInRing(x, y, poly[0])));
}

/** Newest NAIP items over the box, newest first. */
async function naipItems(bbox, signal, fetchImpl) {
  const url =
    PC_STAC +
    `?collections=naip&bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}&limit=40&sortby=-datetime`;
  const r = await (fetchImpl || fetch)(url, { headers: { "user-agent": UA }, signal });
  if (!r.ok) throw new Error("NAIP search HTTP " + r.status);
  const d = await r.json();
  const feats = (d && d.features) || [];
  feats.sort((a, b) => String(b.properties && b.properties.datetime).localeCompare(String(a.properties && a.properties.datetime)));
  return feats;
}

function naipBboxUrl(itemId, ext, w, h) {
  return (
    PC_DATA +
    `${ext.west},${ext.south},${ext.east},${ext.north}/${w}x${h}.jpg` +
    `?collection=naip&item=${encodeURIComponent(itemId)}&assets=image&asset_bidx=image%7C1,2,3` +
    `&dst_crs=epsg:4326&resampling=bilinear&nodata=0`
  );
}

async function renderNaip(ctx, frame, signal, fetchImpl) {
  const items = ctx.items || [];
  if (!items.length) throw Object.assign(new Error("NAIP has no imagery here"), { coverage: true });
  const ext = plateExtent(frame);
  const W = frame.imgW;
  const H = frame.imgH;
  // Newest item that holds the whole window: one read, no seam.
  const newestYear = String(items[0].properties.datetime || "").slice(0, 4);
  const sameYear = items.filter((it) => String(it.properties.datetime || "").slice(0, 4) === newestYear);
  const whole = sameYear.find((it) => itemCovers(it, ext)) || items.find((it) => itemCovers(it, ext));
  if (whole) {
    const { buf, type } = await getBuffer(naipBboxUrl(whole.id, ext, W, H), signal, fetchImpl);
    if (!/jpe?g/i.test(type)) throw new Error("NAIP returned " + (type || "no image"));
    noteItem(ctx, whole);
    return buf;
  }
  // The window straddles quarter quads: fill from the newest items in turn.
  const out = new Uint8Array(W * H * 4);
  const have = new Uint8Array(W * H);
  let filled = 0;
  for (const it of items.slice(0, 6)) {
    if (filled >= W * H * 0.995) break;
    const { buf } = await getBuffer(naipBboxUrl(it.id, ext, W, H), signal, fetchImpl);
    const img = decodeJpeg(buf);
    if (img.width !== W || img.height !== H) continue;
    let used = 0;
    for (let p = 0; p < W * H; p++) {
      if (have[p]) continue;
      const i = p * 4;
      const d = img.data;
      // nodata=0 paints outside the item black; JPEG keeps it near-black.
      if (d[i] <= 10 && d[i + 1] <= 10 && d[i + 2] <= 10) continue;
      out[i] = d[i];
      out[i + 1] = d[i + 1];
      out[i + 2] = d[i + 2];
      out[i + 3] = 255;
      have[p] = 1;
      used++;
    }
    if (used) noteItem(ctx, it);
    filled += used;
  }
  if (filled < W * H * 0.98) throw Object.assign(new Error("NAIP does not cover this whole area"), { coverage: true });
  for (let p = 0; p < W * H; p++) if (!have[p]) out[p * 4 + 3] = 255;
  return encodeRgba(out, W, H);
}

function noteItem(ctx, item) {
  const date = String((item.properties && item.properties.datetime) || "").slice(0, 10);
  if (date && !ctx.dates.includes(date)) ctx.dates.push(date);
}

/* ------------------------------------------------------------ router */

/**
 * Pick a source for this draw. Returns a context the imagery fetch uses for
 * every plate and tile. Never throws: a miss is Esri with a reason.
 */
function createImageryContext(choice, bbox, opts) {
  const o = opts || {};
  const requested = normalizeChoice(choice);
  const ctx = {
    requested,
    source: ESRI,
    reason: "",
    dates: [],
    items: null,
    failed: false,
    failReason: "",
    altPlates: 0,
    esriPlates: 0,
    ready: Promise.resolve(),
  };
  if (requested === "esri" || !bbox) return ctx;
  const env = o.env || process.env;
  const fetchImpl = o.fetch;
  const usNaip = inBox(NAIP.box, bbox);
  const national = nationalFor(bbox, env);
  let pick = null;
  if (requested === "naip") {
    if (usNaip) pick = NAIP;
    else ctx.reason = "NAIP covers the lower 48 US only";
  } else if (requested === "national") {
    if (national) pick = national;
    else ctx.reason = "no open national orthophoto source for this area";
  } else if (requested === "auto") {
    pick = usNaip ? NAIP : national;
  }
  if (!pick) return ctx;
  ctx.source = pick;
  if (pick === NAIP) {
    ctx.ready = (async () => {
      const link = linkSignals(o.signal, STAC_TIMEOUT_MS);
      try {
        ctx.items = await naipItems(bbox, link.signal, fetchImpl);
        if (!ctx.items.length) fallBack(ctx, "NAIP has no imagery for this area");
      } catch (err) {
        fallBack(ctx, "NAIP search failed (" + shortErr(err) + ")");
      } finally {
        link.done();
      }
    })();
  }
  ctx.render = (frame, signal) => {
    if (pick === NAIP) return renderNaip(ctx, frame, signal, fetchImpl);
    if (pick.kind === "wms") return renderWms(pick, frame, signal, fetchImpl);
    return renderWmtsMerc(pick, frame, signal, fetchImpl, env);
  };
  return ctx;
}

function shortErr(err) {
  const m = String((err && err.message) || err || "error");
  if (/abort|timeout/i.test(m) || (err && err.name === "AbortError")) return "timed out";
  return m.slice(0, 80);
}

function fallBack(ctx, why) {
  if (ctx.failed) return;
  ctx.failed = true;
  ctx.failReason = why;
}

/**
 * One plate (or tile) as a JPEG. The chosen source gets most of the wait;
 * Esri gets what is left when it misses. esriFetch(frame, ms, signal).
 */
async function fetchPlateWith(ctx, frame, attemptMs, signal, esriFetch) {
  if (!ctx || ctx.source === ESRI) {
    ctx && ctx.esriPlates++;
    return esriFetch(frame, attemptMs, signal);
  }
  const started = Date.now();
  await ctx.ready;
  if (!ctx.failed) {
    const share = Math.max(1500, Math.min(attemptMs - 4000, Math.round(attemptMs * 0.65)));
    const link = linkSignals(signal, share - (Date.now() - started));
    try {
      const buf = await ctx.render(frame, link.signal);
      ctx.altPlates++;
      return buf;
    } catch (err) {
      if (signal && signal.aborted) throw err;
      fallBack(ctx, err && err.coverage ? String(err.message) : ctx.source.short + " failed (" + shortErr(err) + ")");
    } finally {
      link.done();
    }
  }
  ctx.esriPlates++;
  const left = Math.max(1500, attemptMs - (Date.now() - started));
  return esriFetch(frame, left, signal);
}

/** What the export used, for stats, Details, README. */
function imageryInfo(ctx) {
  const c = ctx || { requested: "esri", source: ESRI, dates: [] };
  const usedAlt = c.source !== ESRI && c.altPlates > 0;
  const mixed = usedAlt && c.esriPlates > 0;
  const src = usedAlt ? c.source : ESRI;
  const dates = usedAlt ? c.dates.slice().sort() : [];
  let reason = c.reason || "";
  if (!usedAlt && c.source !== ESRI) reason = c.failReason || reason || c.source.short + " was not used";
  const esriCite = !usedAlt && c.esriCitation ? c.esriCitation : null;
  const dayList = esriCite ? esriCite.dates : dates;
  return {
    requested: c.requested,
    id: src.id,
    name: src.name,
    attribution: src.attribution,
    license: src.license,
    provider: esriCite && esriCite.providers.length ? esriCite.providers.join(", ") : "",
    captureDate: dayList.length ? (dayList.length === 1 ? dayList[0] : dayList[0] + " to " + dayList[dayList.length - 1]) : "",
    fallback: c.requested !== "esri" && !usedAlt,
    mixed: mixed,
    reason: reason,
  };
}

/** One line for Details and export-warnings.json. */
function imageryLine(info) {
  if (!info) return "";
  let s = "Aerial: " + info.name;
  if (info.provider) s += " (" + info.provider + ")";
  if (info.captureDate) s += ", captured " + info.captureDate;
  else if (info.id !== "esri") s += ", latest published";
  s += ". " + info.attribution + ".";
  if (info.mixed) s += " Part of the map is Esri World Imagery (" + (info.reason || "source miss") + ").";
  if (info.fallback && info.requested !== "esri") {
    s += " Asked for " + (info.requested === "auto" ? "Auto" : info.requested === "naip" ? "NAIP" : "National") + ", used Esri: " + (info.reason || "source not available") + ".";
  }
  return s;
}

function sourceShort(id) {
  if (id === NAIP.id) return NAIP.short;
  const n = NATIONAL.find((p) => p.id === id);
  return n ? n.short : ESRI.short;
}

module.exports = {
  sourceShort,
  ESRI,
  NAIP,
  NATIONAL,
  CHOICES,
  normalizeChoice,
  nationalFor,
  createImageryContext,
  fetchPlateWith,
  imageryInfo,
  imageryLine,
  esriLevelFor,
  esriCitationUrl,
  parseEsriCitation,
  fetchEsriCitation,
  readEsriCitation,
  itemCovers,
  wmsUrl,
  naipBboxUrl,
};
