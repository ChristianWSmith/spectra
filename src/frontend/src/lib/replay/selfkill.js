// lib/replay/selfkill.js — THE frontend disconnect-self-kill criterion.
//
// At a disconnect/kick the game fires a World self-kill on that player's
// exact tick (extract's criterion: same-tick `World` self-kill for the
// identity that disconnected — agg.disconnectTick / flushWorldSelf, and
// the frontend stats fold in replay/livestats.js foldEvent). The KILL ROW
// STAYS IN THE EVENTS (records stay records), but it is not a death that
// happened — it is a disconnect side effect, so surfaces that RENDER a
// death line suppress it under this ONE predicate while the disconnect
// line itself renders (owner ruling 2026-11-18: "he gets a self-kill
// death feed line and then a disconnect line — should be just disconnect.
// Happens for the bot too" — the criterion is per-PLAYER: whoever's
// disconnect it is, human or bot).
//
// This is the narrow, dated exception to the "event surfaces record what
// happened" stance: a disconnect self-kill is not an event-shaped fact
// worth showing — it never renders on the feed list, the kill ticker or
// the death marker. Raw event reads, the events table and CSV/JSON
// exports keep the record untouched.
//
// Twins: the Go rule (internal/analytics/rounds.go PlayerRounds — no stat
// for the pair) and the playhead stats fold (replay/livestats.js
// foldEvent, same criterion inline). livestats.js is fenced to another
// wave in flight right now — consolidating its inline copy onto this
// module is the queued follow-up (cross-ref noted, not edited).

// disconnectSet — the (player, tick) disconnect SET built from a match's
// player_disconnect rows (EventRow.attacker carries the leaver's
// identity — the same field indexConnections keys). A SET of ticks: a
// player may disconnect several times and each tick must match on its
// own. `rows` may be the always-fetched conn rows (the feed list) or any
// row list carrying kind/tick/attacker (the renderer's world rows).
export function disconnectSet(rows) {
  const out = new Map();
  for (const e of rows || []) {
    if (!e || e.kind !== 'player_disconnect') continue;
    const id = String(e.attacker || '');
    const t = Number(e.tick);
    if (!id || !Number.isFinite(t)) continue;
    let set = out.get(id);
    if (!set) out.set(id, (set = new Set()));
    set.add(t);
  }
  return out;
}

// isDisconnectSelfKill — THE predicate: is this row a kill that is the
// disconnect side effect for its own victim? All four must hold:
// a kill row, attacker === victim (a self-kill), weapon 'World', and a
// player_disconnect for that victim on that exact tick in `set`.
// Anything else (a genuine world-hazard self-kill with no same-tick
// disconnect, an attacker≠victim kill, a missing set) is NOT the
// artifact and renders as before — fail toward SHOWING, never toward
// hiding a real death.
export function isDisconnectSelfKill(row, set) {
  if (!row || row.kind !== 'kill') return false;
  const vic = String(row.victim || '');
  if (!vic || String(row.attacker || '') !== vic) return false;
  if (String(row.weapon || '') !== 'World') return false;
  const t = Number(row.tick);
  return Number.isFinite(t) ? !!(set && set.get(vic) && set.get(vic).has(t)) : false;
}
