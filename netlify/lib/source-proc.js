"use strict";

/**
 * Heavy source reads in a short-lived child process (OPE-14, 1.3.102).
 *
 * On a 1 GB Netlify function the read phase grew the process to about
 * 900 MB, and Node does not give that memory back, so Trees and the outdoor
 * pass started near the limit. On such a host (and only in a background
 * export) each heavy read runs in its own child process that returns only
 * its result and exits, which hands its memory back to the system. Fly, the
 * benches, and every roomy host read in process as before.
 *
 * The child is the same file the function runs from (registered with
 * setChildEntry), started with OPENCLUTTER_SOURCE_CHILD=1. A child that
 * crashes, or misses its deadline, makes the read fail like a failed fetch.
 */

let KILL_GRACE_MS = 3000;
const DEFAULT_DEADLINE_MS = 8 * 60 * 1000;
let childEntry = "";
let childPeakKb = 0;
let runs = 0;
let failures = 0;

function isChild() {
  return process.env.OPENCLUTTER_SOURCE_CHILD === "1";
}

function setChildEntry(file) {
  if (file && !childEntry) childEntry = file;
}

function entryFile() {
  return childEntry || require("node:path").join(__dirname, "source-child.js");
}

function enabled(active) {
  if (!active || isChild()) return false;
  const force = String(process.env.OPENCLUTTER_SOURCE_PROCESS || "");
  if (force === "0") return false;
  if (!require("./host-memory").lowMemoryHost()) return false;
  return require("node:fs").existsSync(entryFile());
}

function abortError(msg) {
  return Object.assign(new Error(msg || "The operation was aborted due to timeout"), { name: "AbortError" });
}

/**
 * Run source `kind` with `args` in a child process. `signal` (optional)
 * asks the child to stop and send what it has; `deadlineMs` bounds the
 * whole child. Resolves with the child's value or rejects like the read.
 */
function runInChild(kind, args, opts) {
  const o = opts || {};
  const { fork } = require("node:child_process");
  return new Promise((resolve, reject) => {
    let done = false;
    let child;
    try {
      child = fork(entryFile(), [], {
        env: Object.assign({}, process.env, { OPENCLUTTER_SOURCE_CHILD: "1" }),
        serialization: "advanced",
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
    } catch (e) {
      reject(e);
      return;
    }
    runs++;
    let graceTimer = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(graceTimer);
      if (o.signal) o.signal.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) {
        // A child that answered exits on its own; give it a moment.
        const k = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        if (typeof k.unref === "function") k.unref();
        child.once("exit", () => clearTimeout(k));
      }
      fn(v);
    };
    const stop = (why) => {
      try {
        child.send({ abort: true });
      } catch {
        /* the child already left */
      }
      graceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        failures++;
        finish(reject, abortError(why));
      }, KILL_GRACE_MS);
    };
    const onAbort = () => stop();
    const deadline = setTimeout(() => stop("The operation was aborted due to timeout"), o.deadlineMs > 0 ? o.deadlineMs : DEFAULT_DEADLINE_MS);
    if (o.signal) {
      if (o.signal.aborted) setImmediate(onAbort);
      else o.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("message", (msg) => {
      if (!msg || msg.kind !== kind) return;
      if (msg.maxRssKb > childPeakKb) childPeakKb = msg.maxRssKb;
      if (msg.ok) finish(resolve, msg.value);
      else {
        failures++;
        const err = new Error(msg.error || "source read failed");
        if (msg.name) err.name = msg.name;
        finish(reject, err);
      }
    });
    child.on("error", (e) => {
      failures++;
      finish(reject, e);
    });
    child.on("exit", (code, sig) => {
      if (done) return;
      failures++;
      finish(reject, new Error("The " + kind + " read stopped (" + (sig || "exit " + code) + ")."));
    });
    try {
      child.send({ kind, args });
    } catch (e) {
      failures++;
      finish(reject, e);
    }
  });
}

/** Run in a child on a small host (when `active`), else call `inProcess`. */
function heavyRead(kind, args, inProcess, active, opts) {
  if (!enabled(active)) return inProcess();
  return runInChild(kind, args, opts);
}

function stats() {
  return { runs, failures, childMaxRssMb: childPeakKb ? Math.round((childPeakKb * 1024) / 1e6) : 0 };
}

function setKillGraceForTests(ms) {
  KILL_GRACE_MS = ms > 0 ? ms : 3000;
}

function resetForTests() {
  childPeakKb = 0;
  runs = 0;
  failures = 0;
}

/* ---------------- child side ---------------- */

function defaultUa() {
  return require("./version").userAgent;
}

function executors() {
  return {
    street: ([bbox, o]) => require("./overture-street").fetchOvertureStreet(bbox, { signal: null, deadlineMs: o && o.deadlineMs }),
    microsoft: ([frame, o]) =>
      require("./ms-global").fetchMsGlobalFootprints(
        frame,
        (url) => fetch(url, { headers: { "user-agent": o.ua || defaultUa() }, signal: AbortSignal.timeout(o.coreBudget) }),
        { diskCache: true }
      ),
    usa: ([frame, o]) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), o.coreBudget);
      return require("./usa-structures")
        .fetchUsaStructures(
          frame,
          (url, s) => fetch(url, { headers: { "user-agent": o.ua || defaultUa() }, signal: s || ctrl.signal }),
          { diskCache: true, signal: ctrl.signal }
        )
        .finally(() => clearTimeout(timer));
    },
    overtureBuildings: ([frame, o], signal) => require("./overture").fetchOvertureFootprints(frame, { signal, filter: o.filter }),
    lidar: ([box, o]) => require("./usgs-lidar").fetchUsgsLidar(box, o || {}),
    canopy: ([frame], signal) => require("./canopy-height").fetchChmGrid(frame, { signal }),
    ...(process.env.OPENCLUTTER_SOURCE_TEST === "1" ? testExecutors() : {}),
  };
}

function testExecutors() {
  return {
    echo: ([v]) => v,
    crash: () => process.exit(3),
    fail: () => {
      throw Object.assign(new Error("no rows"), { name: "RangeError" });
    },
    hang: (_args, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ partial: true }), { once: true });
      }),
    stuck: () => new Promise(() => {}),
  };
}

function childMain() {
  const ctrl = new AbortController();
  let started = false;
  process.on("message", async (msg) => {
    if (!msg) return;
    if (msg.abort) {
      ctrl.abort();
      return;
    }
    if (started || !msg.kind) return;
    started = true;
    const run = executors()[msg.kind];
    let reply;
    try {
      if (!run) throw new Error("unknown source " + msg.kind);
      const value = await run(msg.args || [], ctrl.signal);
      reply = { kind: msg.kind, ok: true, value };
    } catch (e) {
      reply = { kind: msg.kind, ok: false, error: String((e && e.message) || e), name: e && e.name };
    }
    reply.maxRssKb = process.resourceUsage().maxRSS;
    try {
      process.send(reply, () => process.exit(0));
    } catch {
      process.exit(1);
    }
  });
  process.on("disconnect", () => process.exit(0));
}

module.exports = { setKillGraceForTests, isChild, setChildEntry, entryFile, enabled, runInChild, heavyRead, stats, resetForTests, childMain, executors };
