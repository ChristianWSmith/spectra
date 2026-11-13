// Canonical landmark module — THE one place the landmark VOCABULARY
// lives for the Replay landmark feed (the app's single raw-event browser
// per match): the category registry, the row shapes and the filter <-> URL
// model. The feed's RUNTIME over this vocabulary (query composition,
// source reads, paging, merge, export) is lib/replay/feed.js.
//
// This module owns:
//
//   1. CATEGORIES      — the filterable category registry (with the
//                       sparse default: round starts only).
//   2. drawBucket      — the kind → drawable bucket mapping the RENDERER
//                        and the scrubber markers consume (rows arrive
//                        pre-bucketed; neither classifies at runtime).
//   3. normalize*      — source rows (typed EventRow / ChatRow /
//                        GenericEvent) → one landmark row shape that
//                        preserves the source's own fields.
//   4. filter <-> URL  — the landmark filter model serialized to the
//                        route query (deep links, refresh, back/forward)
//                        and shouldRevealFeed, the feed-reveal-on-arrival
//                        rule over it.
//   5. conditional fields — applicableFilterFields /
//                        clearInapplicableFields: which FilterBar fields
//                        can constrain a category set at all, and the
//                        clearing rule both choke points (parse and
//                        serialize) apply so a hidden field can never
//                        keep invisibly filtering (owner ruling).
//
// NOT here (the feed RUNTIME lives in lib/replay/feed.js — the one
// filter → query composer, the source descriptors with their paging and
// merge ranks, the ?sel= resolution and the export projection): this
// file is the VOCABULARY — registry, buckets, row shapes, filter model
// — and the derivations over them (typedKindsFor / killRoleFor /
// enabledSources / rowCategory / enabledClaimOf /
// applicableFilterFields).
//
// Unit-tested by src/lib/landmarks.test.js (the lib test glob is
// src/lib/*.test.js, so the fixture lives one level up); the feed
// runtime's tests live beside it in src/lib/feed.test.js.

import { isCounted } from '../rounds.js';

// The authoritative typed-kind list: every events.kind value (mirror of
// models.EventKind — Go side; pinned by this module's test).
export const LANDMARK_KINDS = [
  'kill',
  'damage',
  'blind',
  'bomb_plant',
  'bomb_defuse',
  'bomb_explode',
  'bomb_drop',
  'bomb_pickup',
  // The plant/defuse ATTEMPT lifecycle (mirror of models.EventKind): a
  // begin/start opens an attempt the completion or the *_abort cancel
  // closes (lib/replay/bomb.js actionIntervals owns the pairing).
  'bomb_plant_begin',
  'bomb_plant_abort',
  'bomb_defuse_start',
  'bomb_defuse_abort',
  'grenade_throw',
  'grenade',
  // The dropped-gun/util map evidence (models.EventKind mirror): a
  // weapon_drop is INFERRED at a kill (extract.inferDeathDrops), a
  // weapon_pickup is the gun/util half of item_pickup. A default-OFF
  // category must claim them or normalizeEvent drops them from the
  // draw set (see CATEGORIES 'drops').
  'weapon_drop',
  'weapon_pickup',
  'grenade_land',
  // A grenade projectile BOUNCING off a surface (models.EventGrenadeBounce
  // — the CMsgSosStartSoundEvent bounce family): a positioned VERTEX of a
  // flight, neither a detonation nor a rest. Like every kind it needs a
  // category claim or normalizeEvent drops it from the feed AND the draw
  // set (see CATEGORIES 'grenade_bounces').
  'grenade_bounce',
  // The four FIRE-CUE kinds (models.EventExtinguish … EventFadeOut —
  // Wave C's typed cue rows: smoke⇄fire extinguish, the air-burst
  // failure, the detonation body-break, the fire fade-out). Audio-ONLY
  // by owner decision (2026-11-12 — NO CATEGORIES entry claims them, so
  // normalizeEvent never lists them and typedKindsFor never fetches
  // them for the feed), while normalizeWorld's claim-gate-free path
  // still yields every row for sfx.js fireCues.
  'extinguish',
  'start_failed',
  'smash',
  'fade_out',
  'round_start',
  'round_end',
  'player_connect',
  'player_disconnect',
];

// DRAW_KINDS: the typed kinds the replay world layers draw — positioned
// anchors (kills, damage, grenades, bomb incl. the dropped-C4 evidence
// rows) plus round_end and round_start (the round-cut inputs: a kill
// stamped round N can land AFTER round N's round_end, e.g. the C4
// detonation kill, so the NEXT round's start terminates it — the rows
// are STORED for that rule and never drawn as world markers). Fetched
// once per match, unfiltered by category chips: the map always shows the
// full spatial context, while the LIST and the scrubber's event markers
// follow the enabled categories.
// NEITHER round row feeds a scrubber tick any more (the owner's ruling:
// round-start ticks come from the round rows themselves — Replay's
// markers pass 1, unconditional — and the round-win tick is gone from
// the scrubber; see scrubberMarkerClass). `damage` rides here for the
// victim-hit flash only — it carries no scrubber marker (see
// scrubberMarkerClass); `grenade_land` rides it for the decoy REST
// marker (bucket 'land' — the renderer's plan pairs the throw arc to
// it; no scrubber marker either); `grenade_bounce` rides it because a
// bounce is a VERTEX of the renderer's throw→bounce→det path — the world
// layer needs those rows whether or not the 'Bounce' feed category is
// on (bucket 'bounce', no scrubber marker either).
export const DRAW_KINDS = [
  'kill',
  'damage',
  'grenade',
  'grenade_throw',
  'grenade_bounce',
  'grenade_land',
  'bomb_plant',
  'bomb_defuse',
  'bomb_explode',
  'bomb_drop',
  'bomb_pickup',
  // The plant/defuse ATTEMPT lifecycle rides the draw feed so the
  // renderer's progress rings and the sfx cue points see the whole
  // attempt (begin → completion/abort). They bucket into their OWN
  // buckets (plant_begin/plant_abort/defuse_start/defuse_abort) — never
  // 'plant'/'defuse': those buckets feed the planted-C4 beep scheduler
  // (sfx.js c4BeepRows) and the world markers, and they carry NO
  // scrubber marker (the completion tick already has one).
  'bomb_plant_begin',
  'bomb_plant_abort',
  'bomb_defuse_start',
  'bomb_defuse_abort',
  // Dropped guns/util ride the draw feed for the map's optional drop
  // layer (renderer drawDrops, gated by the toolbar's Guns/Utility
  // toggle — OFF by default). They bucket into 'wdrop'/'wpickup' —
  // NEVER 'drop'/'pickup': those are the dropped-C4 evidence buckets
  // bombEvidenceAt reads, and mixing the two would leak weapon rows
  // into the C4 reconstruction (and vice versa). No scrubber marker
  // (scrubberMarkerClass returns '' for both), and they add no feed
  // rows by default: the 'drops' category below is opt-in.
  'weapon_drop',
  'weapon_pickup',
  // The four FIRE-CUE kinds (models.EventExtinguish … EventFadeOut) ride
  // the draw fetch SOLELY so the sfx engine sees them — sfx.js fireCues
  // filters on kind and plays them on the utility bus. They bucket to ''
  // (drawBucket falls through: no cue kind contains a smoke/fire/molotov
  // substring), so the renderer's bucket switch paints nothing, the
  // scrubber's marker gate finds no claim, and ROUND_POLICY cuts nothing
  // — audio-only rows, exactly the owner's spec (play the cue, change no
  // indicator).
  'extinguish',
  'start_failed',
  'smash',
  'fade_out',
  'round_end',
  'round_start',
];

