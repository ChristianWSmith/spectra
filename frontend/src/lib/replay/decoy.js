// Decoy lifecycle plan (lib/replay/decoy.js) — THE one derivation that
// turns a match's landmark rows + state stream into the decoy's
// rest-to-explosion schedule: where it came to REST, when it EXPLODES,
// and the DETERMINISTIC fake-gunshot cadence it makes while it noisily
// mimics the thrower's main weapon.
//
// Domain (user spec 2026-11-07 — authoritative): thrown → comes to rest
// → makes noise for 15–18 s → explodes. The extraction rows carry the
// two anchors: kind 'grenade_land' (decoy_started ≈ activation/rest) and
// kind 'grenade' with weapon 'Decoy Grenade' (decoy_detonate →
// BaseGrenade.Explode). While noisy the decoy fires FAKE GUNSHOTS that
// mimic the thrower's main weapon — `mainWeaponOf(inventory, { side,
// starter: true })` from lib/replay/loadout.js (primary → secondary →
// side starter pistol Glock-18/USP-S). Cadence: 1–3 shots every 3–5 s,
// EXCEPT SSG 08/AWP mains → exactly 1 per interval; from rest (+ a short
// ~0.5 s settle) until the explosion.
//
// One plan, TWO consumers (the bullets.js pattern): renderer.setDecoyPlan
// draws the rest icon + one white noise pulse per shot, sfx.setDecoyPlan
// plays the SAME shots on the guns channel — a pulse and its sound can
// never disagree. Pure functions only; unit-tested by
// src/lib/decoy.test.js.

import { inFreezeTime } from '../rounds.js';
import { mainWeaponOf } from './loadout.js';
import { slotStateAt } from './state.js';

// The decoy's canonical weapon spelling (EquipmentType.String()).
export const DECOY_WEAPON = 'Decoy Grenade';

// Cadence constants (spec): the noise starts ~0.5 s after the projectile
// settles (one small bounce), then windows of 3–5 s each holding 1–3
// shots; a bolt/sniper main fires exactly ONE shot per window.
export const DECOY_SETTLE_S = 0.5;
export const DECOY_INTERVAL_MIN_S = 3;
export const DECOY_INTERVAL_MAX_S = 5;
export const DECOY_SHOTS_MIN = 1;
export const DECOY_SHOTS_MAX = 3;
// SSG 08 / AWP mains → exactly 1 shot per interval (the spec's bolt
// rule — a sniper-mimicking decoy never bursts).
export const DECOY_BOLT_WEAPONS = new Set(['SSG 08', 'AWP']);

// mulberry32 — the tiny deterministic PRNG (32-bit, no deps). Seeded by
// landTick so the SAME decoy always schedules the SAME shots: every
// redraw, seek and re-push rebuilds the identical plan (the schedule is
// a pure function of its inputs — nothing depends on wall-clock time).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// decoyShotSchedule — the PURE cadence generator: windows of
// rand(3–5)s back-to-back from `landTick` + the settle, each holding
// rand(1–3) shots evenly spaced inside it (bolt mains: exactly 1 per
// window), capped at `detTick` (a shot at/after the explosion is
// impossible — the decoy has already blown up). Returns [{tick}] in tick
// order, [] on unusable input (never throws). `rand` is injectable for
// tests; the default is mulberry32 seeded by landTick (deterministic).
// Pure — unit-tested by src/lib/decoy.test.js.
export function decoyShotSchedule({ landTick, detTick, tickRate = 64, weapon = '', rand = null }) {
  const tr = Number(tickRate) > 0 ? Number(tickRate) : 64;
  if (!Number.isFinite(landTick) || !Number.isFinite(detTick)) return [];
  const start = landTick + Math.round(DECOY_SETTLE_S * tr);
  if (!(detTick > start)) return []; // no room between rest and the blast
  const r = rand || mulberry32(Math.round(landTick) >>> 0);
  const bolt = DECOY_BOLT_WEAPONS.has(String(weapon));
  const randInt = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const shots = [];
  let cursor = start;
  while (cursor < detTick) {
    const len = randInt(DECOY_INTERVAL_MIN_S, DECOY_INTERVAL_MAX_S) * tr;
    const n = bolt ? 1 : randInt(DECOY_SHOTS_MIN, DECOY_SHOTS_MAX);
    for (let i = 1; i <= n; i++) {
      const tick = Math.round(cursor + (i * len) / (n + 1));
      if (tick < detTick) shots.push({ tick }); // capped by the explosion
    }
    cursor += len;
  }
  return shots;
}

