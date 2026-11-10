// Canonical landmark module — THE one place event categorization,
// normalization, merging and filter serialization live for the Replay
// landmark feed (the app's single raw-event browser per match).
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
//   4. mergeFeed       — chronological merge of the source-specific
//                        reads (the backend keeps its three retrieval
//                        paths; there is no universal event query).
//   5. applyRoundPref  — the show_knife_warmup_rounds visibility rule
//                        (an ADDITIONAL feed filter on top of the
//                        category opt-ins and ?roundFrom/?roundTo
//                        scoping).
//   6. filter <-> URL  — the landmark filter model serialized to the
//                        route query (deep links, refresh, back/forward).
//
// Unit-tested by src/lib/landmarks.test.js (the lib test glob is
// src/lib/*.test.js, so the fixture lives one level up).

import { isCounted } from '../rounds.js';
import { chatLine } from '../fmt.js';
import { playerSideAt } from '../teams.js';

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
  'round_start',
  'round_end',
  'player_connect',
  'player_disconnect',
];

// DRAW_KINDS: the typed kinds the replay world layers and scrubber
// markers draw — positioned anchors (kills, damage, grenades, bomb incl.
// the dropped-C4 evidence rows) plus round_end (round-win markers) and
// round_start (the death-X cutoff — a kill stamped round N can land
// AFTER round N's round_end, e.g. the C4 detonation kill, so the NEXT
// round's start terminates it; the row itself is STORED as a round
// start and never drawn as a world marker). Fetched once per match,
// unfiltered by category chips: the map always shows the full spatial
// context, while the LIST and scrubber markers follow the enabled
// categories. `damage` rides here for the victim-hit flash only — it
// carries no scrubber marker (see scrubberMarkerClass); `round_start`
// carries the TALL tick marker when the round_starts category is on
// (the scrubber's marker loop gates this set by the enabled
// categories); `grenade_land` rides it for the decoy REST marker
// (bucket 'land' — the renderer's plan pairs the throw arc to it; no
// scrubber marker either); `grenade_bounce` rides it because a bounce is a
// VERTEX of the renderer's throw→bounce→det path — the world layer needs
// those rows whether or not the 'Bounce' feed category is on (bucket
// 'bounce', no scrubber marker either).
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
  'round_end',
  'round_start',
];

// CATEGORIES — the filterable landmark categories. `source` picks the
// backend retrieval path (typed events / chat / generic events);
// `kinds` (event source) or `name` (generic source) scopes the query;
// `default` categories are the sparse initial selection; `countedOnly`
// restricts the category to counted rounds (lib/rounds.js isCounted —
// knife/warmup rounds are not part of the default narrative).
export const CATEGORIES = [
  { id: 'kills', label: 'Kills', short: 'kill', source: 'event', kinds: ['kill'] },
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
  { id: 'chat', label: 'Chat', short: 'chat', source: 'chat' },
  { id: 'team_changes', label: 'Team changes', short: 'team', source: 'generic', name: 'player_team' },
  { id: 'convars', label: 'Server setting changes', short: 'cvar', source: 'generic', name: 'server_cvar' },
  { id: 'game_events', label: 'Game events', short: 'game', source: 'generic', nameFrom: 'gname' },
];

// The sparse default: round starts only — every other category is
// opt-in (PRD §5.5), even when its data exists.
export const DEFAULT_CATEGORIES = CATEGORIES.filter((c) => c.default).map((c) => c.id);

export function categoryById(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}

