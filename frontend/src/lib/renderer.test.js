// Tests for the replay renderer's pure trail-continuity rule
// (lib/replay/renderer.js trailConnects) — the break that keeps player
// movement trails from streaking across a round reset or a
// death→respawn teleport. Run: node --test src/lib/renderer.test.js
// (from frontend/; the lib test glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import { trailConnects } from './replay/renderer.js';

// slotPos builds one slot's interleaved Float32Array [x, y, z, yaw] from
// a list of per-frame world positions.
function slotPos(points) {
  const a = new Float32Array(points.length * 4);
  points.forEach(([x, y], i) => {
    a[i * 4] = x;
    a[i * 4 + 1] = y;
  });
  return a;
}

test('contiguous human-speed frames connect (the normal trail)', () => {
  const ticks = [0, 1, 2, 3];
  const pos = slotPos([
    [0, 0],
    [4, 0],
    [8, 1],
    [12, 2],
  ]);
  assert.equal(trailConnects(ticks, pos, 0), true);
  assert.equal(trailConnects(ticks, pos, 1), true);
  assert.equal(trailConnects(ticks, pos, 2), true);
});

test('a teleport (round reset / respawn) breaks the trail', () => {
  const ticks = [0, 1, 2, 3];
  // frames 0-1 near the old position; frames 2-3 across the map (the
  // round reset put the player back at spawn between f1 and f2).
  const pos = slotPos([
    [100, 100],
    [104, 100],
    [1600, -900],
    [1604, -900],
  ]);
  assert.equal(trailConnects(ticks, pos, 0), true); // inside the old round
  assert.equal(trailConnects(ticks, pos, 1), false); // the reset boundary
  assert.equal(trailConnects(ticks, pos, 2), true); // fresh from spawn
});

test('a stalled tick gap breaks the trail', () => {
  const ticks = [0, 1, 2, 20];
  const pos = slotPos([
    [0, 0],
    [4, 0],
    [8, 0],
    [12, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, 1), true); // gap of 1 tick
  assert.equal(trailConnects(ticks, pos, 2), false); // gap of 18 ticks
});

test('a non-advancing tick never connects', () => {
  const ticks = [0, 0, 1];
  const pos = slotPos([
    [0, 0],
    [4, 0],
    [8, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, 0), false);
});

test('the step threshold is generous to movement, not to teleports', () => {
  const ticks = [0, 1, 2];
  const near = slotPos([
    [0, 0],
    [256, 0],
    [512, 0],
  ]);
  assert.equal(trailConnects(ticks, near, 0), true);
  const far = slotPos([
    [0, 0],
    [257, 0],
    [514, 0],
  ]);
  assert.equal(trailConnects(ticks, far, 0), false);
});

test('the segment off either end of the window does not connect', () => {
  const ticks = [0, 1];
  const pos = slotPos([
    [0, 0],
    [4, 0],
  ]);
  assert.equal(trailConnects(ticks, pos, -1), false);
  assert.equal(trailConnects(ticks, pos, 1), false); // f+1 past the end
});
