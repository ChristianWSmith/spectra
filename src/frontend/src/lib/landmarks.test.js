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
  DETONATION_BUCKETS,
  categoryOfKind,
  drawBucket,
  detonationStyle,
  detonationStyleOf,
  sameUtilityWeapon,
  scrubberMarkerClass,
  typedKindsFor,
  enabledSources,
  normalizeEvent,
  normalizeChat,
  normalizeGeneric,
  mergeFeed,
  parseLandmarkFilter,
  serializeLandmarkFilter,
  filtersEqual,
  shouldRevealFeed,
  defaultFilter,
  landmarkExportRows,
  precomposeChatLabels,
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
    'bomb_plant_begin',
    'bomb_plant_abort',
    'bomb_defuse_start',
    'bomb_defuse_abort',
    'grenade_throw',
    'grenade',
    'weapon_drop',
    'weapon_pickup',
    'grenade_land',
    // models.EventKind's grenade_bounce (the SOS bounce rows) — order
    // mirrors the Go const block, so the mirror pin stays honest.
    'grenade_bounce',
    'round_start',
    'round_end',
    'player_connect',
    'player_disconnect',
  ]);
  assert.equal(new Set(LANDMARK_KINDS).size, LANDMARK_KINDS.length);
});

test('the default selection is exactly round starts (sparse default)', () => {
  assert.deepEqual(DEFAULT_CATEGORIES, ['round_starts']);
  // …and the default filter carries only that category.
  assert.deepEqual(defaultFilter().cats, ['round_starts']);
  assert.deepEqual(DEFAULT_FILTER.cats, ['round_starts']);
  // Kills and round wins are opt-in, not default (the user-visible rule:
  // only round starts are toggled on out of the box).
  assert.equal(CATEGORIES.find((c) => c.id === 'kills').default, undefined);
  assert.equal(CATEGORIES.find((c) => c.id === 'round_wins').default, undefined);
  assert.equal(CATEGORIES.find((c) => c.id === 'round_starts').default, true);
  // The Bounce category (grenade_bounce rows) is OPT-IN like every
  // non-sparse one — the grenade_lands precedent: its rows ride the draw
  // feed for the world layer, but the feed lists them only when the chip
  // is on, so the sparse default must not claim it.
  assert.equal(CATEGORIES.find((c) => c.id === 'grenade_bounces').default, undefined);
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
  // All stored kinds land in a category — no recorded activity is
  // unreachable from the feed.
  for (const k of LANDMARK_KINDS) assert.ok(seen.has(k), `unclaimed kind ${k}`);
});

test('categoryOfKind maps every kind and rejects unknown input', () => {
  assert.equal(categoryOfKind('kill'), 'kills');
  assert.equal(categoryOfKind('round_end'), 'round_wins');
  assert.equal(categoryOfKind('round_start'), 'round_starts');
  assert.equal(categoryOfKind('bomb_defuse'), 'bomb');
  // The ATTEMPT lifecycle rides the bomb category — an unclaimed kind
  // would be dropped from the feed AND the draw set entirely.
  assert.equal(categoryOfKind('bomb_plant_begin'), 'bomb');
  assert.equal(categoryOfKind('bomb_defuse_start'), 'bomb');
  assert.equal(categoryOfKind('bomb_plant_abort'), 'bomb');
  assert.equal(categoryOfKind('bomb_defuse_abort'), 'bomb');
  assert.equal(categoryOfKind('player_disconnect'), 'connects');
  assert.equal(categoryOfKind('grenade'), 'grenade_dets');
  // The decoy ACTIVATION normalizes under its own category — it is not a
  // detonation (no det scrubber marker, no stat), and an unclaimed kind
  // would be dropped from the feed/draw set entirely.
  assert.equal(categoryOfKind('grenade_land'), 'grenade_lands');
  // The BOUNCE rows claim their OWN default-OFF category — an unclaimed
  // kind would be dropped from the feed AND the draw set entirely (and
  // the renderer's flight path would lose its vertices).
  assert.equal(categoryOfKind('grenade_bounce'), 'grenade_bounces');
  // The death-drop evidence normalizes under its OWN default-OFF
  // category — normalizeEvent requires a claim (an unclaimed kind
  // would be dropped from the feed AND the draw set entirely).
  assert.equal(categoryOfKind('weapon_drop'), 'drops');
  assert.equal(categoryOfKind('weapon_pickup'), 'drops');
  assert.equal(categoryOfKind('teleport'), null);
  assert.equal(categoryOfKind(''), null);
  assert.equal(categoryOfKind(null), null);
});