// categoryOfKind maps a typed events.kind onto its category id (or null
// for a kind no category claims — the stored vocabulary is closed, so
// null only ever hits unknown input).
export function categoryOfKind(kind) {
  const k = String(kind || '');
  const cat = CATEGORIES.find((c) => c.source === 'event' && (c.kinds || []).includes(k));
  return cat ? cat.id : null;
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
// tall tick mark (style.css .scrub-marker.tall): round starts take it —
// and so do round wins, which is why the class is not bucket-named
// (the two overlap on the scrubber when both categories are on; a
// future pass may want to differentiate them). Pure — unit-tested by
// src/lib/landmarks.test.js.
export function scrubberMarkerClass(bucket) {
  const b = String(bucket || '');
  if (b === 'kill') return 'kill';
  if (b === 'plant' || b === 'defuse') return 'plant';
  if (b === 'explode' || DETONATION_BUCKETS.includes(b)) return 'det';
  if (b === 'round' || b === 'start') return 'tall';
  return ''; // 'drop'/'pickup' (bomb evidence), 'wdrop'/'wpickup'
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
// never drawn as a world marker, but it DOES carry the tall scrubber
// tick (scrubberMarkerClass 'tall') so the default round-start feed
// reads on the timeline.
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
// category set (the backend keeps one path per source).
export function enabledSources(catIds) {
  const cats = catIds.map(categoryById).filter(Boolean);
  return {
    event: cats.some((c) => c.source === 'event'),
    chat: cats.some((c) => c.source === 'chat'),
    generic: cats.filter((c) => c.source === 'generic'),
  };
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
// to compare). Returns null when no category claims the kind.
export function normalizeEvent(ev, opts = {}) {
  const category = categoryOfKind(ev.kind);
  if (!category) return null;
  if (opts.policy !== false) {
    const cat = categoryById(category);
    if (cat && cat.countedOnly && opts.roundsByNumber) {
      // Knife/warmup rounds are real rows but not counted play — the
      // canonical rule is lib/rounds.js isCounted (the analytics
      // CountedRounds twin); a round the lookup does not know is kept.
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

// normalizeChat converts one ChatRow into a landmark row. The round
// clock ("R12 1:23" with the match-relative fallback) is a formatting
// concern — lib/fmt.js chatClock — not part of the row.
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

// mergeFeed merges the source-specific arrays into one chronological
// list: tick first, then source (events → chat → generic), then the
// source's own sequence key. Stable and deterministic — the same rows
// always land in the same order regardless of which sources were
// enabled.
export function mergeFeed(arrays) {
  const rank = { event: 0, chat: 1, generic: 2 };
  const seqOf = (r) => (r.source === 'event' ? r.seq : r.source === 'chat' ? r.id : r.rowId);
  const out = [];
  for (const a of arrays) if (Array.isArray(a)) out.push(...a);
  out.sort(
    (a, b) =>
      a.tick - b.tick ||
      (rank[a.source] ?? 3) - (rank[b.source] ?? 3) ||
      (seqOf(a) || 0) - (seqOf(b) || 0),
  );
  return out;
}

// applyRoundPref — the show_knife_warmup_rounds visibility rule (the
// kvstore pref Settings writes; default OFF = hide knife/warmup rows):
// with the pref off, every row of a NON-COUNTED round (negative ingest
// indices — knife/warmup, lib/rounds.js isCounted) is dropped. It is an
// ADDITIONAL filter on top of the category opt-in rules
// (normalizeEvent's countedOnly) and the ?roundFrom/?roundTo scoping —
// never a replacement for either; a row must pass all of them. A round
// the lookup does not know (or a row with no round stamp) is KEPT —
// defensive, never invented, the same convention as normalizeEvent.
// Pref on → the input array comes back untouched (same reference).
// Consumed by Replay's feed and scrubber markers (Replay.svelte).
export function applyRoundPref(rows, roundsByNumber, showKnifeWarmup) {
  if (showKnifeWarmup) return rows;
  const by = roundsByNumber || new Map();
  return rows.filter((r) => {
    const round = by.get(r.round);
    return !round || isCounted(round);
  });
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
  gname: '', // generic event name for the game_events category
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

// parseLandmarkFilter builds a complete filter from a parsed route
// query. Unknown/absent keys fall back to DEFAULT_FILTER — a deep link
// with no params is the sparse default (round starts), never
// "everything on".
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
  f.gname = q.gname || '';
  return f;
}

// serializeLandmarkFilter emits ONLY the non-default keys — default
// state serializes to an empty object so "#/replay/5" and
// "#/replay/5?cat=round_starts" never both exist for the same state.
// Values are URLSearchParams-friendly (comma lists, numbers, steam ids,
// and the bbox rect); a range bound serializes only when it is set (0 =
// open → nothing emitted, so a min-only range stays min-only).
export function serializeLandmarkFilter(filter) {
  const f = { ...DEFAULT_FILTER, ...(filter || {}) };
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
  if (f.gname) q.gname = f.gname;
  return q;
}

// filtersEqual compares two filters for "no refetch needed" (the URL
// round-trip must not loop: serialize → parse → compare → stop).
export function filtersEqual(a, b) {
  return JSON.stringify(serializeLandmarkFilter(a)) === JSON.stringify(serializeLandmarkFilter(b));
}

// --- Export ------------------------------------------------------------------

// sideOfChatRow resolves a chat row's SPEAKER side for the export tags —
// the same teams.playerSideAt + fmt.chatLine composition the UI renders,
// fed from the caller's side inputs (Replay has them in scope at the
// export button). Missing inputs → '' → team chat exports channel-only
// (no bracket), never a guessed side.
function sideOfChatRow(r, sideCtx) {
  const ctx = sideCtx || {};
  return playerSideAt(ctx.players, ctx.sideSwitches, ctx.rounds, r.round, r.steamId, r.who);
}

// composeChatLabel is THE export half of the chat display rule: the
// CSV/JSON feed export PRECOMPOSES the full line into `label` through the
// canonical formatter (fmt.chatLine — `donk666 [T]: lol`), while `who`
// stays the bare name. System rows (no name/channel) stay plain text.
function composeChatLabel(r, sideCtx) {
  return chatLine(r.who || '', r.channel || '', sideOfChatRow(r, sideCtx), r.label || '');
}

// precomposeChatLabels returns the feed rows with every CHAT row's
// `label` replaced by the full precomposed line (fmt.chatLine) — the JSON
// export's shape, so exported JSON reads like the UI (who stays bare).
export function precomposeChatLabels(rows, sideCtx) {
  return (rows || []).map((r) => (r.source === 'chat' ? { ...r, label: composeChatLabel(r, sideCtx) } : r));
}

// landmarkExportRows flattens the loaded feed into canonical CSV/JSON
// export columns (time, round, source, player, details — plus
// category and typed extras). Chat rows carry the PRECOMPOSED line in
// `label` (see composeChatLabel); sideCtx is the side inputs
// ({players, sideSwitches, rounds}) Replay has in scope at the export
// button — omitted, team chat exports with no bracket (never guessed).
export function landmarkExportRows(rows, sideCtx) {
  const out = [['time', 'round', 'source', 'type', 'event', 'player', 'details', 'weapon', 'damage']];
  for (const r of rows) {
    out.push([
      r.tick,
      r.round,
      r.source,
      r.category,
      r.kind || r.name || '',
      r.who || '',
      r.source === 'chat' ? composeChatLabel(r, sideCtx) : r.label || '',
      r.weapon || '',
      r.dmg != null ? r.dmg : '',
    ]);
  }
  return out;
}
