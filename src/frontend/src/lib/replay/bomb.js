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
//   3. actionIntervals / actionDurationTicks / actionProgressAt — the
//                      plant/defuse ATTEMPT lifecycle (below): begin →
//                      completion | abort | round-end fallback, the one
//                      interval rule behind the renderer's progress
//                      rings (and the row taxonomy ACTION_KINDS that
//                      the sfx cue points read). The interval bounds the
//                      ring's VISIBILITY; the ring's FRACTION is elapsed
//                      over the fixed game duration (actionDurationTicks
//                      — 10 s / 5 s defuse by kit, 3.125 s plant), never
//                      over the attempt's own observed span (a fake
//                      defuse aborts in 3–152 ticks and would race to
//                      full otherwise). Sibling of bombEndTick, never a
//                      part of it — that one is the PLANTED-MARKER
//                      lifetime, this one is the ARMING/DEFUSING window.
//
// All are pure functions over pre-bucketed landmark rows (lib/replay/
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
import { sameRoundEndTick, nextRoundStartTick } from './roundcut.js';

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
  // The bomb's OWN terminators (bomb_explode / bomb_defuse): same round,
  // at/after the plant — the earliest wins.
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
  // The round_end half of the boundary is DELEGATED to roundcut.js
  // (sameRoundEndTick — the scan roundCutTick composes), so this rule and
  // the death X / the round-cut cleanup can never drift apart. The MIN
  // with the next round_start below is kept: bombEndTick is pinned to it
  // (a same-round round_end AFTER the next round's start must lose —
  // behavior pins win over consolidation), so the roundCutTick ELSE
  // semantics is deliberately NOT adopted here.
  const roundEnd = sameRoundEndTick(plant, roundEnds);
  if (roundEnd !== null && (end === null || roundEnd < end)) end = roundEnd;
  // No same-round terminator rows loaded → the C4 timer (40 s) is the
  // hard fallback. Present rows are evidence, never capped: the 41 s
  // recorded plant → blast (above) would otherwise truncate before the
  // real explosion.
  if (end === null) end = plant.tick + 40 * tr;
  // The next round's start (rows are chronological, so the earliest
  // start strictly after the plant IS the next round's). Strictly after,
  // like killEndTick: a round_start on the plant's own tick is the
  // plant round's start and cannot terminate a bomb it contains. Only
  // ever shortens (`next < end`), so a distant next-round start never
  // outlives the terminator or the 40 s fallback either. Scanned by
  // roundcut.js's nextRoundStartTick — the same helper killEndTick and
  // the pops' gates use.
  const next = nextRoundStartTick(plant.tick, roundStarts);
  if (next !== null && next < end) end = next;
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

// --- plant/defuse attempt lifecycle -----------------------------------------

// ACTION_KINDS — THE taxonomy of the plant/defuse ATTEMPT events: which
// typed kind OPENS, COMPLETES and CANCELS each action. One home for the
// three-way mapping: actionIntervals below and the sfx cue points
// (sfx.js bombActionCues) both read it, so the renderer's rings and the
// sounds can never disagree about which row is which. The kinds mirror
// models.EventKind — the extractor stores them from demoinfocs'
// entity-derived mimic events (CS2.md "demoinfocs v6 plant/defuse
// ATTEMPT events": cancels are directly detectable, 0 attempts across
// the golden pool saw both an abort and a completion).
export const ACTION_KINDS = {
  plant: { begin: 'bomb_plant_begin', complete: 'bomb_plant', abort: 'bomb_plant_abort' },
  defuse: { begin: 'bomb_defuse_start', complete: 'bomb_defuse', abort: 'bomb_defuse_abort' },
};

// actionActor — a lifecycle row's actor key (the planter/defuser's
// SteamID). Every row carries it on `attacker` (normalizeEvent blanks
// `steamId` only for the COMPLETED bomb-entity rows, and those keep
// `attacker` through the spread), which is what ties an attempt to the
// dot its ring surrounds. '' = unknown: never guessed, and never a veto
// on its own (the absent-data rule of landmarks.sameUtilityWeapon).
function actionActor(row) {
  return String((row && (row.attacker || row.steamId)) || '');
}

