// lib/replay/feed.js — THE landmark feed, as a MODULE: the app's event
// list per match (Replay.svelte keeps only the wiring, the chrome and
// the world pushes — see its header).
//
// This module owns:
//
//   1. buildFeedQuery — THE one landmark-filter → query composer. Every
//      read that answers a FILTER goes through it (the feed's list read
//      AND the scrubber-marker key read), so the list and the markers
//      can never drift. INVARIANT: no second site may compose query
//      params from a filter (pinned by feed.test.js' source scan).
//   2. FEED_SOURCES — THE source interface: one descriptor per
//      retrieval path (typed events / chat / generic), each owning its
//      job list, fetch, normalization, merge rank, sequence key and
//      paging. A new path lands as ONE registration here.
//   3. feedJobs / runFeedJob / pageSlice — the job list a filter needs
//      and the ONE paging rule (the +1 probe row).
//   4. mergeSourceRows / composeFeedRows — the chronological merge (rank
//      and sequence key come from the SOURCES, not a hardcoded table)
//      plus the round-visibility pref.
//   5. entrySelection / fetchEntryRow — the ?sel= deep-link resolution
//      (already-loaded row, else the typed event fetched by id).
//   6. landmarkExportRows / precomposeChatLabels — the feed's CSV/JSON
//      projection (moved here from landmarks.js: this is feed output
//      shape, not vocabulary).
//
// Vocabulary stays in landmarks.js (lib/replay/landmarks.js): the
// category registry, the buckets, the row shapes (normalize*), the
// filter <-> URL model, the enabled-claim/kind derivations and the
// round-visibility RULE. This module is the RUNTIME over that
// vocabulary.
//
// --- Queued follow-ups land as REGISTRATIONS here (NOT implemented) ------
//   Q3a (cuts): drop chat + team_changes + game_events/gname, add
//     `buys → item_purchase`. Landing spots: (a) delete the `chatSource`
//     descriptor below — its rank, job list and normalization leave with
//     it; (b) the generic descriptor needs NO code change: `buys` is a
//     fixed-name category, so `jobs()` already yields one job per
//     distinct name (the `nameFrom`/`gname` branch there disappears with
//     the picker categories in landmarks' CATEGORIES, along with
//     enabledSources' `chat` field and its pin); (c) in Replay.svelte the
//     gname histogram (`hist`/`needHist` + the FilterBar picker) is
//     chrome that goes with the picker; (d) feed.test.js's source-rank
//     pin and its chat/gname job pins are the tests that move with it.
//   Q3b (footsteps): register a FOURTH descriptor over GetSoundEvents'
//     tick window — page: null (that read is already a windowed read in
//     services), normalize the sound row into a landmark row, rank 3
//     after generic, seqOf = its own id. Three REGISTRATIONS, no
//     machinery: the `footsteps` category in landmarks' CATEGORIES, its
//     path field in landmarks' enabledSources (the registry's path
//     split, which every descriptor's jobs() reads), and this descriptor
//     in FEED_SOURCES. jobs(), paging, merge and the export take the
//     registry as they find it; the MARKER answer stays event-only
//     (markers intersect the world rows, which are event kinds) —
//     buildFeedQuery is untouched by it.
import { getEvents, getChat, getGenericEvents, getEvent } from '../services.js';
import { chatLine } from '../fmt.js';
import { playerSideAt } from '../teams.js';
import {
  enabledSources,
  typedKindsFor,
  killRoleFor,
  normalizeEvent,
  normalizeChat,
  normalizeGeneric,
  applyRoundPref,
} from './landmarks.js';

// The feed's page size: a page read requests size+1 (the probe row that
// says "there is more" without truncating silently) and keeps size.
export const PAGE = 500;

// --- THE one filter → query composer --------------------------------------

// srcRound — the chat/generic single-round scope: their Go signatures
// (MatchService.GetChat / LibraryService.GetGenericEvents) take ONE
// exact round, so a filter scopes them when its range names exactly one
// round and leaves them match-wide for any wider range. The typed
// events carry the inclusive range themselves (inside buildFeedQuery).
// Exported because it IS a filter → parameter derivation — a second
// site composing it would be a second composer.
export function srcRound(filter) {
  const f = filter || {};
  // Numeric coercion keeps the contract total: an absent/blank/unparsed
  // bound reads 0 (the unset sentinel) instead of undefined, and a
  // negative knife/warmup round number still scopes exactly like a
  // positive one (it is a real round, not the sentinel).
  const from = Number(f.roundFrom) || 0;
  const to = Number(f.roundTo) || 0;
  return from !== 0 && from === to ? from : -1;
}

