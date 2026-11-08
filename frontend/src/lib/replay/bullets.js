// Bullet derivation (lib/replay/bullets.js) — the ONE frontend home for
// turning the sidecar STATE stream into per-shot rows: what fired, when,
// for whom. Pure functions; both the renderer (`setBullets`) and the sfx
// engine (`setBullets`) consume the same rows, so a tracer and its
// gunshot can never disagree. EVERY derived row animates a tracer (the
// old "every 3rd auto bullet" selection is retired — the renderer
// travels a dash for every row, see strokeTracer in renderer.js).
//
// Why magAmmo, not the attack bit: `attack` is the raw trigger BUTTON
// (extract.go samples ButtonAttack at 64 Hz) — held through an entire
// spray and through every grenade equip/throw, so it cannot count
// bullets, and its rising edges fired util "detonation" sounds on
// throw/equip (the cue bug this replaced). `magAmmo` is the ACTIVE
// weapon's magazine: one round leaving the gun per −1 step. Verified
// against the golden demo: 3,311 single-step decrements vs ~3,300 gun
// `weapon_fire` rows (3,903 total minus ~207 knife and ~393 grenade
// fires; the sidecar's own cross-check of weapon_fire vs the sampled
// attack bit is internal/sidecar/state_golden_test.go). Every decrement
// therefore IS a bullet with its frame (≈15.6 ms — SampleRate 64) and
// slot already attached, and the weapon series already holds CANONICAL
// names ("AK-47" — extract's wepName → EquipmentType.String()), so no
// entity-name join is needed.
//
// Rules (each pinned by bullets.test.js):
//   - GUN weapons only — the iconTable's firearms + Zeus x27. Knives,
//     grenades, the C4, armor/kits never become bullet rows: a nade
//     equip/throw/land can neither draw a tracer nor play a gun sound,
//     and knife swings are not shots (knife HITS arrive separately as
//     damage rows → sfx).
//   - A weapon record RESYNCS (weapon switch, respawn/round seed): a
//     magAmmo step recorded in the same frame as a weapon change, or
//     while the active weapon is unknown, is never a bullet — picking up
//     a gun with fewer rounds is not a shot. Increases (reload, refill)
//     are never bullets either. Records are per-frame atomic samples, so
//     a switch lands as ONE record carrying both fields.
//   - Freeze time is filtered out (rounds.js inFreezeTime — the game
//     forbids firing during freeze, so neither tracers nor sounds may
//     fire there).
//   - Every row is a shot: sfx plays EVERY row (the real fire cadence)
//     and the renderer animates a traveling tracer for EVERY row —
//     there is no per-row `draw` selection anymore (the semi/auto,
//     burst-counting rule was retired by spec: "animate all tracers").

import { inFreezeTime } from '../rounds.js';
import { stateAt } from './state.js';

// GUN_WEAPONS — exactly the iconTable's (internal/mappack/icons.go)
// firearms + Zeus, canonical spellings. Anything not listed here is not
// a gun for shot purposes (utility/knife/C4/armor are deliberately
// absent — never "recover" them into this set). The set is consumed by
// loadout.js (main-weapon rules) too, so it stays the ONE membership
// list; the old auto/semi SPLIT of this set went away with the tracer
// selection rule (every bullet animates now — cadence comments below
// are descriptive only, nothing branches on them).
export const GUN_WEAPONS = new Set([
  // Pistols (semi: one press = one shot; CZ is the full-auto exception)
  'P2000', 'Glock-18', 'P250', 'Desert Eagle', 'Five-SeveN',
  'Dual Berettas', 'Tec-9', 'USP-S', 'R8 Revolver', 'CZ75 Auto',
  // SMGs (full-auto)
  'MP7', 'MP9', 'PP-Bizon', 'MAC-10', 'UMP-45', 'P90', 'MP5-SD',
  // Heavy — shotguns/pows are pump (semi by cadence), LMGs full-auto
  'Sawed-Off', 'Nova', 'MAG-7', 'XM1014', 'M249', 'Negev',
  // Rifles — auto rifles full-auto, bolt-action snipers semi by cadence
  'Galil AR', 'FAMAS', 'AK-47', 'M4A4', 'M4A1', 'SSG 08', 'SG 553',
  'AUG', 'AWP', 'SCAR-20', 'G3SG1',
  // Single-shot
  'Zeus x27',
]);

