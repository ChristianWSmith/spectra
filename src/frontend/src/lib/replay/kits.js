// Canonical defuse-kit evidence module — THE one place the replay-time
// kit reconstruction lives, the structural sibling of bomb.js (the C4
// lifecycle) and drops.js (the dropped-gun/util layer). It answers the
// two questions the kit feature needs:
//
//   1. buildKitEvidence(rows, buyEnds, tickRate) — one match-static
//      pass that BUCKETS the kit rows out of the landmark feed, runs
//      the nearest-death DISAMBIGUATION (which death dropped the kit
//      somebody later picked up) and returns
//        { drops: Map<dropRow, {from, to}>, hasKitAt(steamId, tick) }
//      `drops` is the precomputed visibility window per kit drop — the
//      renderer's per-frame O(1) lookup, exactly drops.js
//      buildDropWindows' contract.
//
//   2. kitWindow(dropRow, pickup, roundEnds, roundStarts) — the
//      half-open [from, to) visibility rule for ONE drop (the mirror of
//      drops.js dropWindow, same gate structure), exported so the rule
//      is testable on its own. The ROUND terminator is delegated to
//      roundcut.js roundCutTick (the one round-boundary home — this
//      module never scans the boundary rows itself); `pickup` stays the
//      kit's own item terminator.
//
// WHY this is a separate module and not drops.js: the kit's evidence
// shape is the OPPOSITE of a gun's. A gun's pickup row names the weapon
// but not WHICH ground copy it took (drops.js says so itself —
// duplicate-name matching is deliberately best-effort), while a kit has
// exactly ONE loss channel (a CT dies holding it — CS2.md: no
// drop/pickup game events fire for kits at all) and buys look identical
// to ground pickups in item_pickup. So the kit layer needs two rules
// drops.js deliberately does not have:
//
//   - BUYTIME: an item_pickup at/before its round's `buytime_ended`
//     generic row is a BUY (the kit was purchased) and must NEVER
//     terminate a drop; only a later pickup can be a ground pickup.
//   - NEAREST DEATH: when several kit owners died before one pickup,
//     the pickup claims the death it most plausibly came from —
//     the owner's rule: "back-propagation … aware of the nearest death
//     that could have resulted in the pickup".
//
// Inputs are match-static (built once from the renderer's normalized
// landmark rows — landmarks.js normalizeEvent output: kind / round /
// tick / weapon / steamId plus x/y/z aliased from the stored positions,
// and `dropCat` joined from store.GetDropDetails by the view):
//
//   kitDrops    weapon_drop rows with dropCat 'kit'   {tick, round,
//               steamId = the victim's key, x/y/z = the victim's
//               position at the kill — extract agg.kill}
//   kitPickups  weapon_pickup rows with weapon KIT_WEAPON {tick, round,
//               steamId = the picker, x/y/z = the picker's position}
//   roundEnds / roundStarts  the boundary rows (the round TERMINATOR
//               is roundcut.js roundCutTick's composition over them —
//               this module never scans them itself; roundStarts also
//               feeds roundContaining below)
//   buyEnds     Map<round, tick> of that round's `buytime_ended` generic
//               row (buyEndsFromRows converts the one
//               getGenericEvents(id, 'buytime_ended', …) call's rows)
//   tickRate    for the score's seconds term (see LAMBDA)
//
// Missing evidence is never guessed: a drop with no position is never
// drawn and never claimed (drops.js hasDropPos's rule), a pickup with
// no position never claims anything (there is no honest distance to
// score), a round with no buytime_ended row reads its buyEnd as 0 (the
// open-bound convention: every pickup counts as post-buytime — there is
// no buy evidence to honour, never an invented one), and hasKitAt
// returns null where the rows cannot answer (no player key, no tick, no
// round containing the tick) instead of a fabricated false.
//
// Pure, seek-safe — unit-tested by src/lib/kits.test.js.
import { hasDropPos } from './drops.js';
import { roundCutTick } from './roundcut.js';

// KIT_WEAPON — THE canonical kit spelling on events.weapon (the Go twin
// is models.DefuseKitName; demoinfocs' EquipmentType.String() for
// EqDefuseKit, which is what extract's wepName stores). Exact match, so
// a near-miss spelling never becomes kit evidence (pinned by the test).
export const KIT_WEAPON = 'Defuse Kit';

