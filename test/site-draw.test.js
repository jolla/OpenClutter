"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  DRAG_PX,
  createSession,
  arm,
  pointerDown,
  pointerMove,
  pointerUp,
  abortPress,
  finish,
  cancel,
  setVertexPixels,
  boundsOf,
} = require("../public/site-draw");

function click(session, pt) {
  const down = pointerDown(session, pt);
  const up = pointerUp(session, pt);
  return { down: down, up: up };
}

describe("site draw gestures", () => {
  it("treats a short press as a polygon vertex and a drag as a box", () => {
    assert.equal(DRAG_PX, 6);
    const session = createSession();
    assert.equal(pointerDown(session, { x: 0, y: 0, lat: 36, lng: -115 }).type, "ignore");

    arm(session);
    const jitter = click(session, { x: 10, y: 10, lat: 36.12, lng: -115.16 });
    assert.equal(jitter.up.type, "vertex");
    assert.equal(jitter.up.vertices.length, 1);
    assert.equal(session.phase, "polygon");
    assert.equal(session.armed, true);

    pointerDown(session, { x: 10, y: 40, lat: 36.13, lng: -115.16 });
    const small = pointerMove(session, { x: 14, y: 40, lat: 36.13, lng: -115.15 });
    assert.equal(small.type, "ignore");
    const stillClick = pointerUp(session, { x: 14, y: 40, lat: 36.13, lng: -115.15 });
    assert.equal(stillClick.type, "vertex");
    assert.equal(stillClick.vertices.length, 2);

    pointerDown(session, { x: 14, y: 40, lat: 36.13, lng: -115.15 });
    const drag = pointerMove(session, { x: 14 + DRAG_PX, y: 40, lat: 36.2, lng: -115.1 });
    assert.equal(drag.type, "drag");
    const box = pointerUp(session, { x: 80, y: 90, lat: 36.25, lng: -115.05 });
    assert.equal(box.type, "commit-box");
    assert.deepEqual(box.start, { lat: 36.13, lng: -115.15 });
    assert.deepEqual(box.end, { lat: 36.25, lng: -115.05 });
    assert.equal(session.vertices.length, 0);
    assert.equal(session.armed, false);
    assert.equal(session.phase, "idle");
    assert.equal(finish(session).type, "ignore");
  });

  it("closes on finish only with 3 or more corners, in click order", () => {
    const session = createSession();
    arm(session);
    assert.equal(finish(session).type, "ignore");
    assert.equal(session.armed, true);

    const corners = [
      { x: 0, y: 0, lat: 36.1, lng: -115.2 },
      { x: 40, y: 0, lat: 36.1, lng: -115.1 },
      { x: 40, y: 50, lat: 36.2, lng: -115.12 },
    ];
    click(session, corners[0]);
    click(session, corners[1]);
    const early = finish(session);
    assert.equal(early.type, "discard");
    assert.equal(early.count, 2);
    assert.equal(session.vertices.length, 0);
    assert.equal(session.armed, false);
    assert.notEqual(early.type, "commit-polygon");

    arm(session);
    let last;
    for (let i = 0; i < corners.length; i++) last = click(session, corners[i]).up;
    assert.equal(last.vertices.length, 3);
    last.vertices.push({ lat: 0, lng: 0 });
    assert.equal(session.vertices.length, 3);

    const closed = finish(session);
    assert.equal(closed.type, "commit-polygon");
    assert.deepEqual(
      closed.vertices,
      corners.map((p) => ({ lat: p.lat, lng: p.lng }))
    );
    assert.deepEqual(closed.bounds, {
      west: -115.2,
      south: 36.1,
      east: -115.1,
      north: 36.2,
    });
    assert.deepEqual(closed.bounds, boundsOf(closed.vertices));
    assert.equal(session.vertices.length, 0);
    assert.equal(session.armed, false);
    assert.equal(finish(session).type, "ignore");
    closed.vertices.push({ lat: 1, lng: 1 });
    assert.equal(session.vertices.length, 0);
  });

  it("cancels an open ring without committing it, and ignores a second click on the same corner", () => {
    const session = createSession();
    assert.equal(cancel(session).type, "ignore");
    arm(session);
    click(session, { x: 0, y: 0, lat: 36, lng: -115 });
    const dup = click(session, { x: 3, y: 1, lat: 36.01, lng: -115.01 });
    assert.equal(dup.up.type, "ignore");
    assert.equal(session.vertices.length, 1);

    setVertexPixels(session, [{ x: 200, y: 200 }]);
    const closeToZoomed = click(session, { x: 204, y: 200, lat: 37, lng: -114 });
    assert.equal(closeToZoomed.up.type, "ignore");
    const far = click(session, { x: 230, y: 200, lat: 36.2, lng: -115.1 });
    assert.equal(far.up.type, "vertex");
    assert.equal(far.up.vertices.length, 2);

    const aborted = cancel(session);
    assert.equal(aborted.type, "cancel");
    assert.equal(aborted.discarded, 2);
    assert.equal(session.phase, "idle");
    assert.equal(session.vertices.length, 0);
    assert.notEqual(aborted.type, "commit-polygon");
    assert.notEqual(aborted.type, "commit-box");
  });

  it("does not add a vertex for a right-click or ctrl-click, and a cancelled press is not a box", () => {
    const session = createSession();
    arm(session);
    assert.equal(pointerDown(session, { x: 0, y: 0, lat: 36, lng: -115, button: 2 }).type, "ignore");
    assert.equal(pointerUp(session, { x: 0, y: 0, lat: 36, lng: -115, button: 2 }).type, "ignore");
    assert.equal(pointerDown(session, { x: 0, y: 0, lat: 36, lng: -115, button: 0, ctrlKey: true }).type, "ignore");

    pointerDown(session, { x: 0, y: 0, lat: 36, lng: -115 });
    pointerMove(session, { x: 30, y: 0, lat: 36.2, lng: -115 });
    assert.equal(abortPress(session).type, "abort-press");
    assert.equal(pointerUp(session, { x: 30, y: 0, lat: 36.2, lng: -115 }).type, "ignore");
    assert.equal(session.armed, true);
    assert.equal(session.vertices.length, 0);

    click(session, { x: 0, y: 0, lat: 36.1, lng: -115.2 });
    click(session, { x: 20, y: 0, lat: 36.1, lng: -115.1 });
    click(session, { x: 20, y: 30, lat: 36.2, lng: -115.1 });
    const closed = finish(session);
    assert.equal(closed.type, "commit-polygon");
    assert.equal(boundsOf(null), null);
    assert.deepEqual(boundsOf(closed.vertices).west, -115.2);
  });

  it("arm drops an in-progress ring so Draw starts clean", () => {
    const session = createSession();
    arm(session);
    click(session, { x: 0, y: 0, lat: 1, lng: 2 });
    click(session, { x: 20, y: 0, lat: 1, lng: 3 });
    assert.equal(arm(session).type, "armed");
    assert.equal(session.vertices.length, 0);
    assert.equal(session.phase, "armed");
    assert.equal(boundsOf([{ lat: 3, lng: 0 }, { lat: 0, lng: 2 }, { lat: 1, lng: 1 }]).north, 3);
  });
});
