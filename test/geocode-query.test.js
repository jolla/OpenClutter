"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { geocodeQueries } = require("../netlify/lib/geocode-query");

describe("geocode queries", () => {
  it("splits the bilingual Pointe-Claire street and drops the postal code", () => {
    const queries = geocodeQueries(
      "298 Chem. du Bord-du-Lac-Lakeshore, Pointe-Claire, QC H9S 4L3"
    );
    assert.ok(queries.includes("298 Chem. du Bord-du-Lac-Lakeshore, Pointe-Claire, QC H9S 4L3"));
    assert.ok(queries.includes("298 Lakeshore Road, Pointe-Claire, QC"));
    assert.ok(queries.includes("298 Chemin du Bord-du-Lac, Pointe-Claire, QC"));
    assert.equal(queries.some((q) => /H9S/i.test(q) && q !== queries[0]), false);
  });

  it("leaves a single-language address as one query", () => {
    assert.deepEqual(geocodeQueries("298 Lakeshore Road, Pointe-Claire"), [
      "298 Lakeshore Road, Pointe-Claire",
    ]);
  });
});