test('drawBucket buckets every drawable kind (renderer/scrubber contract)', () => {
  assert.equal(drawBucket('kill'), 'kill');
  assert.equal(drawBucket('grenade_throw'), 'throw');
  // A grenade detonation routes by WEAPON (the typed buckets the
  // renderer's lingering smoke/fire arrays and per-type visuals read);
  // an unknown/absent weapon stays the generic detonation bucket.
  assert.equal(drawBucket('grenade'), 'detonation');
  assert.equal(drawBucket('grenade', 'HE Grenade'), 'he');
  assert.equal(drawBucket('grenade', 'Flashbang'), 'flash');
  assert.equal(drawBucket('grenade', 'Smoke Grenade'), 'smoke');
  assert.equal(drawBucket('grenade', 'Molotov'), 'fire');
  assert.equal(drawBucket('grenade', 'Incendiary Grenade'), 'fire');
  // WHY 'he', not 'decoy': an exploding decoy plays BaseGrenade.Explode —
  // the HE files (spec research 2026-11-07, verified 5/5 demos; CS2.md
  // "Sound assets": the decoy has NO detonation sound of its own), so its
  // detonation renders and sounds through the HE path. The old 'decoy'
  // bucket has no producer left.
  assert.equal(drawBucket('grenade', 'Decoy Grenade'), 'he');
  assert.equal(drawBucket('grenade', 'AK-47'), 'detonation');
  // The decoy ACTIVATION (a grenade coming to rest) buckets 'land' — its
  // own bucket, NOT in DETONATION_BUCKETS: no detonation visual, no
  // scrubber det-marker (the real explosion carries that one), but the
  // renderer pairs the throw arc to it and draws the rest icon from the
  // plan.
  assert.equal(drawBucket('grenade_land', 'Decoy Grenade'), 'land');
  assert.equal(drawBucket('grenade_land'), 'land');
  // A projectile BOUNCE is neither a detonation nor a rest: its OWN
  // 'bounce' bucket — the renderer's flight-path vertex pool — with no
  // scrubber marker (see scrubberMarkerClass below).
  assert.equal(drawBucket('grenade_bounce'), 'bounce');
  assert.equal(drawBucket('bomb_plant'), 'plant');
  assert.equal(drawBucket('bomb_explode'), 'explode');
  assert.equal(drawBucket('bomb_defuse'), 'defuse');
  // Dropped-C4 evidence rows (the reconstruction in lib/replay/bomb.js
  // consumes them; the scrubber's marker loop still ignores them — no
  // new scrubber marker classes).
  assert.equal(drawBucket('bomb_drop'), 'drop');
  assert.equal(drawBucket('bomb_pickup'), 'pickup');
  // The death-drop evidence buckets — DISTINCT from the C4 ones above
  // (drawDrops consumes these; bombEvidenceAt must stay bomb-only).
  assert.equal(drawBucket('weapon_drop'), 'wdrop');
  assert.equal(drawBucket('weapon_pickup'), 'wpickup');
  // The plant/defuse ATTEMPT lifecycle: its OWN four buckets (never
  // 'plant'/'defuse' — those feed the beep scheduler and the world
  // markers), all marker-less (see scrubberMarkerClass below).
  assert.equal(drawBucket('bomb_plant_begin'), 'plant_begin');
  assert.equal(drawBucket('bomb_plant_abort'), 'plant_abort');
  assert.equal(drawBucket('bomb_defuse_start'), 'defuse_start');
  assert.equal(drawBucket('bomb_defuse_abort'), 'defuse_abort');
  assert.equal(drawBucket('round_end'), 'round');
  // round_start buckets to 'start': STORED as the death-X next-round
  // cutoff (killEndTick) — never drawn as a world marker, but it DOES
  // carry the tall scrubber tick (see scrubberMarkerClass below).
  assert.equal(drawBucket('round_start'), 'start');
  // damage rides the draw feed for the victim-hit flash (no scrubber
  // marker — see scrubberMarkerClass); the rest stay non-drawable:
  for (const k of ['blind', 'player_connect', '']) {
    assert.equal(drawBucket(k), '', k);
  }
  // Extended spellings keep their substring buckets.
  assert.equal(drawBucket('smoke'), 'smoke');
  assert.equal(drawBucket('molotov'), 'fire');
  // DRAW_KINDS is exactly the drawable set (round_end and round_start
  // both ride it for the scrubber's tall round ticks; round_start also
  // rides it as the renderer's death-X cutoff — it never draws on the
  // map; drop/pickup ride it for the bomb evidence, damage for the map
  // flash, the plant/defuse ATTEMPT lifecycle for the progress rings
  // and cue points, and grenade_bounce as the flight path's vertices —
  // none of those adds a scrubber marker).
  assert.deepEqual([...DRAW_KINDS].sort(), [
    'bomb_defuse',
    'bomb_defuse_abort',
    'bomb_defuse_start',
    'bomb_drop',
    'bomb_explode',
    'bomb_pickup',
    'bomb_plant',
    'bomb_plant_abort',
    'bomb_plant_begin',
    'damage',
    'grenade',
    'grenade_bounce',
    'grenade_land',
    'grenade_throw',
    'kill',
    'round_end',
    'round_start',
    'weapon_drop',
    'weapon_pickup',
  ].sort());
});