// LAMBDA — the time weight of the nearest-death score, in world-units
// per SECOND of delay between the death and the pickup (AGENTS.md's
// formula rule: the constant carries its unit and its rationale here).
// 5 wu/s ≈ the picker walks ~5 world-units further per second the kit
// lay there: DISTANCE still dominates a normal pickup (the picker
// stands ON the kit, so a same-spot pickup scores ~0 + a few seconds of
// delay), and the time term only BREAKS TIES between two deaths that are
// comparably near — a 1-second-old death beats a 40-second-old one
// from the same spot. Pinned by kits.test.js.
export const LAMBDA = 5;

// KIT_MATCH_MAX — the hard candidate filter (world units, 2D): a
// pickup further than this from a drop can NEVER have come from it, no
// matter how well the time term scores. 4096 wu is roughly a long
// cross-map walk — far beyond any plausible "walked over the body"
// distance — so a stray late pickup (a kit bought and carried across
// half the map) stays UNMATCHED instead of terminating a distant drop.
// Pinned by kits.test.js.
export const KIT_MATCH_MAX = 4096;

// kitPos — a row's usable world position (drops.js hasDropPos's rule,
// scoped-named so drops.js stays the gun/util layer's content). Missing
// evidence stays null (extract's zero-vector convention → nil columns).
function kitPos(row) {
  return hasDropPos(row);
}

// dist2 — the 2D world distance between two positioned rows (the score
// ignores z: the picker and the body are on the same floor in practice,
// and a floor difference never makes a pickup plausible — see
// KIT_MATCH_MAX).
function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// buyEndsFromRows converts the ONE getGenericEvents(id, 'buytime_ended',
// …) call's rows ({round, tick}) into the Map<round, tick> that
// buildKitEvidence reads — the fetch itself belongs to the view
// (Replay.svelte), this is the shape boundary. A round with several
// rows keeps the FIRST (a round gets one buytime_ended; a duplicate is
// noise, never a later "buy window" — the earliest is the honest
// boundary). Malformed rows are skipped, never guessed.
export function buyEndsFromRows(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r || !Number.isFinite(r.tick) || !Number.isFinite(r.round)) continue;
    if (!out.has(r.round)) out.set(r.round, r.tick);
  }
  return out;
}

// buyEndOf — the round's buytime_ended tick, or 0 when the rows carry
// none (open bound: no buy evidence exists, so every pickup counts as
// post-buytime — the honest reading of absent data, never an invented
// buy window).
function buyEndOf(buyEnds, round) {
  if (buyEnds instanceof Map) {
    const v = buyEnds.get(round);
    return Number.isFinite(v) ? v : 0;
  }
  const v = buyEnds ? buyEnds[round] : undefined;
  return Number.isFinite(v) ? v : 0;
}

// roundContaining — the round NUMBER a tick falls in: the one stamped on
// the LAST round_start at/before the tick (so the round-over tail after
// a round_end still belongs to the round just played — the same reading
// drops.js gives a drop in that tail). null when no round_start row is
// at/before the tick (before the first round, or no rows loaded) — an
// unknown answer, never a guessed round 1.
function roundContaining(tick, roundStarts) {
  let best = null;
  for (const s of roundStarts || []) {
    if (!s || !Number.isFinite(s.tick)) continue;
    if (s.tick > tick) continue;
    if (!best || s.tick > best.tick) best = s;
  }
  return best && Number.isFinite(best.round) ? best.round : null;
}

