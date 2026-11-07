"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../public/box-resize");
const area = require("../public/bbox-area");
const rotateExport = require("../netlify/lib/rotate-export");

const BOX = { west: -115.164, south: 36.126, east: -115.156, north: 36.13 };

function rectAt(deg) {
  return R.rectFromBBox(BOX, deg);
}

function close(a, b, eps) {
  assert.ok(Math.abs(a - b) <= eps, a + " vs " + b + " (eps " + eps + ")");
}

function assertAnchor(start, corner, next) {
  const opp = (corner + 2) % 4;
  const before = R.cornerLatLng(start, opp);
  const after = R.cornerLatLng(next, opp);
  close(after.lat, before.lat, 1e-9);
  close(after.lng, before.lng, 1e-9);
  assert.equal(next.deg, start.deg);
  assert.ok(next.widthM >= R.MIN_SIDE_M - 1e-9);
  assert.ok(next.lengthM >= R.MIN_SIDE_M - 1e-9);
}

function outward(start, corner, scale) {
  const tip = R.cornerLatLng(start, corner);
  const anchor = R.cornerLatLng(start, (corner + 2) % 4);
  const lat = anchor.lat + (tip.lat - anchor.lat) * scale;
  const lng = anchor.lng + (tip.lng - anchor.lng) * scale;
  return { lat: lat, lng: lng };
}

