// Tests for the canonical landmark module (lib/replay/landmarks.js):
// the category registry (sparse default!), kind → category/bucket
// mapping, source normalization, the chronological feed merge, and the
// filter <-> route-query contract. Run: node --test
// src/lib/landmarks.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LANDMARK_KINDS,
  DRAW_KINDS,
  CATEGORIES,
  DEFAULT_CATEGORIES,
  DEFAULT_FILTER,
  categoryOfKind,
  drawBucket,
  typedKindsFor,
  enabledSources,
  normalizeEvent,
  normalizeChat,
  normalizeGeneric,
  mergeFeed,
  parseLandmarkFilter,
  serializeLandmarkFilter,
  filtersEqual,
  defaultFilter,
  landmarkExportRows,
} from './replay/landmarks.js';
import { isCounted } from './rounds.js';

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

test('the default selection is exactly kills + round wins (sparse default)', () => {
  assert.deepEqual(DEFAULT_CATEGORIES, ['kills', 'round_wins']);
  // …and the default filter carries only those two categories.
  assert.deepEqual(defaultFilter().cats, ['kills', 'round_wins']);
  assert.deepEqual(DEFAULT_FILTER.cats, ['kills', 'round_wins']);
});

test('every category is well-formed and typed kinds are covered exactly once', () => {
  const seen = new Set();
  for (const c of CATEGORIES) {
    assert.ok(c.id && c.label && c.source, c.id);
    if (c.source === 'event') {
      assert.ok(Array.isArray(c.kinds) && c.kinds.length > 0, c.id);
      for (const k of c.kinds) {
        assert.ok(LANDMARK_KINDS.includes(k), `${c.id}: unknown kind ${k}`);
        assert.equal(seen.has(k), false, `kind ${k} claimed twice`);
        seen.add(k);
      }
    } else if (c.source === 'generic') {
      assert.ok(c.name || c.nameFrom, c.id);
    } else {
      assert.equal(c.source, 'chat');
    }
  }
  // All 14 stored kinds land in a category — no recorded activity is
  // unreachable from the feed.
  for (const k of LANDMARK_KINDS) assert.ok(seen.has(k), `unclaimed kind ${k}`);
});

test('categoryOfKind maps every kind and rejects unknown input', () => {
  assert.equal(categoryOfKind('kill'), 'kills');
  assert.equal(categoryOfKind('round_end'), 'round_wins');
  assert.equal(categoryOfKind('round_start'), 'round_starts');
  assert.equal(categoryOfKind('bomb_defuse'), 'bomb');
  assert.equal(categoryOfKind('player_disconnect'), 'connects');
  assert.equal(categoryOfKind('grenade'), 'grenade_dets');
  assert.equal(categoryOfKind('teleport'), null);
  assert.equal(categoryOfKind(''), null);
  assert.equal(categoryOfKind(null), null);
});

test('drawBucket buckets every drawable kind (renderer/scrubber contract)', () => {
  assert.equal(drawBucket('kill'), 'kill');
  assert.equal(drawBucket('grenade_throw'), 'throw');
  assert.equal(drawBucket('grenade'), 'detonation');
  assert.equal(drawBucket('bomb_plant'), 'plant');
  assert.equal(drawBucket('bomb_explode'), 'explode');
  assert.equal(drawBucket('bomb_defuse'), 'defuse');
  // Dropped-C4 evidence rows (the reconstruction in lib/replay/bomb.js
  // consumes them; the scrubber's marker loop still ignores them — no
  // new scrubber marker classes).
  assert.equal(drawBucket('bomb_drop'), 'drop');
  assert.equal(drawBucket('bomb_pickup'), 'pickup');
  assert.equal(drawBucket('round_end'), 'round');
  // Not drawable / no marker:
  for (const k of ['damage', 'blind', 'round_start', 'player_connect', '']) {
    assert.equal(drawBucket(k), '', k);
  }
  // Extended spellings keep their substring buckets.
  assert.equal(drawBucket('smoke'), 'smoke');
  assert.equal(drawBucket('molotov'), 'fire');
  // DRAW_KINDS is exactly the drawable set (round_end rides it for the
  // scrubber's round-win markers; it never draws on the map; drop/
  // pickup ride it for the bomb evidence, no marker).
  assert.deepEqual([...DRAW_KINDS].sort(), [
    'bomb_defuse',
    'bomb_drop',
    'bomb_explode',
    'bomb_pickup',
    'bomb_plant',
    'grenade',
    'grenade_throw',
    'kill',
    'round_end',
  ].sort());
});

