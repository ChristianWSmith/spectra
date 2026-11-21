// src/lib/weapon_fire_feed.test.js (from frontend/)
//
// Feed double-surface pin for the weapon_fire promotion. The typed weapon_fire row is stored in
// `events`, and the same shot also remains in generic_events. The feed
// must list the shot exactly once, through no path: no landmark category
// claims the kind, no draw/world fetch asks for it, and no generic
// category names it. A future claim is a product decision and must
// falsify this test on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORIES,
  DRAW_KINDS,
  LANDMARK_KINDS,
  typedKindsFor,
  normalizeEvent,
} from './replay/landmarks.js';

test('weapon_fire is feed-silent: no category, draw fetch or generic name claims it', () => {
  // The Go kind is not mirrored in LANDMARK_KINDS (like bot_takeover);
  // the feed and draw paths only ever ask for claimed or DRAW_KINDS kinds.
  assert.ok(!LANDMARK_KINDS.includes('weapon_fire'));
  assert.ok(!DRAW_KINDS.includes('weapon_fire'));
  for (const c of CATEGORIES) {
    assert.ok(!(c.kinds || []).includes('weapon_fire'), `category ${c.id} claims weapon_fire`);
    assert.notEqual(c.name, 'weapon_fire', `generic category ${c.id} names weapon_fire`);
  }
});

test('weapon_fire never reaches the feed query or its rows', () => {
  const allCats = CATEGORIES.map((c) => c.id);
  assert.ok(!typedKindsFor(allCats).includes('weapon_fire'));
  const row = normalizeEvent(
    { id: 9, seq: 9, tick: 500, round: 1, kind: 'weapon_fire', attacker: '1', weapon: 'AK-47' },
    { roundsByNumber: new Map() },
  );
  assert.equal(row, null, 'a weapon_fire event must be dropped by normalizeEvent');
});
