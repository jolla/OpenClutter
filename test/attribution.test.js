"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const imagery = require("../netlify/lib/imagery-source");
const { attributionTxt } = require("../netlify/lib/pipeline");

describe("export credit", () => {
  it("reads World Imagery capture dates at the export level only", () => {
    const body = {
      features: [
        { attributes: { SRC_DATE2: Date.UTC(2025, 8, 12), NICE_NAME: "Vivid Premium", NICE_DESC: "Vantor", MinMapLevel: 12, MaxMapLevel: 19 } },
        { attributes: { SRC_DATE2: Date.UTC(2014, 0, 1), NICE_NAME: "TerraColor", NICE_DESC: "Earthstar", MinMapLevel: 0, MaxMapLevel: 11 } },
      ],
    };
    const got = imagery.parseEsriCitation(body, 17);
    assert.deepEqual(got.dates, ["2025-09-12"]);
    assert.deepEqual(got.providers, ["Vantor Vivid Premium"]);
  });

  it("puts the Esri vendor and capture date in the info, Details line, and ATTRIBUTION.txt", () => {
    const ctx = imagery.createImageryContext("esri", null);
    ctx.esriCitation = { dates: ["2024-05-01", "2025-09-12"], providers: ["Vantor Vivid Premium"] };
    ctx.esriPlates = 1;
    const info = imagery.imageryInfo(ctx);
    assert.equal(info.id, "esri");
    assert.equal(info.captureDate, "2024-05-01 to 2025-09-12");
    assert.match(imagery.imageryLine(info), /Esri World Imagery \(Vantor Vivid Premium\), captured 2024-05-01 to 2025-09-12/);
    const txt = attributionTxt({ imagery: info, openclutterVersion: "9.9.9" });
    assert.match(txt, /MAP IMAGE \(images\/\)\nEsri World Imagery \(Vantor Vivid Premium\)/);
    assert.match(txt, /Powered by Esri/);
    assert.match(txt, /Captured: 2024-05-01 to 2025-09-12/);
    assert.match(txt, /Credit: Esri, Vantor, Earthstar Geographics, and the GIS User Community/);
  });

  it("credits a national or NAIP plate with its own license and date", () => {
    const txt = attributionTxt({
      imagery: {
        id: "naip",
        name: "USDA NAIP",
        attribution: imagery.NAIP.attribution,
        license: "Public domain",
        captureDate: "2023-06-14",
        requested: "auto",
      },
      demKind: "bare-earth",
    });
    assert.match(txt, /MAP IMAGE \(images\/\)\nUSDA NAIP/);
    assert.match(txt, /Captured: 2023-06-14/);
    assert.match(txt, /License: Public domain/);
    assert.match(txt, /USGS 3DEP/);
    assert.ok(!/Powered by Esri|Esri World Imagery/.test(txt));
  });

  it("carries the ODbL notice and every open-data credit", () => {
    const txt = attributionTxt({});
    assert.match(txt, /MIT license covers its code only/);
    assert.match(txt, /Open Database License \(ODbL\) 1\.0/);
    assert.match(txt, /The vector data in this file .* is made available under the ODbL/);
    assert.match(txt, /\(c\) OpenStreetMap contributors/);
    assert.match(txt, /Microsoft Global ML Building Footprints, ODbL/);
    assert.match(txt, /Overture Maps Foundation, buildings theme \(ODbL\)/);
    assert.match(txt, /CHMv2.*\(c\) 2016 Vantor\. CC BY 4\.0/);
    assert.match(txt, /DINOv3 License/);
    assert.match(txt, /\(c\) ESA WorldCover project 2021 \/ Contains modified Copernicus Sentinel data \(2021\) processed by ESA WorldCover consortium/);
    assert.match(txt, /Courtesy of the U\.S\. Geological Survey/);
    assert.match(txt, /Powered by Esri/);
  });

  it("does not wait on or fail an export when the citation layer misses", async () => {
    const ctx = imagery.createImageryContext("esri", null);
    const failing = async () => {
      throw new Error("offline");
    };
    const got = await imagery.readEsriCitation(ctx, { west: 0, south: 0, east: 0.01, north: 0.01 }, { fetch: failing });
    assert.equal(got, null);
    assert.equal(imagery.imageryInfo(ctx).captureDate, "");
  });

  it("maps the export pixel size to a Web Mercator level", () => {
    assert.equal(imagery.esriLevelFor({ south: 36.1, north: 36.2 }, 1), 17);
    assert.equal(imagery.esriLevelFor({ south: 0, north: 0 }, 0.3), 19);
  });
});
