"use strict";

/**
 * Time a USGS 3DEP lidar sample for the phase-1 sites.
 * Usage: node scripts/measure-usgs-lidar.js
 * Writes /tmp/lidar-measure.json. Does not change an export.
 */

const fs = require("node:fs");
const { fetchUsgsLidar, applyLidarSample, lidarNote, km2Of } = require("../netlify/lib/usgs-lidar");

const sites = [
  {
    id: "wynn",
    frame: { west: -115.16942, south: 36.120084, east: -115.153863, north: 36.131185 },
    probes: [
      { name: "solar", lon: -115.16808, lat: 36.12581 },
      { name: "podium", lon: -115.1683, lat: 36.12571 },
      { name: "tower", lon: -115.1648, lat: 36.1272 },
      { name: "sphere", lon: -115.1615, lat: 36.1205 },
    ],
  },
  {
    id: "wynn-red",
    frame: { west: -115.16895, south: 36.12505, east: -115.1664, north: 36.12775 },
    probes: [
      { name: "solar", lon: -115.16808, lat: 36.12581 },
      { name: "podium", lon: -115.1683, lat: 36.12571 },
      { name: "wedge", lon: -115.1683, lat: 36.1268 },
    ],
  },
  {
    id: "montreal",
    frame: { west: -73.57, south: 45.5, east: -73.565, north: 45.5035 },
    probes: [],
  },
  {
    id: "granite",
    frame: { west: -89.7, south: 44.91, east: -89.684, north: 44.926 },
    probes: [{ name: "lodge", lon: -89.692, lat: 44.918 }],
  },
];

function cellAt(grid, lon, lat) {
  const { mercator } = require("../netlify/lib/usgs-lidar");
  const xy = mercator(lon, lat);
  const ix = Math.floor((xy[0] - grid.originX) / grid.cell);
  const iy = Math.floor((xy[1] - grid.originY) / grid.cell);
  return grid.cells.get(ix + "," + iy) || null;
}

async function main() {
  const out = [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const t0 = Date.now();
    const sample = await fetchUsgsLidar(site.frame, { maxMs: 70000 });
    const row = {
      id: site.id,
      km2: +km2Of(site.frame).toFixed(3),
      skipped: sample.skipped || "",
      warning: sample.warning || "",
      project: sample.project || "",
      collected: sample.collected || "",
      points: sample.points || 0,
      bytes: sample.bytes || 0,
      tiles: sample.tiles || 0,
      ms: sample.ms || Date.now() - t0,
      spacingM: sample.spacingM || 0,
      fullSpacingM: sample.fullSpacingM || 0,
      fullPoints: sample.fullPoints || 0,
      fullBytes: sample.fullBytes || 0,
      capped: !!sample.capped,
      partial: !!sample.partial,
      counts: sample.counts || {},
      tried: sample.tried || [],
    };
    if (sample.km2 > 0 && sample.points) {
      row.pointsPerKm2 = Math.round(sample.points / sample.km2);
      row.mbPerKm2 = +((sample.bytes / sample.km2) / (1024 * 1024)).toFixed(2);
    }
    if (sample.grid) {
      const probes = [];
      for (let p = 0; p < site.probes.length; p++) {
        const probe = site.probes[p];
        const feature = {
          type: "Feature",
          properties: { height: 0, heightSource: "none" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [probe.lon - 0.00015, probe.lat - 0.00012],
                [probe.lon + 0.00015, probe.lat - 0.00012],
                [probe.lon + 0.00015, probe.lat + 0.00012],
                [probe.lon - 0.00015, probe.lat + 0.00012],
                [probe.lon - 0.00015, probe.lat - 0.00012],
              ],
            ],
          },
        };
        const applied = applyLidarSample([feature], [], sample.grid);
        const rec = cellAt(sample.grid, probe.lon, probe.lat);
        probes.push({
          name: probe.name,
          height: applied.features[0].properties.height,
          source: applied.features[0].properties.heightSource,
          addedNearby: applied.added,
          class6: rec ? rec.bc : 0,
          ground: rec && rec.g != null ? +rec.g.toFixed(2) : null,
          roofSamples: rec ? rec.uc : 0,
          veg: rec ? rec.vc : 0,
        });
      }
      const bare = applyLidarSample([], [], sample.grid);
      row.addedFootprints = bare.added;
      row.probes = probes;
      if (site.id === "wynn-red") {
        const R = 20037508.342789244;
        const cells = [];
        for (const rec of sample.grid.cells.values()) {
          if (!(rec.bc > 0 || (rec.uc >= 3 && rec.vc * 2 <= rec.uc))) continue;
          const x = sample.grid.originX + (rec.ix + 0.5) * sample.grid.cell;
          const y = sample.grid.originY + (rec.iy + 0.5) * sample.grid.cell;
          const lon = (x * 180) / R;
          const lat = (Math.atan(Math.sinh((y * Math.PI) / R)) * 180) / Math.PI;
          const z = rec.bc ? rec.b[rec.b.length - 1] : rec.u[rec.u.length - 1];
          cells.push([+lon.toFixed(6), +lat.toFixed(6), rec.bc, rec.uc, rec.g == null ? null : +rec.g.toFixed(1), z == null ? null : +z.toFixed(1)]);
        }
        row.buildingCells = cells;
      }
      row.note = lidarNote(Object.assign({}, sample, { heights: 0, added: bare.added }));
    } else {
      row.note = sample.warning || "";
    }
    out.push(row);
    console.log(row.id, row.note || row.warning);
  }
  fs.writeFileSync("/tmp/lidar-measure.json", JSON.stringify(out, null, 2));
  console.log("wrote /tmp/lidar-measure.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
