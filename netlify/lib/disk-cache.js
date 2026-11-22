"use strict";

/**
 * A bounded on-disk cache for raw source bytes (lidar-style). A hit
 * refreshes mtime (LRU). Expired files are dropped on read and during
 * prune. Writes evict oldest unused files until the size cap is met.
 * Stale .tmp files older than an hour are deleted during prune.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

function createDiskCache(opts) {
  const env = opts.envPrefix;
  const defaultMax = opts.maxBytes;
  const defaultTtl = opts.ttlMs;
  const subdir = opts.subdir;
  let dirOverride = undefined;
  let limitOverride = undefined;
  let pruneChain = Promise.resolve();

  function setDir(dir) {
    dirOverride = dir;
  }

  function setLimits(limits) {
    limitOverride = limits || undefined;
  }

  function maxBytes() {
    if (limitOverride && limitOverride.maxBytes > 0) return limitOverride.maxBytes;
    const n = Number(process.env[env + "_MAX_BYTES"]);
    return n > 0 ? n : defaultMax;
  }

  function ttlMs() {
    if (limitOverride && limitOverride.ttlMs > 0) return limitOverride.ttlMs;
    const n = Number(process.env[env + "_TTL_MS"]);
    return n > 0 ? n : defaultTtl;
  }

  function dir() {
    if (dirOverride !== undefined) return dirOverride || "";
    if (process.env[env] === "0") return "";
    if (process.env[env + "_DIR"] === "0") return "";
    if (process.env[env + "_DIR"]) return process.env[env + "_DIR"];
    // node --test must not reuse ~/.cache from a prior export: a cached
    // 3DEP grid would answer a mocked hang, and a cached Microsoft gzip
    // would skip an oversized-tile test.
    if (process.env.NODE_TEST_CONTEXT) return "";
    try {
      const home = os.homedir();
      if (home) return path.join(home, ".cache/openclutter", subdir);
    } catch {
      /* no home directory in this runtime */
    }
    return "";
  }

  function cachePathFor(key) {
    const root = dir();
    if (!root || !key) return "";
    const hash = crypto.createHash("sha1").update(String(key)).digest("hex");
    return path.join(root, hash.slice(0, 2), hash);
  }

  async function read(key) {
    const file = cachePathFor(key);
    if (!file) return null;
    try {
      const st = await fs.promises.stat(file);
      if (Date.now() - st.mtimeMs > ttlMs()) {
        await fs.promises.unlink(file);
        return null;
      }
      const buf = await fs.promises.readFile(file);
      try {
        const now = new Date();
        await fs.promises.utimes(file, now, now);
      } catch {
        /* a missed touch only means eviction may be slightly less LRU */
      }
      return buf;
    } catch {
      return null;
    }
  }

  async function listFiles(root) {
    const out = [];
    async function walk(current) {
      let ents;
      try {
        ents = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        const file = path.join(current, ent.name);
        if (ent.isDirectory()) {
          await walk(file);
          continue;
        }
        if (!ent.isFile()) continue;
        try {
          const st = await fs.promises.stat(file);
          if (ent.name.indexOf(".tmp") >= 0) {
            if (Date.now() - st.mtimeMs > 60 * 60 * 1000) await fs.promises.unlink(file);
            continue;
          }
          out.push({ path: file, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* skipped */
        }
      }
    }
    await walk(root);
    return out;
  }

  async function prune(now) {
    const root = dir();
    if (!root) return { evicted: 0, bytes: 0 };
    const at = now > 0 ? now : Date.now();
    const ttl = ttlMs();
    const cap = maxBytes();
    const files = await listFiles(root);
    let evicted = 0;
    let bytes = 0;
    const keep = [];
    for (const file of files) {
      if (ttl > 0 && at - file.mtime > ttl) {
        try {
          await fs.promises.unlink(file.path);
          evicted++;
        } catch {
          /* already gone */
        }
      } else {
        keep.push(file);
        bytes += file.size;
      }
    }
    if (bytes <= cap) return { evicted, bytes };
    keep.sort((a, b) => a.mtime - b.mtime);
    for (let i = 0; i < keep.length && bytes > cap; i++) {
      try {
        await fs.promises.unlink(keep[i].path);
        bytes -= keep[i].size;
        evicted++;
      } catch {
        /* already gone */
      }
    }
    return { evicted, bytes: Math.max(0, bytes) };
  }

  function schedulePrune() {
    pruneChain = pruneChain.then(() => prune()).catch(() => {});
    return pruneChain;
  }

  async function write(key, buf) {
    const file = cachePathFor(key);
    if (!file || !buf || !buf.length) return;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp" + process.pid;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, file);
    } catch {
      try {
        await fs.promises.unlink(file + ".tmp" + process.pid);
      } catch {
        /* leftover temp is harmless */
      }
      return;
    }
    await schedulePrune();
  }

  /** Stream a cached file without loading it into RAM. */
  async function createReadStream(key) {
    const file = cachePathFor(key);
    if (!file) return null;
    try {
      const st = await fs.promises.stat(file);
      if (Date.now() - st.mtimeMs > ttlMs()) {
        await fs.promises.unlink(file);
        return null;
      }
      try {
        const now = new Date();
        await fs.promises.utimes(file, now, now);
      } catch {
        /* a missed touch only means eviction may be slightly less LRU */
      }
      return fs.createReadStream(file);
    } catch {
      return null;
    }
  }

  /** Write a stream to the cache without buffering the whole payload. */
  async function writeFromStream(key, readable) {
    const file = cachePathFor(key);
    if (!file || !readable) return 0;
    const tmp = file + ".tmp" + process.pid;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await pipeline(readable, fs.createWriteStream(tmp));
      await fs.promises.rename(tmp, file);
    } catch (err) {
      try {
        await fs.promises.unlink(tmp);
      } catch {
        /* leftover temp is harmless */
      }
      throw err;
    }
    await schedulePrune();
    try {
      const st = await fs.promises.stat(file);
      return st.size;
    } catch {
      return 0;
    }
  }

  function note(source, hit) {
    try {
      require("./stage-clock").noteCache(source, hit);
    } catch {
      /* clock is optional for library calls */
    }
  }

  return {
    setDir,
    setLimits,
    dir,
    maxBytes,
    ttlMs,
    cachePathFor,
    read,
    write,
    createReadStream,
    writeFromStream,
    prune,
    schedulePrune,
    note,
  };
}

module.exports = { createDiskCache };
