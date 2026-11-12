// Node tests for lib/replay/playercolor.js — the ONE mapping from CS2's
// raw m_iCompTeammateColor int to the hex every ring reads (card ring +
// render dot rim). Run: node --test src/lib/playercolor.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAYER_COLORS, colorHexOf, colorSlotsOf, colorRankOf } from './replay/playercolor.js';

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
  // in-game ground truth on the golden demo agree on.
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

test('colorRankOf: the card-column order yellow → purple → green → blue → orange', () => {
  // The owner's ruling (2026-11-11): each team column reads
  // top-to-bottom yellow, purple, green, blue, orange — rank 0 = top,
  // mapped from the raw int (0 blue, 1 green, 2 yellow, 3 orange,
  // 4 purple). A permutation of 0..4: every known color gets exactly
  // one rank, none is dropped or doubled.
  assert.deepEqual([0, 1, 2, 3, 4].map((raw) => colorRankOf(raw)).sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.equal(colorRankOf(2), 0); // yellow — top
  assert.equal(colorRankOf(4), 1); // purple
  assert.equal(colorRankOf(1), 2); // green
  assert.equal(colorRankOf(0), 3); // blue
  assert.equal(colorRankOf(3), 4); // orange — bottom of the knowns
  // …so sorting a SCRAMBLED roster by rank lands in the ratified order.
  const scrambled = [0, 4, 1, 3, 2];
  const sorted = scrambled.slice().sort((a, b) => (colorRankOf(a) ?? Infinity) - (colorRankOf(b) ?? Infinity));
  assert.deepEqual(sorted, [2, 4, 1, 0, 3]); // yellow, purple, green, blue, orange
  // Unknown colors resolve to NULL — never a guessed position (the
  // column sorts these LAST, in slot order). The validator is
  // colorHexOf's, so "has a rank" and "has a ring" always agree.
  for (const raw of [null, undefined, -1, 5, 9, 1.5, NaN, Infinity, {}, [], true, false, '']) {
    assert.equal(colorRankOf(raw), null, String(raw));
  }
  assert.equal(colorRankOf('2'), 0); // the string form ranks like the ring maps
});

test('the golden demo ground-truth assignments resolve to their hexes', () => {
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
