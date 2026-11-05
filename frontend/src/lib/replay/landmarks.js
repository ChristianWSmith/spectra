// Canonical landmark module — THE one place event categorization,
// normalization, merging and filter serialization live for the Replay
// landmark feed (the app's single raw-event browser per match).
//
// This module owns:
//
//   1. CATEGORIES      — the filterable category registry (with the
//                       sparse default: kills + round wins only).
//   2. drawBucket      — the kind → drawable bucket mapping the RENDERER
//                        and the scrubber markers consume (rows arrive
//                        pre-bucketed; neither classifies at runtime).
//   3. normalize*      — source rows (typed EventRow / ChatRow /
//                        GenericEvent) → one landmark row shape that
//                        preserves the source's own fields.
//   4. mergeFeed       — chronological merge of the source-specific
//                        reads (the backend keeps its three retrieval
//                        paths; there is no universal event query).
//   5. filter <-> URL  — the landmark filter model serialized to the
//                        route query (deep links, refresh, back/forward).
//
// Unit-tested by src/lib/landmarks.test.js (the lib test glob is
// src/lib/*.test.js, so the fixture lives one level up).

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
  'grenade_throw',
  'grenade',
  'round_start',
  'round_end',
  'player_connect',
  'player_disconnect',
];

// DRAW_KINDS: the typed kinds the replay world layers and scrubber
// markers draw — positioned anchors (kills, grenades, bomb) plus
// round_end (round-win markers). Fetched once per match, unfiltered by
// category chips: the map always shows the full spatial context, while
// the LIST and scrubber markers follow the enabled categories.
export const DRAW_KINDS = [
  'kill',
  'grenade',
  'grenade_throw',
  'bomb_plant',
  'bomb_defuse',
  'bomb_explode',
  'round_end',
];

// CATEGORIES — the filterable landmark categories. `source` picks the
// backend retrieval path (typed events / chat / generic events);
// `kinds` (event source) or `name` (generic source) scopes the query;
// `default` categories are the sparse initial selection; `countedOnly`
// restricts the category to counted rounds (lib/rounds.js isCounted —
// knife/warmup rounds are not part of the default narrative).
export const CATEGORIES = [
  { id: 'kills', label: 'Kills', short: 'kill', source: 'event', kinds: ['kill'], default: true },
  { id: 'round_wins', label: 'Round wins', short: 'win', source: 'event', kinds: ['round_end'], default: true, countedOnly: true },
  { id: 'round_starts', label: 'Round starts', short: 'start', source: 'event', kinds: ['round_start'], countedOnly: true },
  { id: 'bomb', label: 'Bomb', short: 'bomb', source: 'event', kinds: ['bomb_plant', 'bomb_defuse', 'bomb_explode', 'bomb_drop', 'bomb_pickup'] },
  { id: 'grenade_throws', label: 'Grenade throws', short: 'throw', source: 'event', kinds: ['grenade_throw'] },
  { id: 'grenade_dets', label: 'Grenade detonations', short: 'det', source: 'event', kinds: ['grenade'] },
  { id: 'damage', label: 'Damage', short: 'dmg', source: 'event', kinds: ['damage'] },
  { id: 'blinds', label: 'Flashes & blinds', short: 'flash', source: 'event', kinds: ['blind'] },
  { id: 'connects', label: 'Joins & leaves', short: 'join/leave', source: 'event', kinds: ['player_connect', 'player_disconnect'] },
  { id: 'chat', label: 'Chat', short: 'chat', source: 'chat' },
  { id: 'team_changes', label: 'Team changes', short: 'team', source: 'generic', name: 'player_team' },
  { id: 'convars', label: 'ConVar changes', short: 'cvar', source: 'generic', name: 'server_cvar' },
  { id: 'game_events', label: 'Game events', short: 'game', source: 'generic', nameFrom: 'gname' },
];

// The sparse default: kills + round wins only — every other category is
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