// slotOfSteam — steamId → players[] slot index (meta.players order —
// the same table the renderer's slotOfSteam builds). Returns -1 when the
// thrower cannot be placed (a bot-only or truncated roster — never
// guessed).
function slotOfSteam(players, steamId) {
  if (!steamId) return -1;
  const id = String(steamId);
  for (let i = 0; i < (players || []).length; i++) {
    const p = players[i];
    if (p && p.steamId != null && String(p.steamId) === id) return i;
  }
  return -1;
}

// rowPos — a landmark row's position: the normalized `x`/`y` aliases
// (drawNorm) or the raw EventRow's posX/posY, null when absent (the
// renderer then skips position-dependent drawing — never a guess).
function rowPos(row, key) {
  if (Number.isFinite(row[key])) return row[key];
  const raw = key === 'x' ? row.posX : row.posY;
  return Number.isFinite(raw) ? raw : null;
}

// buildDecoyPlan(rows, rounds, opts) → the plan array
//   [{landTick, detTick, x, y, side, weapon, shots:[{tick}]}]
// over the Replay's drawNorm rows (kind 'grenade_land' + the matching
// kind 'grenade' detonation, both weapon 'Decoy Grenade'):
//
//   - PAIRING: each landing pairs with the NEXT same-round detonation
//     row at/after it (nearest wins). NO detonation row → NO plan entry:
//     without the explosion the noise window cannot be bounded, and an
//     icon that outlives the demo would be a lie — fail soft to nothing
//     (the throw arc and the detonation visual, if any, still draw from
//     setLandmarks on their own).
//   - WEAPON: the thrower (row's steamId/attacker → slot) resolved at
//     the landing frame through `resolveFrame` + slotStateAt's
//     inventory, then mainWeaponOf(inventory, { side, starter: true }).
//     NO state stream / NO resolveFrame / NO slot / NO inventory →
//     weapon null and NO shots (icon + explosion still work — a weapon
//     is NEVER guessed). The starter-pistol leg additionally needs a
//     resolvable `side` (sideAt) — an unresolvable side suppresses only
//     that leg, exactly like mainWeaponOf's contract.
//   - FREEZE: a landing inside freeze time is dropped (belt and braces —
//     the game forbids utility during freeze, rounds.js inFreezeTime).
//   - SHOTS: decoyShotSchedule seeded by landTick — deterministic, so
//     every consumer rebuilds the identical list.
//
// opts: { stateIndex, resolveFrame, sideAt, players, tickRate } — all
// optional; the plan degrades to icon+explosion-only (shots: []) when
// any state input is missing. Pure — unit-tested by src/lib/decoy.test.js.
export function buildDecoyPlan(rows, rounds, opts = {}) {
  const {
    stateIndex = null,
    resolveFrame = null,
    sideAt = null,
    players = [],
    tickRate = 64,
  } = opts;

  const lands = [];
  const dets = [];
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.tick)) continue;
    if (String(row.weapon || '') !== DECOY_WEAPON) continue;
    const kind = String(row.kind || '');
    if (kind === 'grenade_land') lands.push(row);
    else if (kind === 'grenade') dets.push(row);
  }

  const plan = [];
  for (const land of lands) {
    if (inFreezeTime(rounds, land.tick)) continue;

    // Pair with the next same-round detonation (nearest ≥ landing).
    let det = null;
    for (const d of dets) {
      if (d.round !== land.round) continue;
      if (d.tick < land.tick) continue;
      if (!det || d.tick < det.tick) det = d;
    }
    if (!det) continue; // no explosion record → no plan entry (see above)

    const throwerId = land.steamId || land.attacker || '';
    const slot = slotOfSteam(players, throwerId);
    // The canonical side rule is the CALLER's (Replay passes the same
    // sideAt the player cards use — frame bits, then the final-side
    // table); absent → '' → the starter leg is suppressed, never guessed.
    const side = typeof sideAt === 'function' ? String(sideAt(throwerId, land.tick) || '') : '';

    let weapon = null;
    if (stateIndex && slot >= 0 && typeof resolveFrame === 'function') {
      const frame = resolveFrame(land.tick);
      if (Number.isFinite(frame) && frame >= 0) {
        const st = slotStateAt(stateIndex, slot, frame);
        weapon = mainWeaponOf(st.inventory, { side, starter: true });
      }
    }

    const shots = weapon
      ? decoyShotSchedule({ landTick: land.tick, detTick: det.tick, tickRate, weapon })
      : [];

    plan.push({
      landTick: land.tick,
      detTick: det.tick,
      x: rowPos(land, 'x'),
      y: rowPos(land, 'y'),
      side,
      weapon,
      shots,
    });
  }
  plan.sort((a, b) => a.landTick - b.landTick);
  return plan;
}
