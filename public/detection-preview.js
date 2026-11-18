/* Detection preview (1.3.41, dev only, behind ?preview=1).
 * After an export, draw what the zip holds (buildings, trees, vehicles,
 * walls, water) on the map, so the result can be checked before the Hamina
 * import. Read from the finished zip in the browser; no extra server work.
 */
(function (root) {
  "use strict";

  function previewWanted(search, dev) {
    if (!dev) return false;
    try {
      const raw = new URLSearchParams(search || "").get("preview");
      return raw === "1" || raw === "true";
    } catch (err) {
      return false;
    }
  }

  function u16(b, o) {
    return b[o] | (b[o + 1] << 8);
  }
  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  /** Entries from the zip central directory: { name, method, offset, csize }. */
  function zipEntries(bytes) {
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (u32(bytes, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("not a zip");
    const count = u16(bytes, eocd + 10);
    let p = u32(bytes, eocd + 16);
    const out = [];
    for (let k = 0; k < count && u32(bytes, p) === 0x02014b50; k++) {
      const method = u16(bytes, p + 10);
      const csize = u32(bytes, p + 20);
      const nameLen = u16(bytes, p + 28);
      const extraLen = u16(bytes, p + 30);
      const commentLen = u16(bytes, p + 32);
      const offset = u32(bytes, p + 42);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      out.push({ name, method, offset, csize });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  async function entryText(bytes, e) {
    const lh = e.offset;
    const start = lh + 30 + u16(bytes, lh + 26) + u16(bytes, lh + 28);
    const data = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return new TextDecoder().decode(data);
    if (e.method !== 8 || typeof DecompressionStream !== "function") throw new Error("zip method " + e.method);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return await new Response(stream).text();
  }

  /** The OpenIntent document in the zip (the JSON with floorplans). */
  async function openIntentFromZip(buf) {
    const bytes = new Uint8Array(buf);
    const list = zipEntries(bytes).filter((e) => /\.json$/i.test(e.name) && !/terrain/i.test(e.name));
    list.sort((a, b) => b.csize - a.csize);
    for (const e of list) {
      const doc = JSON.parse(await entryText(bytes, e));
      if (doc && Array.isArray(doc.floorplans) && doc.floorplans.length) return doc;
    }
    throw new Error("no OpenIntent document in the zip");
  }

  const KINDS = [
    { id: "building", label: "Buildings", color: "#E4572E", test: /^Building/i },
    { id: "rv", label: "RVs and vehicles", color: "#1E88E5", test: /^(RV|Trailer|Semi|Boat|Car|Mobile home|Storage)/i },
    { id: "tree", label: "Trees", color: "#2E7D32", test: /^Foliage/i },
    { id: "wall", label: "Walls and fences", color: "#8E24AA", test: /(Wall|Fence|Hedge)/i },
    { id: "water", label: "Water", color: "#00ACC1", test: /^Water/i },
    { id: "other", label: "Other", color: "#757575", test: /./ },
  ];

  function kindFor(name) {
    for (const k of KINDS) if (k.test.test(String(name || ""))) return k;
    return KINDS[KINDS.length - 1];
  }

  /**
   * corners: [SW, SE, NE, NW] latlngs of the exported box (turned or not).
   * OpenIntent pixels are Y-up from the southwest corner.
   */
  function shapesFromOpenIntent(doc, corners) {
    const fp = doc.floorplans[0];
    const dim = (fp.dimensions || []).find((d) => d && d.unit === "pixels") || fp.dimensions[0];
    const W = +dim.width;
    const H = +dim.length;
    const [sw, se, , nw] = corners;
    const toLL = (x, y) => {
      const u = x / W;
      const v = y / H;
      return [sw[0] + u * (se[0] - sw[0]) + v * (nw[0] - sw[0]), sw[1] + u * (se[1] - sw[1]) + v * (nw[1] - sw[1])];
    };
    const shapes = [];
    const counts = {};
    for (const a of fp.attenuation_areas || []) {
      const coords = a && a.area && a.area.coordinates;
      if (!coords || coords.length < 3) continue;
      const k = kindFor(a.area_material && a.area_material.name);
      if (k.id === "tree" && /Trunk|Understory/i.test(a.area_material.name)) continue;
      const ring = [];
      for (const c of coords) {
        const p = c && c.coordinate_xyz;
        if (p) ring.push(toLL(+p.x, +p.y));
      }
      if (ring.length < 3) continue;
      shapes.push({ kind: k.id, color: k.color, ring });
      counts[k.id] = (counts[k.id] || 0) + 1;
    }
    for (const w of fp.wall_segments || []) {
      if (!w || !w.start_point || !w.end_point) continue;
      shapes.push({ kind: "rvwall", color: KINDS[1].color, line: [toLL(w.start_point.x, w.start_point.y), toLL(w.end_point.x, w.end_point.y)] });
    }
    return { shapes, counts, W, H };
  }

  /** Leaflet layer for the shapes; canvas so thousands of crowns stay fast. */
  function previewLayer(L, shapes) {
    const renderer = L.canvas({ padding: 0.2 });
    const group = L.layerGroup();
    for (const s of shapes) {
      if (s.line) {
        L.polyline(s.line, { renderer, color: s.color, weight: 1.5, opacity: 0.9, interactive: false }).addTo(group);
      } else {
        L.polygon(s.ring, {
          renderer,
          color: s.color,
          weight: 1,
          opacity: 0.95,
          fillColor: s.color,
          fillOpacity: s.kind === "tree" ? 0.25 : 0.35,
          interactive: false,
        }).addTo(group);
      }
    }
    return group;
  }

  function legendHtml(counts) {
    const parts = [];
    for (const k of KINDS) {
      if (!counts[k.id]) continue;
      parts.push('<span class="dp-swatch" style="background:' + k.color + '"></span>' + k.label + " " + counts[k.id]);
    }
    return parts.join("<br>");
  }

  /** Map control: one checkbox to show or hide the detections, with counts. */
  function attach(L, map, layer, counts) {
    if (root.__ocPreview) {
      try {
        root.__ocPreview.control.remove();
        map.removeLayer(root.__ocPreview.layer);
      } catch (err) {}
    }
    const Ctl = L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const div = L.DomUtil.create("div", "leaflet-bar dp-control");
        div.innerHTML =
          '<label class="dp-toggle"><input type="checkbox" checked> Detections</label><div class="dp-legend">' +
          legendHtml(counts) +
          "</div>";
        L.DomEvent.disableClickPropagation(div);
        const box = div.querySelector("input");
        box.addEventListener("change", () => {
          if (box.checked) layer.addTo(map);
          else map.removeLayer(layer);
          div.querySelector(".dp-legend").hidden = !box.checked;
        });
        return div;
      },
    });
    const control = new Ctl();
    control.addTo(map);
    layer.addTo(map);
    root.__ocPreview = { control, layer };
    return root.__ocPreview;
  }

  async function showFromZip(L, map, blob, corners) {
    const doc = await openIntentFromZip(await blob.arrayBuffer());
    const got = shapesFromOpenIntent(doc, corners);
    const layer = previewLayer(L, got.shapes);
    attach(L, map, layer, got.counts);
    return got.counts;
  }

  const api = { previewWanted, zipEntries, openIntentFromZip, shapesFromOpenIntent, kindFor, showFromZip };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.OpenClutterPreview = api;
})(typeof window !== "undefined" ? window : globalThis);