// drawBucket maps a typed kind onto the drawable bucket the renderer and
// scrubber markers consume ('' = not drawn / no marker). Precomputed at
// normalization time — neither the renderer nor the scrubber classifies
// anything at runtime (PRD §5.5). The substring branches (smoke/fire)
// bucket the extended kind spellings, not only the exact kinds above.
export function drawBucket(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'kill') return 'kill';
  if (k === 'grenade_throw') return 'throw';
  if (k === 'grenade') return 'detonation';
  if (k.includes('smoke')) return 'smoke';
  if (k.includes('fire') || k.includes('molotov')) return 'fire';
  if (k === 'bomb_plant') return 'plant';
  if (k === 'bomb_explode') return 'explode';
  if (k === 'bomb_defuse') return 'defuse';
  if (k === 'round_end') return 'round';
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
  return {
    ...ev,
    key: 'e:' + ev.id,
    source: 'event',
    category,
    bucket: drawBucket(ev.kind),
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

// --- Filter model <-> route query -------------------------------------------

// The landmark filter — the durable state that lives in the URL
// (#/replay/:id?cat=…&round=…). Everything here survives navigation,
// refresh and deep links; transient playback state (engine tick,
// selection) rides the same query as tick/sel but is not "the filter".
export const DEFAULT_FILTER = {
  cats: DEFAULT_CATEGORIES, // ['kills', 'round_wins']
  round: -1, // -1 = all rounds (0 would mean round zero)
  steamId: '',
  weapon: '',
  tickFrom: 0, // 0 = open-ended
  tickTo: 0,
  dmgMin: 0,
  dmgMax: 0,
  distanceMax: 0,
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

// parseLandmarkFilter builds a complete filter from a parsed route
// query. Unknown/absent keys fall back to DEFAULT_FILTER — a deep link
// with no params is the sparse default (kills + round wins), never
// "everything on".
export function parseLandmarkFilter(query) {
  const q = query || {};
  const f = { ...DEFAULT_FILTER, cats: [...DEFAULT_CATEGORIES] };
  if ('cat' in q) f.cats = q.cat === '' ? [] : q.cat.split(',').filter((id) => categoryById(id));
  if (q.round != null && q.round !== '' && Number.isFinite(Number(q.round))) f.round = Number(q.round);
  f.steamId = q.player || q.steamId || '';
  f.weapon = q.weapon || '';
  f.tickFrom = num(q.tickFrom);
  f.tickTo = num(q.tickTo);
  f.dmgMin = num(q.dmgMin);
  f.dmgMax = num(q.dmgMax);
  f.distanceMax = num(q.dist);
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
// "#/replay/5?cat=kills,round_wins" never both exist for the same
// state. Values are URLSearchParams-friendly (comma lists, numbers,
// steam ids, and the bbox rect).
export function serializeLandmarkFilter(filter) {
  const f = { ...DEFAULT_FILTER, ...(filter || {}) };
  const q = {};
  const sameCats =
    f.cats.length === DEFAULT_CATEGORIES.length &&
    DEFAULT_CATEGORIES.every((c) => f.cats.includes(c));
  if (!sameCats) q.cat = f.cats.join(',');
  if (f.round !== -1) q.round = String(f.round);
  if (f.steamId) q.player = f.steamId;
  if (f.weapon) q.weapon = f.weapon;
  if (f.tickFrom) q.tickFrom = String(f.tickFrom);
  if (f.tickTo) q.tickTo = String(f.tickTo);
  if (f.dmgMin) q.dmgMin = String(f.dmgMin);
  if (f.dmgMax) q.dmgMax = String(f.dmgMax);
  if (f.distanceMax) q.dist = String(f.distanceMax);
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

// landmarkExportRows flattens the loaded feed into canonical CSV/JSON
// export columns (tick, round, source, name/who, text/label — plus
// category and typed extras).
export function landmarkExportRows(rows) {
  const out = [['tick', 'round', 'source', 'category', 'kind', 'who', 'label', 'weapon', 'dmg']];
  for (const r of rows) {
    out.push([
      r.tick,
      r.round,
      r.source,
      r.category,
      r.kind || r.name || '',
      r.who || '',
      r.label || '',
      r.weapon || '',
      r.dmg != null ? r.dmg : '',
    ]);
  }
  return out;
}
