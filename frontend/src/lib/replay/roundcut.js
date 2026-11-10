// roundcut.js — THE one round-boundary cleanup rule for replay entities
// (the render-side twin of the game's own cleanup: CS2 clears leftover
// projectiles and infernos when a round is over — demoinfocs models it as
// clearGrenadeProjectiles — so a smoke/fire/pop that outlived its round
// is an artifact of OUR drawing, not of the demo).
//
// The strategy was already solved twice, for the planted C4 (bomb.js
// bombEndTick) and the death marker (renderer.js killEndTick); this module
// is the ONE home for its scans, so the third, fourth… implementations
// cannot drift:
//
//   sameRoundEndTick    — the FIRST same-round round_end at/after the
//                         row's tick, else null (a round_end from another
//                         round, or one stamped BEFORE the row, can never
//                         terminate it);
//   nextRoundStartTick  — the FIRST round_start strictly AFTER the row's
//                         tick, else null (the round that CONTAINS the row
//                         started before it — that start cannot kill it);
//   roundCutTick        — P1: end ?? start ?? null. Never a fabricated
//                         boundary: a live or truncated round (no rows
//                         loaded) returns null and the caller keeps its
//                         own lifetime;
//   entityEndTick       — min(own end, cut) with the fallback semantics:
//                         an own lifetime (smoke 18 s / fire 7 s) bounds
//                         the entity when there is no cut, and the cut
//                         bounds it when the lifetime would outlive the
//                         round. opts { policy, lifetimeS?, tickRate? };
//                         a non-finite row tick ends at 0 — the draw
//                         loops' boundary spelling then skips it forever
//                         (the killEndTick → 0 convention).
//
// Boundary spelling, used verbatim by every gated draw loop (cf.
// drawBomb / drawDeaths): `tick >= end && tick !== row.tick` — the entity
// is gone AT its cutoff (a paused ribbon seek to the next round's
// startTick must clear it), while its OWN tick always draws (a row stamped
// on the boundary still marks that one tick).
//
// ROUND_POLICY — which rule each pre-bucketed landmark bucket obeys.
// Rows arrive bucketed (lib/replay/landmarks.js drawBucket), so this
// table IS the classification: no runtime classification ever happens in
// the render path. Buckets absent from the table are NEVER round-cut:
//
//   P1 'area' — the LINGERING smoke/fire area dies AT its round's
//       round_end, capped by its own lifetime (renderer.js SMOKE_LIFETIME_S
//       / FIRE_LIFETIME_S). Evidence motivating it: smoke leaked in 7/80
//       detections on the dev pool, worst +16.4 s past the end — into the
//       NEXT round's freezetime; a fire leaked +57 ticks.
//   P2 'pop' — detonation pops, the bomb explode/defuse pops, grenade
//       flight arcs and the decoy rest/noise window survive round_end and
//       are cut only at the NEXT round_start. Why: bomb_explode sits
//       EXACTLY on its round's end_tick, so a round_end cut would kill
//       the 3 s explosion ring on its own tick (one-frame flash). A bucket
//       drawn BOTH ways (smoke/fire: the lingering area AND its
//       detonation bloom) carries both rules.
//   P3 keep — deliberately ABSENT (already canonical elsewhere): the death
//       X (killEnds / killEndTick), the planted C4 (bombEndTick), the
//       dropped C4 and guns (bombEvidenceAt / drops.js windows), the
//       plant/defuse action rings (actionIntervals), the kill feed and the
//       chat (round-scoped by their own overlays).
//   P4 deliberate non-consolidations — also ABSENT: players/trails (player
//       state — freezetime movement is legitimate) and the tracers /
//       blinds / voice+shot blooms (sub-second crossings), plus the
//       sub-second damage flash. Distinct questions, left as variants.
//
// Pure functions over pre-bucketed rows — unit-tested by
// src/lib/roundcut.test.js; consumed by renderer.js setLandmarks (the
// precomputed roundCuts Maps) and, for the two boundary scans, delegated
// to by killEndTick (renderer.js) and bombEndTick (bomb.js).

