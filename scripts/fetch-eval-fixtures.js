"use strict";

/**
 * Download cached eval fixtures (USDA NAIP plate + meta, Microsoft Global ML
 * and FEMA footprints, NLCD TCC). Esri imagery is never written to the repo:
 * its terms do not allow redistributing it, and the repo is public.
 * Run: node scripts/fetch-eval-fixtures.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { geoFrame, esriContentExtent, applyImageryMeta, jpegSize } = require("../netlify/lib/geo-frame");
const imagery = require("../netlify/lib/imagery-source");
const { canopySamplesUrl } = require("../netlify/lib/tree-source");
const { fetchMsGlobalFootprints, mergeFootprintFeatures } = require("../netlify/lib/ms-global");
const { fetchUsaStructures } = require("../netlify/lib/usa-structures");
const { version: APP_VERSION } = require("../netlify/lib/version");

const UA = `openclutter/${APP_VERSION}-eval (https://github.com/jolla/OpenClutter)`;
const ROOT = path.join(__dirname, "..", "test", "fixtures");
const SITES = JSON.parse(fs.readFileSync(path.join(ROOT, "sites.json"), "utf8")).sites;

async function fetchOk(url) {
  const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(url + " → HTTP " + r.status);
  return r;
}

async function main() {
  for (const site of SITES) {
    const dir = path.join(ROOT, site.id);
    fs.mkdirSync(dir, { recursive: true });
    const bbox = { west: site.west, south: site.south, east: site.east, north: site.north };
    const drawn = geoFrame(bbox);
    console.log(site.id, "drawn", Math.round(drawn.widthM) + "×" + Math.round(drawn.lengthM) + " m", drawn.imgW + "×" + drawn.imgH);

    const ext = esriContentExtent(drawn, drawn.imgW, drawn.imgH);
    const plate = Object.assign({}, ext, { imgW: drawn.imgW, imgH: drawn.imgH });
    const ctx = imagery.createImageryContext("naip", plate);
    await ctx.ready;
    if (ctx.failed) throw new Error(site.id + ": " + ctx.failReason);
    const jpeg = await ctx.render(plate, AbortSignal.timeout(60000));
    const meta = {
      href: "imagery.jpg",
      width: drawn.imgW,
      height: drawn.imgH,
      extent: { xmin: ext.west, ymin: ext.south, xmax: ext.east, ymax: ext.north, spatialReference: { wkid: 4326 } },
      source: "USDA NAIP " + ctx.dates.join(",") + " (public domain)",
    };
    const frame = applyImageryMeta(drawn, meta, jpegSize(jpeg));
    console.log("  snapped", Math.round(frame.widthM) + "×" + Math.round(frame.lengthM) + " m", frame.imgW + "×" + frame.imgH);
    const arcgis = { features: [] };
    const globalPack = await fetchMsGlobalFootprints(frame, (url) => fetchOk(url)).catch((e) => {
      console.warn("  global footprints skipped:", e.message || e);
      return { features: [] };
    });
    const usaPack = await fetchUsaStructures(frame, (url) => fetchOk(url)).catch((e) => {
      console.warn("  USA Structures skipped:", e.message || e);
      return { features: [] };
    });
    const withArcgis = mergeFootprintFeatures(globalPack.features || [], arcgis.features || []);
    const merged = mergeFootprintFeatures(withArcgis.features, usaPack.features || []);
    const fp = {
      type: "FeatureCollection",
      features: merged.features,
      globalFootprints: (globalPack.features || []).length,
      arcgisFootprints: (arcgis.features || []).length,
      usaFootprints: (usaPack.features || []).length,
      addedFromArcgis: withArcgis.added,
      addedFromUsa: merged.added,
    };
    const tccUrl = canopySamplesUrl(frame);
    const tccRes = await fetchOk(tccUrl);
    const tcc = await tccRes.json();

    fs.writeFileSync(
      path.join(dir, "bbox.json"),
      JSON.stringify(
        {
          id: site.id,
          name: site.name,
          west: site.west,
          south: site.south,
          east: site.east,
          north: site.north,
          note: "Drawn bbox. Eval snaps the frame to imagery-meta.json extent + imagery.jpg size (same as production).",
        },
        null,
        2
      ) + "\n"
    );
    fs.writeFileSync(path.join(dir, "imagery-meta.json"), JSON.stringify(meta, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "imagery.jpg"), jpeg);
    fs.writeFileSync(path.join(dir, "footprints.geojson"), JSON.stringify(fp) + "\n");
    fs.writeFileSync(path.join(dir, "tcc-samples.json"), JSON.stringify(tcc) + "\n");
    console.log(
      "  jpeg",
      jpeg.length,
      "bytes; footprints",
      (fp.features || []).length,
      "; tcc samples",
      (tcc.samples || []).length
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
