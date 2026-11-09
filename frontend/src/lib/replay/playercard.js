// playercard.js — pure presentation rules behind the replay PLAYER CARD
// components (components/PlayerCard.svelte + TeamColumn.svelte).
//
// The cards re-render at the replay playhead rate (~60×/s), so every
// per-frame decision is a plain function over slotStateAt's output here
// — never a rule re-derived in markup, never a zero default: `null`
// (the stream's "unknown", state.js) always renders as "—", never as a
// fact. Pure (no DOM, no services): node-tested by
// src/lib/playercard.test.js; rendered by test/player-card.dom.mjs.
//
// The held-item indicator (knife/util/C4 in hand → an icon riding after
// the main weapon's icon, inside its chip) resolves its VOCABULARY through
// replay/loadout.js (isHeldItem / mainWeaponOf) — the one loadout rule
// home shared with the decoy — this module only projects it for display.
// The connection rules (indexConnections / connectedAt) are consumed by
// Replay's card columns — the caller that owns all data and all fetching
// (PlayerCard's prop contract) — they decide WHICH cards exist at all.
import { detonationStyle } from './landmarks.js';
import { fmtMoney } from '../fmt.js';
import { isFirearm, isHeldItem, mainWeaponOf } from './loadout.js';

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

// heldItemOf — the ACTIVE weapon's name when it is a held item (knife,
// grenade or C4 — loadout.js isHeldItem), else null. A firearm in hand
// (or an unnamed/unknown weapon, or no state at all) means the card
// shows the ordinary weapon block with no held prefix; the active weapon
// is the stream's canonical `weapon` field via weaponName, so the
// "Unknown" sentinel never claims a held item either.
export function heldItemOf(state) {
  const active = weaponName(state);
  if (!active || isFirearm(active)) return null; // the ordinary block
  return isHeldItem(active) ? active : null;
}

// mainOf — the player's MAIN weapon behind the held-item prefix:
// primary ?? secondary ?? null over the stream's inventory, through
// loadout.js mainWeaponOf with NO starter (the card never invents a
// pistol the stream did not say is carried — a knife-round inventory
// resolves to null → the bare held icon, no separator).
export function mainOf(state) {
  if (!state) return null;
  return mainWeaponOf(state.inventory, { starter: false });
}

// mainAmmoText — the MAIN weapon's "mag / reserve": the stream's v3
// mainMag/mainReserve fields, sampled from the STOWED weapon (not the
// active one's artifact ammo — that is what ammoText renders). Same
// honesty rules as ammoText: no state or both sides unknown → "—", one
// unknown side renders inline, a real 0 is kept (an empty magazine is a
// fact).
export function mainAmmoText(state) {
  if (!state) return '—';
  const mag = state.mainMag;
  const res = state.mainReserve;
  if (mag == null && res == null) return '—';
  return `${mag ?? '—'} / ${res ?? '—'}`;
}

// --- Connection (player_connect / player_disconnect) ------------------------
// The roster keeps a slot for everyone who ever touched the match — a
// player who disconnects mid-demo and a bot that joins late both stay in
// meta.players — so without this rule the columns grow a phantom card
// (the nuke golden demo's sixth CT card) for the rest of the replay.
//
// indexConnections groups a match's typed connect/disconnect rows by the
// identity EventRow.attacker carries — the SteamID64 for humans, the
// synthetic bot id — which is EXACTLY meta.players[].steamId's spelling,
// so the index keys are the roster keys. Rows are kept in tick order per
// player; any other kind, an empty identity or a non-finite tick says
// nothing about presence and is dropped.
export function indexConnections(rows) {
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r) continue;
    if (r.kind !== 'player_connect' && r.kind !== 'player_disconnect') continue;
    const t = Number(r.tick);
    if (!Number.isFinite(t)) continue;
    const sid = r.attacker != null ? String(r.attacker) : '';
    if (!sid) continue;
    let list = out.get(sid);
    if (!list) {
      list = [];
      out.set(sid, list);
    }
    list.push({ tick: t, connected: r.kind === 'player_connect' });
  }
  for (const list of out.values()) list.sort((a, b) => a.tick - b.tick);
  return out;
}

// connectedAt — is the player in the match at `tick`? (the card-visibility
// rule; `events` is indexConnections' list for ONE player, or undefined):
//   - at/after an event: that event's state — a disconnect hides the card
//     until a reconnect unhides it (scrubbing back re-shows it, because
//     the answer is a pure function of the playhead, never sticky);
//   - BEFORE the player's first recorded event: hidden iff that first
//     event is a connect — the roster slot exists but the player had not
//     joined yet (the late-joining bot); a first event that is a
//     disconnect means they were in the match before it, so visible;
//   - no events at all: connected — absence of evidence is never treated
//     as a disconnect (the same "no evidence" honesty as alive: null).
export function connectedAt(events, tick) {
  if (!events || events.length === 0) return true;
  const t = Number(tick);
  if (!Number.isFinite(t)) return true;
  let state = null;
  for (const e of events) {
    if (e.tick > t) break;
    state = e.connected;
  }
  if (state != null) return state;
  return !events[0].connected;
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

// --- Reload ring ---------------------------------------------------------
// reloadProgress — the grey ring's fill (0..1) at `frame` for one slot's
// `reloading` series ({frames, values} — state.js buildStateIndex), or
// null = the ring is HIDDEN. This is the ONE home of the rule: PlayerCard
// only paints the number Replay computes through it.
//
// Formula (documented here per AGENTS.md's documented-in-the-helper rule):
//   - the value at `frame` is not exactly true (false, or unknown —
//     null before the field's first record / a slot that never carried
//     it) → null, the ring hides; an unknown is NEVER drawn as a fact;
//   - start = the FIRST frame of the current true run (walk back from
//     the last record at or before `frame` while the value stays true);
//   - end   = the next record whose value is false — the run's end. The
//     stream carries the flag clearing on BOTH paths: the clip change
//     that COMPLETED the reload and the weapon switch (or death) that
//     CANCELLED it, so a cancellation ends the run with no special case;
//   - progress = clamp((frame − start) / (end − start), 0, 1).
//
// The whole match stream is loaded (loadState fetches everything), so at
// any playhead the end is known by look-ahead — including mid-run at the
// live edge of playback. The ONE exception is a run the stream never
// clears (the demo itself ends mid-reload): its duration is unknown, so
// the fill clamps to 0 — the ring still shows that a reload is running,
// it never fabricates a percentage.
export function reloadProgress(series, frame) {
  const frames = series && series.frames;
  if (!frames || frames.length === 0) return null;
  const values = series.values;
  // Last record at or before the playhead (stateAt's binary search).
  let lo = 0;
  let hi = frames.length - 1;
  let cur = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid] <= frame) {
      cur = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (cur < 0 || values[cur] !== true) return null; // not reloading (or unknown)
  let startIdx = cur;
  while (startIdx > 0 && values[startIdx - 1] === true) startIdx--;
  let endIdx = cur;
  while (endIdx < values.length && values[endIdx] === true) endIdx++;
  if (endIdx >= values.length) return 0; // never cleared → duration unknown → clamp
  const span = frames[endIdx] - frames[startIdx];
  if (!(span > 0)) return 0; // same-frame run (can't happen; defensive)
  const p = (frame - frames[startIdx]) / span;
  return Math.max(0, Math.min(1, p));
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
