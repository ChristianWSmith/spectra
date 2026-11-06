// playercard.js — pure presentation rules behind the replay PLAYER CARD
// components (components/PlayerCard.svelte + TeamColumn.svelte).
//
// The cards re-render at the replay playhead rate (~60×/s), so every
// per-frame decision is a plain function over slotStateAt's output here
// — never a rule re-derived in markup, never a zero default: `null`
// (the stream's "unknown", state.js) always renders as "—", never as a
// fact. Pure (no DOM, no services): node-tested by
// src/lib/playercard.test.js; rendered by test/player-card.dom.mjs.
import { detonationStyle } from './landmarks.js';
import { fmtMoney } from '../fmt.js';

// utilityOf groups a state-stream inventory into the player's UTILITY:
// [{name, count}] in first-seen order — or null when the inventory
// itself is unknown (an honest "—"), as distinct from [] (known, no
// grenades carried).
//
// Membership reuses detonationStyle: landmarks.js's switch IS the
// frontend's canonical grenade set (its header pins it to Go's
// models/utilityWeaponKinds — Molotov ≡ Incendiary), so anything it
// leaves at the generic 'detonation' default is not utility: weapons,
// knife, C4, defuser, and the "Unknown" sentinel all fall out, and a
// future grenade name is never half-recognized.
export function utilityOf(inventory) {
  if (!Array.isArray(inventory)) return null;
  const out = [];
  const byName = new Map();
  for (const name of inventory) {
    if (typeof name !== 'string' || name === '' || detonationStyle(name) === 'detonation') continue;
    let entry = byName.get(name);
    if (!entry) {
      entry = { name, count: 0 };
      byName.set(name, entry);
      out.push(entry);
    }
    entry.count++;
  }
  return out;
}

// hpPct clamps a known HP onto the bar's 0–100 scale; unknown stays
// null (the bar renders its "no data" track, never an empty = 0 read).
export function hpPct(hp) {
  if (hp == null) return null;
  const n = Number(hp);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// hpBand buckets a known HP into the bar's three colors. The thresholds
// are a readability choice for a glanceable bar, NOT a game rule — do
// not reuse them for any scoring/analysis surface.
export function hpBand(hp) {
  const pct = hpPct(hp);
  if (pct == null) return 'unknown';
  if (pct > 50) return 'high';
  if (pct > 20) return 'mid';
  return 'low';
}

// ammoText renders "mag / reserve". The two sides are reconstructed
// independently, so one may be known while the other is not — a missing
// side renders "—" inside the pair; both missing (or no state at all)
// is a plain "—". A real 0 is kept as 0 (an empty magazine is a fact).
export function ammoText(state) {
  if (!state) return '—';
  const mag = state.magAmmo;
  const res = state.reserveAmmo;
  if (mag == null && res == null) return '—';
  return `${mag ?? '—'} / ${res ?? '—'}`;
}

// armorChip picks the armor row's icon + text label from the helmet
// flag (armor and helmet are separate stream fields — each is read
// independently). Both helmet states have an extracted icon
// (mappack iconTable: "Kevlar Vest" / "Kevlar + Helmet"); an UNKNOWN
// helmet gets NO icon — choosing one would assert a helmet the stream
// never said — and falls back to the plain "Armor" label.
export function armorChip(state) {
  const helmet = state ? state.helmet : null;
  if (helmet === true) return { icon: 'Kevlar + Helmet', text: 'Kevlar + Helmet' };
  if (helmet === false) return { icon: 'Kevlar Vest', text: 'Kevlar Vest' };
  return { icon: null, text: 'Armor' };
}

// moneyText renders the unspent account through the app's canonical
// money formatter (fmt.fmtMoney — "$1,234"); absent/unknown state
// renders "—", never the "$0" a missing read would fake.
export function moneyText(state) {
  if (!state || state.money == null) return '—';
  return fmtMoney(state.money);
}

// weaponName is the equipped weapon for display: null when the stream
// has no name yet OR the sidecar's unnamed-weapon sentinel ("Unknown",
// internal/sidecar's unknownWeaponName — a weapon we could not name).
// "Unknown" is rendered as unknown, and its clamped 0/0 ammo must never
// pass as a real read (ammoText is gated on this in the card).
export function weaponName(state) {
  const w = state ? state.weapon : null;
  return w && w !== 'Unknown' ? w : null;
}

// carriesC4 reports whether the stream's inventory carries the bomb.
// Deliberately SEPARATE from utilityOf: utilityOf drops 'C4' on purpose
// (it is the objective, not a grenade — pinned by playercard.test.js),
// and the card shows the bomb as its own icon next to the util row.
// An unknown (non-array) inventory never claims a C4 the stream did not
// say — false, not "maybe".
export function carriesC4(inventory) {
  return Array.isArray(inventory) && inventory.includes('C4');
}

// STATS_TITLE documents the live stats row's exact formula — the card's
// title attribute, so a tooltip always carries what the numbers mean
// (they are a playhead fold of the typed events, not the match's stored
// scoreboard: internal/analytics/rounds.go's rules, replay/livestats.js
// the fold).
export const STATS_TITLE =
  'at the playhead: counted rounds started so far; damage includes friendly fire ' +
  '(ADR = Σdamage ÷ counted rounds started)';

// statsText renders the compact live stats row: "K/D/A 12/5/3 · ADR 87.4".
// A missing row (no fold yet) renders honest placeholders, and an ADR
// with no counted round started is "—" — never a 0 presented as a fact.
export function statsText(stats) {
  if (!stats) return 'K/D/A — · ADR —';
  const n = (v) => (Number.isInteger(v) && v >= 0 ? String(v) : '—');
  const adr = Number.isFinite(stats.adr) ? stats.adr.toFixed(1) : '—';
  return `K/D/A ${n(stats.k)}/${n(stats.d)}/${n(stats.a)} · ADR ${adr}`;
}
