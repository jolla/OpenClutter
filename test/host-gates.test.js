const test = require("node:test");
const assert = require("node:assert");
const { isQualityHost, isDevTestHost, isDevDemHost } = require("../netlify/lib/terrain");

const ev = (host, path = "/.netlify/functions/clutter") => ({ headers: { host }, path });

test("production hosts get the quality gate but not the testing overrides", () => {
  for (const h of ["openclutter.com", "www.openclutter.com", "openclutter.netlify.app", "main--openclutter.netlify.app", "OpenClutter.com:443"]) {
    assert.strictEqual(isQualityHost(ev(h)), true, h);
    assert.strictEqual(isDevTestHost(ev(h)), false, h);
  }
});

test("dev and deploy previews get both gates", () => {
  for (const h of ["dev.openclutter.com", "dev--openclutter.netlify.app", "deploy-preview-12--openclutter.netlify.app"]) {
    assert.strictEqual(isQualityHost(ev(h)), true, h);
    assert.strictEqual(isDevTestHost(ev(h)), true, h);
    assert.strictEqual(isDevDemHost(ev(h)), true, h);
  }
  assert.strictEqual(isDevTestHost(ev("openclutter.com", "/dev/x")), true);
});

test("classic v1 and unknown hosts get neither", () => {
  for (const h of ["v1--openclutter.netlify.app", "evil.example.com", "openclutter.com.evil.net", ""]) {
    assert.strictEqual(isQualityHost(ev(h)), false, h);
    assert.strictEqual(isDevTestHost(ev(h)), false, h);
  }
  assert.strictEqual(isQualityHost({ host: "openclutter.com" }), true);
});

test("clutter.js keeps overrides on the testing gate", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../netlify/functions/clutter.js"), "utf8");
  assert.match(src, /areaCapOverride = testHost \?/);
  assert.match(src, /jsonBudgetOverride = testHost \?/);
  assert.match(src, /terrainFloors = testHost \?/);
  assert.match(src, /terrainFloors: isDevTestHost\(event\)/);
  assert.doesNotMatch(src, /isDevDemHost/);
});