test('detonationStyle / detonationStyleOf: the one weapon → visual decision', () => {
  assert.equal(detonationStyle('Smoke Grenade'), 'smoke');
  assert.equal(detonationStyle('Molotov'), 'fire');
  assert.equal(detonationStyle('Incendiary Grenade'), 'fire');
  // WHY 'he' (rewritten deliberately — this used to be 'decoy'): the
  // exploding decoy plays BaseGrenade.Explode = the HE files (spec
  // research 2026-11-07, verified 5/5 demos; CS2.md "Sound assets"
  // records the decoy has no detonation sound of its own), so one
  // animation + one sound covers both — the renderer's HE ring and
  // sfx.js's 'Decoy Grenade' → 'HE Grenade' cue remap both read this.
  assert.equal(detonationStyle('Decoy Grenade'), 'he');
  assert.equal(detonationStyle('Flashbang'), 'flash');
  assert.equal(detonationStyle('HE Grenade'), 'he');
  // Unknown / absent weapon — the generic ring, never a guess:
  assert.equal(detonationStyle('AK-47'), 'detonation');
  assert.equal(detonationStyle(''), 'detonation');
  assert.equal(detonationStyle(undefined), 'detonation');
  // detonationStyleOf prefers the row's PRE-COMPUTED bucket (it already
  // went through detonationStyle) and falls back to the weapon for a
  // generic bucket / a defensive kind spelling with no weapon.
  assert.equal(detonationStyleOf({ bucket: 'smoke', weapon: '' }), 'smoke');
  assert.equal(detonationStyleOf({ bucket: 'detonation', weapon: 'Flashbang' }), 'flash');
  assert.equal(detonationStyleOf({ bucket: 'detonation', weapon: undefined }), 'detonation');
  assert.equal(detonationStyleOf({ bucket: '', weapon: 'Molotov' }), 'fire');
  assert.equal(detonationStyleOf(null), 'detonation');
});

test('sameUtilityWeapon: exact match, Molotov ≡ Incendiary, absent never blocks', () => {
  assert.equal(sameUtilityWeapon('Smoke Grenade', 'Smoke Grenade'), true);
  assert.equal(sameUtilityWeapon('HE Grenade', 'Flashbang'), false);
  // The pairing rule: the throw records "Molotov" while the burn
  // detonation records "Incendiary Grenade" (models/weapons.go) — the
  // molotov flight must still pair.
  assert.equal(sameUtilityWeapon('Molotov', 'Incendiary Grenade'), true);
  assert.equal(sameUtilityWeapon('Incendiary Grenade', 'Molotov'), true);
  assert.equal(sameUtilityWeapon('Molotov', 'Smoke Grenade'), false);
  // Unknown on either side never vetoes a pair (the pairing's own rule).
  assert.equal(sameUtilityWeapon('', 'HE Grenade'), true);
  assert.equal(sameUtilityWeapon('HE Grenade', undefined), true);
});

