"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../public/box-resize");
const rotateExport = require("../netlify/lib/rotate-export");

const BOX = { west: -115.164, south: 36.126, east: -115.156, north: 36.13 };

function rectAt(deg) {
  return R.rectFromBBox(BOX, deg);
}

function close(a, b, eps) {
  assert.ok(Math.abs(a - b) <= eps, a + " vs " + b + " (eps " + eps + ")");
}

describe("move a finished rectangle", () => {
  it("keeps width, length, and bearing and moves only the centre", () => {
    for (const deg of [0, 33, -20]) {
      const start = rectAt(deg);
      const grabLat = start.lat0 + 0.0004;
      const grabLng = start.lon0 - 0.0003;
      const session = R.beginMove(start, grabLat, grabLng);
      const dLat = 0.004;
      const dLng = 0.005;
      const next = R.updateMove(session, grabLat + dLat, grabLng + dLng);
      assert.equal(session.moved, true);
      assert.equal(next.widthM, start.widthM);
      assert.equal(next.lengthM, start.lengthM);
      assert.equal(next.deg, deg);
      close(next.lat0, start.lat0 + dLat, 1e-12);
      close(next.lon0, start.lon0 + dLng, 1e-12);
      const again = R.updateMove(session, grabLat + 0.001, grabLng - 0.002);
      assert.equal(again.widthM, start.widthM);
      assert.equal(again.lengthM, start.lengthM);
      assert.equal(again.deg, deg);
      close(again.lat0, start.lat0 + 0.001, 1e-12);
      close(again.lon0, start.lon0 - 0.002, 1e-12);
    }
  });

  it("a centre shift under the resize threshold does not replace the area", () => {
    const start = rectAt(0);
    const session = R.beginMove(start, start.lat0, start.lon0);
    const held = R.updateMove(session, start.lat0 + 1e-9, start.lon0);
    assert.equal(session.moved, false);
    assert.equal(held.widthM, start.widthM);
    assert.equal(held.lengthM, start.lengthM);
    assert.equal(held.deg, start.deg);
    const released = R.settledRect(session, true);
    assert.equal(released.lat0, start.lat0);
    assert.equal(released.lon0, start.lon0);
    assert.equal(released.widthM, start.widthM);
    const real = R.updateMove(session, start.lat0 + 1e-5, start.lon0 + 2e-5);
    assert.equal(session.moved, true);
    assert.equal(real.widthM, start.widthM);
    assert.equal(real.lengthM, start.lengthM);
    assert.equal(real.deg, 0);
  });

  it("cancel and an unmoved release restore the starting rectangle", () => {
    const start = rectAt(-20);
    const session = R.beginMove(start, start.lat0 + 0.001, start.lon0);
    R.updateMove(session, start.lat0 + 0.008, start.lon0 + 0.006);
    assert.equal(session.moved, true);
    const back = R.cancel(session);
    assert.equal(session.moved, false);
    assert.equal(back.widthM, start.widthM);
    assert.equal(back.lengthM, start.lengthM);
    assert.equal(back.deg, start.deg);
    assert.equal(back.lat0, start.lat0);
    assert.equal(back.lon0, start.lon0);
    const still = R.beginMove(start, start.lat0, start.lon0);
    R.updateMove(still, start.lat0, start.lon0);
    const same = R.settledRect(still, true);
    assert.equal(same.lat0, start.lat0);
    assert.equal(same.lon0, start.lon0);
    assert.equal(same.widthM, start.widthM);
    assert.equal(same.deg, -20);
    assert.equal(R.beginMove(null, 0, 0), null);
    assert.equal(R.beginMove(start, NaN, 0), null);
    assert.equal(R.updateMove(null, 0, 0), null);
  });

  it("a committed move stays put when the drag is later cancelled", () => {
    const start = rectAt(15);
    const session = R.beginMove(start, start.lat0, start.lon0);
    R.updateMove(session, start.lat0 + 0.01, start.lon0 - 0.02);
    const sent = R.settledRect(session, true);
    const reverted = R.cancel(session);
    close(sent.lat0, start.lat0 + 0.01, 1e-12);
    close(sent.lon0, start.lon0 - 0.02, 1e-12);
    assert.equal(sent.widthM, start.widthM);
    assert.equal(sent.lengthM, start.lengthM);
    assert.equal(sent.deg, 15);
    assert.equal(reverted.lat0, start.lat0);
    assert.equal(reverted.lon0, start.lon0);
    assert.equal(reverted.widthM, start.widthM);
    assert.ok(Math.abs(sent.lat0 - reverted.lat0) > 0.001);
    const box = R.bboxFromRect(sent);
    const again = R.rectFromBBox(box, sent.deg);
    close(again.widthM, start.widthM, 1e-6);
    close(again.lengthM, start.lengthM, 1e-6);
    close(again.lat0, sent.lat0, 1e-9);
    const exported = rotateExport.rotatedRect(box, sent.deg);
    assert.equal(exported.deg, 15);
    close(exported.widthM, start.widthM, 1e-6);
    close(exported.lengthM, start.lengthM, 1e-6);
    close(exported.lat0, sent.lat0, 1e-12);
    close(exported.lon0, sent.lon0, 1e-12);
  });
});

