// livestats.js — the player card's LIVE K/D/A + ADR at the playhead.
//
// The replay already fetches the drawable typed events (Replay's
// drawNorm — kill + damage rows) and the match's rounds rows, so the
// card's stats are a pure fold of that data at uiTick: no extra fetch, no
// stored metric re-derivation, and nothing computed a second time in
// markup. ONE $derived in Replay.svelte folds per playhead tick through
// the incremental cursor (liveStatsIncremental — the rows are tick-
// sorted, so only the rows the playhead passed are folded; the pure
// liveStats below stays the reference the cursor is pinned against);
// PlayerCard only renders the row.
//
// The fold mirrors the canonical Go rules in
// internal/analytics/rounds.go PlayerRounds (the same rows that back
// PlayerRound DMG/K/A/D):
//   - counted rounds ONLY (lib/rounds.js isCounted on the event's round
//     row; a round the lookup does not know is NOT counted — Go only
//     folds rounds CountedRounds returned). Every stored round is
//     counted since the knife/warmup discard; the gate is the legacy
//     guard over a pre-reprocess match's negative rows,
//   - kills: enemy-only — side of killer vs victim resolved AT THE EVENT
//     TICK by the injected sideAt callback; an unknown side never matches
//     (Go's sameSide: a != "" && a == b), so an unknown side is
//     PERMISSIVE and the kill counts,
//   - assists: assister set, ≠ victim, cross-team, !assistedFlash,
//   - deaths: every death of the player (no side gate),
//   - damage: ALL damage attributed to the player — the canonical fold
//     `dmg[e.Attacker] += e.Dmg` has NO side gate, so friendly fire
//     counts (do NOT "fix" it),
//   - ADR = Σdamage ÷ number of counted rounds STARTED at/before the
//     playhead; 0 rounds → adr is null (rendered "—", never 0).
//
// Pure (no DOM, no services, no globals): node-tested by
// src/lib/livestats.test.js. sideAt is injected so the module stays a
// plain function — Replay passes its position-store flags lookup.
//
// Two entry points over the ONE fold rule below:
//   - liveStats(events, opts)          — the pure fold: recomputes
//     everything from the rows every call (tests + the fallback path);
//   - liveStatsIncremental(cursor, …)  — the SAME output with a cursor
//     that only folds the rows the playhead advanced past (the view's
//     per-tick path — see the cursor section at the bottom).
import { isCounted } from '../rounds.js';

// sameSide — the JS twin of internal/analytics/rounds.go sameSide: an
// unknown side ("") never matches anything, which is exactly what makes
// an unknown side permissive for a kill/assist classification.
function sameSide(a, b) {
  return a !== '' && a === b;
}

// foldEvent — THE per-row fold rule, the ONE spelling of the kill /
// assist / death / damage accounting both entry points run (the playhead
// gate lives in the callers — it decides WHICH rows reach here; this
// decides what a row that reached here counts as). Writes into `acc`
// ({kills, deaths, assists, dmg} — plain counters, keyed by steam id).
//   et       the row's tick, already validated finite and ≤ playhead
//   byNumber round number → round row (counted-round gate, module header)
//   sideAt   injected side lookup (see liveStats)
function foldEvent(e, et, byNumber, sideAt, acc) {
  // Counted rounds only — see the module header.
  if (!isCounted(byNumber.get(Number(e.round)))) return;
  const { kills, deaths, assists, dmg } = acc;
  if (e.kind === 'kill') {
    const atk = String(e.attacker || '');
    const vic = String(e.victim || '');
    const asr = String(e.assister || '');
    const vt = vic ? side(vic, et, sideAt) : '';
    if (atk && !sameSide(side(atk, et, sideAt), vt)) bump(kills, atk);
    if (asr && asr !== vic && !sameSide(vt, side(asr, et, sideAt)) && !e.assistedFlash) {
      bump(assists, asr);
    }
    if (vic) bump(deaths, vic);
  } else if (e.kind === 'damage') {
    const atk = String(e.attacker || '');
    if (atk) addDmg(dmg, atk, Number(e.dmg) || 0);
  }
}

// side — one spell of the injected lookup's coercion (unknown → '').
function side(id, tick, sideAt) {
  return sideAt ? String(sideAt(id, tick) || '') : '';
}

// bump / addDmg — the counter steps (shared so both entry points add in
// exactly the same order — the floating-point ADR sums stay bit-identical).
function bump(m, id) {
  m.set(id, (m.get(id) || 0) + 1);
}
function addDmg(m, id, n) {
  m.set(id, (m.get(id) || 0) + n);
}

// newAcc — one fold's four counters.
function newAcc() {
  return { kills: new Map(), deaths: new Map(), assists: new Map(), dmg: new Map() };
}

