/**
 * Map view and drawn box in the page URL, so a site can be bookmarked or shared.
 *
 *   #map=17/36.12800/-115.16000&box=36.127100,-115.161900,36.129300,-115.158400
 *
 * map is zoom/lat/lon. box is south,west,north,east (the export frame).
 * The state lives in the hash, so query overrides like ?areaCap=... keep
 * working, and nothing in it reaches the server. Other hash keys are kept.
 * Bad or out-of-range values are dropped, never thrown.
 *
 * Browser + Node.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  if (typeof globalThis !== "undefined") globalThis.OpenClutterUrlState = lib;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_LAT = 85.05112878;
  const MIN_ZOOM = 1;
  const DEFAULT_MAX_ZOOM = 23;
  const KNOWN = ["map", "box"];

  function num(text) {
    const s = String(text == null ? "" : text).trim();
    if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    return Number(s);
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function wrapLon(lon) {
    if (lon >= -180 && lon <= 180) return lon;
    const w = ((((lon + 180) % 360) + 360) % 360) - 180;
    return w === -180 && lon > 0 ? 180 : w;
  }

  /** Splits "#a=1&b=2" into ordered [key, value] pairs. */
  function hashPairs(hash) {
    let s = String(hash || "");
    if (s.charAt(0) === "#") s = s.slice(1);
    if (!s) return [];
    const out = [];
    const parts = s.split("&");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const eq = p.indexOf("=");
      let key = eq < 0 ? p : p.slice(0, eq);
      let value = eq < 0 ? "" : p.slice(eq + 1);
      try {
        key = decodeURIComponent(key);
        value = decodeURIComponent(value);
      } catch (err) {
        continue;
      }
      out.push([key, value]);
    }
    return out;
  }

  function parseView(text, opts) {
    const bits = String(text || "").split("/");
    if (bits.length !== 3) return null;
    const z = num(bits[0]);
    const lat = num(bits[1]);
    const lon = num(bits[2]);
    if (!Number.isFinite(z) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 540) return null;
    const maxZoom = opts && opts.maxZoom > 0 ? opts.maxZoom : DEFAULT_MAX_ZOOM;
    return {
      zoom: clamp(Math.round(z * 100) / 100, MIN_ZOOM, maxZoom),
      lat: clamp(lat, -MAX_LAT, MAX_LAT),
      lon: wrapLon(lon),
    };
  }

  function parseBox(text) {
    const bits = String(text || "").split(",");
    if (bits.length !== 4) return null;
    let south = num(bits[0]);
    let west = num(bits[1]);
    let north = num(bits[2]);
    let east = num(bits[3]);
    if (![south, west, north, east].every(Number.isFinite)) return null;
    if (Math.abs(south) > MAX_LAT || Math.abs(north) > MAX_LAT) return null;
    if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
    if (south > north) {
      const t = south;
      south = north;
      north = t;
    }
    if (west > east) {
      const t = west;
      west = east;
      east = t;
    }
    if (!(north - south > 0) || !(east - west > 0)) return null;
    // A whole-hemisphere box is not a site; the page would only show the size error.
    if (north - south > 10 || east - west > 10) return null;
    return { south, west, north, east };
  }

  /**
   * Reads map and box from a location hash. Either may be null.
   * opts.maxZoom clamps the zoom to what the map allows.
   */
  function parse(hash, opts) {
    const pairs = hashPairs(hash);
    let view = null;
    let box = null;
    for (let i = 0; i < pairs.length; i++) {
      const k = pairs[i][0];
      if (k === "map") view = parseView(pairs[i][1], opts);
      else if (k === "box") box = parseBox(pairs[i][1]);
    }
    return { view, box };
  }

  function fixed(n, digits) {
    const s = (+n).toFixed(digits);
    return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
  }

  function viewDigits(zoom) {
    return zoom >= 18 ? 6 : 5;
  }

  function formatView(view) {
    if (!view) return "";
    const z = Math.round(+view.zoom * 100) / 100;
    const d = viewDigits(z);
    return String(z) + "/" + fixed(view.lat, d) + "/" + fixed(wrapLon(+view.lon), d);
  }

  function formatBox(box) {
    if (!box) return "";
    return [box.south, box.west, box.north, box.east].map((v) => fixed(v, 6)).join(",");
  }

  /**
   * The new hash for a view and box. Other keys already in the hash stay,
   * in their order. A null box removes box=.
   */
  function format(prevHash, state) {
    const kept = hashPairs(prevHash).filter((p) => KNOWN.indexOf(p[0]) < 0);
    const parts = [];
    const v = state && state.view ? formatView(state.view) : "";
    const b = state && state.box ? formatBox(state.box) : "";
    if (v) parts.push("map=" + v);
    if (b) parts.push("box=" + b);
    for (let i = 0; i < kept.length; i++) {
      const k = encodeURIComponent(kept[i][0]);
      parts.push(kept[i][1] === "" ? k : k + "=" + encodeURIComponent(kept[i][1]));
    }
    return parts.length ? "#" + parts.join("&") : "";
  }

  /**
   * Calls fn at most once per wait ms, with the last arguments (trailing).
   * flush() runs a pending call now.
   */
  function debounce(fn, wait, timers) {
    // Wrapped: a browser throws "Illegal invocation" for setTimeout called on another object.
    const t = timers || {
      setTimeout: (f, ms) => setTimeout(f, ms),
      clearTimeout: (id) => clearTimeout(id),
    };
    let id = null;
    let last = null;
    function run() {
      id = null;
      const args = last;
      last = null;
      fn.apply(null, args || []);
    }
    function wrapped() {
      last = Array.prototype.slice.call(arguments);
      if (id != null) t.clearTimeout(id);
      id = t.setTimeout(run, wait);
    }
    wrapped.flush = function () {
      if (id == null) return;
      t.clearTimeout(id);
      run();
    };
    wrapped.cancel = function () {
      if (id != null) t.clearTimeout(id);
      id = null;
      last = null;
    };
    return wrapped;
  }

  return { parse, format, formatView, formatBox, parseView, parseBox, hashPairs, debounce, MAX_LAT };
});