test('scrubberMarkerClass maps every drawable bucket (the markers contract)', () => {
  assert.equal(scrubberMarkerClass('kill'), 'kill');
  assert.equal(scrubberMarkerClass('plant'), 'plant');
  assert.equal(scrubberMarkerClass('defuse'), 'plant');
  assert.equal(scrubberMarkerClass('explode'), 'det');
  // 'tall' is THE vertical tick: round starts take it (the default
  // category) and so do round wins — both buckets return the SAME class,
  // so the mark is never named after one of them.
  assert.equal(scrubberMarkerClass('round'), 'tall');
  assert.equal(scrubberMarkerClass('start'), 'tall');
  // Every typed grenade bucket keeps a scrubber marker (they used to
  // all be the one 'detonation' bucket)…
  for (const b of DETONATION_BUCKETS) assert.equal(scrubberMarkerClass(b), 'det', b);
  // …while bomb evidence, the plant/defuse ATTEMPT lifecycle and damage
  // stay marker-less (one plant/defuse = ONE marker, at its completion):
  assert.equal(scrubberMarkerClass('drop'), '');
  assert.equal(scrubberMarkerClass('pickup'), '');
  // …and the death-drop evidence buckets (the world layer draws them;
  // no scrubber tick, and the feed shows them only via the opt-in
  // 'drops' category — markers still key off bucket classes alone).
  assert.equal(scrubberMarkerClass('wdrop'), '');
  assert.equal(scrubberMarkerClass('wpickup'), '');
  assert.equal(scrubberMarkerClass('damage'), '');
  assert.equal(scrubberMarkerClass('plant_begin'), '');
  assert.equal(scrubberMarkerClass('plant_abort'), '');
  assert.equal(scrubberMarkerClass('defuse_start'), '');
  assert.equal(scrubberMarkerClass('defuse_abort'), '');
  // …and so does 'land': a grenade ACTIVATION (decoy rest) gets NO det
  // marker — the scrubber marks the REAL explosion (bucket 'he' now that
  // decoy detonations share the HE path), not the moment the decoy
  // started making noise.
  assert.equal(scrubberMarkerClass('land'), '');
  // …and 'bounce' too: the vertices of a flight carry no scrubber tick of
  // their own — the flight's DETONATION carries the det marker.
  assert.equal(scrubberMarkerClass('bounce'), '');
  assert.equal(scrubberMarkerClass(''), '');
  assert.equal(scrubberMarkerClass(null), '');
  // 'decoy' is no longer a bucket ANYWHERE: detonationStyle('Decoy
  // Grenade') is 'he', so DETONATION_BUCKETS lost it (the old sound-gate
  // exclusion in sfx.js died with it).
  assert.equal(DETONATION_BUCKETS.includes('decoy'), false);
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
  // The bucket follows the KIND and the weapon (grenade routing reaches
  // the renderer through this one stamping point).
  assert.equal(normalizeEvent({ ...ev, kind: 'grenade', weapon: 'Smoke Grenade' }, {}).bucket, 'smoke');
  assert.equal(normalizeEvent({ ...ev, kind: 'grenade', weapon: 'HE Grenade' }, {}).bucket, 'he');
  // The decoy ACTIVATION normalizes under grenade_lands → bucket 'land'
  // (an unclaimed kind would be dropped — normalizeEvent returns null).
  const land = normalizeEvent({ ...ev, kind: 'grenade_land', weapon: 'Decoy Grenade' }, {});
  assert.ok(land, 'grenade_land rows survive normalization');
  assert.equal(land.category, 'grenade_lands');
  assert.equal(land.bucket, 'land');
  // A BOUNCE row survives under its OWN default-OFF category with the
  // vertex bucket (unclaimed kinds are dropped), and it keeps the source
  // fields the renderer's projectile join reads — normalizeEvent spreads
  // them through.
  const bnc = normalizeEvent({ ...ev, kind: 'grenade_bounce', weapon: 'HE Grenade', posX: 3 }, {});
  assert.ok(bnc, 'grenade_bounce rows survive normalization');
  assert.equal(bnc.category, 'grenade_bounces');
  assert.equal(bnc.bucket, 'bounce');
  assert.equal(bnc.posX, 3);
  assert.equal(normalizeEvent({ ...ev, kind: 'damage' }, {}).bucket, 'damage');
  // The death-drop rows survive normalization under their own category
  // (unclaimed kinds are dropped) and carry the drop layer's buckets.
  const wdr = normalizeEvent({ ...ev, kind: 'weapon_drop', weapon: 'AK-47' }, {});
  assert.ok(wdr, 'weapon_drop rows survive normalization');
  assert.equal(wdr.category, 'drops');
  assert.equal(wdr.bucket, 'wdrop');
  assert.equal(wdr.steamId, '1', 'the dropper keeps its key (not a bomb-entity row)');
  assert.equal(
    normalizeEvent({ ...ev, kind: 'weapon_pickup', weapon: 'AK-47' }, {}).bucket,
    'wpickup',
  );
  // The plant/defuse ATTEMPT lifecycle keeps the actor's key (the
  // renderer resolves it to the dot its ring surrounds), while a
  // COMPLETED plant still attributes to the bomb entity (steamId '').
  const begin = normalizeEvent({ ...ev, kind: 'bomb_plant_begin', attacker: '42' }, {});
  assert.equal(begin.bucket, 'plant_begin');
  assert.equal(begin.category, 'bomb');
  assert.equal(begin.steamId, '42');
  assert.equal(normalizeEvent({ ...ev, kind: 'bomb_plant', attacker: '42' }, {}).steamId, '');
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
  const c = normalizeChat({ id: 4, tick: 9, round: 1, steamId: '1', name: 'alice', text: 'hi', kind: 'chat', channel: 'all' });
  assert.equal(c.key, 'c:4');
  assert.equal(c.source, 'chat');
  assert.equal(c.category, 'chat');
  assert.equal(c.who, 'alice');
  assert.equal(c.label, 'hi');
  // the chat CHANNEL rides the spread row (models.ChatRow.channel → the
  // [ALL]/[T]/[CT] tag the surfaces render); normalize* never re-derives it
  assert.equal(c.channel, 'all');

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
    roundFrom: 3,
    roundTo: 7,
    steamId: '76561198012345678',
    weapon: 'AWP',
    distMin: 10,
    distMax: 50,
    headshotOnly: true,
    bbox: { minX: -1, minY: -2, maxX: 3, maxY: 4 },
    gname: 'weapon_fire',
  };
  const q = serializeLandmarkFilter(f);
  assert.deepEqual(q, {
    cat: 'kills,chat',
    roundFrom: '3',
    roundTo: '7',
    player: '76561198012345678',
    weapon: 'AWP',
    distMin: '10',
    distMax: '50',
    hs: '1',
    bbox: '-1,-2,3,4',
    gname: 'weapon_fire',
  });
  const back = parseLandmarkFilter(q);
  assert.ok(filtersEqual(f, back), JSON.stringify([q, back]));
  assert.deepEqual(back.cats, ['kills', 'chat']);
  assert.equal(back.roundFrom, 3);
  assert.equal(back.roundTo, 7);
  assert.equal(back.steamId, '76561198012345678');
  assert.deepEqual(back.bbox, { minX: -1, minY: -2, maxX: 3, maxY: 4 });
});