// byNumberOf — the round number → round row lookup (the counted-round
// gate's index). Pure function of the rounds rows — the cursor caches it
// against the rounds array's identity.
function byNumberOf(rounds) {
  const byNumber = new Map();
  for (const r of rounds) {
    if (r && Number.isFinite(Number(r.number))) byNumber.set(Number(r.number), r);
  }
  return byNumber;
}

// startedCount — the ADR denominator: counted rounds whose START is
// at/before the playhead (a round whose start tick is unknown is not
// counted as started — never guessed into the denominator).
function startedCount(rounds, playhead) {
  let started = 0;
  for (const r of rounds) {
    if (!isCounted(r)) continue;
    const start = Number(r.startTick);
    if (Number.isFinite(start) && start <= playhead) started++;
  }
  return started;
}

// scanRounds — both round-derived inputs of one fold, in one call.
function scanRounds(rounds, playhead) {
  return { byNumber: byNumberOf(rounds), started: startedCount(rounds, playhead) };
}

// emit — the output shape: rows seeded for every steamId (plus whoever
// the counters touched), the counters copied in, ADR over the counted
// rounds started so far (null while none started). This tail is shared
// verbatim, so both entry points return the SAME structure.
function emit(acc, started, steamIds) {
  const out = new Map();
  const rowFor = (id) => {
    let row = out.get(id);
    if (!row) {
      row = { k: 0, d: 0, a: 0, adr: null };
      out.set(id, row);
    }
    return row;
  };
  for (const id of steamIds) {
    if (id) rowFor(id);
  }
  for (const m of [acc.kills, acc.deaths, acc.assists, acc.dmg]) {
    for (const id of m.keys()) rowFor(id);
  }
  for (const [id, n] of acc.kills) out.get(id).k = n;
  for (const [id, n] of acc.deaths) out.get(id).d = n;
  for (const [id, n] of acc.assists) out.get(id).a = n;
  // ADR per player: their damage (friendly fire included) over the
  // counted rounds started so far. With 0 started rounds every adr stays
  // null — the card renders "—", never a fake 0.
  if (started > 0) {
    for (const id of out.keys()) out.get(id).adr = (acc.dmg.get(id) || 0) / started;
  }
  return out;
}

// liveStats folds events AT the playhead into per-player rows.
//
//   events   normalized typed event rows (Replay's drawNorm): only
//            `kill` / `damage` rows do anything here
//   opts.rounds   GetRounds rows (number/startTick/…)
//   opts.tick     the playhead tick (uiTick)
//   opts.sideAt   (steamId, tick) => 'ct' | 't' | '' — side of that
//            player AT THE EVENT'S TICK (Replay's position-store flags;
//            '' = unknown → permissive)
//   opts.steamIds every roster steam id (slot order) — each one gets a
//            row even with no events (a player with 0 kills is a fact,
//            not an absence)
//
// Returns Map<steamId, {k, d, a, adr}>; adr is null while no counted
// round has started yet. Rows are seeded for every steamId, plus any
// steam id only present in the events.
export function liveStats(events, opts = {}) {
  const rounds = Array.isArray(opts.rounds) ? opts.rounds : [];
  const sideAt = typeof opts.sideAt === 'function' ? opts.sideAt : null;
  const t = Number(opts.tick);
  const playhead = Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  const steamIds = Array.isArray(opts.steamIds) ? opts.steamIds : [];

  const { byNumber, started } = scanRounds(rounds, playhead);
  const acc = newAcc();

  for (const e of events || []) {
    if (!e) continue;
    const et = Number(e.tick);
    // A row without a usable tick cannot be placed at the playhead —
    // dropped, never guessed into the fold.
    if (!Number.isFinite(et) || et > playhead) continue;
    foldEvent(e, et, byNumber, sideAt, acc);
  }

  return emit(acc, started, steamIds);
}