describe("rectangle corner resize", () => {
  it("keeps the opposite corner and the bearing for every corner, north-up", () => {
    const start = rectAt(0);
    for (let corner = 0; corner < 4; corner++) {
      const to = outward(start, corner, 1.4);
      const next = R.resizeFromCorner(start, corner, to.lat, to.lng);
      assertAnchor(start, corner, next);
      assert.ok(next.widthM > start.widthM + 1);
      assert.ok(next.lengthM > start.lengthM + 1);
      const box = R.bboxFromRect(next);
      const fixed = R.cornerLatLng(start, (corner + 2) % 4);
      if (corner === 2) {
        close(box.west, fixed.lng, 1e-9);
        close(box.south, fixed.lat, 1e-9);
        assert.ok(box.east > BOX.east && box.north > BOX.north);
      } else if (corner === 0) {
        close(box.east, fixed.lng, 1e-9);
        close(box.north, fixed.lat, 1e-9);
        assert.ok(box.west < BOX.west && box.south < BOX.south);
      } else if (corner === 1) {
        close(box.west, fixed.lng, 1e-9);
        close(box.north, fixed.lat, 1e-9);
      } else {
        close(box.east, fixed.lng, 1e-9);
        close(box.south, fixed.lat, 1e-9);
      }
    }
  });

  it("resizes a turned box without changing the bearing or the anchored corner", () => {
    for (const deg of [33, -20, 90]) {
      const start = rectAt(deg);
      const corner = 2;
      const to = outward(start, corner, 1.35);
      const next = R.resizeFromCorner(start, corner, to.lat, to.lng);
      assertAnchor(start, corner, next);
      assert.equal(next.deg, deg);
      const sw0 = R.cornerLatLng(start, 0);
      const se0 = R.cornerLatLng(start, 1);
      const sw1 = R.cornerLatLng(next, 0);
      const se1 = R.cornerLatLng(next, 1);
      const bear = (p, q) => (Math.atan2(q.lng - p.lng, q.lat - p.lat) * 180) / Math.PI;
      let delta = bear(sw1, se1) - bear(sw0, se0);
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      close(delta, 0, 0.05);
    }
  });

  it("resizes again from the new rectangle and still anchors the opposite corner", () => {
    let rect = rectAt(33);
    const first = outward(rect, 2, 1.5);
    rect = R.resizeFromCorner(rect, 2, first.lat, first.lng);
    const ne = R.cornerLatLng(rect, 2);
    const second = outward(rect, 0, 1.25);
    const again = R.resizeFromCorner(rect, 0, second.lat, second.lng);
    assertAnchor(rect, 0, again);
    const ne2 = R.cornerLatLng(again, 2);
    close(ne2.lat, ne.lat, 1e-9);
    close(ne2.lng, ne.lng, 1e-9);
    assert.equal(again.deg, 33);
    assert.ok(again.widthM > rect.widthM);
    assert.ok(again.lengthM > rect.lengthM);
  });

  it("a later draw uses the new box, not the resized one", () => {
    const start = rectAt(0);
    const grown = R.resizeFromCorner(start, 1, outward(start, 1, 1.8).lat, outward(start, 1, 1.8).lng);
    const freshBox = { west: -115.17, south: 36.12, east: -115.168, north: 36.122 };
    const fresh = R.rectFromBBox(freshBox, 0);
    const session = R.begin(fresh, 3);
    const moved = R.update(session, outward(fresh, 3, 1.2).lat, outward(fresh, 3, 1.2).lng);
    assertAnchor(fresh, 3, moved);
    assert.ok(Math.abs(moved.widthM - grown.widthM) > 10);
    assert.equal(session.start.deg, 0);
    assert.equal(R.begin(grown, 2).start.widthM, grown.widthM);
  });

  it("stops at the minimum instead of inverting when a corner crosses the anchor", () => {
    const start = rectAt(15);
    const anchor = R.cornerLatLng(start, 0);
    const crossed = R.resizeFromCorner(start, 2, anchor.lat - 0.002, anchor.lng - 0.002);
    close(crossed.widthM, R.MIN_SIDE_M, 1e-6);
    close(crossed.lengthM, R.MIN_SIDE_M, 1e-6);
    assertAnchor(start, 2, crossed);
    const ne = R.cornerLatLng(crossed, 2);
    const sw = R.cornerLatLng(crossed, 0);
    assert.ok(ne.lat > sw.lat);
    assert.equal(crossed.deg, 15);
    const custom = R.resizeFromCorner(start, 2, anchor.lat, anchor.lng, 25);
    close(custom.widthM, 25, 1e-6);
    close(custom.lengthM, 25, 1e-6);
  });

  it("a press that does not move, and a cancel, leave the starting rectangle", () => {
    const start = rectAt(-20);
    const session = R.begin(start, 3);
    const tip = R.cornerLatLng(start, 3);
    const held = R.update(session, tip.lat, tip.lng);
    assert.equal(session.moved, false);
    close(held.widthM, start.widthM, 0.05);
    close(held.lengthM, start.lengthM, 0.05);
    const far = outward(start, 3, 1.6);
    R.update(session, far.lat, far.lng);
    assert.equal(session.moved, true);
    const direct = R.resizeFromCorner(start, 3, far.lat, far.lng);
    close(session.current.lat0, direct.lat0, 1e-12);
    close(session.current.widthM, direct.widthM, 1e-6);
    const back = R.cancel(session);
    assert.equal(session.moved, false);
    assert.equal(back.widthM, start.widthM);
    assert.equal(back.lengthM, start.lengthM);
    assert.equal(back.deg, start.deg);
    close(back.lat0, start.lat0, 0);
    close(back.lon0, start.lon0, 0);
    assert.equal(R.resizeFromCorner(start, 2, NaN, 0), null);
    assert.equal(R.begin(start, 4), null);
    assert.equal(R.update(null, 0, 0), null);
  });

  it("writes the export frame, the chip area, and the turned-box size from the resized rectangle", () => {
    const start = rectAt(33);
    const to = outward(start, 2, 1.45);
    const next = R.resizeFromCorner(start, 2, to.lat, to.lng);
    const box = R.bboxFromRect(next);
    const sides = area.bboxSidesM(box);
    close(sides.widthM, next.widthM, 1e-6);
    close(sides.lengthM, next.lengthM, 1e-6);
    const readout = area.bboxReadout(box);
    const before = area.bboxReadout(R.bboxFromRect(start));
    assert.ok(readout && readout.text);
    assert.notEqual(readout.text, before.text);
    const exported = rotateExport.rotatedRect(box, next.deg);
    assert.equal(exported.deg, 33);
    close(exported.widthM, next.widthM, 1e-6);
    close(exported.lengthM, next.lengthM, 1e-6);
    close(exported.lon0, next.lon0, 1e-12);
    close(exported.lat0, next.lat0, 1e-12);
  });
});

