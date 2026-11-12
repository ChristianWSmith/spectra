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
  rowCategory,
  enabledClaimOf,
  killRoleFor,
  drawBucket,
  detonationStyle,
  detonationStyleOf,
  sameUtilityWeapon,
  scrubberMarkerClass,
  typedKindsFor,
  enabledSources,
  applicableFilterFields,
  clearInapplicableFields,
  ENDPOINT_KINDS,
  SCOPED_KINDS,
  WEAPON_KINDS,
  normalizeEvent,
  normalizeWorld,
  normalizeChat,
  normalizeGeneric,
  parseLandmarkFilter,
  serializeLandmarkFilter,
  filtersEqual,
  shouldRevealFeed,
  defaultFilter,
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
  // Deaths (the SECOND view of the kill kind) is OPT-IN too — the sparse
  // default never selects a view of the kill rows.
  assert.equal(CATEGORIES.find((c) => c.id === 'deaths').default, undefined);
});

test('every category is well-formed and every typed kind is claimed at least once', () => {
  const seen = new Set();
  for (const c of CATEGORIES) {
    assert.ok(c.id && c.label && c.source, c.id);
    if (c.source === 'event') {
      assert.ok(Array.isArray(c.kinds) && c.kinds.length > 0, c.id);
      for (const k of c.kinds) {
        assert.ok(LANDMARK_KINDS.includes(k), `${c.id}: unknown kind ${k}`);
        // DELIBERATE RELAXATION — claims may be SHARED: deaths/kill are
        // two VIEWS of one row (the category is the spectra concept, the
        // kind the demo detail — the audit's translation-layer ruling at
        // the spectra↔demo boundary), so the kind → category map is
        // one-to-MANY. What must hold is COVERAGE: every kind is claimed
        // at least once — an unclaimed kind would be dropped from the
        // feed AND the draw set by normalizeEvent (the old "claimed
        // exactly once" assert died with the Deaths category).
        seen.add(k);
      }
    } else if (c.source === 'generic') {
      // Q3a: every generic category is FIXED-NAME (the nameFrom/gname
      // picker left with game_events) — a category without a name would
      // yield no feed job.
      assert.ok(c.name, c.id);
    } else {
      // Q3a: the chat path left with its category; Q3b added `sound`
      // (footsteps). An unknown source fails here rather than silently
      // rendering as something the feed has no descriptor for — and a
      // sound category must NOT claim typed kinds (kinds are the
      // events-table vocabulary; typedKindsFor/marker answers scan
      // source === 'event' only).
      assert.ok(['event', 'generic', 'sound'].includes(c.source), c.id);
      if (c.source === 'sound') assert.equal(c.kinds, undefined, c.id);
    }
  }
  // All stored kinds land in a category — no recorded activity is
  // unreachable from the feed.
  for (const k of LANDMARK_KINDS) assert.ok(seen.has(k), `unclaimed kind ${k}`);
});