test('typedKindsFor unions enabled categories; enabledSources splits paths', () => {
  assert.deepEqual(typedKindsFor(['kills', 'round_wins']), ['kill', 'round_end']);
  assert.deepEqual(typedKindsFor(['kills', 'damage']), ['kill', 'damage']);
  assert.deepEqual(typedKindsFor(['chat']), []);
  assert.deepEqual(typedKindsFor([]), []);
  assert.deepEqual(typedKindsFor(['kills', 'kills']), ['kill']);

  const src = enabledSources(['kills', 'chat', 'convars', 'game_events']);
  assert.equal(src.event, true);
  assert.equal(src.chat, true);
  assert.deepEqual(src.generic.map((c) => c.id), ['convars', 'game_events']);
  const none = enabledSources([]);
  assert.equal(none.event, false);
  assert.equal(none.chat, false);
  assert.deepEqual(none.generic, []);
});

test('normalizeEvent tags the row, keeps source fields and drops unknown kinds', () => {
  const ev = {
    id: 7, seq: 3, tick: 100, round: 1, kind: 'kill',
    attacker: '1', attackerName: 'a', victim: '2', victimName: 'b',
    weapon: 'ak47', dmg: 100, headshot: true, posX: 1.5,
  };
  const row = normalizeEvent(ev, { roundsByNumber: new Map() });
  assert.equal(row.key, 'e:7');
  assert.equal(row.source, 'event');
  assert.equal(row.category, 'kills');
  assert.equal(row.bucket, 'kill');
  assert.equal(row.attackerName, 'a'); // source fields preserved
  assert.equal(row.posX, 1.5);
  assert.equal(normalizeEvent({ ...ev, kind: 'teleport' }), null);
});

test('normalizeEvent round policy drops non-counted round categories only', () => {
  const rounds = new Map([
    [1, { number: 1, warmup: false, pregame: false }],
    [-1, { number: -1, warmup: true, pregame: false }],
  ]);
  const win = (round) => ({ id: 9, seq: 1, tick: 5, round, kind: 'round_end' });
  assert.ok(normalizeEvent(win(1), { roundsByNumber: rounds }), 'counted round kept');
  assert.equal(normalizeEvent(win(-1), { roundsByNumber: rounds }), null, 'warmup dropped');
  // A round the lookup does not know is kept (defensive, never invented).
  assert.ok(normalizeEvent(win(42), { roundsByNumber: rounds }));
  // The policy does not touch other categories (kills stay in knife rounds).
  const kill = { id: 10, seq: 2, tick: 6, round: -1, kind: 'kill' };
  assert.ok(normalizeEvent(kill, { roundsByNumber: rounds }), 'kills unaffected by policy');
  // policy:false (CompareRounds) shows every row the user selected.
  assert.ok(normalizeEvent(win(-1), { roundsByNumber: rounds, policy: false }));
  // and the policy follows lib/rounds.js isCounted exactly.
  assert.equal(isCounted({ number: -1 }), false);
});

test('normalizeChat / normalizeGeneric tag rows with who+label', () => {
  const c = normalizeChat({ id: 4, tick: 9, round: 1, steamId: '1', name: 'alice', text: 'hi', kind: 'chat' });
  assert.equal(c.key, 'c:4');
  assert.equal(c.source, 'chat');
  assert.equal(c.category, 'chat');
  assert.equal(c.who, 'alice');
  assert.equal(c.label, 'hi');

  const g = normalizeGeneric(
    { rowId: 12, name: 'server_cvar', tick: 8, round: 1, payloadJson: '{}', who: '', label: 'sv = 1' },
    'convars',
  );
  assert.equal(g.key, 'g:12');
  assert.equal(g.source, 'generic');
  assert.equal(g.category, 'convars');
  assert.equal(g.label, 'sv = 1');
});

