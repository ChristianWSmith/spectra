// Loadout rules (lib/replay/loadout.js) — the ONE frontend home for
// "what does this player hold" and "what is their MAIN weapon": the
// player card's held-item indicator (knife/util/C4 in hand → an icon after
// the main weapon's icon) and the decoy's mimic weapon both resolve
// through here, so a card and a decoy can never disagree.
//
// Vocabulary is canonical EquipmentType.String() spellings — the same
// names the state stream's `weapon`/`inventory` fields carry. The
// primary/secondary SPLIT is the frontend twin of the Go rule
// (internal/models/weapons.go: IsPrimaryWeapon/IsSecondaryWeapon —
// extract computes the state stream's stowed main-weapon ammo with it;
// the two must classify identically, cf. the sideparity Go/JS twins).

import { detonationStyle } from './landmarks.js';

// PRIMARY_WEAPONS — long guns: rifles, SMGs, shotguns, LMGs, snipers.
export const PRIMARY_WEAPONS = new Set([
  'Galil AR', 'FAMAS', 'AK-47', 'M4A4', 'M4A1', 'SG 553', 'AUG',
  'SSG 08', 'AWP', 'SCAR-20', 'G3SG1',
  'MP7', 'MP9', 'PP-Bizon', 'MAC-10', 'UMP-45', 'P90', 'MP5-SD',
  'Sawed-Off', 'Nova', 'MAG-7', 'XM1014', 'M249', 'Negev',
]);

// SECONDARY_WEAPONS — sidearms (the Zeus rides with the pistols).
export const SECONDARY_WEAPONS = new Set([
  'P2000', 'Glock-18', 'P250', 'Desert Eagle', 'Five-SeveN',
  'Dual Berettas', 'Tec-9', 'CZ75 Auto', 'USP-S', 'R8 Revolver',
  'Zeus x27',
]);

// STARTER_PISTOLS — the side-issued free sidearm, by side (CS2 issues
// the Glock-18 to T and the USP-S to CT). ONLY used behind the
// `starter` opt-in — never as a display fallback (a card must not show
// a pistol the player does not carry).
export const STARTER_PISTOLS = Object.freeze({ t: 'Glock-18', ct: 'USP-S' });

export function isPrimaryWeapon(name) {
  return PRIMARY_WEAPONS.has(name);
}

export function isSecondaryWeapon(name) {
  return SECONDARY_WEAPONS.has(name);
}

// isFirearm — a real gun (primary or secondary), i.e. GUN_WEAPONS from
// bullets.js — firearms only, no knives/util/C4.
export function isFirearm(name) {
  return isPrimaryWeapon(name) || isSecondaryWeapon(name);
}

// isHeldItem — what the card prefixes when it is ACTIVE in hand: the
// knife, the C4, or any grenade (detonationStyle classifies grenades —
// every typed style IS a thrown utility; firearms/armor/kits/unknowns
// fall through to 'detonation' and are not held items).
export function isHeldItem(name) {
  if (name === 'Knife' || name === 'C4') return true;
  return detonationStyle(name) !== 'detonation';
}

// mainWeaponOf — primary ?? secondary ?? (opt-in) side starter.
//   - The CARD calls it plainly (no starter): its spec shows a main
//     weapon only when one is actually CARRIED — knife-round-inventory
//     (knife only) resolves to null → the bare held-item icon, no
//     separator.
//   - The DECOY passes { side, starter: true }: a player who dropped
//     their sidearm still "sounds like" their side's starter pistol.
//     An unresolvable side (never guessed) suppresses the starter leg.
export function mainWeaponOf(inventory, { side, starter = false } = {}) {
  if (!Array.isArray(inventory)) return null;
  for (const n of inventory) {
    if (isPrimaryWeapon(n)) return n;
  }
  for (const n of inventory) {
    if (isSecondaryWeapon(n)) return n;
  }
  if (starter) {
    const s = side === 't' || side === 'ct' ? STARTER_PISTOLS[side] : null;
    if (s) return s;
  }
  return null;
}