describe("inside the rectangle, clear control offset", () => {
  it("the centre and the corners are inside; a point past the edge is not", () => {
    for (const deg of [0, 40, -15]) {
      const rect = rectAt(deg);
      assert.equal(R.containsPoint(rect, rect.lat0, rect.lon0), true);
      for (let i = 0; i < 4; i++) {
        const corner = R.cornerLatLng(rect, i);
        assert.equal(R.containsPoint(rect, corner.lat, corner.lng), true);
      }
      assert.equal(R.containsPoint(rect, rect.lat0 + 0.05, rect.lon0 + 0.05), false);
    }
    const turned = rectAt(40);
    const frame = R.bboxFromRect(turned);
    assert.equal(R.containsPoint(turned, frame.north, frame.east), false);
    assert.equal(R.containsPoint(null, 0, 0), false);
    assert.equal(R.containsPoint(turned, NaN, 0), false);
  });

  it("places a point past the corner, away from the centre", () => {
    const at = R.pointBeyond({ x: 0, y: 0 }, { x: 10, y: 0 }, 30);
    close(at.x, 40, 1e-9);
    close(at.y, 0, 1e-9);
    const diag = R.pointBeyond({ x: 0, y: 0 }, { x: 3, y: 4 }, 10);
    close(diag.x, 9, 1e-9);
    close(diag.y, 12, 1e-9);
    const back = R.pointBeyond({ x: 5, y: 5 }, { x: 5, y: 0 }, 8);
    close(back.x, 5, 1e-9);
    close(back.y, -8, 1e-9);
    assert.equal(R.pointBeyond(null, { x: 0, y: 0 }, 4), null);
    assert.equal(R.pointBeyond({ x: 0, y: 0 }, { x: 1, y: 1 }, -1), null);
  });
});