// isGunWeapon — THE gun membership predicate (also consumed by
// loadout.js). An unknown name is NOT a gun: never widen the set by
// guess.
export function isGunWeapon(name) {
  return GUN_WEAPONS.has(name);
}

// deriveBullets walks each slot's `weapon` + `magAmmo` series (record-
// ordered, so one merge pass per slot — O(records), no per-frame
// lookups) and returns rows {tick, frame, slot, weapon} sorted by tick,
// freeze-filtered, guns only. `ticks` is the position stream's
// frame→tick table (data.ticks); `rounds` is GetRounds' rows; null/absent
// index (a match without the state stream) yields [] — fail soft, never
// an error. (The options bag may carry `tickRate` from Replay.svelte —
// it is ignored: burst/tracer selection no longer exists, so nothing
// needs the tickrate anymore.)
export function deriveBullets(index, { ticks, rounds } = {}) {
  if (!index || !Array.isArray(index.slots) || !index.slots.length) return [];
  if (!ticks || !ticks.length) return [];
  const rows = [];

  for (let slot = 0; slot < index.slots.length; slot++) {
    const s = index.slots[slot];
    if (!s) continue;
    const wser = s.weapon || { frames: [], values: [] };
    const mser = s.magAmmo || { frames: [], values: [] };
    let wi = 0;
    let mi = 0;
    // curWeapon: the canonical name standing at the current frame
    // (null = unknown — records resolve names at parse time, so a null
    // VALUE is an out-of-table index, never a guess). lastMag: the
    // magazine standing at the current frame (null = unknown → the
    // first mag record only resyncs).
    let curWeapon = null;
    let lastMag = null;

    while (wi < wser.frames.length || mi < mser.frames.length) {
      const fw = wi < wser.frames.length ? wser.frames[wi] : Infinity;
      const fm = mi < mser.frames.length ? mser.frames[mi] : Infinity;
      const f = Math.min(fw, fm);
      const hasW = fw === f;
      const hasM = fm === f;

      if (hasW) {
        // Weapon record — a resync: switch, respawn or round seed. The
        // sample is per-frame atomic, so a switch's new mag rides the
        // SAME record when it differs; when it does not (equal mags),
        // stateAt carries the standing value across. Either way this
        // frame is never a bullet.
        curWeapon = wser.values[wi];
        wi++;
        if (hasM) {
          lastMag = mser.values[mi];
          mi++;
        } else {
          lastMag = stateAt(mser, f);
        }
        continue;
      }

      // Mag-only record: a bullet iff the SAME known gun's magazine
      // went DOWN. Decreases are one bullet even if the step is >1
      // (physically impossible within one 15.6 ms frame otherwise);
      // increases are reloads/refills; non-guns and freeze ticks are
      // never bullets.
      mi++;
      const mag = mser.values[mi - 1];
      const fell =
        curWeapon != null &&
        typeof mag === 'number' &&
        typeof lastMag === 'number' &&
        mag < lastMag;
      if (fell && isGunWeapon(curWeapon)) {
        const tick = f < ticks.length ? ticks[f] : undefined;
        if (tick !== undefined && Number.isFinite(tick) && !inFreezeTime(rounds, tick)) {
          rows.push({ tick, frame: f, slot, weapon: curWeapon });
        }
      }
      lastMag = typeof mag === 'number' ? mag : null;
    }
  }

  // Global tick order (sfx relies on it — the ONE sort); no per-row
  // selection anymore: every bullet row animates a tracer.
  rows.sort((a, b) => a.tick - b.tick || a.slot - b.slot);
  return rows;
}