// actionIntervals — THE plant/defuse ATTEMPT interval rule (sibling of
// bombEndTick, which is the PLANTED-MARKER lifetime — never a part of
// it). For every begin row, end = the earliest COMPLETION inside the
// attempt window — a completed plant/defuse always wins, completion
// overrides any cancel (the spec's rule) — else the earliest ABORT in
// the window, else the round-end fallback: that round's round_end at or
// after the begin, else the next round_start (the SAME evidence rows
// bombEndTick / killEndTick consume; 1 of 92 plant attempts on the
// golden pool emitted neither an abort nor a completion and must not
// ring forever). With no round rows loaded the attempt is DROPPED — no
// invented duration. The window is [begin, the next begin of the same
// action): everything after the next attempt's begin belongs to that
// attempt, so the fallback end is capped there too ('next-begin'). A
// close whose actor differs from the begin's never closes it, and an
// attempt that closes at/before its own begin (zero span) is dropped —
// progress would be undefined.
//
// The returned span bounds the ring's VISIBILITY only ([start, end): the
// arc appears at begin and vanishes at completion/abort/round-end); the
// ring's FRACTION is elapsed over the fixed game duration — see
// actionDurationTicks / actionProgressAt below. A fake/tapped attempt's
// span (3–152 ticks — CS2.md "What cancels a plant / defuse") must never
// be the denominator: dividing by it raced a tapped attempt's arc to full.
//
// Returns [{action, start, end, closedBy, steamId, round}] with
// start < end, in begin-tick order. Pure — unit-tested by
// src/lib/bomb.test.js; consumed by renderer.js setLandmarks (rings).
export function actionIntervals(rows) {
  const out = [];
  if (!Array.isArray(rows) || rows.length === 0) return out;
  const begins = { plant: [], defuse: [] };
  const closes = { plant: [], defuse: [] };
  const roundEnds = [];
  const roundStarts = [];
  for (const r of rows) {
    if (!r || !Number.isFinite(r.tick)) continue;
    const kind = String(r.kind || '');
    let family = null;
    for (const action of ['plant', 'defuse']) {
      const k = ACTION_KINDS[action];
      if (kind === k.begin || kind === k.complete || kind === k.abort) {
        family = action;
        break;
      }
    }
    if (family) {
      const k = ACTION_KINDS[family];
      if (kind === k.begin) begins[family].push(r);
      else closes[family].push(r);
    } else if (kind === 'round_end') {
      roundEnds.push(r);
    } else if (kind === 'round_start') {
      roundStarts.push(r);
    }
  }
  const byTick = (a, b) => a.tick - b.tick;
  for (const action of ['plant', 'defuse']) {
    const k = ACTION_KINDS[action];
    const bs = begins[action].slice().sort(byTick);
    const cs = closes[action].slice().sort(byTick);
    bs.forEach((b, i) => {
      const windowEnd = i + 1 < bs.length ? bs[i + 1].tick : Infinity;
      const actor = actionActor(b);
      let completion = null;
      let abort = null;
      for (const c of cs) {
        if (c.tick < b.tick || c.tick >= windowEnd) continue;
        const ca = actionActor(c);
        if (ca && actor && ca !== actor) continue; // another player's close
        if (c.kind === k.complete) {
          if (!completion || c.tick < completion.tick) completion = c;
        } else if (!abort || c.tick < abort.tick) {
          abort = c;
        }
      }
      let end = null;
      let closedBy = '';
      if (completion) {
        end = completion.tick;
        closedBy = 'complete';
      } else if (abort) {
        end = abort.tick;
        closedBy = 'abort';
      } else {
        for (const r of roundEnds) {
          if (r.round === b.round && r.tick >= b.tick && (end === null || r.tick < end)) end = r.tick;
        }
        if (end === null) {
          for (const s of roundStarts) {
            if (s.tick > b.tick && (end === null || s.tick < end)) end = s.tick;
          }
        }
        closedBy = 'round';
        if (end !== null && windowEnd !== Infinity && end > windowEnd) {
          end = windowEnd; // the next attempt's begin bounds this one
          closedBy = 'next-begin';
        }
      }
      if (end === null || !(end > b.tick)) return; // no evidence → no ring
      out.push({
        action,
        start: b.tick,
        end,
        closedBy,
        steamId: actor,
        round: b.round,
      });
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// actionDurationTicks — the FIXED game duration of an attempt in ticks:
// the ring's denominator (CS2.md "Plant / defuse durations": plant
// 3.125 s = 200 ticks @64; defuse 10 s = 640 / 5 s = 320 with a kit).
//
//   plant   3.125 s × tickRate
//   defuse  (hasKit === true ? 5 : 10) s × tickRate
//
// Kit is TRI-STATE (kits.js hasKitAt: true | false | null): only an
// answered `true` buys the 5 s denominator — false and null (rows cannot
// answer: no player key, before the first round_start) both read as NO
// kit, the conservative side: a fake must never fill fast. An invalid
// tickRate reads as 64 (the killEndTick rule).
//
// WHY a constant and not the observed span: for a COMPLETED attempt the
// span equals the real duration (640/320/200), so the two agree — but a
// FAKE/tapped attempt aborts 3–152 ticks after its begin (CS2.md "What
// cancels a plant / defuse"), and dividing by that span raced a tap's
// arc to ~full. Visibility stays the observed interval (actionIntervals
// — begin → completion/abort/round-end); only the FRACTION is game-time.
// Pure — unit-tested by src/lib/bomb.test.js; consumed by renderer.js
// drawPlayers at draw time (see the setKitEvidence / setLandmarks
// ordering note there).
export function actionDurationTicks(action, hasKit, tickRate) {
  const tr = tickRate > 0 ? tickRate : 64;
  if (action === 'defuse') return (hasKit === true ? 5 : 10) * tr;
  if (action === 'plant') return 3.125 * tr;
  return null; // unknown family — no ring rather than a guessed duration
}

// actionProgressAt — the ring's fraction at `tick`: elapsed / fixed game
// duration —
//
//   defuse  (tick − start) / (hasKit ? 5 s : 10 s)      [actionDurationTicks]
//   plant   (tick − start) / 3.125 s
//
// CLAMPED to ≤ 1: an attempt that outlives its duration (the round-end
// fallback window) holds a full circle and never sweeps past 2π
// (drawActionRing's arc math would otherwise wrap). The denominator is
// NEVER the attempt's own [start, end) span — that span bounds
// VISIBILITY only: null OUTSIDE [start, end), open at the end (the
// attempt is over AT its end tick — a finished plant is no longer
// planting, an aborted one no longer arming), so the ring disappears the
// moment the attempt resolves — a pure function of tick, seek-safe like
// every other renderer layer. Range is (0, 1]: the begin tick itself
// draws nothing (a zero-length arc with a round cap would be a dot, and
// progress 0 has nothing to show). A non-finite/non-positive duration
// draws nothing — never a guessed denominator (the observed-span bug
// this replaced). `duration` comes from actionDurationTicks.
export function actionProgressAt(interval, tick, duration) {
  if (!interval || !Number.isFinite(tick)) return null;
  const start = interval.start;
  const end = interval.end;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return null;
  if (tick <= start || tick >= end) return null;
  if (!Number.isFinite(duration) || !(duration > 0)) return null;
  return Math.min((tick - start) / duration, 1);
}