// --- Feed reveal on filter arrival (shouldRevealFeed) -----------------------
// The rule entering the replay must obey: a NON-default landmark filter
// reveals the feed rail (the drill's effect must be visible), a default
// one never does, and a filter the instance ALREADY had never re-opens a
// rail the user deliberately closed. The wiring (mount + keep-alive
// activation, never in-session churn) is Replay.svelte's.

test('shouldRevealFeed: a default arrival never reveals', () => {
  // No prior filter + default arrival = silent.
  assert.equal(shouldRevealFeed(null, undefined), false);
  assert.equal(shouldRevealFeed(null, {}), false);
  assert.equal(shouldRevealFeed(null, defaultFilter()), false);
  assert.equal(shouldRevealFeed(null, parseLandmarkFilter({})), false);
  // The default cats spelled out serialize to nothing → still default.
  assert.equal(shouldRevealFeed(null, parseLandmarkFilter({ cat: 'round_starts' })), false);
  // Unset sentinels / empty values serialize to nothing → default.
  assert.equal(shouldRevealFeed(null, parseLandmarkFilter({ roundFrom: '0', roundTo: '0' })), false);
  assert.equal(shouldRevealFeed(null, parseLandmarkFilter({ player: '', weapon: '', hs: '0' })), false);
  assert.equal(shouldRevealFeed(null, parseLandmarkFilter({ bbox: 'junk' })), false); // malformed → dropped by parse
});