// buildFeedQuery(matchId, filter) — THE one landmark-filter → query
// composer (models.EventFilter's wire shape):
//   kinds    — the enabled categories' kind set (typedKindsFor); an
//              empty set would mean "every kind" in the store contract,
//              so callers gate on an event job existing (feedJobs).
//   killRole — the player filter's ROLE for kill rows (killRoleFor over
//              the category ids — the kinds can't tell Kills from
//              Deaths): Kills-only → "X's kills" (attacker), Deaths-only
//              → "X's deaths" (victim), both/neither → 'any'. Go scopes
//              it to kind='kill' only.
//   side/team — the heatmap-mirror keys (side-at-round / start-side
//              identity); the chat and generic reads have no side/team
//              columns in their Go signatures, so those sources stay
//              unscoped (noted, not invented).
//   distMin/distMax → the Go EventFilter's distanceMin/distanceMax JSON
//              fields; bbox is omitted (undefined) when absent rather
//              than sent as an empty rect.
// PURE: absent fields fall back to whatever the filter model already
// holds (parseLandmarkFilter normalized the URL before this).
// INVARIANT: this is the ONLY site that maps a landmark filter onto
// query params — feed.test.js scans every view/helper for a second
// composer (typedKindsFor / killRoleFor / distanceMin literals outside
// this file and landmarks.js, which only DERIVES them).
export function buildFeedQuery(matchId, filter) {
  const f = filter || {};
  return {
    matchId,
    kinds: typedKindsFor(f.cats),
    roundFrom: f.roundFrom,
    roundTo: f.roundTo,
    steamId: f.steamId,
    killRole: killRoleFor(f.cats),
    side: f.side,
    team: f.team,
    weapon: f.weapon,
    distanceMin: f.distMin,
    distanceMax: f.distMax,
    headshotOnly: f.headshotOnly,
    bbox: f.bbox || undefined,
  };
}

// --- THE source interface --------------------------------------------------
//
// One descriptor per retrieval path:
//   id        — the page-slot namespace ('event' | 'chat' | 'generic');
//               it is also the landmark row's own `source` field, which
//               is how the merge finds a row's rank/seqOf.
//   rank      — the merge tiebreak when two rows share a tick (the
//               sources are listed in merge order: events → chat →
//               generic); a queued source appends its own rank here.
//   page      — {size} when the path pages, null for an unpaged read
//               (runFeedJob then slices with Infinity: everything back,
//               hasMore false).
//   jobs      — (filter) → the fetch jobs this path needs; [] when the
//               path is OFF for this filter. The job list IS the enabled
//               check (one gate, not two). A path may need MORE than one
//               job: generic yields one per distinct name. A job is
//               { key, ...params } — `key` is the page slot's name;
//               feedJobs() stamps `source` onto it.
//   fetch     — (matchId, filter, job, offset) → Promise<raw rows>
//   normalize — (rawRow, job, ctx) → the landmark row (null = dropped —
//               the feed's own gate, e.g. a kind no category claims)
//   seqOf     — (rawRow) → the row's own sequence key (the merge's third
//               tiebreak)
//
// normalize's ctx: { roundsByNumber, cats } — the round index behind the
// countedOnly rule and the enabled category set behind the enabled-claim
// stamp.

// The typed (event) source — the typed-event timeline read, paged. Its
// query is also the scrubber-marker answer's (buildFeedQuery below).
const typedSource = {
  id: 'event',
  rank: 0,
  page: { size: PAGE },
  jobs(filter) {
    return enabledSources(filter.cats).event ? [{ key: 'event' }] : [];
  },
  fetch(matchId, filter, job, offset) {
    return getEvents({
      ...buildFeedQuery(matchId, filter),
      offset,
      limit: PAGE + 1, // probe row → "load more" without silent truncation
    });
  },
  normalize(row, job, ctx) {
    // cats rides the stamp: a kill row presents as 'deaths' under a
    // deaths-only selection and as 'kills' otherwise (rowCategory — the
    // list chips and the export `type` column read the stamp).
    return normalizeEvent(row, { roundsByNumber: ctx.roundsByNumber, cats: ctx.cats });
  },
  seqOf: (row) => row.seq,
};