describe("move and clear on the map page", () => {
  const root = path.join(__dirname, "../public");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

  it("a press inside moves the area; pan and a press outside still draw or pan", () => {
    const downAt = app.indexOf('mapEl.addEventListener(\n  "pointerdown"');
    const downBody = app.slice(downAt, app.indexOf('"pointermove"'));
    const panAt = downBody.indexOf("panGesture(ev)");
    const moveAt = downBody.indexOf("startAreaMove(ev)");
    const drawAt = downBody.indexOf("OpenClutterDraw.pointerDown");
    assert.ok(panAt > 0 && moveAt > panAt && drawAt > moveAt);
    const start = app.slice(app.indexOf("function startAreaMove"), app.indexOf("function moveAreaDrag"));
    assert.match(start, /if \(!pointerInsideFinishedArea\(ev\)\) return false/);
    assert.match(start, /OpenClutterBoxResize\.beginMove\(rect, pt\.lat, pt\.lng\)/);
    assert.match(start, /committedLabel/);
    const inside = app.slice(app.indexOf("function pointerInsideFinishedArea"), app.indexOf("function rotateForExport"));
    assert.match(inside, /OpenClutterBoxResize\.containsPoint\(rect, pt\.lat, pt\.lng\)/);
    assert.match(inside, /committedLabel/);
    const drag = app.slice(app.indexOf("function moveAreaDrag"), app.indexOf("function finishAreaMove"));
    assert.match(drag, /OpenClutterBoxResize\.updateMove\(moveDrag\.session/);
    const finish = app.slice(app.indexOf("function finishAreaMove"), app.indexOf("function pointerInsideFinishedArea"));
    assert.match(finish, /OpenClutterBoxResize\.settledRect\(drag\.session, commit\)/);
    assert.match(finish, /paintResizedRect\(rect, changed\)/);
    assert.match(finish, /noteDrawCancelled\(\)/);
    const paint = app.slice(app.indexOf("function paintResizedRect"), app.indexOf("function attachCornerHandles"));
    assert.match(paint, /if \(commit\) \{\n    noteAreaReplaced\(\)/);
    assert.equal(/boxRotate = 0/.test(paint), false);
  });

  it("cancel on Escape, pointercancel, blur, and pinch restores the area", () => {
    assert.match(app, /ev\.key === "Escape" && moveDrag/);
    assert.match(app, /finishAreaMove\(false\)/);
    const up = app.slice(app.indexOf('mapEl.addEventListener("pointerup"'), app.indexOf('mapEl.addEventListener("pointercancel"'));
    assert.match(up, /finishAreaMove\(!pinchGesture\)/);
    const cancel = app.slice(app.indexOf('mapEl.addEventListener("pointercancel"'), app.indexOf('mapEl.addEventListener("click"'));
    assert.match(cancel, /finishAreaMove\(false\)/);
    const blur = app.slice(app.indexOf('window.addEventListener("blur"'), app.indexOf('document.addEventListener("visibilitychange"'));
    assert.match(blur, /finishAreaMove\(false\)/);
    assert.match(blur, /stopSpacePan\(\)/);
    const pinch = app.slice(app.indexOf("function abortDrawForPinch"), app.indexOf("mapEl.addEventListener"));
    assert.match(pinch, /if \(moveDrag\) finishAreaMove\(false\)/);
    const hoverAt = app.indexOf('"pointermove"');
    const hoverBody = app.slice(hoverAt, app.indexOf("let blockMapDblClick"));
    assert.match(hoverBody, /movePointer != null && ev\.pointerId === movePointer/);
    assert.match(
      hoverBody,
      /spacePan && panPointer == null && activePointer == null && resizePointer == null && hoverPanPointer\(ev\)/
    );
    assert.match(app, /function moveHoverPan/);
    assert.match(app, /scrollWheelZoom/);
  });

  it("the turn handle is on unless the page is opened with ?rotate=0", () => {
    const start = app.indexOf("function rotatePage");
    const body = app.slice(start, app.indexOf("let boxRotate"));
    assert.match(body, /get\("rotate"\) !== "0"/);
    assert.equal(/get\("rotate"\) === "1"/.test(body), false);
    assert.match(app, /function attachRotateHandle/);
  });

  it("the clear control is only on a finished rectangle, and Delete clears from the map", () => {
    assert.match(html, /\.area-clear \{/);
    assert.match(html, /width: 28px;/);
    assert.match(html, /height: 28px;/);
    assert.match(app, /class="area-clear"/);
    assert.match(app, /title="Clear area"/);
    assert.match(app, /aria-label="Clear area"/);
    assert.match(app, /<svg /);
    assert.equal(/aria-label="Clear">x</.test(app), false);
    assert.match(app, /cornerLatLng\(rect, 2\)/);
    assert.match(app, /pointBeyond\(mid, tip, CLEAR_PAD_PX\)/);
    const allow = app.slice(app.indexOf("function areaClearAllowed"), app.indexOf("function removeClearControl"));
    assert.match(allow, /cornerHandlesFor\(label\)/);
    assert.match(allow, /exportLocked\(\)/);
    assert.match(allow, /resizeDrag/);
    assert.match(allow, /moveDrag/);
    const clearFn = app.slice(app.indexOf("function clearFinishedShape"), app.indexOf("function commitBox"));
    assert.match(clearFn, /if \(exportLocked\(\)\) return/);
    assert.match(clearFn, /noteAreaReplaced\(\)/);
    assert.match(clearFn, /bbox = null/);
    assert.match(clearFn, /writeUrlState\(\)/);
    const preview = app.slice(app.indexOf("function showDragPreview"), app.indexOf("function showVertexPreview"));
    assert.match(preview, /showAreaChip\(bounds\)/);
    assert.equal(/clearButtonHtml/.test(preview), false);
    const poly = app.slice(app.indexOf("function commitPolygon"), app.indexOf("function showDragPreview"));
    assert.equal(/attachCornerHandles/.test(poly), false);
    const keys = app.slice(app.indexOf("function clearAreaFromKey"), app.indexOf('window.addEventListener("keydown"'));
    assert.match(keys, /ev\.key !== "Delete" && ev\.key !== "Backspace"/);
    assert.match(keys, /typingTarget\(ev\.target\)/);
    assert.match(keys, /closest\("#map"\)/);
    assert.match(keys, /exportLocked\(\)/);
    assert.match(app, /clearAreaFromKey\(ev\)/);
    assert.match(app, /clearFinishedShape\(\)/);
    const exportClick = app.slice(
      app.indexOf('document.getElementById("export").onclick'),
      app.indexOf("if (copyTerrainLabelReady())")
    );
    assert.match(exportClick, /finishAreaMove\(true\)/);
    assert.match(exportClick, /finishCornerResize\(true\)/);
  });
});