// ROUND_POLICY — bucket → the round rules that bucket's drawings obey
// (see the P1/P2/P3/P4 notes in the header).
export const ROUND_POLICY = {
  // P1 areas — the lingering area plus its detonation bloom (a pop):
  smoke: ['area', 'pop'],
  fire: ['area', 'pop'],
  // P2 pops/arcs — grace to the next round_start only:
  detonation: ['pop'],
  flash: ['pop'],
  he: ['pop'],
  throw: ['pop'], // the flight arc (gated on its throw row)
  land: ['pop'], // the decoy REST/noise window — drawn from the PLAN, so
  //              the renderer computes this cut per plan entry from
  //              landTick (same rule, same helper)
  explode: ['pop'], // the C4 blast ring
  defuse: ['pop'], // the defuse completion pop
};

// sameRoundEndTick — the P1 round_end scan: the earliest SAME-ROUND
// round_end at/after the row, else null. Round-scoped on purpose: a later
// round's round_end (or an earlier one) must never terminate this row.
// A non-finite row tick never matches (mirrors killEndTick/bombEndTick —
// NaN comparisons fail, so the result is null, never a fabricated cut).
export function sameRoundEndTick(row, roundEnds) {
  if (!row || !Number.isFinite(row.tick)) return null;
  let end = null;
  for (const e of roundEnds || []) {
    if (
      e &&
      Number.isFinite(e.tick) &&
      e.round === row.round &&
      e.tick >= row.tick &&
      (end === null || e.tick < end)
    ) {
      end = e.tick;
    }
  }
  return end;
}

// nextRoundStartTick — the P2 rule (and the P1 rule's second half): the
// first round_start strictly AFTER the given tick, else null. Deliberately
// NOT round-scoped — rows are chronological, so the earliest start after
// the row IS the round that follows it. A non-finite tick never matches.
export function nextRoundStartTick(tick, roundStarts) {
  if (!Number.isFinite(tick)) return null;
  let next = null;
  for (const s of roundStarts || []) {
    if (s && Number.isFinite(s.tick) && s.tick > tick && (next === null || s.tick < next)) {
      next = s.tick;
    }
  }
  return next;
}

// roundCutTick — the P1 boundary: the same-round round_end at/after the
// row, else the next round_start, else null (a live/truncated round is
// never cut). Post-round rows (stamped past their own round_end — the
// C4-detonation shape) fall through to the next start exactly like
// killEndTick's fix for them.
export function roundCutTick(row, roundEnds, roundStarts) {
  const end = sameRoundEndTick(row, roundEnds);
  return end !== null ? end : nextRoundStartTick(row && row.tick, roundStarts);
}

// entityEndTick — min(own end, cut) with the fallback semantics (the
// unified per-row end every gated draw loop reads):
//   policy 'area' → roundCutTick (round_end else next round_start);
//   policy 'pop'  → nextRoundStartTick only (round_end is NOT a
//                   terminator — see ROUND_POLICY P2);
//   any other     → no round rule at all (P3/P4 buckets are never routed
//                   here; the own lifetime, when given, still applies).
// With an own `lifetimeS` the result is min(lifetime, cut) — the lifetime
// alone when nothing cuts (truncated round), the cut alone when no
// lifetime is given (a pop), null when neither applies (nothing to bound).
// An invalid tickRate defaults to 64 exactly like killEndTick, and a
// non-finite row tick ends at 0 (never draws — the killEndTick convention).
export function entityEndTick(row, opts, roundEnds, roundStarts) {
  if (!row || !Number.isFinite(row.tick)) return 0;
  const policy = opts && opts.policy;
  let cut = null;
  if (policy === 'area') cut = roundCutTick(row, roundEnds, roundStarts);
  else if (policy === 'pop') cut = nextRoundStartTick(row.tick, roundStarts);
  let own = null;
  if (opts && Number.isFinite(opts.lifetimeS)) {
    const tr = opts.tickRate > 0 ? opts.tickRate : 64;
    own = row.tick + opts.lifetimeS * tr;
  }
  if (own === null) return cut;
  if (cut === null) return own;
  return Math.min(own, cut);
}
