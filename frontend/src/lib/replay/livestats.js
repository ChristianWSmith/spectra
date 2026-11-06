// livestats.js — the player card's LIVE K/D/A + ADR at the playhead.
//
// The replay already fetches the drawable typed events (Replay's
// drawNorm — kill + damage rows) and the match's rounds rows, so the
// card's stats are a pure fold of that data at uiTick: no extra fetch, no
// stored metric re-derivation, and nothing computed a second time in
// markup. ONE $derived in Replay.svelte calls liveStats per playhead
// tick; PlayerCard only renders the row.
//
// The fold mirrors the canonical Go rules in
// internal/analytics/rounds.go PlayerRounds (the same rows that back
// PlayerRound DMG/K/A/D):
//   - counted rounds ONLY (lib/rounds.js isCounted on the event's round
//     row; a round the lookup does not know is NOT counted — Go only
//     folds rounds CountedRounds returned),
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
import { isCounted } from '../rounds.js';

// sameSide — the JS twin of internal/analytics/rounds.go sameSide: an
// unknown side ("") never matches anything, which is exactly what makes
// an unknown side permissive for a kill/assist classification.
function sameSide(a, b) {
  return a !== '' && a === b;
}

// liveStats folds events AT the playhead into per-player rows.
//
//   events   normalized typed event rows (Replay's drawNorm): only
//            `kill` / `damage` rows do anything here
//   opts.rounds   GetRounds rows (number/startTick/warmup/pregame)
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

  const byNumber = new Map();
  for (const r of rounds) {
    if (r && Number.isFinite(Number(r.number))) byNumber.set(Number(r.number), r);
  }

  // ADR denominator: counted rounds whose START is at/before the
  // playhead (a round whose start tick is unknown is not counted as
  // started — never guessed into the denominator).
  let started = 0;
  for (const r of rounds) {
    if (!isCounted(r)) continue;
    const start = Number(r.startTick);
    if (Number.isFinite(start) && start <= playhead) started++;
  }

  const kills = new Map();
  const deaths = new Map();
  const assists = new Map();
  const dmg = new Map();
  const bump = (m, id) => m.set(id, (m.get(id) || 0) + 1);
  const addDmg = (id, n) => dmg.set(id, (dmg.get(id) || 0) + n);

  const side = (id, tick) => (sideAt ? String(sideAt(id, tick) || '') : '');

  for (const e of events || []) {
    if (!e) continue;
    const et = Number(e.tick);
    // A row without a usable tick cannot be placed at the playhead —
    // dropped, never guessed into the fold.
    if (!Number.isFinite(et) || et > playhead) continue;
    // Counted rounds only — see the module header.
    if (!isCounted(byNumber.get(Number(e.round)))) continue;

    if (e.kind === 'kill') {
      const atk = String(e.attacker || '');
      const vic = String(e.victim || '');
      const asr = String(e.assister || '');
      const vt = vic ? side(vic, et) : '';
      if (atk && !sameSide(side(atk, et), vt)) bump(kills, atk);
      if (asr && asr !== vic && !sameSide(vt, side(asr, et)) && !e.assistedFlash) {
        bump(assists, asr);
      }
      if (vic) bump(deaths, vic);
    } else if (e.kind === 'damage') {
      const atk = String(e.attacker || '');
      if (atk) addDmg(atk, Number(e.dmg) || 0);
    }
  }

  const out = new Map();
  const rowFor = (id) => {
    let row = out.get(id);
    if (!row) {
      row = { k: 0, d: 0, a: 0, adr: null };
      out.set(id, row);
    }
    return row;
  };
  for (const id of Array.isArray(opts.steamIds) ? opts.steamIds : []) {
    if (id) rowFor(id);
  }
  for (const m of [kills, deaths, assists, dmg]) {
    for (const id of m.keys()) rowFor(id);
  }
  for (const [id, n] of kills) out.get(id).k = n;
  for (const [id, n] of deaths) out.get(id).d = n;
  for (const [id, n] of assists) out.get(id).a = n;
  // ADR per player: their damage (friendly fire included) over the
  // counted rounds started so far. With 0 started rounds every adr stays
  // null — the card renders "—", never a fake 0.
  if (started > 0) {
    for (const id of out.keys()) out.get(id).adr = (dmg.get(id) || 0) / started;
  }
  return out;
}
