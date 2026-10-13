"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { looksLikeVenueName, addressFromVenueText } = require("../netlify/lib/venue-address");

const SNIPPET =
  "<a class='result-link'>Casa Evexía, 298 Lakeshore, Pointe-Claire, QC (2026) - Glartent</a>" +
  "<p>Other listing, 100 Main Street, Montreal, QC</p>";

describe("venue address", () => {
  it("reads the street printed next to Casa Evexia", () => {
    assert.equal(
      addressFromVenueText("Casa Evexia", SNIPPET),
      "298 Lakeshore, Pointe-Claire, QC"
    );
    assert.equal(
      addressFromVenueText("Casa Evexía", SNIPPET),
      "298 Lakeshore, Pointe-Claire, QC"
    );
  });

  it("ignores a street that is not next to the typed name", () => {
    assert.equal(addressFromVenueText("Something Else", SNIPPET), null);
  });

  it("treats a venue name as a name and a street paste as an address", () => {
    assert.equal(looksLikeVenueName("Casa Evexia"), true);
    assert.equal(looksLikeVenueName("Casa Evexia, Pointe-Claire"), true);
    assert.equal(
      looksLikeVenueName("298 Chem. du Bord-du-Lac-Lakeshore, Pointe-Claire, QC H9S 4L3"),
      false
    );
    assert.equal(looksLikeVenueName("298 Lakeshore Road, Pointe-Claire"), false);
  });

  it("asks for the street when a name still misses", () => {
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    assert.match(app, /No results\. Try the street address\./);
  });
});