// CATEGORIES — the filterable landmark categories. GAMEPLAY-ONLY since
// Q3a: the chat / team-change / game-event filters left the surface (the
// store keeps those rows; this registry stops offering them) and `buys`
// is the one generic (fixed-name) category left, and `footsteps` (Q3b)
// is the one sound-event source. `source` picks the backend retrieval
// path (typed events / generic events / sound events);
// `kinds` (event source) or `name` (generic source) scopes the query;
// `default` categories are the sparse initial selection; `countedOnly`
// restricts the category to counted rounds (lib/rounds.js isCounted —
// legacy tolerance: every stored round is counted since the knife/warmup
// discard, but a pre-reprocess row must not enter the default
// narrative).
export const CATEGORIES = [
  { id: 'kills', label: 'Kills', short: 'kill', source: 'event', kinds: ['kill'] },
  // Deaths claims the SAME kind as Kills — deliberately SHARED: a death
  // IS a kill row (victim side), so the two are two VIEWS of one row
  // (the audit's translation-layer ruling: the category is the spectra
  // concept, the kind the demo detail). First in CATEGORIES order after
  // kills, so categoryOfKind/rowCategory's first claim stays 'kills'
  // (both-enabled rows present as kills — the enabled set decides which
  // view a row shows under: see rowCategory). Default-OFF like every
  // non-sparse category; no new kind, so LANDMARK_KINDS/DRAW_KINDS are
  // untouched.
  { id: 'deaths', label: 'Deaths', short: 'death', source: 'event', kinds: ['kill'] },
  { id: 'round_wins', label: 'Round wins', short: 'win', source: 'event', kinds: ['round_end'], countedOnly: true },
  { id: 'round_starts', label: 'Round starts', short: 'start', source: 'event', kinds: ['round_start'], default: true, countedOnly: true },
  { id: 'bomb', label: 'Bomb', short: 'bomb', source: 'event', kinds: ['bomb_plant', 'bomb_defuse', 'bomb_explode', 'bomb_drop', 'bomb_pickup', 'bomb_plant_begin', 'bomb_plant_abort', 'bomb_defuse_start', 'bomb_defuse_abort'] },
  // The death-drop evidence rows. Their OWN category on purpose (the
  // grenade_lands precedent): normalizeEvent REQUIRES a category to
  // claim a kind (unclaimed kinds are dropped from the draw set
  // entirely), but the drops are a WORLD LAYER first — the category is
  // opt-in like every non-sparse one, default OFF, so the feed's
  // default (round starts) and its scrubber markers are unchanged; the
  // map's rows ride DRAW_KINDS regardless (never filtered by chips).
  { id: 'drops', label: 'Dropped items', short: 'drop', source: 'event', kinds: ['weapon_drop', 'weapon_pickup'] },
  { id: 'grenade_throws', label: 'Grenade throws', short: 'throw', source: 'event', kinds: ['grenade_throw'] },
  { id: 'grenade_dets', label: 'Grenade detonations', short: 'det', source: 'event', kinds: ['grenade'] },
  // The grenade's ACTIVATION (it came to rest — models.EventGrenadeLand,
  // the decoy's decoy_started). Its OWN category on purpose: it is not a
  // detonation (it never claims grenade_dets' kinds, so heatkinds' region
  // drill and the det scrubber markers stay untouched) and it needs SOME
  // category to normalize under (normalizeEvent drops unclaimed kinds).
  // Opt-in like every non-sparse category; default OFF.
  { id: 'grenade_lands', label: 'Grenade landings', short: 'land', source: 'event', kinds: ['grenade_land'] },
  // The grenade's BOUNCE rows (models.EventGrenadeBounce — the five SOS
  // bounce soundevents). Their OWN category on purpose (the grenade_lands
  // precedent): normalizeEvent REQUIRES a category to claim a kind, but
  // the rows are a WORLD-LAYER input FIRST — the renderer builds its
  // multi-segment throw→bounce→det path from them regardless of the chips
  // (they ride DRAW_KINDS), while the feed lists them only when this
  // opt-in, default-OFF category is on. No scrubber marker either
  // (scrubberMarkerClass 'bounce' → '').
  { id: 'grenade_bounces', label: 'Bounce', short: 'bounce', source: 'event', kinds: ['grenade_bounce'] },
  { id: 'damage', label: 'Damage', short: 'dmg', source: 'event', kinds: ['damage'] },
  { id: 'blinds', label: 'Flashes & blinds', short: 'flash', source: 'event', kinds: ['blind'] },
  { id: 'connects', label: 'Joins & leaves', short: 'join/leave', source: 'event', kinds: ['player_connect', 'player_disconnect'] },
  // Q3a (gameplay-only ruling): `chat`, `team_changes` and `game_events`
  // (the gname name-picker) are CUT from the filter surface — the store
  // keeps their rows, only this filter stops offering them. `buys` is
  // the one generic category that remains: a FIXED-NAME read (no picker,
  // no histogram), one job in feed.genericSource per filter that enables
  // it.
  { id: 'buys', label: 'Buys', short: 'buy', source: 'generic', name: 'item_purchase' },
  // Q3b: the player-sound rows (step/jump/land/fall — sound_events, NOT
  // the events table) as a feed source. Its OWN `source: 'sound'` value
  // is the whole point: typedKindsFor / categoryOfKind / enabledClaimOf
  // all scan `source === 'event'`, so footsteps can never leak into a
  // typed query, a world row or the scrubber-marker answer. Its kinds
  // are deliberately NOT listed here (kinds = the typed-event vocabulary
  // — LANDMARK_KINDS is the pinned models.EventKind mirror) and NOT in
  // LANDMARK_KINDS; the row carries its own `kind` (step/jump/land/fall).
  { id: 'footsteps', label: 'Footsteps', short: 'step', source: 'sound' },
];

