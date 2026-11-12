"use strict";

/**
 * At most two active exports per visitor. The visitor id is the same hash
 * the usage counter uses: sha256(monthSalt + ip + user-agent), stored on
 * the job as usageVisitor, and scoped to usageHost (prod / dev / other).
 * A third export is created as a queued job and sits with a clear status
 * line until one of the two running jobs finishes or is cancelled, then
 * the worker is started. Requests with no visitor (bots, benches, a
 * missing address) are not limited.
 *
 * The active/waiting lists live in the export blob store, not the usage
 * store, so the Fly worker and the status function can both release a slot.
 */

const ACTIVE_PER_USER = 2;
const USER_WAIT_LABEL = "Waiting: two exports already in progress";
const USER_WAIT_REASON = "user-limit";

function limitKey(host, visitor) {
  return "user-active/" + host + "/" + visitor;
}

function invokeKey(id) {
  return "job/" + id + "/invoke";
}

function emptyRec() {
  return { active: [], waiting: [] };
}

function normalize(cur) {
  const rec = emptyRec();
  if (!cur || typeof cur !== "object") return rec;
  if (Array.isArray(cur.active)) rec.active = cur.active.map(String).filter(Boolean);
  if (Array.isArray(cur.waiting)) rec.waiting = cur.waiting.map(String).filter(Boolean);
  return rec;
}

function identified(job) {
  return !!(job && job.usageVisitor && job.usageHost && job.id);
}

function isTerminalState(state) {
  return state === "done" || state === "error" || state === "failed" || state === "cancelled";
}

async function stillActive(store, id) {
  if (!id) return false;
  const job = await store.get("job/" + id, { type: "json" }).catch(() => null);
  if (!job) return false;
  if (job.expiresAt && Date.now() > job.expiresAt) return false;
  if (isTerminalState(job.state)) return false;
  return true;
}

async function pruneRec(store, rec) {
  const active = [];
  for (const id of rec.active) {
    if (await stillActive(store, id)) active.push(id);
  }
  const waiting = [];
  const seen = new Set(active);
  for (const id of rec.waiting) {
    if (seen.has(id)) continue;
    if (await stillActive(store, id)) {
      waiting.push(id);
      seen.add(id);
    }
  }
  rec.active = active;
  rec.waiting = waiting;
  return rec;
}

async function registerJob(store, job) {
  if (!store || !identified(job)) return { start: true };
  let decision = { start: true };
  // prune + decide in one write after a fresh read, with a short retry loop
  for (let attempt = 0; attempt < 6; attempt++) {
    let cur = null;
    let etag = null;
    let haveMeta = typeof store.getWithMetadata === "function";
    if (haveMeta) {
      try {
        const row = await store.getWithMetadata(limitKey(job.usageHost, job.usageVisitor), { type: "json" });
        if (row && row.data) cur = row.data;
        if (row && row.etag) etag = row.etag;
      } catch {
        haveMeta = false;
        cur = await store.get(limitKey(job.usageHost, job.usageVisitor), { type: "json" });
      }
    } else {
      cur = await store.get(limitKey(job.usageHost, job.usageVisitor), { type: "json" });
    }
    const rec = await pruneRec(store, normalize(cur));
    if (rec.active.includes(job.id)) {
      decision = { start: true };
    } else if (rec.waiting.includes(job.id)) {
      decision = { start: false };
    } else if (rec.active.length < ACTIVE_PER_USER) {
      rec.active.push(job.id);
      decision = { start: true };
    } else {
      rec.waiting.push(job.id);
      decision = { start: false };
    }
    const next = rec.active.length || rec.waiting.length ? rec : null;
    if (next === null) {
      if (typeof store.delete === "function") await store.delete(limitKey(job.usageHost, job.usageVisitor)).catch(() => {});
      return decision;
    }
    if (haveMeta && etag) {
      const res = await store.setJSON(limitKey(job.usageHost, job.usageVisitor), next, { onlyIfMatch: etag });
      if (res && res.modified === false) continue;
      return decision;
    }
    if (haveMeta && !etag) {
      const res = await store.setJSON(limitKey(job.usageHost, job.usageVisitor), next, { onlyIfNew: true });
      if (res && res.modified === false) continue;
      return decision;
    }
    await store.setJSON(limitKey(job.usageHost, job.usageVisitor), next);
    return decision;
  }
  return decision;
}

async function releaseJob(store, job) {
  if (!store || !identified(job)) return { promoted: [] };
  const key = limitKey(job.usageHost, job.usageVisitor);
  for (let attempt = 0; attempt < 6; attempt++) {
    let cur = null;
    let etag = null;
    let haveMeta = typeof store.getWithMetadata === "function";
    if (haveMeta) {
      try {
        const row = await store.getWithMetadata(key, { type: "json" });
        if (row && row.data) cur = row.data;
        if (row && row.etag) etag = row.etag;
      } catch {
        haveMeta = false;
        cur = await store.get(key, { type: "json" });
      }
    } else {
      cur = await store.get(key, { type: "json" });
    }
    const rec = await pruneRec(store, normalize(cur));
    rec.active = rec.active.filter((id) => id !== job.id);
    rec.waiting = rec.waiting.filter((id) => id !== job.id);
    const promoted = [];
    while (rec.active.length < ACTIVE_PER_USER && rec.waiting.length) {
      const id = rec.waiting.shift();
      rec.active.push(id);
      promoted.push(id);
    }
    const next = rec.active.length || rec.waiting.length ? rec : null;
    if (next === null) {
      if (typeof store.delete === "function") await store.delete(key).catch(() => {});
      return { promoted };
    }
    if (haveMeta && etag) {
      const res = await store.setJSON(key, next, { onlyIfMatch: etag });
      if (res && res.modified === false) continue;
      return { promoted };
    }
    if (haveMeta && !etag) {
      const res = await store.setJSON(key, next, { onlyIfNew: true });
      if (res && res.modified === false) continue;
      return { promoted };
    }
    await store.setJSON(key, next);
    return { promoted };
  }
  return { promoted: [] };
}

async function isActiveSlot(store, job) {
  if (!store || !identified(job)) return true;
  const rec = normalize(await store.get(limitKey(job.usageHost, job.usageVisitor), { type: "json" }).catch(() => null));
  return rec.active.includes(job.id);
}

module.exports = {
  ACTIVE_PER_USER,
  USER_WAIT_LABEL,
  USER_WAIT_REASON,
  limitKey,
  invokeKey,
  registerJob,
  releaseJob,
  isActiveSlot,
};
