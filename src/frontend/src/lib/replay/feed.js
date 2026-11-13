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
//      retrieval path (typed events / generic / sound — Q3a made the
//      filters gameplay-only, Q3b added the footsteps sound source),
//      each owning its job list, fetch, normalization, merge rank,
//      sequence key and paging. A new path lands as ONE registration
//      here.
//   3. feedJobs / runFeedJob / pageSlice — the job list a filter needs
//      and the ONE paging rule (the +1 probe row).
//   4. mergeSourceRows / composeFeedRows — the chronological merge (rank
//      and sequence key come from the SOURCES, not a hardcoded table)
//      plus the round-visibility pref.
//   5. entrySelection / fetchEntryRow — the ?sel= deep-link resolution
//      (already-loaded row, else the typed event fetched by id).
//   6. landmarkExportRows — the feed's CSV/JSON projection (moved here
//      from landmarks.js: this is feed output shape, not vocabulary).
//      Its chat half left with Q3a (no chat can reach a feed export);
//      the chat ROW SHAPE stays in landmarks.normalizeChat.
//
// Vocabulary stays in landmarks.js (lib/replay/landmarks.js): the
// category registry, the buckets, the row shapes (normalize*), the
// filter <-> URL model, the enabled-claim/kind derivations and the
// round-visibility RULE. This module is the RUNTIME over that
// vocabulary.
//
// --- The queued follow-up lands as a REGISTRATION here ---------------------
//   Q3a (gameplay-only filters) is DONE: `chat`/`team_changes`/
//     `game_events` and their gname picker are gone — `chatSource` was
//     deleted, `genericSource.jobs` lost the `nameFrom`/gname branch and
//     the name-dedupe (one job per FIXED-NAME category now), the rank
//     table shrank to event: 0 / generic: 1, and the export lost its
//     chat half. The FILTER's `gname` key died with the picker in
//     landmarks.js; the in-view histogram chrome (hist/needHist +
//     getGenericHistogram) died with it in Replay.svelte.
//   Q3b (footsteps) is DONE: the `footsteps` category (landmarks'
//     CATEGORIES, its own `source: 'sound'`), its path field in
//     enabledSources, and the `soundSource` descriptor below. The one
//     design point it settled — a TICK-windowed read under a
//     ROUND-scoped filter — is documented on the descriptor: the scope
//     rides the JOB and is applied in normalize(), the fetch reads the
//     whole match through the shared cache. buildFeedQuery, the paging
//     rule, the merge and the marker answer were all untouched.
import { getEvents, getGenericEvents, getEvent, getSoundEvents } from '../services.js';
import {
  enabledSources,
  typedKindsFor,
  killRoleFor,
  normalizeEvent,
  normalizeGeneric,
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
//   id        — the page-slot namespace ('event' | 'generic' | 'sound');
//               it is also the landmark row's own `source` field, which
//               is how the merge finds a row's rank/seqOf.
//   rank      — the merge tiebreak when two rows share a tick (the
//               sources are listed in merge order: events → generic →
//               sound); a queued source appends its own rank here.
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
//               (may be async and may choose the window it reads — see
//               the tick-windowed contract on soundSource below)
//   normalize — (rawRow, job, ctx, index) → the landmark row (null =
//               dropped — the feed's own gate: a kind no category
//               claims, or a row outside the job's own scope). `index`
//               is the row's position in its page slot: the stable,
//               unique key for a source whose rows carry NO id (sound).
//   seqOf     — (rawRow) → the row's own sequence key (the merge's third
//               tiebreak; 0 when it has none — the merge's sort is
//               stable, so ties keep the store's own order)
//
// normalize's ctx: { roundsByNumber, cats } — the round index behind the
// countedOnly rule and the enabled category set behind the enabled-claim
// stamp. Per-source scope that the row itself cannot express rides the
// JOB (chat's `round`, sound's round bounds + player) — never a second
// query composer (buildFeedQuery owns the events matcher).

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

// The generic source — ONE job per fixed-name category (Q3a: every
// generic category now carries its own `name`, so the old name-picker
// branch and the name-dedupe both left with the gname picker — a
// category without a name yields no job, the registry's contract).
const genericSource = {
  id: 'generic',
  rank: 1,
  page: { size: PAGE }, // one page per name
  jobs(filter) {
    const round = srcRound(filter);
    return enabledSources(filter.cats).generic
      .filter((c) => !!c.name)
      .map((c) => ({
        key: `generic:${c.name}`,
        name: c.name,
        catId: c.id,
        round,
      }));
  },
  fetch(matchId, filter, job, offset) {
    return getGenericEvents(matchId, job.name, job.round, PAGE + 1, offset);
  },
  normalize: (row, job) => normalizeGeneric(row, job.catId),
  seqOf: (row) => row.rowId,
};

// The sound source (Q3b) — the player-sound rows behind the `footsteps`
// category: step / jump / land / fall (sound_events — a table of its
// own, NOT the events table).
//
// FEED-ONLY: sound rows are never world rows (the world dataset is the
// event kinds the renderer/sfx push), so they never reach the map, the
// scrubber markers or the cue lists — the marker answer stays
// event-only by construction, and nothing here touches world.js.
//
// THE TICK-WINDOWED-SOURCE CONTRACT (the one design point Q3b settled):
// GetSoundEvents reads a (fromTick, toTick) window while the feed filter
// is ROUND-scoped — and the feed effect can fire BEFORE the rounds list
// lands (Replay loads rounds asynchronously), so a window translated
// from rounds would be wrong exactly when it mattered, and would force
// `rounds` into the effect's dependencies (a second fetch when they
// arrive — breaking its "re-runs only when the serialized filter
// changes" contract). Therefore this descriptor:
//   - reads the WHOLE match `getSoundEvents(matchId, 0, 0)` — the
//     store's own open-window contract, and the SAME cache key Replay's
//     sfx `soundRows` read already uses (services.getSoundEvents is a
//     cachedRead), so a match with footsteps shares ONE DB read between
//     the feed and the audio path;
//   - applies the round scope AND the player scope on the JOB inside
//     `normalize` (the row carries its own `round`/`steamId`) — exact no
//     matter when the rounds arrive. The scopes a sound row cannot
//     answer are NOT applied and never guessed: side/team are DB joins
//     in the store (event-source keys), and weapon/distance/headshot/bbox
//     have no field on a sound row — the same contract the chat source
//     had before Q3a (round + player only).
const soundSource = {
  id: 'sound',
  rank: 2,
  page: null, // one whole-match read, never paged
  jobs(filter) {
    return enabledSources(filter.cats).sound
      ? [
          {
            key: 'sound',
            roundFrom: filter.roundFrom,
            roundTo: filter.roundTo,
            steamId: filter.steamId,
          },
        ]
      : [];
  },
  fetch(matchId) {
    return getSoundEvents(matchId, 0, 0); // (0, 0) = the whole match
  },
  normalize(row, job, ctx, index) {
    // The round scope (0 = open on that side) and the player scope
    // ('' = all) — the two bounds a sound row CAN answer, applied here
    // because the Go read takes ticks, not rounds.
    if (job.roundFrom !== 0 && row.round < job.roundFrom) return null;
    if (job.roundTo !== 0 && row.round > job.roundTo) return null;
    if (job.steamId && row.steamId !== job.steamId) return null;
    return {
      ...row,
      // SoundEvent carries NO id: the page index is the row's key within
      // this filter's list (the store orders the read by tick, rowid —
      // deterministic, so the index is stable across re-derivations).
      key: `s:${index}`,
      source: 'sound',
      category: 'footsteps', // the stamp the list chip / export `type` read
      bucket: '', // a world concept — sound rows never render on the map
      // sound_events has no position — never invented (x/y/z stay absent).
      who: '', // no display name on the row (steamId only)
      name: row.kind, // the detail pane's "Event" line
      label: row.material ? `${row.kind} · ${row.material}` : String(row.kind || 'sound'),
    };
  },
  seqOf: () => 0, // no sequence id — the stable sort keeps (tick, rowid)
};

// THE registry — merge order = rank order (Q3a renumbered generic to 1
// when chatSource left; Q3b's footsteps appends at 2).
export const FEED_SOURCES = [typedSource, genericSource, soundSource];

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
// normalized, merged feed rows.
//   pages — { [key]: { job, rows, hasMore } } (the view's one state map)
//   ctx   — { roundsByNumber, cats }
// Normalization happens HERE (per source descriptor), so a row's
// enabled-claim stamp follows the CURRENT filter even though the raw
// rows were fetched under it too, and the countedOnly rule has the round
// index it needs. (The old knife/warmup visibility pref is retired with
// the discard — every stored round is counted; the feed's category
// opt-in rules and round-range scoping are already in the query.)
export function composeFeedRows(pages, ctx) {
  const rows = [];
  for (const slot of Object.values(pages || {})) {
    const source = slot.job && slot.job.source;
    if (!source) continue;
    const raw = slot.rows || [];
    for (let i = 0; i < raw.length; i++) {
      const row = source.normalize(raw[i], slot.job, ctx, i);
      if (row) rows.push(row); // null = the feed's gate dropped it
    }
  }
  return mergeSourceRows(rows);
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
// Moved here from landmarks.js: this shapes the FEED's rows for CSV
// output (feed output shape, not the row vocabulary). Q3a removed the
// chat half WITH the chat source — no chat row can reach a feed export
// any more, so `details` is the row's own label for every source (the
// chat-LINE rule itself lives in fmt.chatLine, which RoundDetail still
// renders from the same ChatRow vocabulary).

// landmarkExportRows flattens the loaded feed into canonical CSV
// columns (time, round, source, type, event, player, details, weapon,
// damage). `type` carries the STAMPED category (the enabled claim — a
// deaths-only selection exports its kill rows as 'deaths') while `event`
// keeps the demo kind.
export function landmarkExportRows(rows) {
  const out = [['time', 'round', 'source', 'type', 'event', 'player', 'details', 'weapon', 'damage']];
  for (const r of rows || []) {
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