// The sparse default: round starts only — every other category is
// opt-in (PRD §5.5), even when its data exists.
export const DEFAULT_CATEGORIES = CATEGORIES.filter((c) => c.default).map((c) => c.id);

export function categoryById(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}

// categoryOfKind maps a typed events.kind onto its category id (or null
// for a kind no category claims — the stored vocabulary is closed, so
// null only ever hits unknown input). SHARED claims resolve to the FIRST
// claim in CATEGORIES order (kill → 'kills', with Deaths second) — the
// canonical first claim; which view a row PRESENTS as is rowCategory's
// job (the enabled set decides).
export function categoryOfKind(kind) {
  const k = String(kind || '');
  const cat = CATEGORIES.find((c) => c.source === 'event' && (c.kinds || []).includes(k));
  return cat ? cat.id : null;
}

// rowCategory — THE enabled-claim stamp (one canonical resolution): the
// category the user actually has ENABLED for this row's kind — the first
// claim (CATEGORIES order) among the enabled set — falling back to the
// canonical first claim (categoryOfKind) when NO claim is enabled (an
// unfiltered draw row under a sparse selection: its stamp stays 'kills'
// and the scrubber-marker gate simply excludes it). Shared claims are
// two VIEWS of one row (deaths/kill — the category IS the spectra
// concept, the kind the demo detail), so the ENABLED set decides which
// view the row presents under: kills-only → 'kills', deaths-only →
// 'deaths', both → 'kills' (first claim wins). Pure — unit-tested by
// src/lib/landmarks.test.js; every FEED consumer (list chips, the export
// `type` column, the ?sel= detail) reads the stamp normalizeEvent sets
// through this, so no site re-derives it. The WORLD path never stamps —
// see normalizeWorld.
export function rowCategory(row, cats) {
  return enabledClaimOf((row && row.kind) || '', cats) || categoryOfKind((row && row.kind) || '');
}

// enabledClaimOf — THE pure enabled-claim answer for a KIND: the first
// category claiming `kind` (CATEGORIES order) that the enabled set
// contains, or null when none is enabled. rowCategory is exactly this
// rule plus the canonical first-claim fallback (that is the stamp); the
// raw answer is what a GATE needs — "may a row of this kind show?" —
// where a null must mean NO, not "fall back to a claim nobody enabled".
// Array-shaped like rowCategory (callers pass filter.cats verbatim).
// Pure — unit-tested by src/lib/landmarks.test.js, which pins the
// equivalence every marker gate relies on:
//   cats.has(rowCategory(row, cats))  ⇔  enabledClaimOf(row.kind, cats) != null
// (the §N deaths-only case is one row of that matrix).
export function enabledClaimOf(kind, cats) {
  if (!cats) return null;
  const k = String(kind || '');
  const enabled = CATEGORIES.find(
    (c) => c.source === 'event' && (c.kinds || []).includes(k) && cats.includes(c.id),
  );
  return enabled ? enabled.id : null;
}

// detonationStyle — THE weapon → detonation-visual decision (pure; the
// renderer's world layer and drawBucket both read it, so a grenade's
// bucket and its on-map detonation visual can never disagree). Input is
// the canonical demoinfocs EquipmentType.String() spelling every
// events.weapon writer emits (internal/models/weapons.go
// utilityWeaponKinds pins the same set on the Go side; Molotov ≡
// Incendiary). Unknown/absent weapon → 'detonation' (the generic
// expanding ring — never guessed, never thrown).
// Decoy Grenade → 'he': the domain fact (spec research 2026-11-07,
// verified 5/5 demos) is that an exploding decoy plays BaseGrenade.Explode
// — the SAME sound as an HE grenade (CS2.md "Sound assets": the decoy has
// no detonation sound of its own) — so its detonation renders and sounds
// through the HE path (sfx.js remaps the cue to "HE Grenade"). The old
// 'decoy' pulse bucket is gone with it.
export function detonationStyle(weapon) {
  switch (String(weapon || '')) {
    case 'Smoke Grenade':
      return 'smoke';
    case 'Molotov':
    case 'Incendiary Grenade':
      return 'fire';
    case 'Flashbang':
      return 'flash';
    case 'HE Grenade':
    case 'Decoy Grenade': // BaseGrenade.Explode — the HE files (see above)
      return 'he';
    default:
      return 'detonation';
  }
}

// DETONATION_BUCKETS — every drawable grenade bucket drawBucket can
// produce (the generic 'detonation' plus the typed ones). The
// renderer's setLandmarks routes all of them through its detonation
// loop; 'smoke'/'fire' rows additionally feed the lingering-area arrays.
// 'decoy' is deliberately ABSENT: a decoy detonation buckets 'he'
// (detonationStyle — BaseGrenade.Explode), and its ACTIVATION buckets
// 'land' (drawBucket), which is not a detonation at all.
export const DETONATION_BUCKETS = ['detonation', 'smoke', 'fire', 'flash', 'he'];

// detonationStyleOf — the style of one PRE-BUCKETED row: the bucket
// already carries it (drawBucket routed the row through detonationStyle),
// so prefer the bucket and fall back to the weapon decision for a row
// whose bucket is the generic 'detonation' (or a defensive kind spelling
// with no weapon). Pure — unit-tested by src/lib/landmarks.test.js.
export function detonationStyleOf(row) {
  const b = String((row && row.bucket) || '');
  if (b !== 'detonation' && DETONATION_BUCKETS.includes(b)) return b;
  return detonationStyle(row && row.weapon);
}