describe("corner handles on the map page", () => {
  const root = path.join(__dirname, "../public");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

  it("loads the resize math and draws a handle on each corner of a finished box", () => {
    assert.match(html, /src="\/box-resize\.js"/);
    assert.ok(html.indexOf('src="/box-resize.js"') < html.indexOf('src="/app.js"'));
    assert.match(html, /\.corner-handle \{/);
    const commit = app.slice(app.indexOf("function commitBox"), app.indexOf("function commitPolygon"));
    assert.match(commit, /drawn\.clearLayers\(\)/);
    assert.match(commit, /L\.rectangle/);
    assert.match(commit, /attachCornerHandles\(bounds\)/);
    const poly = app.slice(app.indexOf("function commitPolygon"), app.indexOf("function showDragPreview"));
    assert.equal(/attachCornerHandles/.test(poly), false);
    assert.match(app, /function applyUrlBox/);
    const urlBox = app.slice(app.indexOf("function applyUrlBox"), app.indexOf("function applyUrlBox") + 700);
    assert.match(urlBox, /attachCornerHandles\(bounds\)/);
  });

  it("a resize commit updates the export box and drops a stale export, and cancel puts the box back", () => {
    const paint = app.slice(app.indexOf("function paintResizedRect"), app.indexOf("function attachCornerHandles"));
    assert.match(paint, /bbox = OpenClutterBoxResize\.bboxFromRect\(rect\)/);
    assert.match(paint, /showAreaChip/);
    assert.match(paint, /syncExportReady/);
    assert.match(paint, /if \(commit\) \{\n    noteAreaReplaced\(\)/);
    assert.equal(/boxRotate = 0/.test(paint), false);
    const finish = app.slice(app.indexOf("function finishCornerResize"), app.indexOf("function cornerIndexFromEvent"));
    assert.match(finish, /OpenClutterBoxResize\.cancel/);
    assert.match(finish, /noteDrawCancelled/);
    assert.match(finish, /paintResizedRect\(rect, changed\)/);
    const move = app.slice(app.indexOf("function moveCornerResize"), app.indexOf("function finishCornerResize"));
    assert.match(move, /OpenClutterBoxResize\.update\(resizeDrag\.session/);
    assert.match(app, /function placeCornerHandles/);
    const rotateDrag = app.slice(app.indexOf('rotateHandle.on("drag"'), app.indexOf('rotateHandle.on("dragend"'));
    assert.match(rotateDrag, /committedBounds/);
    assert.match(rotateDrag, /placeCornerHandles\(live\)/);
  });

  it("does not take redraw, Space pan, or a pan gesture away from the map", () => {
    const down = app.slice(app.indexOf("function cornerIndexFromEvent"), app.indexOf('mapEl.addEventListener(\n  "pointerdown"'));
    assert.match(down, /panGesture\(ev\)\) return/);
    assert.match(down, /exportLocked\(\)\) return/);
    assert.match(down, /closest\("\.corner-handle"\)/);
    const hoverAt = app.indexOf('"pointermove"');
    const hoverBody = app.slice(hoverAt, app.indexOf("let blockMapDblClick"));
    assert.match(hoverBody, /resizePointer != null && ev\.pointerId === resizePointer/);
    assert.match(hoverBody, /spacePan && panPointer == null && activePointer == null && resizePointer == null && hoverPanPointer\(ev\)/);
    assert.match(hoverBody, /moveHoverPan\(ev\)/);
    assert.match(app, /ev\.key === "Escape" && resizeDrag/);
    assert.match(app, /finishCornerResize\(false\)/);
  });
});