test('shouldRevealFeed: a fresh entry (no prior filter) reveals every non-default filter', () => {
  // Every serializable key counts on its own — the "present beyond what
  // serializes to nothing" definition.
  const cases = [
    { roundFrom: '3', roundTo: '3' },
    { bbox: '-1,-2,3,4' },
    { player: '76561198012345678' },
    { cat: 'kills' },
    { cat: '' }, // explicitly NO categories — a real state, not the default
    { weapon: 'AWP' },
    { hs: '1' },
    { gname: 'weapon_fire' },
    { distMin: '10' },
    { distMax: '50' },
  ];
  for (const q of cases) {
    assert.equal(shouldRevealFeed(null, parseLandmarkFilter(q)), true, JSON.stringify(q));
    assert.equal(shouldRevealFeed(undefined, parseLandmarkFilter(q)), true, JSON.stringify(q));
  }
});

test('shouldRevealFeed: entry context that is NOT a filter never reveals', () => {
  // ?tick=/?loop=/?sel=/?back=/?follow= are entry/navigation context, not
  // landmark filter keys — a watch link (tick + loop), a follow link
  // (back + follow) and a linked landmark (sel) all arrive silently.
  assert.equal(shouldRevealFeed(null, parseLandmarkFilter({ tick: '1200', loop: '1000,2000', back: 'match/5/round/3' })), false);
  assert.equal(shouldRevealFeed(null, parseLandmarkFilter({ follow: '76561198012345678', back: 'match/5' })), false);
  assert.equal(shouldRevealFeed(null, parseLandmarkFilter({ sel: 'e:9' })), false);
  // A ?tick= ALONE on top of an unchanged non-default filter is not a new
  // filter either — only the filter half is compared.
  const scoped = parseLandmarkFilter({ roundFrom: '3', roundTo: '3' });
  assert.equal(shouldRevealFeed(scoped, parseLandmarkFilter({ tick: '9999', roundFrom: '3', roundTo: '3' })), false);
});

test('shouldRevealFeed: the same filter never reveals (deliberate close survives)', () => {
  const f = parseLandmarkFilter({ bbox: '-1,-2,3,4', cat: 'damage' });
  assert.equal(shouldRevealFeed(f, f), false);
  assert.equal(shouldRevealFeed(f, parseLandmarkFilter({ bbox: '-1,-2,3,4', cat: 'damage' })), false);
  // The keep-alive dock expand: expandReplayHash re-arrives with the
  // instance's OWN captured query → same filter → no forced open.
  const captured = parseLandmarkFilter(serializeLandmarkFilter(f));
  assert.equal(shouldRevealFeed(f, captured), false);
  // In-session baseline + unchanged default (rail closed by the user).
  assert.equal(shouldRevealFeed(defaultFilter(), defaultFilter()), false);
});

test('shouldRevealFeed: a DIFFERENT non-default filter reveals; a default arrival still does not', () => {
  const before = parseLandmarkFilter({ roundFrom: '3', roundTo: '3' });
  assert.equal(shouldRevealFeed(before, parseLandmarkFilter({ roundFrom: '4', roundTo: '4' })), true);
  assert.equal(shouldRevealFeed(before, parseLandmarkFilter({ bbox: '-1,-2,3,4' })), true);
  assert.equal(
    shouldRevealFeed(parseLandmarkFilter({ weapon: 'AWP' }), parseLandmarkFilter({ distMax: '50' })),
    true,
  );
  // Reverting to the default differs, but the non-default half gates it:
  // a default arrival NEVER opens the rail.
  assert.equal(shouldRevealFeed(before, defaultFilter()), false);
  assert.equal(shouldRevealFeed(before, parseLandmarkFilter({})), false);
});

