"use strict";

/**
 * Nominatim search, inside the OSMF usage policy:
 *   - at most 1 request per second for the whole app, not per instance:
 *     each call reserves the next free second in a shared blob with a
 *     conditional write, and waits for it. Without a blob store (tests,
 *     local runs) the same reservation is kept in process.
 *   - an identifying User-Agent with a project contact URL.
 *   - the endpoint is NOMINATIM_URL, so the provider can be switched
 *     without a code change. Nominatim is only asked after a user search,
 *     never for autocomplete.
 */

const DEFAULT_URL = "https://nominatim.openstreetmap.org/search";
const GAP_MS = 1000;
const MAX_WAIT_MS = 6000;
const SLOT_KEY = "nominatim-next-slot";

let localNext = 0;
let storeOverride;

function endpoint(env) {
  const raw = String(((env || process.env).NOMINATIM_URL || "")).trim();
  return /^https:\/\//i.test(raw) ? raw.replace(/\?.*$/, "") : DEFAULT_URL;
}

function searchUrl(q, env) {
  return endpoint(env) + "?format=json&limit=5&q=" + encodeURIComponent(q);
}

function sharedStore() {
  if (storeOverride !== undefined) return storeOverride;
  if (process.env.OPENCLUTTER_SHARED_LIMIT === "0") return null;
  try {
    const { getStore } = require("@netlify/blobs");
    return getStore({ name: "openclutter-ratelimit" });
  } catch {
    return null;
  }
}

/** Reserve the next free 1 s slot app-wide. Returns the time to start at. */
async function reserveSlot(now) {
  const store = sharedStore();
  if (store) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const got = await store.getWithMetadata(SLOT_KEY, { type: "json" });
        const next = got && got.data && Number(got.data.next) > 0 ? Number(got.data.next) : 0;
        const slot = Math.max(now, next, localNext);
        const write = got
          ? await store.setJSON(SLOT_KEY, { next: slot + GAP_MS }, { onlyIfMatch: got.etag })
          : await store.setJSON(SLOT_KEY, { next: slot + GAP_MS }, { onlyIfNew: true });
        if (write && write.modified === false) continue;
        localNext = Math.max(localNext, slot + GAP_MS);
        return slot;
      } catch {
        break;
      }
    }
  }
  const slot = Math.max(now, localNext);
  localNext = slot + GAP_MS;
  return slot;
}

/** One Nominatim search, paced to 1 request per second. */
async function nominatimSearch(q, opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || fetch;
  const now = Date.now();
  const slot = await reserveSlot(now);
  const wait = slot - Date.now();
  if (wait > MAX_WAIT_MS) return { ok: false, status: 429, data: [] };
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const r = await fetchImpl(searchUrl(q, o.env), {
    headers: { "user-agent": o.userAgent || "openclutter", "accept-language": "en" },
    signal: AbortSignal.timeout(o.timeoutMs || 8000),
  });
  if (!r.ok) return { ok: false, status: r.status, data: [] };
  const data = await r.json();
  return { ok: true, status: 200, data: Array.isArray(data) ? data : [] };
}

module.exports = {
  DEFAULT_URL,
  GAP_MS,
  endpoint,
  searchUrl,
  reserveSlot,
  nominatimSearch,
  /** Tests: swap the shared store. Resets this process's clock, as a new instance would have. */
  _setStore(s) {
    storeOverride = s;
    localNext = 0;
  },
};
