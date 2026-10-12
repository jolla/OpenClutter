#!/usr/bin/env node
"use strict";

/**
 * Vehicle and mobile-structure benchmark.
 *
 * Recall and precision are against the hand-checked labels for that site.
 * A prediction counts only when it lands on a checked pad. Pads that were
 * not reviewed are left out of the score. The label file says how those
 * pads were checked. A model output is not a label.
 *
 *   node scripts/vehicle-bench.js
 *   node scripts/vehicle-bench.js --aerial /tmp/rogers.jpg --preview /tmp/rogers-preview.png
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { parseOverpass, planOutdoor } = require("../netlify/lib/outdoor-clutter");
const { decodePlate, centroidLL, scoreVehicles } = require("../netlify/lib/vehicle-track");
const { buildClutter, OPENINTENT_JSON_BUDGET } = require("../netlify/lib/pipeline");

const ROOT = path.join(__dirname, "..");
const SITES = JSON.parse(fs.readFileSync(path.join(ROOT, "bench/vehicle-sites.json"), "utf8"));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

function pct(n) {
  if (n == null || !Number.isFinite(n)) return "";
  return (Math.round(n * 1000) / 10).toFixed(1) + "%";
}

function loadAerial(site) {
  const given = arg("--aerial");
  if (given && fs.existsSync(given)) return fs.readFileSync(given);
  const cached = path.join(os.tmpdir(), "vehicle-aerial-" + site.id + ".jpg");
  if (fs.existsSync(cached) && fs.statSync(cached).size > 1000) return fs.readFileSync(cached);
  const url =
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=" +
    [site.west, site.south, site.east, site.north].join(",") +
    "&bboxSR=4326&imageSR=4326&size=1600,1200&format=jpg&f=image";
  execFileSync("curl", ["-fsS", "--max-time", "40", "-A", "openclutter/vehicle-bench", "-o", cached, url], {
    stdio: "inherit",
  });
  return fs.readFileSync(cached);
}

function scoreSite(site, aerialBuf) {
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, site.fixture), "utf8"));
  const labelsDoc = JSON.parse(fs.readFileSync(path.join(ROOT, site.labels), "utf8"));
  const plate = decodePlate(aerialBuf);
  if (!plate) throw new Error(site.id + " aerial did not decode");
  const frame = geoFrame(site, { imgW: plate.width, imgH: plate.height, maxSpanM: 8000, minSpanM: 1 });
  const parsed = parseOverpass(fixture, { rvs: true });
  const planned = planOutdoor({
    features: parsed.features.filter((f) => f && (f.kind === "rv" || f.kind === "trailer-candidate" || f.kind === "trailer")),
    frame,
    vehiclePlate: plate,
  });
  const preds = [];
  for (let i = 0; i < planned.items.length; i++) {
    const item = planned.items[i];
    if (!item || (item.kind !== "rv" && item.kind !== "trailer")) continue;
    const ring = [];
    for (let k = 0; k < item.ringPx.length; k++) {
      const x = item.ringPx[k][0];
      const y = item.ringPx[k][1];
      ring.push([
        frame.west + (x / frame.imgW) * (frame.east - frame.west),
        frame.south + (y / frame.imgH) * (frame.north - frame.south),
      ]);
    }
    preds.push({ class: item.kind, ring, center: centroidLL(ring) });
  }
  const rows = scoreVehicles(labelsDoc.labels, preds, labelsDoc.matchM || 12);
  const exportFeatures = preds.map((p) => ({
    kind: p.class,
    coords: p.ring,
    heightM: p.class === "trailer" ? 3.2 : 3.5,
    explicitHeight: true,
  }));
  const built = buildClutter({
    frame,
    footprintsGeojson: { type: "FeatureCollection", features: [] },
    treePoints: [],
    name: site.name,
    imgBuf: aerialBuf,
    includeFoliage: false,
    includeRvs: true,
    outdoorFeatures: exportFeatures,
  });
  const jsonBytes = built.stats.openIntentJsonBytes;
  return {
    site,
    labelsDoc,
    rows,
    preds: preds.length,
    jsonBytes,
    zip: built.zip,
    merged: false,
  };
}

function writeBoard(results) {
  const lines = [];
  lines.push("# Vehicle scoreboard");
  lines.push("");
  lines.push(
    "Recall and precision use the hand-checked pads only. A pad that was not reviewed is not in the score. The label source is on each row. A detector output is not a label. A site passes a class at 85% recall and 85% precision. Dense car lots are one 1.5 m layer. Rogers has mapped pads, so each kept vehicle is its own box. JSON bytes are the OpenIntent document for those vehicle boxes on this plate, foliage off, against the 4.9 MB budget."
  );
  lines.push("");
  lines.push("| Site | Class | Recall | Precision | Labels | Predictions | Source | Merged | JSON | Pass |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |");
  const csv = ["site,class,recall,precision,labels,predictions,source,merged,json_bytes,json_budget,pass"];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const source = "manual image labels";
    if (!result.rows.length) {
      lines.push(
        "| " +
          [result.site.name, "", "", "", "0", String(result.preds), source, result.merged ? "yes" : "no", result.jsonBytes, "no"].join(" | ") +
          " |"
      );
      continue;
    }
    for (let r = 0; r < result.rows.length; r++) {
      const row = result.rows[r];
      const pass = row.recall >= 0.85 && row.precision >= 0.85 ? "yes" : "no";
      lines.push(
        "| " +
          [
            result.site.name,
            row.class,
            pct(row.recall),
            pct(row.precision),
            String(row.labels),
            String(row.predictions),
            source,
            result.merged ? "yes" : "no",
            result.jsonBytes + " / " + OPENINTENT_JSON_BUDGET,
            pass,
          ].join(" | ") +
          " |"
      );
      csv.push(
        [
          result.site.name,
          row.class,
          pct(row.recall),
          pct(row.precision),
          row.labels,
          row.predictions,
          source,
          result.merged ? "yes" : "no",
          result.jsonBytes,
          OPENINTENT_JSON_BUDGET,
          pass,
        ].join(",")
      );
    }
  }
  lines.push("");
  fs.writeFileSync(path.join(ROOT, "bench/vehicle-scoreboard.md"), lines.join("\n"));
  fs.writeFileSync(path.join(ROOT, "bench/vehicle-scoreboard.csv"), csv.join("\n") + "\n");
}

function main() {
  const aerialBuf = loadAerial(SITES[0]);
  const results = [];
  for (let i = 0; i < SITES.length; i++) {
    const result = scoreSite(SITES[i], aerialBuf);
    results.push(result);
    console.log(SITES[i].name, "preds", result.preds, "json", result.jsonBytes);
    for (let r = 0; r < result.rows.length; r++) {
      const row = result.rows[r];
      console.log(" ", row.class, "recall", pct(row.recall), "precision", pct(row.precision), "labels", row.labels, "preds", row.predictions, "matched", row.matched);
    }
    const preview = arg("--preview");
    if (preview && result.zip) {
      const zipPath = preview.replace(/\.png$/i, ".zip");
      fs.mkdirSync(path.dirname(preview), { recursive: true });
      fs.writeFileSync(zipPath, result.zip);
      execFileSync("node", [path.join(ROOT, "scripts/hamina-preview.js"), "--zip", zipPath, "--name", SITES[i].name, "--out", preview], {
        stdio: "inherit",
      });
    }
  }
  writeBoard(results);
  console.log("wrote bench/vehicle-scoreboard.md");
}

main();