test('round range: inclusive, partial, 0 = unset (round 0 never exists)', () => {
  // Both bounds travel together…
  const both = parseLandmarkFilter({ roundFrom: '3', roundTo: '5' });
  assert.deepEqual([both.roundFrom, both.roundTo], [3, 5]);
  assert.deepEqual(serializeLandmarkFilter(both), { roundFrom: '3', roundTo: '5' });
  // …while a one-sided range stays one-sided through the URL: the unset
  // side serializes to nothing (min only = no max, max only = no min).
  const minOnly = parseLandmarkFilter({ roundFrom: '3' });
  assert.equal(minOnly.roundTo, 0);
  assert.deepEqual(serializeLandmarkFilter(minOnly), { roundFrom: '3' });
  const maxOnly = parseLandmarkFilter({ roundTo: '3' });
  assert.equal(maxOnly.roundFrom, 0);
  assert.deepEqual(serializeLandmarkFilter(maxOnly), { roundTo: '3' });
  // Negative bounds are real rounds (knife -2 / warmup -1).
  const knife = parseLandmarkFilter({ roundFrom: '-2', roundTo: '-1' });
  assert.deepEqual([knife.roundFrom, knife.roundTo], [-2, -1]);
  // 0 and absent both mean "unset" — never a bound to clamp to.
  assert.deepEqual(serializeLandmarkFilter(parseLandmarkFilter({ roundFrom: '0', roundTo: '0' })), {});
  assert.equal(parseLandmarkFilter({}).roundFrom, 0);
  assert.equal(parseLandmarkFilter({}).roundTo, 0);
  // Malformed bounds fall back to unset (never guessed); partial values
  // truncate to integers.
  assert.equal(parseLandmarkFilter({ roundFrom: 'x' }).roundFrom, 0);
  assert.equal(parseLandmarkFilter({ roundFrom: '2.7' }).roundFrom, 2);
});

test('distance range: inclusive, partial, 0 = open', () => {
  const both = parseLandmarkFilter({ distMin: '10', distMax: '50' });
  assert.deepEqual([both.distMin, both.distMax], [10, 50]);
  assert.deepEqual(serializeLandmarkFilter(both), { distMin: '10', distMax: '50' });
  const minOnly = parseLandmarkFilter({ distMin: '10' });
  assert.equal(minOnly.distMax, 0);
  assert.deepEqual(serializeLandmarkFilter(minOnly), { distMin: '10' });
  const maxOnly = parseLandmarkFilter({ distMax: '50' });
  assert.equal(maxOnly.distMin, 0);
  assert.deepEqual(serializeLandmarkFilter(maxOnly), { distMax: '50' });
  // 0 / absent / junk = open on that side.
  assert.equal(parseLandmarkFilter({ distMin: '0', distMax: '0' }).distMax, 0);
  assert.equal(parseLandmarkFilter({ distMin: 'x' }).distMin, 0);
  assert.deepEqual(serializeLandmarkFilter(defaultFilter()), {});
});

test('removed filter fields are gone: exact round, tick window, damage range', () => {
  // Pre-release policy: no legacy param fallbacks — the old params are
  // not read, not kept and never serialized back out.
  const f = parseLandmarkFilter({
    round: '7',
    tickFrom: '1',
    tickTo: '2',
    dmgMin: '3',
    dmgMax: '4',
    dist: '9',
  });
  for (const k of ['round', 'tickFrom', 'tickTo', 'dmgMin', 'dmgMax', 'distanceMax']) {
    assert.equal(f[k], undefined, k);
    assert.equal(DEFAULT_FILTER[k], undefined, `DEFAULT_FILTER.${k}`);
  }
  assert.deepEqual(serializeLandmarkFilter(f), {});
  assert.deepEqual(
    serializeLandmarkFilter({ ...defaultFilter(), round: 7, tickFrom: 1, dmgMin: 3, dist: 9 }),
    {},
  );
});

test('parse edge cases: empty cat = none, junk falls back, no shared arrays', () => {
  assert.deepEqual(parseLandmarkFilter({ cat: '' }).cats, []);
  // Unknown category ids are dropped, not invented.
  assert.deepEqual(parseLandmarkFilter({ cat: 'kills,bogus' }).cats, ['kills']);
  // A missing/invalid round bound means "unset" (open), never round 0.
  assert.equal(parseLandmarkFilter({ roundFrom: 'x' }).roundFrom, 0);
  assert.equal(parseLandmarkFilter({ roundTo: 'x' }).roundTo, 0);
  assert.equal(parseLandmarkFilter({}).roundFrom, 0);
  assert.equal(parseLandmarkFilter({}).roundTo, 0);
  // A malformed bbox is ignored rather than half-applied.
  assert.equal(parseLandmarkFilter({ bbox: '1,2,3' }).bbox, null);
  // Each parse gets fresh arrays (callers may mutate freely).
  const a = parseLandmarkFilter({});
  const b = parseLandmarkFilter({});
  a.cats.push('chat');
  assert.deepEqual(b.cats, ['round_starts']);
});

