// Canonical bomb (C4) lifecycle module — THE one place the replay-time
// bomb state machine lives:
//
//   1. bombEndTick    — how long a PLANTED C4 marker stays on the map:
//                      plant → first same-round terminator (detonation,
//                      defuse, or the ROUND END itself) or the NEXT
//                      round's start (the death-X fix's second cutoff —
//                      see killEndTick), with the 40 s C4 timer as the
//                      fallback when NO terminator row is loaded — never
//                      a cap over a present row (the recorded
//                      plant → blast interval is 41 s; see bombEndTick).
//                      The round-end terminator is the cleanup for
//                      rounds that end before the bomb resolves (a
//                      defuse, or a round decided while the bomb still
//                      ticks) — without it the marker stuck until the
//                      timer ran out even though the round was over.
//
//   2. bombEvidenceAt — the DROPPED-C4 reconstruction rule (below).
//
// Both are pure functions over pre-bucketed landmark rows (lib/replay/
// landmarks.js normalizeEvent output: kind / round / tick plus x/y/z
// aliased from the stored posX/posY/posZ). The renderer's world layers
// (drawBomb's planted + dropped markers) and the smart camera's bomb
// point are the consumers; rows arrive with positions because the
// extractor stores the carrier's position on bomb_drop and the bomb /
// pickup player's position on bomb_pickup (extract agg.bombDropped /
// bombPickedUp).
//
// Deliberately NO Go twin: internal/analytics bombStateAt classifies
// STATE for clutches (planted|carried|dropped|none) from the same
// events and has no position need — a second position implementation
// would be a layer with no consumer (AGENTS.md "one canonical way").
// The dropped-C4 evidence is stored, not derived, on the Go side, so
// there is no rule left to twin.
//
// Unit-tested by src/lib/bomb.test.js (the lib test glob
// src/lib/*.test.js picks it up).

// hasBombPos reports whether a row carries a usable world position
// (normalizeEvent aliases posX/posY → x/y; missing evidence stays
// null — the zero-vector convention of extract's posPtrs).
export function hasBombPos(row) {
  return !!row && Number.isFinite(row.x) && Number.isFinite(row.y);
}

// bombEndTick — the planted-C4 visibility rule: the marker is drawn
// from plant.tick until the FIRST terminator at/after the plant —
// bomb_explode, bomb_defuse, or round_end (the round is over, the entity
// is gone — this is the round-end cleanup) — plus the NEXT round's first
// round_start after it, which is the death-marker fix's second cutoff
// (renderer.js killEndTick, commits 5b21c4f + 5dc0f93) carried over:
// a plant stamped AFTER its round's round_end (the C4-detonation
// window) has no same-round end left to terminate it, and without the
// round_start it survived into the next round on the fallback. With no
// terminator in the loaded rows the C4 timer (40 s) is the hard
// fallback — but only THEN: a terminator row that lands past it is real
// evidence and must win, never be capped by the estimate. Every
// detonation in the dev matches records plant → blast at exactly
// 2624 ticks = 41 s (one second past 40 s), so a 40 s cap truncated
// `end` BEFORE the real explosion — the marker died a second early and
// renderer detonatedAt, which gates on this terminator BEING the
// explode row (`e.tick === end`), never fired, letting the 115 s round
// clock resurrect during the round-over tail (the freeze-clock bug).
// Terminators from ANOTHER round, before the plant, or a round_start
// at/before the plant are ignored (a later round's round_end must never
// cut an earlier plant short; the plant round's own round_start precedes
// its plant), and a round_start never LENGTHENS the window past the
// terminator/fallback it cuts. Pure — head-tested in src/lib/bomb.test.js;
// drawn by renderer.js drawBomb and reused by the smart camera's bomb
// point and the HUD clock.
export function bombEndTick(plant, tr, explodes, defuses, roundEnds, roundStarts) {
  if (!plant || !Number.isFinite(plant.tick)) return 0;
  let end = null;
  const consider = (list) => {
    if (!list) return;
    for (const e of list) {
      if (e && e.round === plant.round && e.tick >= plant.tick && (end === null || e.tick < end)) {
        end = e.tick;
      }
    }
  };
  consider(explodes);
  consider(defuses);
  consider(roundEnds);
  // No same-round terminator rows loaded → the C4 timer (40 s) is the
  // hard fallback. Present rows are evidence, never capped: the 41 s
  // recorded plant → blast (above) would otherwise truncate before the
  // real explosion.
  if (end === null) end = plant.tick + 40 * tr;
  // The next round's start (rows are chronological, so the earliest
  // start strictly after the plant IS the next round's). Strictly after,
  // like killEndTick: a round_start on the plant's own tick is the
  // plant round's start and cannot terminate a bomb it contains. Only
  // ever shortens (`s.tick < end`), so a distant next-round start never
  // outlives the terminator or the 40 s fallback either.
  for (const s of roundStarts || []) {
    if (s && Number.isFinite(s.tick) && s.tick > plant.tick && s.tick < end) {
      end = s.tick;
    }
  }
  return end;
}