// sameUtilityWeapon — throw→detonate weapon equality for the renderer's
// pairing (JS twin of the Molotov ≡ Incendiary rule in
// internal/models/weapons.go utilityWeaponKinds): the throw records the
// projectile's weapon ("Molotov") while the burn detonation records
// "Incendiary Grenade" for BOTH teams' flames, so exact matching never
// pairs a molotov and its flight never animates. Exact match otherwise;
// an unknown side on either row never blocks a pair (the pairing's own
// rule — absent data must not veto a match). Pure — unit-tested by
// src/lib/landmarks.test.js.
export function sameUtilityWeapon(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  const molotov = (w) => w === 'Molotov' || w === 'Incendiary Grenade';
  return molotov(a) && molotov(b);
}

// scrubberMarkerClass — the bucket → scrubber-marker class mapping the
// feed's markers derivation (Replay.svelte) consumes; '' = no marker.
// Kept here so the one categorization module owns the whole bucket
// contract: every drawable bucket the world layers draw stays meaningful
// on the scrubber, including the typed grenade buckets. 'tall' is THE
// tall tick mark (style.css .scrub-marker.tall) and it is round STARTS'
// class only: the scrubber draws those ticks from the match's own round
// rows (Replay.svelte's markers pass 1), unconditionally — the owner's
// ruling: round-start ticks always draw regardless of filter and are the
// ONLY tick marks. ROUND WINS carry NO scrubber mark ('round' → '' — the
// round-win tick is removed from the scrubber; its feed rows, category
// and map/world presence are untouched). Note the scrubber skips
// round_start/round_end world rows before consulting this mapping, so
// 'start' survives as the vocabulary for the class pass 1 emits (and the
// never-duplicated-tick rule lives in the view), never as a second source
// of ticks. Pure — unit-tested by src/lib/landmarks.test.js.
export function scrubberMarkerClass(bucket) {
  const b = String(bucket || '');
  if (b === 'kill') return 'kill';
  if (b === 'plant' || b === 'defuse') return 'plant';
  if (b === 'explode' || DETONATION_BUCKETS.includes(b)) return 'det';
  if (b === 'start') return 'tall';
  return ''; // 'round' (a round WIN — no scrubber tick since the ruling
  //             above), 'drop'/'pickup' (bomb evidence), 'wdrop'/'wpickup'
  //             (weapon evidence — the drop layer draws from the world,
  //             no scrubber tick), the plant/defuse ATTEMPT
  //             lifecycle buckets (the completion tick already carries the
  //             marker), 'damage' and 'land' (a grenade ACTIVATION — the
  //             real explosion carries the det marker) and 'bounce' (the
  //             vertices of a flight — its detonation carries the det
  //             marker) — no marker
}

// drawBucket maps a typed kind onto the drawable bucket the renderer and
// scrubber markers consume ('' = not drawn / no marker). Precomputed at
// normalization time — neither the renderer nor the scrubber classifies
// anything at runtime (PRD §5.5). `grenade` rows route by WEAPON
// (detonationStyle) so the renderer's lingering smoke/fire arrays and
// per-type detonation visuals reach it — the substring branches below
// keep the extended kind spellings bucketing the same way. `grenade_land`
// buckets 'land' — the REST position marker (a grenade coming to rest is
// NOT a detonation: no det scrubber marker, no detonation visual; the
// renderer pairs the throw arc to it and its decoy plan draws the rest
// icon from there). damage → 'damage' (the victim-hit flash).
// bomb_drop/bomb_pickup bucket into 'drop'/'pickup' — the DROPPED-C4
// evidence rows the renderer's reconstruction (lib/replay/bomb.js)
// consumes; they and 'damage' carry no scrubber marker
// (scrubberMarkerClass returns '' for them).
// round_start buckets to 'start' — the death-X cutoff row the renderer
// STORES as a round start (killEndTick's next-round terminator); it is
// never drawn as a world marker and it no longer sources a scrubber tick
// either: the scrubber's round-start ticks come from the round ROWS
// themselves (Replay's markers pass 1, unconditional — the owner's
// ruling), so 'start' stays the bucket vocabulary and the class pass 1
// emits (scrubberMarkerClass 'tall'), never a second tick source.
// round_end buckets to 'round' — the round-cut input only; the round-win
// tick was removed from the scrubber (scrubberMarkerClass 'round' → '').
// The plant/defuse ATTEMPT lifecycle buckets into its OWN four buckets
// (plant_begin/plant_abort/defuse_start/defuse_abort): they are neither
// 'plant'/'defuse' (those feed the planted-C4 beep scheduler and the
// world markers) nor drawable-world rows — scrubberMarkerClass returns
// '' for all four, so one plant/defuse still makes ONE scrubber marker
// (at its completion tick). The renderer's progress rings read the ROWS
// (lib/replay/bomb.js actionIntervals), not these buckets' geometry.
export function drawBucket(kind, weapon) {
  const k = String(kind || '').toLowerCase();
  if (k === 'kill') return 'kill';
  if (k === 'grenade_throw') return 'throw';
  if (k === 'grenade_land') return 'land';
  // A projectile BOUNCE: a vertex of the renderer's flight path (not a
  // detonation, not a rest) — its own bucket so the renderer can collect
  // the rows without touching the det/land pairing pools, marker-less on
  // the scrubber (scrubberMarkerClass) and feed-visible only through the
  // opt-in 'grenade_bounces' category.
  if (k === 'grenade_bounce') return 'bounce';
  if (k === 'grenade') return detonationStyle(weapon);
  if (k === 'damage') return 'damage';
  if (k.includes('smoke')) return 'smoke';
  if (k.includes('fire') || k.includes('molotov')) return 'fire';
  if (k === 'bomb_plant') return 'plant';
  if (k === 'bomb_explode') return 'explode';
  if (k === 'bomb_defuse') return 'defuse';
  if (k === 'bomb_drop') return 'drop';
  if (k === 'bomb_pickup') return 'pickup';
  // The death-drop evidence buckets — DISTINCT from 'drop'/'pickup'
  // (the dropped-C4 reconstruction's lists): drawDrops consumes these,
  // bombEvidenceAt must never see a weapon row or the C4 marker would
  // vanish when a gun is picked up. Marker-less (scrubberMarkerClass).
  if (k === 'weapon_drop') return 'wdrop';
  if (k === 'weapon_pickup') return 'wpickup';
  if (k === 'bomb_plant_begin') return 'plant_begin';
  if (k === 'bomb_plant_abort') return 'plant_abort';
  if (k === 'bomb_defuse_start') return 'defuse_start';
  if (k === 'bomb_defuse_abort') return 'defuse_abort';
  if (k === 'round_end') return 'round';
  if (k === 'round_start') return 'start';
  return '';
}