// Q3a REMOVES this descriptor (and the chat category): its rank, job
// list and normalization leave with it — nothing else in this module
// special-cases chat.
const chatSource = {
  id: 'chat',
  rank: 1,
  page: null, // the chat read is one unpaged call
  jobs(filter) {
    return enabledSources(filter.cats).chat
      ? [{ key: 'chat', round: srcRound(filter) }]
      : [];
  },
  fetch(matchId, filter, job) {
    return getChat(matchId, job.round, filter.steamId);
  },
  normalize: (row) => normalizeChat(row),
  seqOf: (row) => row.id,
};

// The generic source — one job per DISTINCT name (two enabled categories
// naming the same generic — e.g. a gname equal to a surviving source's
// name — dedupe to a single read; the FIRST category in registry order
// owns the category stamp, exactly as the old inline loop did).
// Q3a: `buys → item_purchase` arrives as one more fixed-name CATEGORY in
// landmarks' CATEGORIES — this descriptor already yields a job per name,
// so no code changes here (the `nameFrom`/`gname` branch goes away with
// the picker categories).
const genericSource = {
  id: 'generic',
  rank: 2,
  page: { size: PAGE }, // one page per name
  jobs(filter) {
    const cats = enabledSources(filter.cats).generic;
    const names = new Map();
    for (const c of cats) {
      const name = c.nameFrom ? filter.gname : c.name;
      if (name && !names.has(name)) names.set(name, c.id);
    }
    const round = srcRound(filter);
    return [...names].map(([name, catId]) => ({
      key: `generic:${name}`,
      name,
      catId,
      round,
    }));
  },
  fetch(matchId, filter, job, offset) {
    return getGenericEvents(matchId, job.name, job.round, PAGE + 1, offset);
  },
  normalize: (row, job) => normalizeGeneric(row, job.catId),
  seqOf: (row) => row.rowId,
};

// THE registry — merge order = rank order. Q3b appends its footsteps
// descriptor here (rank 3); Q3a deletes chatSource.
export const FEED_SOURCES = [typedSource, chatSource, genericSource];

const SOURCE_BY_ID = new Map(FEED_SOURCES.map((s) => [s.id, s]));

// feedJobs(filter) — THE enabled job list for a filter: every source's
// jobs(), with `source` stamped on (so a page slot can find its source
// again). Empty = nothing to fetch. Also the gate the marker answer
// reads: an 'event' job existing IS "the event source is enabled" (an
// empty kinds list would mean "every kind" in the store's contract).
export function feedJobs(filter) {
  const out = [];
  for (const source of FEED_SOURCES) {
    for (const job of source.jobs(filter || {})) {
      out.push({ ...job, key: job.key || source.id, source });
    }
  }
  return out;
}

// pageSlice — THE one paging rule: a page read asked for size+1 (the
// probe row), so `hasMore` is exact and the kept rows are exactly
// `size`. An unpaged source passes Infinity: everything back, no more.
export function pageSlice(rows, size) {
  const page = rows || [];
  return { rows: page.slice(0, size), hasMore: page.length > size };
}

// runFeedJob — one source job: fetch, then apply its source's paging
// rule. The ONLY way the view reads a source (initial load AND load
// more), so paging behavior lives here, not in the caller.
export async function runFeedJob(matchId, filter, job, offset = 0) {
  const raw = await job.source.fetch(matchId, filter, job, offset);
  const size = job.source.page ? job.source.page.size : Infinity;
  return pageSlice(raw, size);
}

// --- The merged list -------------------------------------------------------

// mergeSourceRows — chronological merge of the source reads: tick
// first, then the row's SOURCE RANK, then its own sequence key. Stable
// and deterministic — the same rows always land in the same order
// regardless of which sources were enabled. (The rank/seq table lives
// on the SOURCES now — each normalized row carries its `source` id, so
// a queued source brings its own tiebreak instead of extending a
// hardcoded map.)
export function mergeSourceRows(rows) {
  const rankOf = (row) => {
    const src = SOURCE_BY_ID.get(row.source);
    return src ? src.rank : 3;
  };
  const seqOf = (row) => {
    const src = SOURCE_BY_ID.get(row.source);
    return src ? src.seqOf(row) : 0;
  };
  const out = [];
  for (const r of rows || []) if (r) out.push(r);
  out.sort(
    (a, b) =>
      a.tick - b.tick ||
      rankOf(a) - rankOf(b) ||
      (seqOf(a) || 0) - (seqOf(b) || 0),
  );
  return out;
}

