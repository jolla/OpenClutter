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
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function zipStore(files, opts) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const deflateAll = !!(opts && opts.deflate === true);
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const useDeflate = deflateAll || !!(opts && opts.deflate === "auto" && f.deflate);
    const payload = useDeflate ? zlib.deflateRawSync(data, { level: 6 }) : data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.concat([
      Buffer.from("PK\x03\x04"),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      payload,
    ]);
    const central = Buffer.concat([
      Buffer.from("PK\x01\x02"),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from("PK\x05\x06"),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, central, end]);
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