// typedKindsFor unions the typed kinds of the enabled categories — the
// single IN-filter the typed-event query fetches with.
export function typedKindsFor(catIds) {
  const kinds = [];
  for (const id of catIds) {
    const c = categoryById(id);
    if (c && c.source === 'event') {
      for (const k of c.kinds || []) if (!kinds.includes(k)) kinds.push(k);
    }
  }
  return kinds;
}

// enabledSources reports which retrieval paths the feed needs for a
// category set (the backend keeps one path per source). The path split
// follows the registry: `event` (typed), `generic` (a fixed name) and
// `sound` (the Q3b footsteps source) — the chat path left with its
// category in Q3a. `event`/`sound` are booleans (one category each
// today), `generic` returns the records because its jobs are per-name.
export function enabledSources(catIds) {
  const cats = catIds.map(categoryById).filter(Boolean);
  return {
    event: cats.some((c) => c.source === 'event'),
    generic: cats.filter((c) => c.source === 'generic'),
    sound: cats.some((c) => c.source === 'sound'),
  };
}

// --- Conditional filter fields (applicability + clearing) ----------------------
//
// The product-owner ruling behind both helpers below: "many of these
// filter options only apply to certain subsets of events, so it's bad to
// show all of them all the time" — a field that does not apply to the
// currently enabled categories is REMOVED from the panel AND its value
// is DROPPED from the filter (the owner explicitly chose clear over
// retain: a hidden-but-retained value keeps invisibly filtering the
// list, the scrubber markers and the URL).
//
// The kind sets are derived from the STORE's own clauses
// (internal/store/queries.go eventWhere / endpointScopeClause /
// heatmapScopedKinds) and the row writers in internal/extract — never
// re-expressed in a component. FilterBar only CONSUMES
// applicableFilterFields; the parse/serialize choke points below are the
// only places clearInapplicableFields runs.

// ENDPOINT_KINDS — every typed kind whose rows carry an attacker/victim
// endpoint, i.e. the kinds the PLAYER filter can actually constrain
// (eventWhere: `e.attacker = ? OR e.victim = ?`). Write sites in
// internal/extract: agg.kill/hurt/blind write Attacker+Victim,
// agg.grenadeBlast/grenadeThrown/decoyLanded write the thrower,
// agg.weaponDrop/weaponPickedUp and the bomb lifecycle
// (plant/defuse/attempts/drop/pickup) write the actor, and
// agg.connect/disconnect stamp the player key. The COMPLEMENT of this
// set (pinned by the unit test) is the eight kinds that store NO player:
// round_start / round_end (agg.roundStart/roundEnd — playerless rows),
// bomb_explode (the bomb entity), grenade_bounce (the projectile
// only) and the four FIRE-CUE kinds (sos.go fireCue: their source entity
// is a projectile/inferno, never resolved to a participant). Footsteps
// rides PLAYER through the sound SOURCE instead — see
// applicableFilterFields.
export const ENDPOINT_KINDS = [
  'kill',
  'damage',
  'blind',
  'grenade',
  'grenade_throw',
  'grenade_land',
  'weapon_drop',
  'weapon_pickup',
  'bomb_plant',
  'bomb_defuse',
  'bomb_plant_begin',
  'bomb_plant_abort',
  'bomb_defuse_start',
  'bomb_defuse_abort',
  'bomb_drop',
  'bomb_pickup',
  'player_connect',
  'player_disconnect',
];

// SCOPED_KINDS — every typed kind the SIDE/TEAM keys constrain: THE
// mirror of store queries.go heatmapScopedKinds + heatmapScopedGrenades
// (kill, damage and the four grenade projectile rows — throw/det/bounce/
// land, "same thrower, same side"). Every OTHER kind is an UNSCOPED
// no-op under endpointScopeClause's `kind NOT IN (…)` arm — for pure
// round_starts/connects/buys/footsteps a side/team value filters
// nothing, so those fields hide.
export const SCOPED_KINDS = [
  'kill',
  'damage',
  'grenade',
  'grenade_throw',
  'grenade_bounce',
  'grenade_land',
];

// WEAPON_KINDS — every typed kind whose row carries a weapon value, so
// the WEAPON select can constrain it (eventWhere: `e.weapon = ?`).
// Write sites in internal/extract: agg.kill (k.weapon), agg.hurt
// (damage), agg.grenadeBlast / grenadeThrown / grenadeBounced +
// handlers.decoyLanded (the grenade family), agg.inferDeathDrops output
// (weapon_drop), agg.weaponPickedUp (weapon_pickup), agg.bombExploded
// ("C4") — plus Wave C's fire cues whose soundevent NAME spells the nade
// (sos.go fireCueDefs: start_failed and smash rows carry Molotov /
// Incendiary Grenade; the extinguish/fade cues are nade-agnostic — ONE
// sound for both nades — and write NO weapon, so they stay in the
// complement). The COMPLEMENT (pinned) is the playerless/player-keyed
// kinds that store no weapon: blind, the bomb plant/defuse lifecycle
// (drop/pickup included — the dropped C4 row carries no weapon column),
// connect/disconnect, the round rows and the two nade-agnostic fire
// cues. The generic `buys` category has NO kinds at all, so buys-only
// exposes no weapon either (the weapon clause only ever reaches typed
// rows).
export const WEAPON_KINDS = [
  'kill',
  'damage',
  'grenade',
  'grenade_throw',
  'grenade_bounce',
  'grenade_land',
  'weapon_drop',
  'weapon_pickup',
  'bomb_explode',
  // Wave C's nade-spelled fire cues (their rows carry the weapon column;
  // extinguish/fade_out deliberately do NOT — see the complement above).
  'start_failed',
  'smash',
];