// bombEvidenceAt — THE dropped-C4 reconstruction rule, over an evidence
// bundle of pre-bucketed rows { drops, pickups, plants, roundEnds }:
//
//   For tick T in a round, with d = the LAST bomb_drop at/before T:
//     1. if a bomb_pickup (or bomb_plant) exists in d's round at
//        tick > d.tick and ≤ T → the bomb's evidenced position is THAT
//        row's position ({state: 'picked-up' | 'planted'});
//     2. else if d's round is still live at T → the bomb is on the
//        ground at the carrier position recorded on the drop
//        ({state: 'dropped'});
//     3. else → unknown (null — draw nothing, never extrapolate).
//
// Round scoping: T is evaluated against d's round only ("for tick T in
// a round"), and a T at/after that round's round_end returns unknown —
// a previous round's drop must never anchor the current frame. A drop
// without a stored position (old evidence / zero vector) falls through
// to unknown too. 'picked-up' consumers resolve the carrier from
// row.attacker (the pickup player) and follow that PLAYER's stream —
// carried bomb = its player; the pickup position itself is evidence of
// where the carrier took it, not a place to draw. Unit-tested by
// src/lib/bomb.test.js.
export function bombEvidenceAt(ev, tick) {
  const e = ev || {};
  let d = null;
  for (const row of e.drops || []) {
    if (row && row.tick <= tick && (!d || row.tick > d.tick)) d = row;
  }
  if (!d) return null; // never dropped before T: carried from spawn or
  // planted directly — the player stream / plant path owns those.

  // Scope to the drop's round; out of scope once that round ended.
  let end = null;
  for (const r of e.roundEnds || []) {
    if (r && r.round === d.round && r.tick >= d.tick && (!end || r.tick < end.tick)) {
      end = r;
    }
  }
  if (end && tick >= end.tick) return null;

  // Branch 1: a pickup/plant after the drop, still ≤ T, ends it.
  let term = null;
  for (const list of [e.pickups, e.plants]) {
    for (const row of list || []) {
      if (!row) continue;
      if (row.round !== d.round || row.tick <= d.tick || row.tick > tick) continue;
      if (!term || row.tick < term.tick) term = row;
    }
  }
  if (term) {
    return {
      state: term.kind === 'bomb_plant' ? 'planted' : 'picked-up',
      row: term,
      x: Number.isFinite(term.x) ? term.x : null,
      y: Number.isFinite(term.y) ? term.y : null,
      z: Number.isFinite(term.z) ? term.z : null,
    };
  }

  // Branch 2: still on the ground in a live round — the drop position.
  if (!hasBombPos(d)) return null; // branch 3: no evidence → unknown
  return { state: 'dropped', row: d, x: d.x, y: d.y, z: d.z ?? null };
}
