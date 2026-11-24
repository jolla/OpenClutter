"use strict";

// OPE-14: heavy source reads in a child process on a small host only.
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const sp = require("../netlify/lib/source-proc");

describe("source child process (OPE-14)", () => {
  before(() => {
    process.env.OPENCLUTTER_SOURCE_TEST = "1";
    sp.setKillGraceForTests(300);
  });
  after(() => {
    delete process.env.OPENCLUTTER_SOURCE_TEST;
    sp.setKillGraceForTests(0);
  });
  afterEach(() => {
    delete process.env.OPENCLUTTER_LOW_MEMORY;
    delete process.env.OPENCLUTTER_SOURCE_PROCESS;
  });

  it("a roomy host, a foreground request, and the off switch read in process", async () => {
    process.env.OPENCLUTTER_LOW_MEMORY = "0";
    assert.equal(sp.enabled(true), false);
    assert.equal(await sp.heavyRead("echo", [1], () => "inproc", true), "inproc");
    process.env.OPENCLUTTER_LOW_MEMORY = "1";
    assert.equal(sp.enabled(false), false);
    assert.equal(await sp.heavyRead("echo", [1], () => "inproc", false), "inproc");
    process.env.OPENCLUTTER_SOURCE_PROCESS = "0";
    assert.equal(sp.enabled(true), false);
  });

  it("a small host gets the child's value, typed arrays and shared objects intact", async () => {
    process.env.OPENCLUTTER_LOW_MEMORY = "1";
    sp.resetForTests();
    const frame = { west: 1, south: 2 };
    const v = { grid: { values: new Float32Array([1.5, 2.5]), counts: new Uint16Array([3]) }, a: frame, b: frame, n: null, s: "x" };
    const got = await sp.heavyRead("echo", [v], () => assert.fail("ran in process"), true);
    assert.deepEqual(got, v);
    assert.ok(got.grid.values instanceof Float32Array);
    assert.equal(got.a, got.b, "shared reference survives");
    const st = sp.stats();
    assert.equal(st.runs, 1);
    assert.ok(st.childMaxRssMb > 0);
  });

  it("a crash, a thrown error, and a missed deadline reject cleanly", async () => {
    await assert.rejects(sp.runInChild("crash", []), /crash read stopped \(exit 3\)/);
    await assert.rejects(sp.runInChild("fail", []), (e) => e.name === "RangeError" && /no rows/.test(e.message));
    const t = Date.now();
    await assert.rejects(sp.runInChild("stuck", [], { deadlineMs: 200 }), (e) => e.name === "AbortError");
    assert.ok(Date.now() - t < 3000);
  });

  it("an abort asks the child to stop and keeps what it sends", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 150);
    assert.deepEqual(await sp.runInChild("hang", [], { signal: ctrl.signal }), { partial: true });
  });
});