// kitWindow — the half-open VISIBILITY WINDOW [from, to) for ONE kit
// drop, the structural mirror of drops.js dropWindow (same gate
// structure, evaluated once over match-static rows — the renderer
// precomputes it in setLandmarks, so a frame is one Map read):
//
//   1. position    hasDropPos(d) — a position-less row returns null
//                  (never drawn, never guessed — drops.js's rule);
//   2. from        d.tick (the death is when the kit hits the ground);
//   3. to          the MIN of
//                    - the matched pickup's tick (the nearest-death
//                      winner — buildKitEvidence resolves `pickup`;
//                      null for a drop nobody claimed), and
//                    - roundCutTick(d, roundEnds, roundStarts) — the
//                      canonical round boundary (roundcut.js): the
//                      FIRST same-round round_end at/after d.tick,
//                      else the next round_start (a kit dropped AFTER
//                      its round ended — the post-round tail — ends
//                      THERE), else null for a live/truncated round
//                      (kept as Infinity — never a fabricated
//                      boundary). The two layers (drops/kits) can never
//                      disagree about when a round's items vanish:
//                      they run the SAME composition;
//                  Infinity when neither exists (lives until the demo
//                  ends, exactly like dropWindow's fallback).
// Half-open: visible at tick === from, gone at tick === to (pinned by
// the boundary test). `roundStarts` is OPTIONAL (a 4th arg): omitted /
// empty it contributes no fallback cut, exactly like no boundary rows.
export function kitWindow(dropRow, pickup, roundEnds, roundStarts) {
  const d = dropRow;
  if (!d || !Number.isFinite(d.tick) || !kitPos(d)) return null;
  const cut = roundCutTick(d, roundEnds, roundStarts);
  let to = cut !== null ? cut : Infinity;
  if (pickup && Number.isFinite(pickup.tick) && pickup.tick > d.tick && pickup.tick < to) {
    to = pickup.tick;
  }
  return { from: d.tick, to };
}

// kitVisibleAt — the window's half-open membership test (the one place
// the [from, to) semantics live, so the renderer and the tests read the
// same comparison). A null window is never visible.
export function kitVisibleAt(win, tick) {
  return !!win && Number.isFinite(tick) && tick >= win.from && tick < win.to;
}

// --- nearest-death disambiguation ------------------------------------------

// score — Formula:
//   score(d, P) = dist(d.pos, P.pos) + LAMBDA * (P.tick - d.tick) / tickRate
// i.e. world-distance plus LAMBDA world-units per second of delay
// between the death and the pickup (see LAMBDA). Lower wins; distance
// dominates, time is the tie-breaker. tickRate <= 0 / non-finite → the
// seconds term is 0 (a missing tick rate must never divide by zero, and
// the distance term — the dominant one — still decides).
function score(d, p, tickRate) {
  const seconds = tickRate > 0 ? (p.tick - d.tick) / tickRate : 0;
  return dist2(d, p) + LAMBDA * seconds;
}

// matchKits — THE nearest-death rule, run ONCE per build in pickup-tick
// order, grouped per round (the owner's spec: "back-propagation …
// aware of the nearest death that could have resulted in the pickup").
// Returns Map<dropRow, pickupRow> of CLAIMED drops.
//
// For each pickup P (round R, ascending tick):
//   - P is a BUY (P.tick <= buyEnd[R]) → skipped entirely: a buy never
//     terminates a drop (buys and ground pickups are the SAME
//     item_pickup row — only buytime tells them apart);
//   - P has no position → skipped (no honest distance to score);
//   - candidates d: same round, d.tick < P.tick, cat 'kit', positioned,
//     not already claimed (claim order = pickup tick order — a drop is
//     taken by exactly one pickup), dist(d, P) <= KIT_MATCH_MAX;
//   - winner = the LOWEST score (ties → the earliest drop, iteration
//     order over the tick-sorted list, so the result is deterministic);
//   - no candidate → P stays UNMATCHED: a plain gain (it still counts
//     in hasKitAt) with no window effect on any drop.
// Losers and never-claimed drops keep their round-end window — they
// were never picked up in this round, so they render at the death
// position until the round ends.
function matchKits(kitDrops, kitPickups, buyEnds, tickRate) {
  const claimed = new Map();
  const dropsByRound = new Map();
  const pickupsByRound = new Map();
  const byTick = (a, b) => a.tick - b.tick;
  for (const d of kitDrops) {
    if (!dropsByRound.has(d.round)) dropsByRound.set(d.round, []);
    dropsByRound.get(d.round).push(d);
  }
  for (const p of kitPickups) {
    if (!pickupsByRound.has(p.round)) pickupsByRound.set(p.round, []);
    pickupsByRound.get(p.round).push(p);
  }
  // Every round either side touched runs (a buy-only round simply
  // claims nothing); both lists are tick-sorted so the candidate walk
  // can break at the first non-earlier death and ties resolve to the
  // earliest drop — a DETERMINISTIC winner for identical inputs.
  const rounds = new Set([...dropsByRound.keys(), ...pickupsByRound.keys()]);
  for (const round of rounds) {
    const drops = (dropsByRound.get(round) || []).slice().sort(byTick);
    const pickups = (pickupsByRound.get(round) || []).slice().sort(byTick);
    const buyEnd = buyEndOf(buyEnds, round);
    for (const p of pickups) {
      if (p.tick <= buyEnd) continue; // a buy never terminates a drop
      if (!kitPos(p)) continue; // no distance → never claims
      let best = null;
      let bestScore = Infinity;
      for (const d of drops) {
        if (d.tick >= p.tick) break; // sorted: only EARLIER deaths
        if (claimed.has(d)) continue; // already taken by an earlier pickup
        if (!kitPos(d)) continue; // never claimed (never drawn either)
        const dist = dist2(d, p);
        if (dist > KIT_MATCH_MAX) continue; // hard filter
        const s = score(d, p, tickRate);
        if (s < bestScore) {
          bestScore = s;
          best = d;
        }
      }
      if (best) claimed.set(best, p);
    }
  }
  return claimed;
}