// applicableFilterFields — THE conditional-field derivation: which
// FilterBar fields apply to a category selection (pure; unit-tested by
// src/lib/landmarks.test.js against the owner's rule table). Keys are
// the field names, `true` = the field applies:
//
//   player    — any enabled kind carries attacker/victim endpoints
//               (round_start/round_end carry NONE — so this hides under
//               the default selection), OR the sound source is enabled
//               (footsteps rows are per-player and the feed honors the
//               player key on that source).
//   side/team — any enabled kind is endpoint-scoped in
//               store.endpointScopeClause (SCOPED_KINDS — kill/damage/
//               grenade family; no-ops for everything else → hide).
//   weapon    — any enabled kind carries a weapon value (WEAPON_KINDS).
//   dist      — the `kill` kind is enabled (distance is written only on
//               kill rows).
//   headshot  — the `kill` kind is enabled (headshot only written on
//               kill rows).
//   bbox      — the event source is enabled (the bbox predicate lives in
//               eventWhere over typed rows only; the chip additionally
//               keeps its own `{#if f.bbox}` value check).
//
// ALWAYS visible (never keyed off the selection): the Categories
// dropdown, ROUND from–to, the saved-filter chrome and Reset. Accepts
// any catIds array shape (unknown ids are dropped; a missing/empty
// selection → nothing applies — no throw).
export function applicableFilterFields(catIds) {
  const ids = catIds || [];
  const kinds = typedKindsFor(ids);
  const src = enabledSources(ids);
  const any = (list) => kinds.some((k) => list.includes(k));
  return {
    player: any(ENDPOINT_KINDS) || src.sound,
    side: any(SCOPED_KINDS),
    team: any(SCOPED_KINDS),
    weapon: any(WEAPON_KINDS),
    dist: kinds.includes('kill'),
    headshot: kinds.includes('kill'),
    bbox: src.event,
  };
}

// killRoleFor — THE player-filter role derivation for kind='kill' rows
// (pure; unit-tested by src/lib/landmarks.test.js, applied by
// store.queryEvents): Kills-only means "X's kills" (attacker),
// Deaths-only means "X's deaths" (victim), both or neither → 'any'
// (today's either-endpoint match — no clause Go-side). The role MUST
// come from the CATEGORY ids, never the kinds: both categories claim
// 'kill', so typedKindsFor cannot tell the two selections apart.
// Applies only to kill rows (every other kind keeps attacker-OR-victim
// — "involved in" for damage/blinds) and only with a player selected
// (store-side guard). Malformed/unknown ids behave as 'neither' → 'any'.
export function killRoleFor(catIds) {
  const cats = new Set(catIds || []);
  const kills = cats.has('kills');
  const deaths = cats.has('deaths');
  if (kills && !deaths) return 'attacker';
  if (deaths && !kills) return 'victim';
  return 'any';
}

// --- Normalization -----------------------------------------------------------

// roundsByNumber builds the counted-round lookup from a GetRounds array
// (Replay already loads rounds for its jump selector).
export function roundsByNumber(rounds) {
  return new Map((rounds || []).map((r) => [r.number, r]));
}

// normalizeEvent converts one typed EventRow into a landmark row.
// opts.roundsByNumber + the category's countedOnly rule drop knife /
// warmup round-win rows from the sparse narrative (a round the lookup
// does not know is kept — defensive, never invented). opts.policy=false
// skips the round policy (CompareRounds shows every row the user asked
// to compare). opts.cats is the ENABLED category set — the row is
// STAMPED with its enabled claim (rowCategory: kills-only → 'kills',
// deaths-only → 'deaths', both → 'kills'), which is what the list chips,
// the export `type` column and the scrubber-marker gate read; absent
// (every non-feed caller — CompareRounds, the ?sel= detail, the unit
// fixtures) the stamp is the canonical first claim, exactly as before.
// Returns null when no category claims the kind (shared claims count —
// a kill row is never dropped because only Deaths is enabled).
export function normalizeEvent(ev, opts = {}) {
  const category = rowCategory(ev, opts.cats);
  if (!category) return null;
  if (opts.policy !== false) {
    const cat = categoryById(category);
    if (cat && cat.countedOnly && opts.roundsByNumber) {
      // The canonical rule is lib/rounds.js isCounted — legacy
      // tolerance: every stored round is counted since the knife/warmup
      // discard, but a pre-reprocess negative row must not enter a
      // counted-only narrative; a round the lookup does not know is kept.
      const r = opts.roundsByNumber.get(ev.round);
      if (r && !isCounted(r)) return null;
    }
  }
  // Note on attribution: the completed plant/defuse/explode rows
  // attribute to the BOMB ENTITY (steamId ''), but the ATTEMPT
  // lifecycle rows (begin/abort) keep ev.attacker — a begin/abort IS the
  // planter/defuser, and the renderer resolves that key to the dot its
  // progress ring surrounds.
  return {
    ...ev,
    key: 'e:' + ev.id,
    source: 'event',
    category,
    bucket: drawBucket(ev.kind, ev.weapon),
    // Landmark position/attribution aliases the renderer's world layers
    // consume (the shared landmark representation — EventRow keeps its
    // posX/posY/posZ for everything else). Bomb events attribute to the
    // bomb entity, not a player.
    x: ev.posX ?? null,
    y: ev.posY ?? null,
    z: ev.posZ ?? null,
    steamId:
      ev.kind === 'bomb_plant' || ev.kind === 'bomb_defuse' || ev.kind === 'bomb_explode'
        ? ''
        : ev.attacker || '',
    who: '',
    label: '',
  };
}