test('mergeFeed orders by tick, then source, then sequence key', () => {
  const ev = (id, tick) => ({ ...normalizeEvent({ id, seq: id, tick, round: 1, kind: 'kill' }, {}) });
  const chat = (id, tick) => normalizeChat({ id, tick, round: 1, name: 'a', text: 'x' });
  const gen = (rowId, tick) => normalizeGeneric({ rowId, name: 'server_cvar', tick, round: 1, payloadJson: '{}' }, 'convars');

  const merged = mergeFeed([
    [ev(1, 300), ev(2, 100)],
    [chat(5, 100), chat(6, 200)],
    [gen(9, 100)],
  ]);
  assert.deepEqual(
    merged.map((r) => r.key),
    ['e:2', 'e:1', 'c:5', 'c:6', 'g:9'].sort((a, b) => {
      const t = { 'e:2': 100, 'c:5': 100, 'g:9': 100, 'c:6': 200, 'e:1': 300 };
      return t[a] - t[b];
    }),
  );
  // Same tick: event < chat < generic; within a source: seq/id order.
  const ticks = merged.map((r) => r.tick);
  assert.deepEqual(ticks, [100, 100, 100, 200, 300]);
  assert.deepEqual(merged.slice(0, 3).map((r) => r.source), ['event', 'chat', 'generic']);
  // Empty/disabled sources merge cleanly.
  assert.deepEqual(mergeFeed([]), []);
  assert.equal(mergeFeed([[ev(1, 1)], null, undefined]).length, 1);
});

test('filter <-> query round-trip: defaults serialize to nothing', () => {
  // Default state → empty query ("#/replay/5" IS the sparse default).
  assert.deepEqual(serializeLandmarkFilter(defaultFilter()), {});
  assert.deepEqual(parseLandmarkFilter({}), defaultFilter());
  assert.ok(filtersEqual(defaultFilter(), parseLandmarkFilter({})));

  const f = {
    ...defaultFilter(),
    cats: ['kills', 'chat'],
    round: 7,
    steamId: '76561198012345678',
    weapon: 'awp',
    tickFrom: 100,
    tickTo: 200,
    dmgMin: 30,
    dmgMax: 100,
    distanceMax: 50,
    headshotOnly: true,
    bbox: { minX: -1, minY: -2, maxX: 3, maxY: 4 },
    gname: 'weapon_fire',
  };
  const q = serializeLandmarkFilter(f);
  const back = parseLandmarkFilter(q);
  assert.ok(filtersEqual(f, back), JSON.stringify([q, back]));
  assert.deepEqual(back.cats, ['kills', 'chat']);
  assert.equal(back.round, 7);
  assert.equal(back.steamId, '76561198012345678');
  assert.deepEqual(back.bbox, { minX: -1, minY: -2, maxX: 3, maxY: 4 });
});

test('parse edge cases: empty cat = none, junk falls back, no shared arrays', () => {
  assert.deepEqual(parseLandmarkFilter({ cat: '' }).cats, []);
  // Unknown category ids are dropped, not invented.
  assert.deepEqual(parseLandmarkFilter({ cat: 'kills,bogus' }).cats, ['kills']);
  // A missing/invalid round means "all rounds", never round 0.
  assert.equal(parseLandmarkFilter({ round: 'x' }).round, -1);
  assert.equal(parseLandmarkFilter({}).round, -1);
  // A malformed bbox is ignored rather than half-applied.
  assert.equal(parseLandmarkFilter({ bbox: '1,2,3' }).bbox, null);
  // Each parse gets fresh arrays (callers may mutate freely).
  const a = parseLandmarkFilter({});
  const b = parseLandmarkFilter({});
  a.cats.push('chat');
  assert.deepEqual(b.cats, ['kills', 'round_wins']);
});

test('landmarkExportRows flattens the feed into canonical columns', () => {
  const rows = [
    normalizeEvent({ id: 1, seq: 0, tick: 10, round: 1, kind: 'kill', attackerName: 'a', victimName: 'b', weapon: 'ak47', dmg: 100 }, {}),
    normalizeChat({ id: 2, tick: 11, round: 1, name: 'alice', text: 'gl hf', kind: 'chat' }),
  ];
  const out = landmarkExportRows(rows);
  assert.deepEqual(out[0], ['tick', 'round', 'source', 'category', 'kind', 'who', 'label', 'weapon', 'dmg']);
  assert.deepEqual(out[1], [10, 1, 'event', 'kills', 'kill', '', '', 'ak47', 100]);
  assert.deepEqual(out[2], [11, 1, 'chat', 'chat', 'chat', 'alice', 'gl hf', '', '']);
});
