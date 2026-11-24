"use strict";

// 1.3.101: the zip is written into one buffer, with the same bytes as the
// old concat writer kept here as the reference.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { zipStore, unzipStore, zipUnderLimit } = require("../netlify/lib/zip-store");

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
function oldZipStore(files, opts) {
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
    const local = Buffer.concat([Buffer.from("PK\x03\x04"), u16(20), u16(0), u16(method), u16(0), u16(0), u32(crc), u32(payload.length), u32(data.length), u16(name.length), u16(0), name, payload]);
    const central = Buffer.concat([Buffer.from("PK\x01\x02"), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(crc), u32(payload.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([Buffer.from("PK\x05\x06"), u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, central, end]);
}

function sample(seed) {
  const r = crypto.createHash("sha256").update(String(seed)).digest();
  const json = Buffer.from(JSON.stringify({ seed, a: Array.from({ length: 200 + r[0] * 20 }, (_, i) => ({ i, v: i * r[1] })) }));
  return [
    { name: "openIntent_Fort-Wilderness-é.json", data: json, deflate: true },
    { name: "images/Fort.jpg", data: crypto.randomBytes(1000 + r[2] * 50) },
    { name: "ATTRIBUTION.txt", data: "Esri World Imagery\n" + seed },
  ];
}

describe("zip writer (1.3.101)", () => {
  it("writes the same bytes as the concat writer, stored, deflated, and mixed", () => {
    for (let seed = 0; seed < 12; seed++) {
      const files = sample(seed);
      assert.ok(zipStore(files).equals(oldZipStore(files)));
      assert.ok(zipStore(files, { deflate: true }).equals(oldZipStore(files, { deflate: true })));
      assert.ok(zipStore(files, { deflate: "auto" }).equals(oldZipStore(files, { deflate: "auto" })));
    }
    assert.ok(zipStore([]).equals(oldZipStore([])));
  });

  it("round-trips through unzipStore and keeps the download limit rule", () => {
    const files = sample(99);
    const back = unzipStore(zipUnderLimit(files, 1));
    assert.ok(back[files[0].name].equals(files[0].data));
    assert.ok(back["images/Fort.jpg"].equals(files[1].data));
    assert.equal(back["ATTRIBUTION.txt"].toString(), files[2].data);
    assert.ok(zipUnderLimit(files, 0).equals(oldZipStore(files)));
  });
});