// normalizeWorld — THE world-path normalizer: the SAME row shape
// normalizeEvent builds for the renderer / sfx / kit evidence / decoy
// plan / live-stats dataset, with the two FEED rules stripped off:
//
//   1. NO claim gate. Every row the draw fetch returns (kinds:
//      DRAW_KINDS — already scoped upstream in the fetch) normalizes to
//      a row, whatever CATEGORIES claims. Deleting a category can never
//      drop a world marker, an audio cue, the kit evidence or a
//      live-stat row — the claim gate is a FEED concept (rowCategory)
//      and lives only there. A kind no category claims still yields a
//      row (bucket '' = not drawn, never a null).
//   2. NO round policy (no countedOnly drop, no roundsByNumber): the
//      world shows the full spatial context — the consumers that need
//      round-visibility apply it themselves where they mean it (the
//      scrubber-marker gate's countedOnly rule), never in the shape.
//
// The returned row deliberately carries NO `category` field: the enabled
// stamp is feed-only by construction, so no world consumer can read it
// (the fs-scan contract in src/lib/replay-world-contract.test.js pins
// that no lib/replay/{renderer,sfx,kits,drops,bomb,decoy,livestats,
// roundcut,playercard}.js references `.category` at all). `key`,
// `bucket`, the position/attribution aliases and `source` are shared
// with the feed rows — the world and the feed are two READS of one
// event vocabulary, not two vocabularies.
// Unit-tested by src/lib/landmarks.test.js (every DRAW_KINDS kind → a
// row, claim-gate-free).
export function normalizeWorld(ev) {
  if (!ev) return null; // defensive: a null row yields null, never a throw
  return {
    ...ev,
    key: 'e:' + ev.id,
    source: 'event',
    bucket: drawBucket(ev.kind, ev.weapon),
    // Landmark position/attribution aliases the renderer's world layers
    // consume (the shared landmark representation — EventRow keeps its
    // posX/posY/posZ for everything else). Bomb events attribute to the
    // bomb entity, not a player.
    x: ev.posX ?? null,
    y: ev.posY ?? null,
    z: ev.posZ ?? null,
    steamId:
      ev.kind === 'bomb_plant' || ev.kind === 'bomb_defuse' || ev.kind === 'bomb_explode'
        ? ''
        : ev.attacker || '',
    who: '',
    label: '',
  };
}

// normalizeChat converts one ChatRow into a landmark row. The round
// clock ("RD12 1:23" with the match-relative fallback) is a formatting
// concern — lib/fmt.js chatClock — not part of the row.
// KEPT (not dead): no FEED SOURCE produces chat rows since Q3a cut the
// chat category, but the chat ROW SHAPE is still vocabulary — the shared
// LandmarkRow renders it (pinned by landmark-row.dom.mjs), RoundDetail
// shows the same ChatRow vocabulary through its own round-chat list, and
// a surface that lists chat again just re-registers a source (feed.js'
// chatSource is the deleted template). Removing this would cascade into
// LandmarkRow's chat display contract for no product gain.
export function normalizeChat(c) {
  return {
    ...c,
    key: 'c:' + c.id,
    source: 'chat',
    category: 'chat',
    bucket: '',
    who: c.name || '',
    label: c.text || '',
  };
}

// normalizeGeneric converts one GenericEvent into a landmark row under
// the given category. who/label come back pre-parsed from the ONE Go
// labeler (eventlabels.go) — no payload parsing happens here.
export function normalizeGeneric(g, category) {
  return {
    ...g,
    key: 'g:' + g.rowId,
    source: 'generic',
    category,
    bucket: '',
    who: g.who || '',
    label: g.label || '',
  };
}

// --- Filter model <-> route query -------------------------------------------

// The landmark filter — the durable state that lives in the URL
// (#/replay/:id?cat=…&roundFrom=…&roundTo=…). Everything here survives
// navigation, refresh and deep links; transient playback state (engine
// tick, selection) rides the same query as tick/sel but is not "the
// filter".
//
// Range fields (roundFrom/roundTo, distMin/distMax) are INCLUSIVE and
// PARTIAL: 0/absent = open on that side (min only = no max, max only =
// no min, both 0 = unconstrained). Round values are round NUMBERS —
// negative = knife/warmup rounds — and 0 is the "unset" sentinel (round
// 0 never exists), never a bound to clamp to.
export const DEFAULT_FILTER = {
  cats: DEFAULT_CATEGORIES, // ['round_starts']
  roundFrom: 0, // 0 = open (round 0 never exists → 0 can only mean unset)
  roundTo: 0,
  steamId: '',
  weapon: '',
  distMin: 0, // 0 = open; the event's own distance units
  distMax: 0,
  headshotOnly: false,
  bbox: null, // {minX,minY,maxX,maxY}
  // Side/Team — the heatmap mirror (both '' = unconstrained):
  //   side — the side AT the event's round (the exact per-round sample,
  //          swaps at halftime): the value the heatmap's Team selector
  //          actually carries (its label says Side now — see
  //          heatkinds.heatRegionFilter).
  //   team — the team IDENTITY: the side the player OPENED the match
  //          with (constant across halftime).
  // Exact 'ct'/'t' wire spellings only (malformed → '' at parse, the
  // store's literal discipline); plain filter state — they serialize
  // whenever set AND applicable to the payload's own cats
  // (clearInapplicableFields — for a selection outside
  // SCOPED_KINDS they are cleared at parse/serialize and drop out),
  // and neither ever positions the replay (only ?tick= does).
  side: '',
  team: '',
};