test('landmarkExportRows flattens the feed into canonical columns', () => {
  const rows = [
    normalizeEvent({ id: 1, seq: 0, tick: 10, round: 1, kind: 'kill', attackerName: 'a', victimName: 'b', weapon: 'ak47', dmg: 100 }, {}),
    normalizeChat({ id: 2, tick: 11, round: 1, name: 'alice', text: 'gl hf', kind: 'chat', channel: 'all' }),
  ];
  const out = landmarkExportRows(rows);
  assert.deepEqual(out[0], ['time', 'round', 'source', 'type', 'event', 'player', 'details', 'weapon', 'damage']);
  assert.deepEqual(out[1], [10, 1, 'event', 'kills', 'kill', '', '', 'ak47', 100]);
  // DELIBERATE pin change: the chat `label` is the PRECOMPOSED line — the
  // canonical fmt.chatLine (`name [tag]: text`) — while `who` stays the
  // bare name (owner's export contract; matches what the UI renders).
  assert.deepEqual(out[2], [11, 1, 'chat', 'chat', 'chat', 'alice', 'alice [ALL]: gl hf', '', '']);
});

test('export chat labels side-indicate: [ALL] always, [T]/[CT] from the side inputs', () => {
  // 14 counted rounds so switch 1 (after round 12) is in range —
  // round 13 is second-half, round 1 first-half.
  const rounds = Array.from({ length: 14 }, (_, i) => ({ number: i + 1 }));
  const sideCtx = {
    players: [
      { steamId: '1', name: 'alice', side: 'ct' },
      { steamId: '2', name: 'bob', side: 't' },
    ],
    sideSwitches: 1,
    rounds,
  };
  const all = normalizeChat({ id: 1, tick: 5, round: 13, steamId: '1', name: 'alice', text: 'gg', kind: 'chat', channel: 'all' });
  const teamCT = normalizeChat({ id: 2, tick: 6, round: 13, steamId: '1', name: 'alice', text: 'b site', kind: 'chat', channel: 'team' });
  const teamT = normalizeChat({ id: 3, tick: 7, round: 1, steamId: '1', name: 'alice', text: 'mid', kind: 'chat', channel: 'team' });
  const system = normalizeChat({ id: 4, tick: 8, round: 1, name: '', text: 'Match is live', kind: 'system' });
  const out = landmarkExportRows([all, teamCT, teamT, system], sideCtx);
  // all chat → [ALL] regardless of who spoke (alice is CT here)
  assert.equal(out[1][6], 'alice [ALL]: gg');
  // team chat → the SPEAKER'S SIDE at that round: alice finished ct, so
  // round 13 (second half) is [CT] and round 1 (first half) is [T].
  assert.equal(out[2][6], 'alice [CT]: b site');
  assert.equal(out[3][6], 'alice [T]: mid');
  // system row → plain text, no bracket, no colon
  assert.equal(out[4][6], 'Match is live');
  // `who` stays the BARE name in every chat row (the tag lives in label)
  assert.deepEqual(out.slice(1).map((r) => r[5]), ['alice', 'alice', 'alice', '']);

  // No side inputs (a surface without them) → team chat exports the line
  // WITHOUT a bracket — never a guessed side; [ALL] still applies.
  const noCtx = landmarkExportRows([all, teamCT]);
  assert.equal(noCtx[1][6], 'alice [ALL]: gg');
  assert.equal(noCtx[2][6], 'alice: b site');
});

test('precomposeChatLabels is the JSON export shape (label composed, others untouched)', () => {
  const rows = [
    normalizeEvent({ id: 1, seq: 0, tick: 10, round: 1, kind: 'kill', attackerName: 'a' }, {}),
    normalizeChat({ id: 2, tick: 11, round: 1, name: 'alice', text: 'gl hf', kind: 'chat', channel: 'all' }),
  ];
  const out = precomposeChatLabels(rows);
  assert.equal(out[0], rows[0], 'event rows pass through untouched');
  assert.equal(out[1].label, 'alice [ALL]: gl hf', 'chat label precomposed for JSON');
  assert.equal(out[1].who, 'alice', 'who stays the bare name');
  assert.equal(out[1].text, 'gl hf', 'the raw text column is preserved');
  assert.equal(rows[1].label, 'gl hf', 'the input rows are not mutated');
});
