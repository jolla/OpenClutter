"use strict";

/**
 * Short-lived cache for place search. Hits live in memory on a warm
 * function instance, and in a Netlify blob store so a cold instance can
 * reuse them. Empty lists and errors are never stored: a timeout or a
 * brief Photon gap must not stick.
 */

const crypto = require("node:crypto");

const MEMORY_MAX = 500;
const SUGGEST_TTL_MS = 30 * 60 * 1000;
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;

const memory = new Map();
let storeOverride;

function ttlMs(kind) {
  return kind === "geocode" ? GEOCODE_TTL_MS : SUGGEST_TTL_MS;
}

function viewKey(view) {
  if (!view || !Number.isFinite(view.lat) || !Number.isFinite(view.lon)) return "";
  return view.lat.toFixed(2) + "," + view.lon.toFixed(2);
}

function cacheKey(kind, q, view) {
  const norm = String(q || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return kind + ":" + viewKey(view) + ":" + norm;
}

function blobKey(key) {
  return "s" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function memGet(key) {
  const e = memory.get(key);
  if (!e) return null;
  if (Date.now() >= e.exp) {
    memory.delete(key);
    return null;
  }
  memory.delete(key);
  memory.set(key, e);
  return e.value;
}

function memSet(key, value, ttl) {
  if (memory.has(key)) memory.delete(key);
  memory.set(key, { value, exp: Date.now() + ttl });
  while (memory.size > MEMORY_MAX) {
    const first = memory.keys().next().value;
    memory.delete(first);
  }
}

function sharedStore() {
  if (storeOverride !== undefined) return storeOverride;
  if (process.env.OPENCLUTTER_SEARCH_CACHE === "0") return null;
  try {
    const { getStore } = require("@netlify/blobs");
    return getStore({ name: "openclutter-search-cache" });
  } catch {
    return null;
  }
}

async function cacheGet(kind, q, view) {
  const key = cacheKey(kind, q, view);
  const hit = memGet(key);
  if (hit) return hit;
  const store = sharedStore();
  if (!store) return null;
  try {
    const got = await store.get(blobKey(key), { type: "json" });
    if (!got || !Array.isArray(got.value) || !got.value.length) return null;
    const exp = Number(got.exp);
    if (!exp || Date.now() >= exp) return null;
    memSet(key, got.value, exp - Date.now());
    return got.value;
  } catch {
    return null;
  }
}

async function cacheSet(kind, q, view, value) {
  if (!Array.isArray(value) || !value.length) return;
  const key = cacheKey(kind, q, view);
  const ttl = ttlMs(kind);
  memSet(key, value, ttl);
  const store = sharedStore();
  if (!store) return;
  try {
    await store.setJSON(blobKey(key), { value, exp: Date.now() + ttl });
  } catch {
    /* Memory still holds the hit. */
  }
}

module.exports = {
  SUGGEST_TTL_MS,
  GEOCODE_TTL_MS,
  cacheKey,
  cacheGet,
  cacheSet,
  _clear() {
    memory.clear();
  },
  _setStore(s) {
    storeOverride = s;
    memory.clear();
  },
};