test('categoryOfKind maps every kind and rejects unknown input', () => {
  assert.equal(categoryOfKind('kill'), 'kills');
  // kill is claimed TWICE — kills + deaths, IN THAT ORDER (the shared
  // claim): the FIRST claim stays 'kills' (categoryOfKind's/rowCategory's
  // fallback and the both-enabled stamp), while the ENABLED set decides
  // which view a row presents under (rowCategory below).
  assert.deepEqual(
    CATEGORIES.filter((c) => (c.kinds || []).includes('kill')).map((c) => c.id),
    ['kills', 'deaths'],
  );
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

test('rowCategory stamps the ENABLED claim (the deaths/kill view decision)', () => {
  const kill = { kind: 'kill' };
  // Kills-only → the kills view; deaths-only → the deaths view (the row
  // PRESENTS under the category the user actually has on).
  assert.equal(rowCategory(kill, ['round_starts', 'kills']), 'kills');
  assert.equal(rowCategory(kill, ['round_starts', 'deaths']), 'deaths');
  // Both → the FIRST claim wins (kills is first in CATEGORIES order) —
  // one row, one stamp, never a double-presented row.
  assert.equal(rowCategory(kill, ['kills', 'deaths']), 'kills');
  assert.equal(rowCategory(kill, ['deaths', 'kills']), 'kills');
  // Neither (the sparse default) → the canonical first claim: the stamp
  // stays 'kills' so the marker gate's cats.has() simply excludes it.
  assert.equal(rowCategory(kill, ['round_starts']), 'kills');
  assert.equal(rowCategory(kill, []), 'kills');
  // No cats at all (every non-feed caller) → first claim, exactly the
  // pre-stamping behavior.
  assert.equal(rowCategory(kill, undefined), 'kills');
  assert.equal(rowCategory(kill, null), 'kills');
  // Single-claim kinds are unaffected by the enabled set.
  assert.equal(rowCategory({ kind: 'round_start' }, ['round_starts']), 'round_starts');
  assert.equal(rowCategory({ kind: 'damage' }, ['deaths']), 'damage'); // damage never presents as deaths
  // An unclaimed kind still resolves to null (normalizeEvent's drop).
  assert.equal(rowCategory({ kind: 'teleport' }, ['kills']), null);
  assert.equal(rowCategory(null, ['kills']), null);
});

// --- World path: normalizeWorld + the enabled-claim predicate ---------------

test('DRAW_KINDS ⊆ claimed kinds (the draw fetch can never outrun the registry)', () => {
  // The world fetch is scoped to kinds: DRAW_KINDS; normalizeWorld has
  // no claim gate, so an unclaimed draw kind would still RENDER — but no
  // feed filter could ever select it. The two registries must stay in
  // step; this is the direct subset assert beside the all-kinds coverage
  // above.
  for (const k of DRAW_KINDS) {
    assert.ok(LANDMARK_KINDS.includes(k), `draw kind not in LANDMARK_KINDS: ${k}`);
    assert.ok(categoryOfKind(k), `unclaimed draw kind: ${k}`);
  }
});

test('normalizeWorld: every DRAW_KINDS kind yields a row — the world path has NO claim gate', () => {
  for (const k of DRAW_KINDS) {
    const row = normalizeWorld({ id: 7, seq: 1, tick: 64, round: 1, kind: k, weapon: 'ak47' });
    assert.ok(row, `normalizeWorld dropped ${k}`);
    assert.equal(row.key, 'e:7');
    assert.equal(row.source, 'event');
    assert.equal(row.bucket, drawBucket(k, 'ak47'), k);
    // The enabled stamp is FEED-ONLY by construction: a world row never
    // carries `category`, so no world consumer can read it (the fs-scan
    // contract pins that no lib/replay consumer references `.category`).
    assert.equal('category' in row, false, `world row carries a category stamp: ${k}`);
  }
  // The gate normalizeEvent KEEPS (the feed's) is gone on the world path:
  // a kind no category claims still normalizes for the world, still
  // drops from the feed — deleting a category can never kill a world
  // marker, a cue, the kit evidence or a live-stat row.
  const unclaimed = { id: 8, seq: 2, tick: 128, round: 1, kind: 'teleport' };
  assert.equal(normalizeEvent(unclaimed, {}), null, 'the feed gate stays');
  assert.ok(normalizeWorld(unclaimed), 'the world gate is gone');
  assert.equal(normalizeWorld(unclaimed).bucket, '', 'an un-drawable kind keeps no bucket');
  assert.equal(normalizeWorld(null), null, 'a null row yields null, never a throw');
  // No round policy either: a countedOnly kind from a knife round still
  // normalizes (round visibility is the CONSUMER'S rule — the marker
  // gate's applyRoundPref — never the shape's).
  assert.ok(normalizeWorld({ id: 9, tick: 1, round: -2, kind: 'round_start' }));
});

test('enabledClaimOf ⇔ cats.has(rowCategory) — the marker-gate equivalence', () => {
  // The scrubber gate used to read the STAMP off the row
  // (cats.has(rowCategory(row, cats))); world rows carry no stamp, so
  // the gate asks the predicate instead. For EVERY kind × a spread of
  // enabled sets the two answers must agree — that equivalence is what
  // keeps §N (deaths-only marks kill rows) green through the switch.
  const catSets = [
    DEFAULT_CATEGORIES, // the sparse default
    [],
    ['kills'],
    ['deaths'],
    ['kills', 'deaths'],
    ['round_starts', 'kills', 'deaths'],
    CATEGORIES.map((c) => c.id), // everything on
    ['bogus'], // unknown ids are never a claim
  ];
  for (const kind of LANDMARK_KINDS) {
    for (const cats of catSets) {
      const stamped = cats.includes(rowCategory({ kind }, cats));
      const gated = enabledClaimOf(kind, cats) != null;
      assert.equal(gated, stamped, `${kind} @ ${JSON.stringify(cats)}`);
    }
  }
  // No cats at all (defensive): the stamp falls back to the canonical
  // claim but the predicate says "no" — a gate must never open on an
  // absent filter, which is exactly why the gate asks the predicate.
  assert.equal(enabledClaimOf('kill', undefined), null);
  assert.equal(enabledClaimOf('kill', null), null);
});

test('killRoleFor derives the player-filter role from the CATEGORY ids', () => {
  // Both categories claim 'kill', so typedKindsFor cannot tell the
  // selections apart — the role MUST come from the ids (the endpoint
  // clause in store.queryEvents applies it to kind=kill rows only).
  assert.equal(killRoleFor(['round_starts', 'kills']), 'attacker'); // "X's kills"
  assert.equal(killRoleFor(['kills']), 'attacker');
  assert.equal(killRoleFor(['round_starts', 'deaths']), 'victim'); // "X's deaths"
  assert.equal(killRoleFor(['deaths']), 'victim');
  // Both or neither → today's either-endpoint match (no behavior change).
  assert.equal(killRoleFor(['kills', 'deaths']), 'any');
  assert.equal(killRoleFor(['round_starts']), 'any');
  assert.equal(killRoleFor([]), 'any');
  // Malformed/unknown ids behave as 'neither' → 'any' (never guessed).
  assert.equal(killRoleFor(['bogus']), 'any');
  assert.equal(killRoleFor(['kills', 'bogus']), 'attacker');
  assert.equal(killRoleFor(undefined), 'any');
  assert.equal(killRoleFor(null), 'any');
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
  // A generic category claims no typed KIND (its read is name-scoped) …
  assert.deepEqual(typedKindsFor(['buys']), []);
  // … and neither does the sound category: typedKindsFor scans
  // source === 'event' only, so footsteps can never leak into a typed
  // query (the marker answer's kind set rides this function).
  assert.deepEqual(typedKindsFor(['footsteps']), []);
  assert.deepEqual(typedKindsFor([]), []);
  assert.deepEqual(typedKindsFor(['kills', 'kills']), ['kill']);

  // convars (Q1) and chat/team_changes/game_events (Q3a) left the FE
  // registry: a stale id degrades silently here exactly like a stale URL
  // does — categoryById → null → dropped (the unknown-id-drop pin below).
  const src = enabledSources(['kills', 'buys']);
  assert.equal(src.event, true);
  assert.deepEqual(src.generic.map((c) => c.id), ['buys']);
  // Q3a: the chat PATH went with the chat category.
  assert.equal('chat' in src, false, 'enabledSources still reports a chat path');
  assert.deepEqual(enabledSources(['convars']).generic, []);
  assert.deepEqual(enabledSources(['chat']).generic, []);
  // Q3b: the sound path — footsteps alone turns it on and NOTHING else
  // (never the typed query, never a generic name read).
  const snd = enabledSources(['footsteps']);
  assert.equal(snd.sound, true);
  assert.equal(snd.event, false);
  assert.deepEqual(snd.generic, []);
  assert.equal(enabledSources(['kills']).sound, false);
  const none = enabledSources([]);
  assert.equal(none.event, false);
  assert.equal(none.sound, false);
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
  // The SHARED claim (deaths/kill): a kill row is never dropped because
  // only Deaths is enabled — it stamps as 'deaths' instead (rowCategory
  // through opts.cats), while the bucket/kind stay the demo detail.
  const drow = normalizeEvent(ev, { cats: ['deaths'] });
  assert.equal(drow.category, 'deaths');
  assert.equal(drow.bucket, 'kill');
  assert.equal(drow.attackerName, 'a');
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

  // The generic category that survived Q3a (buys → item_purchase): the
  // stamp comes from the FETCH's catId — generic sources are one
  // category per name, so there is no shared-claim question there.
  const g = normalizeGeneric(
    { rowId: 12, name: 'item_purchase', tick: 8, round: 1, payloadJson: '{}', who: 'alice', label: 'alice bought AK-47' },
    'buys',
  );
  assert.equal(g.key, 'g:12');
  assert.equal(g.source, 'generic');
  assert.equal(g.category, 'buys');
  assert.equal(g.who, 'alice');
  assert.equal(g.label, 'alice bought AK-47');
});

test('filter <-> query round-trip: defaults serialize to nothing', () => {
  // Default state → empty query ("#/replay/5" IS the sparse default).
  assert.deepEqual(serializeLandmarkFilter(defaultFilter()), {});
  assert.deepEqual(parseLandmarkFilter({}), defaultFilter());
  assert.ok(filtersEqual(defaultFilter(), parseLandmarkFilter({})));

  // The seed's cats (kills + connects) make EVERY field applicable —
  // kill carries endpoints/weapon/distance/headshot and is endpoint-
  // scoped, connects carry the player key, and the event source covers
  // bbox — so this round-trip still exercises every serializable key
  // through clearInapplicableFields (nothing gets cleared here by
  // design; the clearing pins live in the tests below).
  const f = {
    ...defaultFilter(),
    cats: ['kills', 'connects'],
    roundFrom: 3,
    roundTo: 7,
    steamId: '76561198012345678',
    weapon: 'AWP',
    distMin: 10,
    distMax: 50,
    headshotOnly: true,
    bbox: { minX: -1, minY: -2, maxX: 3, maxY: 4 },
  };
  const q = serializeLandmarkFilter(f);
  assert.deepEqual(q, {
    cat: 'kills,connects',
    roundFrom: '3',
    roundTo: '7',
    player: '76561198012345678',
    weapon: 'AWP',
    distMin: '10',
    distMax: '50',
    hs: '1',
    bbox: '-1,-2,3,4',
  });
  const back = parseLandmarkFilter(q);
  assert.ok(filtersEqual(f, back), JSON.stringify([q, back]));
  assert.deepEqual(back.cats, ['kills', 'connects']);
  assert.equal(back.roundFrom, 3);
  assert.equal(back.roundTo, 7);
  assert.equal(back.steamId, '76561198012345678');
  assert.deepEqual(back.bbox, { minX: -1, minY: -2, maxX: 3, maxY: 4 });
});

// --- Conditional fields (applicableFilterFields + clearing) ------------------
// The product-owner ruling: a field that does not apply to the enabled
// categories is REMOVED from the panel AND its value is DROPPED from the
// filter (the owner chose clear over retain — a hidden-but-retained value
// keeps invisibly filtering the list, the markers and the URL).
// applicableFilterFields is THE one derivation (replay/landmarks.js,
// beside CATEGORIES/typedKindsFor/enabledSources — FilterBar only
// consumes it); clearInapplicableFields runs inside parse (every
// arrival: URL, saved preset, CommandPalette, Heatmaps drill) and
// serialize (every write), so both halves of the round trip obey one
// rule. The DOM twins live in test/replay.dom.mjs §G/G2.

test('applicableFilterFields: the owner rule table (kind-level applicability)', () => {
  const on = (cats) => applicableFilterFields(cats);
  // Default selection (Round starts only) → every value field hides —
  // exactly the empty-list footgun the ruling complained about. The
  // event source is on, so bbox APPLIES (the chip keeps its own value
  // check and only renders when a bbox exists).
  assert.deepEqual(on(['round_starts']), {
    player: false, side: false, team: false, weapon: false, dist: false, headshot: false, bbox: true,
  });
  // buys-only → ROUND only: the generic source contributes no kinds (no
  // endpoints/scope/weapon) and there is no event source → bbox goes too.
  assert.deepEqual(on(['buys']), {
    player: false, side: false, team: false, weapon: false, dist: false, headshot: false, bbox: false,
  });
  // footsteps-only → PLAYER + ROUND (the sound source honors the player
  // key — feed.js soundSource carries/filters steamId; nothing else
  // applies, bbox included).
  assert.deepEqual(on(['footsteps']), {
    player: true, side: false, team: false, weapon: false, dist: false, headshot: false, bbox: false,
  });
  // kills → every field (endpoints, heatmap scope, weapon, distance,
  // headshot, event source).
  assert.deepEqual(on(['kills']), {
    player: true, side: true, team: true, weapon: true, dist: true, headshot: true, bbox: true,
  });
  // DIST/HS are kill-only: every other event selection hides them.
  for (const id of ['round_wins', 'damage', 'blinds', 'connects', 'grenade_dets']) {
    const f = on([id]);
    assert.equal(f.dist, false, id);
    assert.equal(f.headshot, false, id);
  }
  // SIDE/TEAM follow the endpoint-scoped set (store heatmapScopedKinds):
  // damage + the grenade family scope; round_wins/connects do not.
  assert.equal(on(['damage']).side, true);
  assert.equal(on(['grenade_throws']).side, true);
  assert.equal(on(['grenade_dets']).team, true);
  assert.equal(on(['grenade_bounces']).side, true);
  assert.equal(on(['round_wins']).side, false);
  assert.equal(on(['connects']).side, false);
  // PLAYER follows the endpoint kinds: connects/blinds/bomb carry a
  // player; round_end (playerless rows) does not — and neither does a
  // Bounce-only selection (grenade_bounce stores only the projectile).
  assert.equal(on(['connects']).player, true);
  assert.equal(on(['blinds']).player, true);
  assert.equal(on(['bomb']).player, true); // plant/defuse/drop/pickup carry the actor
  assert.equal(on(['round_wins']).player, false);
  assert.equal(on(['grenade_bounces']).player, false);
  // WEAPON follows the weapon-writing kinds: drops/grenades/bomb
  // (bomb_explode writes "C4") yes; blinds (no weapon column) no.
  assert.equal(on(['drops']).weapon, true);
  assert.equal(on(['grenade_lands']).weapon, true);
  assert.equal(on(['bomb']).weapon, true);
  assert.equal(on(['blinds']).weapon, false);
  // Empty or unknown selections: nothing applies, never a throw.
  const none = { player: false, side: false, team: false, weapon: false, dist: false, headshot: false, bbox: false };
  assert.deepEqual(on([]), none);
  assert.deepEqual(on(['bogus']), none);
  assert.deepEqual(on(undefined), none);
});

test('the applicability kind tables partition LANDMARK_KINDS (new kinds must be classified)', () => {
  // ENDPOINT_KINDS' complement is exactly the four kinds that store NO
  // attacker/victim (extract agg): the round rows, the bomb explosion
  // (bomb entity) and the grenade bounce (projectile only).
  assert.deepEqual(
    LANDMARK_KINDS.filter((k) => !ENDPOINT_KINDS.includes(k)).sort(),
    ['bomb_explode', 'grenade_bounce', 'round_end', 'round_start'],
  );
  // SCOPED_KINDS is THE store mirror: heatmapScopedKinds (kill, damage)
  // + heatmapScopedGrenades (the four projectile rows).
  assert.deepEqual(
    [...SCOPED_KINDS].sort(),
    ['damage', 'grenade', 'grenade_bounce', 'grenade_land', 'grenade_throw', 'kill'].sort(),
  );
  // WEAPON_KINDS' complement: every kind with no weapon column written
  // in internal/extract.
  assert.deepEqual(
    LANDMARK_KINDS.filter((k) => !WEAPON_KINDS.includes(k)).sort(),
    [
      'blind', 'bomb_plant', 'bomb_defuse', 'bomb_drop', 'bomb_pickup',
      'bomb_plant_begin', 'bomb_plant_abort', 'bomb_defuse_start', 'bomb_defuse_abort',
      'player_connect', 'player_disconnect', 'round_start', 'round_end',
    ].sort(),
  );
  // Both positive tables stay closed over the stored vocabulary.
  for (const k of ENDPOINT_KINDS) assert.ok(LANDMARK_KINDS.includes(k), k);
  for (const k of SCOPED_KINDS) assert.ok(LANDMARK_KINDS.includes(k), k);
  for (const k of WEAPON_KINDS) assert.ok(LANDMARK_KINDS.includes(k), k);
});

test('clearInapplicableFields at BOTH choke points: arrivals parse clean, writes serialize clean', () => {
  // ARRIVAL — a saved preset / deep link / drill carrying inapplicable
  // keys normalizes to the default payload (clear over retain)…
  const stale = parseLandmarkFilter({
    cat: 'round_starts',
    player: '76561198012345678', weapon: 'AWP', side: 'ct', team: 't',
    hs: '1', distMin: '10', distMax: '50',
  });
  assert.deepEqual(stale, defaultFilter());
  assert.deepEqual(serializeLandmarkFilter(stale), {});
  // …while the bbox chip keeps its OWN conditional: cleared only when the
  // event source is off (round_starts keeps the value; footsteps/buys
  // drop it — the chip then hides because f.bbox is null).
  assert.deepEqual(
    parseLandmarkFilter({ cat: 'round_starts', bbox: '1,2,3,4' }).bbox,
    { minX: 1, minY: 2, maxX: 3, maxY: 4 },
  );
  assert.equal(parseLandmarkFilter({ cat: 'footsteps', bbox: '1,2,3,4' }).bbox, null);
  // Applicable values survive untouched (the footgun is the hidden half,
  // not the value).
  const live = parseLandmarkFilter({
    cat: 'kills', player: '76561198012345678', weapon: 'AWP', side: 'ct', hs: '1',
  });
  assert.equal(live.steamId, '76561198012345678');
  assert.equal(live.weapon, 'AWP');
  assert.equal(live.side, 'ct');
  assert.equal(live.headshotOnly, true);
  // WRITE — a category toggle that makes a SET value inapplicable
  // rewrites the URL without it: serialize prunes against the payload's
  // OWN cats (toggleCat spreads the previous filter + the new cats
  // through here, so this is the kills-off-with-a-weapon-set path).
  assert.deepEqual(
    serializeLandmarkFilter({ ...defaultFilter(), cats: ['round_starts', 'kills'], weapon: 'AWP', side: 'ct' }),
    { cat: 'round_starts,kills', weapon: 'AWP', side: 'ct' },
  );
  assert.deepEqual(
    serializeLandmarkFilter({ ...defaultFilter(), cats: ['round_starts'], weapon: 'AWP', side: 'ct' }),
    {},
  );
  // The helper itself: the same rule against an explicit selection,
  // mutating and returning its argument.
  const f = { ...defaultFilter(), cats: ['kills'], weapon: 'AWP', steamId: 'x', distMin: 5 };
  f.cats = ['footsteps'];
  assert.equal(clearInapplicableFields(f, f.cats), f);
  assert.equal(f.weapon, ''); // the sound source carries no weapon rows
  assert.equal(f.steamId, 'x'); // footsteps honors the player → kept
  assert.equal(f.distMin, 0);
  assert.equal(f.side, '');
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
  // serializes to nothing" definition. Since the hide-and-clear ruling,
  // a key is only serializable when it APPLIES to the payload's own cats
  // (clearInapplicableFields) — so the field keys below carry a seed cat
  // that makes them applicable (kills → endpoints/weapon/distance/
  // headshot/scoped), while ROUND and bbox already apply under the
  // default selection (round starts keeps the event source on).
  const cases = [
    { roundFrom: '3', roundTo: '3' },
    { bbox: '-1,-2,3,4' },
    { cat: 'round_starts,kills', player: '76561198012345678' },
    { cat: 'kills' },
    { cat: '' }, // explicitly NO categories — a real state, not the default
    { cat: 'kills', weapon: 'AWP' },
    { cat: 'kills', hs: '1' },
    { cat: 'kills', side: 'ct' },
    { cat: 'kills', distMin: '10' },
    { cat: 'kills', distMax: '50' },
  ];
  for (const q of cases) {
    assert.equal(shouldRevealFeed(null, parseLandmarkFilter(q)), true, JSON.stringify(q));
    assert.equal(shouldRevealFeed(undefined, parseLandmarkFilter(q)), true, JSON.stringify(q));
  }
  // THE clearing counterpart (the owner's ruling): a payload whose keys
  // are ALL inapplicable to its own cats parses to the default — it has
  // no scope left to reveal, so it never opens the rail. Same payloads,
  // seed removed.
  const clearedCases = [
    { player: '76561198012345678' },
    { weapon: 'AWP' },
    { hs: '1' },
    { side: 'ct' },
    { team: 't' },
    { distMin: '10', distMax: '50' },
  ];
  for (const q of clearedCases) {
    assert.deepEqual(parseLandmarkFilter(q), defaultFilter(), JSON.stringify(q));
    assert.equal(shouldRevealFeed(null, parseLandmarkFilter(q)), false, JSON.stringify(q));
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
  // Seeded with `cat: kills` — the hide-and-clear ruling removes these
  // keys under the default selection, so the kill seed is what keeps
  // weapon/dist under test as CHANGING filters (not as cleared ones).
  assert.equal(
    shouldRevealFeed(
      parseLandmarkFilter({ cat: 'kills', weapon: 'AWP' }),
      parseLandmarkFilter({ cat: 'kills', distMax: '50' }),
    ),
    true,
  );
  // Reverting to the default differs, but the non-default half gates it:
  // a default arrival NEVER opens the rail.
  assert.equal(shouldRevealFeed(before, defaultFilter()), false);
  assert.equal(shouldRevealFeed(before, parseLandmarkFilter({})), false);
  // The side/team keys participate through the SAME serialization: a
  // side-scoped arrival is non-default (it reveals), changing ONLY side
  // counts as a different filter (it reveals over the previous side),
  // and re-arriving with the SAME side is not a change (it does not —
  // the keys are filter state, churn-safe like every other). Seeded with
  // `cat: round_starts,kills` (kill ∈ SCOPED_KINDS): without an
  // endpoint-scoped selection both keys clear to default and there is
  // deliberately nothing left to reveal — pinned below.
  const seed = 'round_starts,kills';
  assert.equal(shouldRevealFeed(defaultFilter(), parseLandmarkFilter({ cat: seed, side: 'ct' })), true);
  assert.equal(shouldRevealFeed(defaultFilter(), parseLandmarkFilter({ cat: seed, team: 't' })), true);
  assert.equal(
    shouldRevealFeed(parseLandmarkFilter({ cat: seed, side: 'ct' }), parseLandmarkFilter({ cat: seed, side: 't' })),
    true,
  );
  assert.equal(
    shouldRevealFeed(parseLandmarkFilter({ cat: seed, side: 'ct' }), parseLandmarkFilter({ cat: seed, side: 'ct' })),
    false,
  );
  // Hide-and-clear: side alone under the default selection parses to the
  // default → no reveal (the clearing ruling's reveal twin).
  assert.equal(shouldRevealFeed(null, parseLandmarkFilter({ side: 'ct' })), false);
  assert.equal(shouldRevealFeed(null, parseLandmarkFilter({ team: 't', player: '76561198012345678' })), false);
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
  // Seeded with `cat: kills`: DIST applies only while the kill kind is
  // enabled (distance is written on kill rows alone — the conditional-
  // fields ruling clears it under any other selection), so the kill seed
  // keeps the RANGE SEMANTICS — the subject of this test — observable.
  const both = parseLandmarkFilter({ cat: 'kills', distMin: '10', distMax: '50' });
  assert.deepEqual([both.distMin, both.distMax], [10, 50]);
  assert.deepEqual(serializeLandmarkFilter(both), { cat: 'kills', distMin: '10', distMax: '50' });
  const minOnly = parseLandmarkFilter({ cat: 'kills', distMin: '10' });
  assert.equal(minOnly.distMax, 0);
  assert.deepEqual(serializeLandmarkFilter(minOnly), { cat: 'kills', distMin: '10' });
  const maxOnly = parseLandmarkFilter({ cat: 'kills', distMax: '50' });
  assert.equal(maxOnly.distMin, 0);
  assert.deepEqual(serializeLandmarkFilter(maxOnly), { cat: 'kills', distMax: '50' });
  // 0 / absent / junk = open on that side.
  assert.equal(parseLandmarkFilter({ distMin: '0', distMax: '0' }).distMax, 0);
  assert.equal(parseLandmarkFilter({ distMin: 'x' }).distMin, 0);
  assert.deepEqual(serializeLandmarkFilter(defaultFilter()), {});
  // …and under a selection with no kill kind the bounds are CLEARED at
  // parse and at serialize (hide-and-clear — a hidden bound must never
  // keep constraining the list/markers/URL).
  const cleared = parseLandmarkFilter({ distMin: '10', distMax: '50' });
  assert.deepEqual([cleared.distMin, cleared.distMax], [0, 0]);
  assert.deepEqual(serializeLandmarkFilter({ ...defaultFilter(), distMin: 10 }), {});
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
  a.cats.push('connects');
  assert.deepEqual(b.cats, ['round_starts']);
});

test('side/team keys: exact ct/t only, ride the URL round-trip, absent = open', () => {
  // Absent (saved filters and links from before the keys existed) →
  // open, and the DEFAULT serializes to NOTHING (the round-trip rule —
  // a plain arrival never looks non-default just for being parsed).
  assert.equal(parseLandmarkFilter({}).side, '');
  assert.equal(parseLandmarkFilter({}).team, '');
  assert.deepEqual(serializeLandmarkFilter(defaultFilter()), {});
  // The exact wire spellings pass; everything else is dropped — never a
  // guessed side (the store's literal discipline, mirrored here). Seeded
  // with `cat: kills`: side/team are endpoint-scoped fields (kill ∈
  // SCOPED_KINDS), and the conditional-fields ruling CLEARS them under a
  // selection the endpointScopeClause clause cannot constrain — so the
  // kill seed keeps the LITERAL rule itself under test, not the clearing.
  assert.equal(parseLandmarkFilter({ cat: 'kills', side: 'ct' }).side, 'ct');
  assert.equal(parseLandmarkFilter({ cat: 'kills', side: 't' }).side, 't');
  assert.equal(parseLandmarkFilter({ cat: 'kills', team: 'ct' }).team, 'ct');
  assert.equal(parseLandmarkFilter({ cat: 'kills', side: 'CT' }).side, ''); // uppercase is not the wire
  assert.equal(parseLandmarkFilter({ cat: 'kills', side: 'x' }).side, '');
  assert.equal(parseLandmarkFilter({ cat: 'kills', team: '' }).team, '');
  // Round-trip: both keys survive serialize → parse, alone and together
  // (partial state stays partial — no other default leaks out).
  const both = { ...defaultFilter(), cats: ['kills'], side: 'ct', team: 't' };
  const q = serializeLandmarkFilter(both);
  assert.deepEqual(q, { cat: 'kills', side: 'ct', team: 't' });
  assert.ok(filtersEqual(both, parseLandmarkFilter(q)));
  assert.deepEqual(serializeLandmarkFilter({ ...defaultFilter(), cats: ['kills'], team: 't' }), { cat: 'kills', team: 't' });
  // The keys are plain FILTER state: they never carry a position (the
  // filter parse ignores ?tick= — THE position stays nav.entrySeekTick's
  // own query read, untouched by these keys).
  assert.equal(parseLandmarkFilter({ cat: 'kills', side: 'ct', tick: '99' }).tick, undefined);
  // Hide-and-clear: under the default selection (round starts — outside
  // SCOPED_KINDS) a side/team value is a NO-OP for the query, so both
  // choke points drop it — it never rides the URL or the local copy
  // invisibly filtering.
  assert.equal(parseLandmarkFilter({ side: 'ct', team: 't' }).side, '');
  assert.equal(parseLandmarkFilter({ side: 'ct', team: 't' }).team, '');
  assert.deepEqual(serializeLandmarkFilter({ ...defaultFilter(), side: 'ct' }), {});
});
