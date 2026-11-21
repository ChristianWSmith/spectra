// The Combat tab's pure model (builtins/match): the engagement kinds, the
// per-kill grouping of engagement rows and the clutch kill-tick parse. No
// imports, so the unit tests and the panels share one definition.

// The engagement kinds the backend produces (analytics/engagements.go).
export const ENG_KINDS = ['opening', 'trade', 'traded', 'untraded'];

// The tick rate a match with no recorded rate is read at (the Combat view's
// long-standing default).
export const DEFAULT_TICK_RATE = 64;

// groupEngagements merges the rows of one kill into ONE row per KILL: the
// grouping key is round | tick | killer | victim, and the row keeps the
// fetch's order (first appearance) with its distinct kinds in fetch order.
// Every kill yields at least one row (exactly one victim-side row: traded or
// untraded), and the kinds are independent facts of the same kill.
export function groupEngagements(engagements) {
  const groups = new Map();
  for (const e of engagements) {
    const key = `${e.round}|${e.tick}|${e.aSteam}|${e.bSteam}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        round: e.round,
        tick: e.tick,
        aSteam: e.aSteam,
        aName: e.aName,
        bSteam: e.bSteam,
        bName: e.bName,
        distance: e.distance,
        kinds: [],
      };
      groups.set(key, g);
    }
    if (!g.kinds.includes(e.kind)) g.kinds.push(e.kind);
  }
  return [...groups.values()];
}

// clutchKillTicks parses a ClutchRow.killTicks value: a JSON array of int
// ticks. Anything unparseable reads as no kills, never a guessed tick.
export function clutchKillTicks(raw) {
  if (typeof raw !== 'string' || raw === '') return [];
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
}
