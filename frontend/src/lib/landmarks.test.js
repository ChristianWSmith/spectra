// Fixture test for src/lib/replay/landmarks.js — the shared kind
// vocabulary + classifier the renderer, Replay's scrubber markers and
// FilterBar all consume. (Lives in src/lib/ because the keep-green suite
// glob is `node --test src/lib/*.test.js`, which does not recurse.)
// Run: node --test src/lib/landmarks.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { LANDMARK_KINDS, classifyLandmark } from './replay/landmarks.js';

test('LANDMARK_KINDS is the models.EventKind mirror (order included)', () => {
  assert.deepEqual(LANDMARK_KINDS, [
    'kill',
    'damage',
    'blind',
    'bomb_plant',
    'bomb_defuse',
    'bomb_explode',
    'bomb_drop',
    'bomb_pickup',
    'grenade_throw',
    'grenade',
    'round_start',
    'round_end',
    'player_connect',
    'player_disconnect',
  ]);
  assert.equal(new Set(LANDMARK_KINDS).size, LANDMARK_KINDS.length);
});

test('classifyLandmark buckets every landmark kind', () => {
  // renderer.setLandmarks buckets (the pre-consolidation behavior)
  assert.equal(classifyLandmark('grenade_throw'), 'throw');
  assert.equal(classifyLandmark('grenade'), 'detonation');
  assert.equal(classifyLandmark('he'), 'detonation');
  assert.equal(classifyLandmark('he_explode'), 'detonation');
  assert.equal(classifyLandmark('smoke'), 'smoke');
  assert.equal(classifyLandmark('smokegrenade'), 'smoke'); // substring branch
  assert.equal(classifyLandmark('fire'), 'fire');
  assert.equal(classifyLandmark('molotov'), 'fire');
  assert.equal(classifyLandmark('bomb_plant'), 'plant');
  assert.equal(classifyLandmark('bomb_explode'), 'explode');
  assert.equal(classifyLandmark('bomb_defuse'), 'defuse');
  // Replay.svelte's scrubber markers
  assert.equal(classifyLandmark('kill'), 'kill');
});

test('classifyLandmark is case-insensitive and normalizes non-strings', () => {
  assert.equal(classifyLandmark('KILL'), 'kill');
  assert.equal(classifyLandmark('Bomb_Explode'), 'explode');
  assert.equal(classifyLandmark(null), '');
  assert.equal(classifyLandmark(undefined), '');
  assert.equal(classifyLandmark(''), '');
});

test('classifyLandmark returns "" for kinds neither surface handles', () => {
  for (const kind of ['damage', 'blind', 'round_start', 'round_end', 'bomb_drop', 'bomb_pickup', 'player_connect', 'player_disconnect']) {
    assert.equal(classifyLandmark(kind), '', kind);
  }
  assert.equal(classifyLandmark('teleport'), '');
});

test('grenade_throw never falls into the detonation bucket (order matters)', () => {
  // The throw branch must win over the substring/equality branches —
  // renderer pairs throws with their detonation via this bucket.
  assert.notEqual(classifyLandmark('grenade_throw'), 'detonation');
});