// composeFeedRows — THE list derivation: the raw page slots → the
// normalized, merged, round-visibility-pref'd feed rows.
//   pages — { [key]: { job, rows, hasMore } } (the view's one state map)
//   ctx   — { roundsByNumber, cats, showKnifeWarmup }
// Normalization happens HERE (per source descriptor), so a row's
// enabled-claim stamp follows the CURRENT filter even though the raw
// rows were fetched under it too, and the countedOnly rule has the round
// index it needs. applyRoundPref (landmarks) is the additional
// knife/warmup visibility rule on top — the feed's own category opt-in
// rules and round-range scoping are already in the query.
export function composeFeedRows(pages, ctx) {
  const rows = [];
  for (const slot of Object.values(pages || {})) {
    const source = slot.job && slot.job.source;
    if (!source) continue;
    for (const raw of slot.rows || []) {
      const row = source.normalize(raw, slot.job, ctx);
      if (row) rows.push(row); // null = the feed's gate dropped it
    }
  }
  return applyRoundPref(mergeSourceRows(rows), ctx.roundsByNumber, ctx.showKnifeWarmup);
}

// --- The ?sel= deep-link resolution ---------------------------------------

// entrySelection — the feed half of a ?sel= arrival: the landmark the
// selection names when it is ALREADY in the loaded feed ({row}), else
// the typed event id to fetch ({id} — a typed landmark resolves by id
// even beyond the loaded pages), else null (nothing to select). Pure:
// the view owns the applying (selection state + the entry seek).
export function entrySelection(sel, rows) {
  if (!sel) return null;
  const hit = (rows || []).find((r) => r.key === sel);
  if (hit) return { row: hit };
  if (sel.startsWith('e:')) {
    const n = Number(sel.slice(2));
    if (Number.isFinite(n) && n > 0) return { id: n };
  }
  return null;
}

// fetchEntryRow — the id half of entrySelection: the event DETAIL (the
// detail pane's payloads) plus its normalized landmark row under the
// CURRENT category set (the stamp decides which view it presents as).
// null = the id resolves to nothing (never an error to the caller).
export async function fetchEntryRow(matchId, eventId, cats) {
  const d = await getEvent(eventId);
  if (!d) return null;
  const row = normalizeEvent(d, { cats });
  return row ? { row, detail: d } : null;
}

// --- The feed's export projection -----------------------------------------
//
// Moved here from landmarks.js: these shape the FEED's rows for CSV/JSON
// output (feed output shape, not the row vocabulary). The chat line is
// precomposed through THE display rule (fmt.chatLine — `donk666 [T]: lol`)
// while `who` stays the bare name; the side inputs come from the caller's
// side context ({players, sideSwitches, rounds}).

// sideOfChatRow resolves a chat row's SPEAKER side for the export tags —
// the same teams.playerSideAt + fmt.chatLine composition the UI renders,
// fed from the caller's side inputs (Replay has them in scope at the
// export button). Missing inputs → '' → team chat exports channel-only
// (no bracket), never a guessed side.
function sideOfChatRow(r, sideCtx) {
  const ctx = sideCtx || {};
  return playerSideAt(ctx.players, ctx.sideSwitches, ctx.rounds, r.round, r.steamId, r.who);
}

function composeChatLabel(r, sideCtx) {
  return chatLine(r.who || '', r.channel || '', sideOfChatRow(r, sideCtx), r.label || '');
}

// precomposeChatLabels returns the feed rows with every CHAT row's
// `label` replaced by the full precomposed line (fmt.chatLine) — the
// JSON export's shape, so exported JSON reads like the UI (who stays
// bare).
export function precomposeChatLabels(rows, sideCtx) {
  return (rows || []).map((r) => (r.source === 'chat' ? { ...r, label: composeChatLabel(r, sideCtx) } : r));
}

// landmarkExportRows flattens the loaded feed into canonical CSV/JSON
// export columns (time, round, source, type, event, player, details,
// weapon, damage — plus the feed's category). Chat rows carry the
// PRECOMPOSED line in `label` (see composeChatLabel); sideCtx is the
// side inputs Replay has in scope at the export button — omitted, team
// chat exports with no bracket (never guessed).
export function landmarkExportRows(rows, sideCtx) {
  const out = [['time', 'round', 'source', 'type', 'event', 'player', 'details', 'weapon', 'damage']];
  for (const r of rows || []) {
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
