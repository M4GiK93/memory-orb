"use strict";

const assert = require("node:assert/strict");
const { Orb, activeRegions } = require("./orb");
const working = { node: { region: "short" } }, library = { node: { region: "long" } };
assert.deepEqual([...activeRegions("", [], null, null, false)], []);
assert.deepEqual([...activeRegions("", [], null, working, false)], ["short"]);
assert.deepEqual([...activeRegions("", [], library, working, true)], ["long"]);
assert.deepEqual([...activeRegions("find", [working.node, library.node], library, working, false)], ["short", "long"]);
assert.deepEqual([...activeRegions("find", [], null, working, false)], []);
assert.deepEqual([...activeRegions("find", [working.node], working, library, true)], ["short"]);
assert.deepEqual([...activeRegions("", [], {node: {region: "synthesis"}}, working, true)], ["synthesis"]);

const orb = Object.create(Orb.prototype);
let opened = 0;
Object.assign(orb, {
    stage: { clientWidth: 400, clientHeight: 300 },
    canvas: {
        clientWidth: 400, style: {}, setPointerCapture() {},
        getBoundingClientRect: () => ({ left: 20, top: 10, width: 400, height: 300 }),
    },
    zoomOut: {}, zoomIn: {}, zoomReset: { setAttribute() {} },
    pointers: new Map(), view: { zoom: 1, x: 0, y: 0 },
    yaw: 0, pitch: 0.08, schedule() {}, hover() {},
    hit: () => ({ node: { path: "memory.md" } }), openNote: () => opened++,
});
let handledDowns = 0;
const touch = (pointerId, x, y) => ({
    pointerId, clientX: x, clientY: y, button: 0, pointerType: "touch",
    stopPropagation() { handledDowns++; },
});

// The original midpoint is 30 px right and 10 px above the viewport center.
orb.down(touch(1, 230, 150));
orb.down(touch(2, 270, 150));
orb.down(touch(2, 270, 150));
assert.equal(handledDowns, 2);
orb.move(touch(1, 215, 160));
orb.move(touch(2, 295, 160));
assert.deepEqual(orb.view, { zoom: 2, x: -25, y: 20 });
orb.move(touch(1, 235, 175));
orb.move(touch(2, 315, 175));
assert.deepEqual(orb.view, { zoom: 2, x: -5, y: 35 });
orb.up(touch(2, 315, 175));
orb.endPointer(touch(2, 315, 175)); // Implicit lostpointercapture after pointerup.
orb.move(touch(1, 255, 175));
orb.up(touch(1, 255, 175));
assert.equal(orb.yaw, 0);
assert.equal(opened, 0);

orb.down(touch(3, 150, 100));
orb.move(touch(3, 180, 100));
orb.up(touch(3, 180, 100));
assert.ok(orb.yaw > 0);
assert.equal(opened, 0);
orb.down(touch(4, 100, 100));
orb.up(touch(4, 100, 100));
assert.equal(opened, 1);
orb.zoomBy(100);
assert.equal(orb.view.zoom, 8);
orb.zoomBy(0.001);
assert.equal(orb.view.zoom, 1);
orb.resetView();
assert.deepEqual(orb.view, { zoom: 1, x: 0, y: 0 });
assert.equal(orb.yaw, 0);
assert.equal(orb.zoomOut.disabled, true);
console.log("Zoom anchor, two-finger pan, release, rotation, tap, limits and reset passed.");
