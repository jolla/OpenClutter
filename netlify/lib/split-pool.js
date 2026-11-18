"use strict";

/**
 * One persistent split thread per Node thread (main or a canopy worker).
 * Callers stay synchronous: the request is posted, the caller blocks on a
 * shared flag with the stand budget, then reads the reply with
 * receiveMessageOnPort. A hang terminates the thread and the next call
 * starts a fresh one, so the 1.3.26 hang guard is kept without paying a
 * process spawn and a terrain copy per stand.
 *
 * OPENCLUTTER_SPLIT_CHILD=1 restores the old child process per stand.
 */

const path = require("path");
const { Worker, MessageChannel, receiveMessageOnPort } = require("worker_threads");

const THREAD_FILE = path.join(__dirname, "split-thread.js");

let current = null;
let terrainSeq = 0;
const terrainKeys = new WeakMap();

let threadFileOk = null;

/**
 * The child path also runs when the thread file is not on disk (a bundle
 * that did not copy it). A missing file must fail fast there, not wait
 * out the stand budget on every stand.
 */
function useChild() {
  if (process.env.OPENCLUTTER_SPLIT_CHILD === "1") return true;
  if (threadFileOk == null) {
    try {
      threadFileOk = require("fs").existsSync(THREAD_FILE);
    } catch (_) {
      threadFileOk = false;
    }
  }
  return !threadFileOk;
}

function start() {
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(THREAD_FILE, {
    workerData: { sab, port: port2 },
    transferList: [port2],
  });
  worker.unref();
  port1.unref();
  const st = { worker, flag, port: port1, seq: 0, terrainId: 0, dead: false };
  worker.on("error", () => {
    st.dead = true;
  });
  worker.on("exit", () => {
    st.dead = true;
  });
  return st;
}

function stop(st) {
  if (!st) return;
  st.dead = true;
  try {
    st.port.close();
  } catch (_) {}
  try {
    st.worker.terminate().catch(() => {});
  } catch (_) {}
  if (current === st) current = null;
}

/**
 * Send one request and wait up to timeoutMs.
 * Returns { msg } on success, { timedOut: true } on a hang, or { error }.
 */
function call(build, timeoutMs) {
  let st = current;
  if (!st || st.dead) {
    st = current = start();
  }
  const seq = (st.seq = (st.seq % 0x3fffffff) + 1);
  const req = build(st);
  req.seq = seq;
  try {
    st.worker.postMessage(req);
  } catch (err) {
    stop(st);
    return { error: "post " + (err && err.message ? err.message : err) };
  }
  const deadline = Date.now() + Math.max(1, timeoutMs);
  for (;;) {
    const got = Atomics.load(st.flag, 0);
    if (got === seq) break;
    const left = deadline - Date.now();
    if (left <= 0) {
      stop(st);
      return { timedOut: true };
    }
    Atomics.wait(st.flag, 0, got, left);
  }
  let reply = null;
  for (;;) {
    const r = receiveMessageOnPort(st.port);
    if (!r) break;
    if (r.message && r.message.seq === seq) {
      reply = r.message;
      break;
    }
  }
  if (!reply) {
    stop(st);
    return { error: "no reply" };
  }
  if (reply.error) {
    if (reply.error === "terrain-missing") st.terrainId = 0;
    return { error: reply.error, ms: reply.ms };
  }
  return { msg: reply };
}

function terrainFingerprint(terrain) {
  const cb = terrain.clipboard || null;
  return [
    terrain.frame,
    cb,
    cb && cb.slopedFloors,
    cb && cb.slopedFloors ? cb.slopedFloors.length : -1,
    cb && cb.raisedFloorZones,
    cb && cb.raisedFloorZones ? cb.raisedFloorZones.length : -1,
    terrain.gridCols,
    terrain.gridRows,
    terrain.kind,
    terrain.reliefM,
    terrain.raised,
    terrain.sloped,
    terrain._floorCells || null,
  ];
}

function sameFingerprint(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Split one stand. snapshot(terrain) builds the copy the old child got.
 * The copy is sent once per terrain per thread and reused after that.
 */
function splitInThread(terrain, ring, opts, timeoutMs, snapshot) {
  let key = terrainKeys.get(terrain);
  if (key) {
    const fp = terrainFingerprint(terrain);
    if (!sameFingerprint(fp, key.fp)) key = null;
  }
  if (!key) {
    const snap = snapshot(terrain);
    key = { id: ++terrainSeq, snap, fp: terrainFingerprint(terrain) };
    terrainKeys.set(terrain, key);
  }
  const res = call((st) => {
    const req = { op: "split", terrainId: key.id, ring, opts: opts || {} };
    if (st.terrainId !== key.id) {
      req.terrain = key.snap;
      st.terrainId = key.id;
    }
    return req;
  }, timeoutMs);
  if (res.msg && Array.isArray(res.msg.pieces)) return { pieces: res.msg.pieces, ms: res.msg.ms };
  return { timedOut: !!res.timedOut, error: res.error || (res.msg ? "no pieces" : null) };
}

function mergeInThread(seats, frame, timeoutMs) {
  const res = call(() => ({ op: "merge", seats, frame }), timeoutMs);
  if (res.msg && Array.isArray(res.msg.seats)) return { seats: res.msg.seats, ms: res.msg.ms };
  return { timedOut: !!res.timedOut, error: res.error || (res.msg ? "no seats" : null) };
}

function shutdown() {
  stop(current);
}

function threadIdForTest() {
  return current && !current.dead ? current.worker.threadId : 0;
}

function hangForTest(timeoutMs) {
  return call(() => ({ op: "hang" }), timeoutMs);
}

module.exports = { splitInThread, mergeInThread, shutdown, useChild, threadIdForTest, hangForTest };
