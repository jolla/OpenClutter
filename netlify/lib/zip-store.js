"use strict";

const zlib = require("node:zlib");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/**
 * Writes the zip into one buffer sized up front (1.3.101). It used to build
 * each local entry with Buffer.concat and then concat them all again, so
 * the OpenIntent JSON was in memory three times at the end of a Netlify
 * export. Same bytes as before.
 */
function zipStore(files, opts) {
  const deflateAll = !!(opts && opts.deflate === true);
  const entries = [];
  let localBytes = 0;
  let centralBytes = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const useDeflate = deflateAll || !!(opts && opts.deflate === "auto" && f.deflate);
    const payload = useDeflate ? zlib.deflateRawSync(data, { level: 6 }) : data;
    entries.push({ name, size: data.length, crc, payload, method: useDeflate ? 8 : 0, offset: localBytes });
    localBytes += 30 + name.length + payload.length;
    centralBytes += 46 + name.length;
  }
  const out = Buffer.allocUnsafe(localBytes + centralBytes + 22);
  let at = 0;
  for (const e of entries) {
    out.writeUInt32LE(0x04034b50, at);
    out.writeUInt16LE(20, at + 4);
    out.writeUInt16LE(0, at + 6);
    out.writeUInt16LE(e.method, at + 8);
    out.writeUInt16LE(0, at + 10);
    out.writeUInt16LE(0, at + 12);
    out.writeUInt32LE(e.crc >>> 0, at + 14);
    out.writeUInt32LE(e.payload.length >>> 0, at + 18);
    out.writeUInt32LE(e.size >>> 0, at + 22);
    out.writeUInt16LE(e.name.length, at + 26);
    out.writeUInt16LE(0, at + 28);
    e.name.copy(out, at + 30);
    e.payload.copy(out, at + 30 + e.name.length);
    at += 30 + e.name.length + e.payload.length;
  }
  for (const e of entries) {
    out.writeUInt32LE(0x02014b50, at);
    out.writeUInt16LE(20, at + 4);
    out.writeUInt16LE(20, at + 6);
    out.writeUInt16LE(0, at + 8);
    out.writeUInt16LE(e.method, at + 10);
    out.writeUInt16LE(0, at + 12);
    out.writeUInt16LE(0, at + 14);
    out.writeUInt32LE(e.crc >>> 0, at + 16);
    out.writeUInt32LE(e.payload.length >>> 0, at + 20);
    out.writeUInt32LE(e.size >>> 0, at + 24);
    out.writeUInt16LE(e.name.length, at + 28);
    out.writeUInt16LE(0, at + 30);
    out.writeUInt16LE(0, at + 32);
    out.writeUInt16LE(0, at + 34);
    out.writeUInt16LE(0, at + 36);
    out.writeUInt32LE(0, at + 38);
    out.writeUInt32LE(e.offset >>> 0, at + 42);
    e.name.copy(out, at + 46);
    at += 46 + e.name.length;
  }
  out.writeUInt32LE(0x06054b50, at);
  out.writeUInt16LE(0, at + 4);
  out.writeUInt16LE(0, at + 6);
  out.writeUInt16LE(files.length, at + 8);
  out.writeUInt16LE(files.length, at + 10);
  out.writeUInt32LE(centralBytes >>> 0, at + 12);
  out.writeUInt32LE(localBytes >>> 0, at + 16);
  out.writeUInt16LE(0, at + 20);
  return out;
}

/**
 * Store method stays the default. A zip that would miss the download limit
 * is rewritten with raw deflate (method 8) on the JSON. The JPEG is left
 * stored: it does not shrink, and deflating it can make the zip larger.
 */
function zipUnderLimit(files, maxBytes) {
  const stored = zipStore(files);
  if (!(maxBytes > 0) || stored.length <= maxBytes) return stored;
  const mixed = files.map((f) => {
    const name = String(f.name || "");
    return { name, data: f.data, deflate: /\.json$/i.test(name) };
  });
  const deflated = zipStore(mixed, { deflate: "auto" });
  return deflated.length < stored.length ? deflated : stored;
}

/** Read store-method and raw-deflate zips written by zipStore. */
function unzipStore(buf) {
  const files = {};
  let i = 0;
  while (i + 30 <= buf.length) {
    const sig = buf.readUInt32LE(i);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString("utf8");
    const start = i + 30 + nameLen + extraLen;
    const raw = buf.slice(start, start + compSize);
    files[name] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    i = start + compSize;
  }
  return files;
}

module.exports = { zipStore, unzipStore, zipUnderLimit };