// --- Incremental fold (the playhead cursor) ---------------------------------
//
// The view folds ONCE PER PLAYHEAD TICK (Replay's $derived over uiTick).
// A full fold re-walks every drawable row at/before the playhead — late
// in a long match that is thousands of rows, hundreds of String()
// coercions and four fresh Maps per tick for a result that differs from
// the previous tick only by the handful of rows the playhead passed.
// The rows are TICK-SORTED (drawNorm comes back chronological from the
// store), so the fold only ever needs to run FORWARD: keep the
// accumulators + the index of the first row not yet folded, and on a
// playhead advance fold just the rows in (lastTick, tick].
//
// The cursor state lives HERE (beside the rule it caches), never loose in
// the view: a caller owns one cursor per derived and passes it in.
//
// CONTRACT — the output of liveStatsIncremental(cursor, events, opts) is
// byte-identical to liveStats(events, opts) at every tick, for every
// input (that equivalence is pinned by the sweep in
// src/lib/livestats.test.js). To keep it:
//   - the rows array is treated as IMMUTABLE while the cursor holds it
//     (the view rebuilds drawNorm wholesale — a new identity — whenever
//     the rows change; a same-identity mutation would be missed, which
//     is why `rows` identity is part of the reset key),
//   - anything the cursor cannot vouch for (a non-array, an UNSORTED
//     rows array — detected once on reset) falls back to the pure fold
//     every call, so correctness never depends on the sort order being
//     right;
//   - a BACKWARD seek, a rows/rounds/sideAt identity change or a
//     non-finite playhead rebuilds the accumulators from scratch (the
//     pure fold's own rule), then runs forward again.
//
// `steamIds` is deliberately NOT part of the reset key: it only seeds the
// OUTPUT rows, never the counters (the view builds a fresh array per
// evaluation).
export function createLiveStatsCursor() {
  return {
    rows: null, // rows identity the accumulators reflect
    rounds: null, // rounds identity (the byNumber index + ADR denominator)
    sideAt: null, // side-lookup identity (a different lookup, different folds)
    usable: false, // rows verified tick-sorted on the last reset
    next: 0, // index of the first row NOT yet folded
    tick: Number.NEGATIVE_INFINITY, // the playhead the counters reflect
    byNumber: new Map(),
    started: 0, // counted rounds started at/before `tick`
    acc: newAcc(), // kills / deaths / assists / dmg counters
  };
}

// tickSorted — the cursor's one structural assumption, verified ONCE per
// rows identity (not per call): every row with a usable tick is at or
// after the previous one. Rows without a usable tick never fold at all
// (the pure fold drops them), so they sit outside the ordering.
function tickSorted(events) {
  let prev = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    if (!e) continue;
    const et = Number(e.tick);
    if (!Number.isFinite(et)) continue;
    if (et < prev) return false;
    prev = et;
  }
  return true;
}

// resetCursor — start over: fresh counters, the rounds index rebuilt,
// the cursor parked BEFORE the first row (tick −∞) so the caller's
// forward advance does the actual folding.
function resetCursor(c, events, rounds, sideAt) {
  c.rows = events;
  c.rounds = rounds;
  c.sideAt = sideAt;
  c.usable = tickSorted(events);
  c.acc = newAcc();
  c.byNumber = byNumberOf(rounds);
  c.started = 0;
  c.next = 0;
  c.tick = Number.NEGATIVE_INFINITY;
}

// advanceCursor — fold the rows the playhead moved past, then widen the
// ADR denominator to the rounds that STARTED in the same span. One pass
// over the rows (from the cursor) + one over the rounds rows; both are
// cheap next to the work they replace.
function advanceCursor(c, playhead) {
  const events = c.rows;
  const len = events.length;
  let i = c.next;
  while (i < len) {
    const e = events[i];
    if (e) {
      const et = Number(e.tick);
      if (Number.isFinite(et)) {
        // Sorted rows: the first row past the playhead ends the walk —
        // every later row sits at or after it (the non-finite rows that
        // follow can never fold anyway).
        if (et > playhead) break;
        foldEvent(e, et, c.byNumber, c.sideAt, c.acc);
      }
    }
    i++;
  }
  c.next = i;
  // ADR denominator: counted rounds STARTED since the last playhead —
  // startedCount over the whole span, one round row each (a round row is
  // never counted twice: the window is (c.tick, playhead]).
  for (const r of c.rounds) {
    if (!isCounted(r)) continue;
    const start = Number(r.startTick);
    if (Number.isFinite(start) && start > c.tick && start <= playhead) c.started++;
  }
  c.tick = playhead;
}

// liveStatsIncremental — liveStats through a cursor (see the section
// header): the SAME rows out, the fold run only over what the playhead
// actually passed. See createLiveStatsCursor's contract for exactly when
// it rebuilds vs. falls back.
export function liveStatsIncremental(cursor, events, opts = {}) {
  const rounds = Array.isArray(opts.rounds) ? opts.rounds : [];
  const sideAt = typeof opts.sideAt === 'function' ? opts.sideAt : null;
  const t = Number(opts.tick);
  const playhead = Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  const steamIds = Array.isArray(opts.steamIds) ? opts.steamIds : [];

  if (!cursor || !Array.isArray(events)) return liveStats(events, opts);
  if (cursor.rows !== events || cursor.rounds !== rounds || cursor.sideAt !== sideAt) {
    resetCursor(cursor, events, rounds, sideAt);
  }
  // Unsorted rows: the cursor cannot vouch for the forward walk — the
  // pure fold every call (correctness first, the fast path is a bonus).
  if (!cursor.usable) return liveStats(events, opts);
  if (playhead < cursor.tick) resetCursor(cursor, events, rounds, sideAt);
  if (playhead !== cursor.tick) advanceCursor(cursor, playhead);

  return emit(cursor.acc, cursor.started, steamIds);
}