// defaultFilter returns a fresh copy of the sparse default (new arrays
// per call — callers may mutate their copy freely).
export function defaultFilter() {
  return { ...DEFAULT_FILTER, cats: [...DEFAULT_CATEGORIES], bbox: null };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Round bounds keep NEGATIVE values (knife/warmup rounds are real
// rounds) and truncate to an integer; 0 and anything unusable mean
// "unset" — never a bound.
function roundNum(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n !== 0 ? n : 0;
}

// sideVal reads a side query param (side= / team=) strictly: only the
// exact wire spellings 'ct'/'t' pass — the same values the heatmap's
// Team selector and models.EventFilter.Side/Team carry. Absent, empty,
// uppercase or unknown → '' = unconstrained (never a guessed side; the
// same discipline the store applies to the literal). Exported for
// FilterBar's own filter copy (the ONE spelling of the rule).
export function sideVal(v) {
  return v === 'ct' || v === 't' ? v : '';
}

// clearInapplicableFields — THE one clearing rule (the product-owner
// ruling: hide AND clear, never retain): drop every value whose field
// does not apply to the filter's OWN category selection (see
// applicableFilterFields for the rule table). `catIds` is the selection
// to clear against (both filter choke points pass the payload's own
// cats); mutates and returns `f` — every caller hands it a fresh copy.
//
// It runs at BOTH ends of the filter<->URL round trip, which is what
// makes "clear" cover every arrival path with one rule:
//   - parseLandmarkFilter — every arrival (route URL, saved-preset
//     apply, CommandPalette jumps, Heatmaps drills) parses here, so an
//     inapplicable key in a deep link/preset normalizes away and can
//     never invisibly filter the list, the markers or the URL;
//   - serializeLandmarkFilter — every write goes through here, so a
//     category toggle that makes a SET value inapplicable rewrites the
//     URL without it (it already emits only non-default keys — a cleared
//     value is a default value, so it falls out naturally).
export function clearInapplicableFields(f, catIds) {
  const on = applicableFilterFields(catIds);
  if (!on.player) f.steamId = '';
  if (!on.side) f.side = '';
  if (!on.team) f.team = '';
  if (!on.weapon) f.weapon = '';
  if (!on.dist) {
    f.distMin = 0;
    f.distMax = 0;
  }
  if (!on.headshot) f.headshotOnly = false;
  if (!on.bbox) f.bbox = null;
  return f;
}

// parseLandmarkFilter builds a complete filter from a parsed route
// query. Unknown/absent keys fall back to DEFAULT_FILTER — a deep link
// with no params is the sparse default (round starts), never
// "everything on". Keys that do not apply to the parsed payload's OWN
// cats are then cleared (clearInapplicableFields — the ruling above).
export function parseLandmarkFilter(query) {
  const q = query || {};
  const f = { ...DEFAULT_FILTER, cats: [...DEFAULT_CATEGORIES] };
  if ('cat' in q) f.cats = q.cat === '' ? [] : q.cat.split(',').filter((id) => categoryById(id));
  f.roundFrom = roundNum(q.roundFrom);
  f.roundTo = roundNum(q.roundTo);
  f.steamId = q.player || q.steamId || '';
  f.weapon = q.weapon || '';
  f.distMin = num(q.distMin);
  f.distMax = num(q.distMax);
  f.headshotOnly = q.hs === '1';
  if (q.bbox) {
    const p = String(q.bbox).split(',').map(Number);
    if (p.length === 4 && p.every(Number.isFinite)) {
      f.bbox = { minX: p[0], minY: p[1], maxX: p[2], maxY: p[3] };
    }
  }
  f.side = sideVal(q.side);
  f.team = sideVal(q.team);
  return clearInapplicableFields(f, f.cats);
}

// serializeLandmarkFilter emits ONLY the non-default keys — default
// state serializes to an empty object so "#/replay/5" and
// "#/replay/5?cat=round_starts" never both exist for the same state.
// Values are URLSearchParams-friendly (comma lists, numbers, steam ids,
// and the bbox rect); a range bound serializes only when it is set (0 =
// open → nothing emitted, so a min-only range stays min-only). Values
// the payload's own cats make inapplicable are cleared first
// (clearInapplicableFields), so a write that narrows the selection can
// never leave a now-hidden key behind in the URL.
export function serializeLandmarkFilter(filter) {
  const f = { ...DEFAULT_FILTER, ...(filter || {}) };
  clearInapplicableFields(f, f.cats);
  const q = {};
  const sameCats =
    f.cats.length === DEFAULT_CATEGORIES.length &&
    DEFAULT_CATEGORIES.every((c) => f.cats.includes(c));
  if (!sameCats) q.cat = f.cats.join(',');
  if (f.roundFrom) q.roundFrom = String(f.roundFrom);
  if (f.roundTo) q.roundTo = String(f.roundTo);
  if (f.steamId) q.player = f.steamId;
  if (f.weapon) q.weapon = f.weapon;
  if (f.distMin) q.distMin = String(f.distMin);
  if (f.distMax) q.distMax = String(f.distMax);
  if (f.headshotOnly) q.hs = '1';
  if (f.bbox) q.bbox = `${f.bbox.minX},${f.bbox.minY},${f.bbox.maxX},${f.bbox.maxY}`;
  if (f.side) q.side = f.side;
  if (f.team) q.team = f.team;
  return q;
}

// filtersEqual compares two filters for "no refetch needed" (the URL
// round-trip must not loop: serialize → parse → compare → stop).
export function filtersEqual(a, b) {
  return JSON.stringify(serializeLandmarkFilter(a)) === JSON.stringify(serializeLandmarkFilter(b));
}

// shouldRevealFeed — THE feed-reveal-on-arrival rule: entering the replay
// with a NON-DEFAULT landmark filter must open the landmark feed rail so
// the arriving scope (the Heatmaps region drill, a saved filter, a scoped
// deep link) is actually visible; a default arrival stays collapsed.
//   - non-default = the arriving filter serializes to AT LEAST ONE key
//     (serializeLandmarkFilter's round-trip rule: defaults emit nothing,
//     so bbox/player/cats/roundFrom/weapon/hs/… all count, an absent or
//     default filter does not). Note the clearing ruling's interaction:
//     a payload whose keys are ALL inapplicable to its own cats parses to
//     the default (clearInapplicableFields), so it serializes to nothing
//     and never reveals — an "arrived scoped" link whose scope could not
//     filter anything is a default arrival.
//   - AND different from the filter the instance ALREADY had — the second
//     half is what keeps a rail the user deliberately closed closed: the
//     keep-alive dock expand re-arrives with the instance's OWN captured
//     filter (same filter → no forced open), while a genuinely new scope
//     re-opens it. No prior filter (fresh mount) differs from any
//     non-default arrival, so mount falls out of the same rule — no
//     special case. Entry context that is not a filter (?tick=, ?loop=,
//     ?sel=, ?back=, ?follow=) never reaches this decision: the caller
//     passes the PARSED LANDMARK FILTER only. Pure — unit-tested by
//     src/lib/landmarks.test.js; the wiring (mount + keep-alive
//     activation, never in-session churn) lives in Replay.svelte.
export function shouldRevealFeed(prevFilter, nextFilter) {
  if (Object.keys(serializeLandmarkFilter(nextFilter)).length === 0) return false;
  return !filtersEqual(prevFilter, nextFilter);
}