// buildKitEvidence — THE one builder (module header). Buckets the kit
// rows out of `rows`, runs matchKits, and returns:
//   drops     Map<dropRow, {from, to}> — the visibility window of every
//             DRAWABLE kit drop (position-less rows get no entry: they
//             are never drawn, drops.js's rule). Keyed by the ROW
//             OBJECT, so the renderer's lookup is identity-exact —
//             drops.js buildDropWindows' contract.
//   hasKitAt  (steamId, tick) → true | false | null — see below.
// Pure over its inputs: the same rows always produce the same windows.
export function buildKitEvidence(rows, buyEnds, tickRate) {
  const kitDrops = [];
  const kitPickups = [];
  const roundEnds = [];
  const roundStarts = [];
  for (const r of rows || []) {
    if (!r || !Number.isFinite(r.tick)) continue;
    const kind = String(r.kind || '');
    if (kind === 'weapon_drop' && r.dropCat === 'kit') kitDrops.push(r);
    else if (kind === 'weapon_pickup' && r.weapon === KIT_WEAPON) kitPickups.push(r);
    else if (kind === 'round_end') roundEnds.push(r);
    else if (kind === 'round_start') roundStarts.push(r);
  }
  const claimed = matchKits(kitDrops, kitPickups, buyEnds, tickRate);

  const drops = new Map();
  for (const d of kitDrops) {
    const w = kitWindow(d, claimed.get(d) || null, roundEnds, roundStarts);
    if (w) drops.set(d, w);
  }

  // hasKitAt — does this player hold a kit AT `tick`? Round-scoped (the
  // round containing the tick — rounds reset kits, so nothing carries
  // across):
  //   gains   = that player's kit pickups in that round at/before the
  //             tick (buy OR ground — both are stored, both are gains:
  //             a bought kit is a kit);
  //   losses  = that player's kit drops in that round at/before the
  //             tick (a DEATH is the only way a CT loses a kit — the
  //             owner rule);
  //   answer  = gains.length > 0 && lastGain > lastLoss
  //             (gain → lose → gain again = true; lose → nothing = false;
  //             no gains at all = false — the evidence is complete for
  //             the match, so "no kit rows for this player" IS an
  //             answer, not missing data).
  // null = the rows cannot answer: no player key, a non-finite tick, or
  // a tick before the first round_start (no round to scope to).
  function hasKitAt(steamId, tick) {
    const sid = steamId == null ? '' : String(steamId);
    if (!sid || !Number.isFinite(tick)) return null;
    const round = roundContaining(tick, roundStarts);
    if (round === null) return null;
    let gains = 0;
    let lastGain = -Infinity;
    let lastLoss = -Infinity;
    for (const p of kitPickups) {
      if (p.round !== round || p.tick > tick) continue;
      if (String(p.steamId || '') !== sid) continue;
      gains++;
      if (p.tick > lastGain) lastGain = p.tick;
    }
    for (const d of kitDrops) {
      if (d.round !== round || d.tick > tick) continue;
      if (String(d.steamId || '') !== sid) continue;
      if (d.tick > lastLoss) lastLoss = d.tick;
    }
    return gains > 0 && lastGain > lastLoss;
  }

  return { drops, hasKitAt };
}
