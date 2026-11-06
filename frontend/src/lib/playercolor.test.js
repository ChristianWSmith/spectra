// Node tests for lib/replay/playercolor.js — the ONE mapping from CS2's
// raw m_iCompTeammateColor int to the hex every ring reads (card ring +
// render dot rim). Run: node --test src/lib/playercolor.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAYER_COLORS, colorHexOf, colorSlotsOf } from './replay/playercolor.js';

test('PLAYER_COLORS is the exact five CS2 teammate colors', () => {
  // The hexes the spec pinned for voice/player colors, now keyed by the
  // CS2 color NAME (the raw int order below is the game's, not a
  // preference): blue, green, yellow, orange, purple.
  assert.deepEqual(PLAYER_COLORS, {
    blue: '#84C8ED',
    green: '#009A7D',
    yellow: '#ECDF41',
    orange: '#DF7D29',
    purple: '#A56FB2',
  });
  for (const hex of Object.values(PLAYER_COLORS)) {
    assert.match(hex, /^#[0-9A-F]{6}$/);
  }
});

test('colorHexOf: the raw ints 0..4 map blue/green/yellow/orange/purple', () => {
  // CS2.md "Player scoreboard/radar colors": 0 blue, 1 green, 2 yellow,
  // 3 orange, 4 purple — the mapping demoparser's PLAYER_COLOR and the
  // in-game ground truth on donk.dem.zst agree on.
  assert.equal(colorHexOf(0), '#84C8ED');
  assert.equal(colorHexOf(1), '#009A7D');
  assert.equal(colorHexOf(2), '#ECDF41');
  assert.equal(colorHexOf(3), '#DF7D29');
  assert.equal(colorHexOf(4), '#A56FB2');
});

test('colorHexOf: never guesses — absent/none/out-of-range is null', () => {
  // -1 = the demo said "no color" (GOTV/unassigned), null/undefined =
  // an absent field (a sidecar predating playerColors), 5+ / fractional
  // / junk = not a CS2 color. None of them may fall back to a default.
  for (const raw of [null, undefined, -1, 5, 9, 1.5, NaN, Infinity, {}, [], true, false, '']) {
    assert.equal(colorHexOf(raw), null, String(raw));
  }
  // A numeric STRING still maps (JSON round-trips), an empty one does not.
  assert.equal(colorHexOf('2'), '#ECDF41');
  assert.equal(colorHexOf('  '), null);
  assert.equal(colorHexOf('blue'), null);
});

test('colorSlotsOf: slot-aligned hex array, null where there is no color', () => {
  assert.deepEqual(colorSlotsOf([{ color: 0 }, {}, { color: 4 }, null]), [
    '#84C8ED',
    null,
    '#A56FB2',
    null,
  ]);
  assert.deepEqual(colorSlotsOf(null), []);
  assert.deepEqual(colorSlotsOf(undefined), []);
  assert.deepEqual(colorSlotsOf('nope'), []);
});

test('the donk.dem.zst ground-truth assignments resolve to their hexes', () => {
  // The ten raw values verified in-game against this demo (pinned in
  // internal/extract/golden_test.go): each color appears exactly once per
  // team. The card shows the ring; nothing here re-derives the rule.
  const truth = [
    ['Magnojezzz', 3, '#DF7D29'], // orange
    ['donk666', 4, '#A56FB2'], // purple
    ['Zuedsta', 1, '#009A7D'], // green
    ['forever2kELO', 2, '#ECDF41'], // yellow
    ['-meg2k', 0, '#84C8ED'], // blue
    ['FREELOOK', 0, '#84C8ED'], // blue
    ['llorente', 3, '#DF7D29'], // orange
    ['kRaSnaL', 1, '#009A7D'], // green
    ['hades--', 2, '#ECDF41'], // yellow
    ['adamS', 4, '#A56FB2'], // purple
  ];
  for (const [name, raw, hex] of truth) {
    assert.equal(colorHexOf(raw), hex, name);
  }
});
