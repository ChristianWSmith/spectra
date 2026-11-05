// The sparse player-state stream loader (lib/replay/state.js) — the
// frontend half of the sidecar state stream (Go: internal/sidecar's
// state.go is the format authority; this decoder must stay byte-compatible
// with it).
//
// The stream carries per-CHANGE samples of HP, armor, active weapon,
// inventory, magazine/reserve ammo and the attack trigger, anchored to
// position-stream frame indices. Records only contain fields that
// CHANGED (or a round-start seed), so reads reconstruct by keeping the
// last value at or before a frame — never zero defaults: a field with no
// record yet is UNKNOWN (null).
//
// This module is deliberately UNWIRED: Replay.svelte does not import it,
// so opening a replay fetches nothing extra until a UI actually renders
// player state. Capability is detected via meta.json's
// `stateFormatVersion` (matches imported before the stream simply return
// null — fail soft, never an error).
//
// Layout per record (little-endian):
//   uvarint  frame (absolute frame index, LEB128)
//   uint8    slot        — the positions sidecar slot table (meta.players)
//   uint8    mask        — bit per present field, values in bit order:
//     0x01 hp          uint8
//     0x02 armor       uint8
//     0x04 weapon      uint8 index into meta.weaponNames
//     0x08 inventory   uint8 count, then count × uint8 name index
//     0x10 magAmmo     uint16
//     0x20 reserveAmmo uint16
//     0x40 attack      uint8 0/1

// Field-mask bits (mirror internal/sidecar's State* constants).
export const STATE_FIELDS = {
  HP: 0x01,
  ARMOR: 0x02,
  WEAPON: 0x04,
  INVENTORY: 0x08,
  MAG_AMMO: 0x10,
  RESERVE_AMMO: 0x20,
  ATTACK: 0x40,
};

// The series every slot index keeps (record key → mask bit).
const SERIES = [
  ['hp', STATE_FIELDS.HP],
  ['armor', STATE_FIELDS.ARMOR],
  ['weapon', STATE_FIELDS.WEAPON],
  ['inventory', STATE_FIELDS.INVENTORY],
  ['magAmmo', STATE_FIELDS.MAG_AMMO],
  ['reserveAmmo', STATE_FIELDS.RESERVE_AMMO],
  ['attack', STATE_FIELDS.ATTACK],
];

// parseState decodes an ArrayBuffer of concatenated state records.
// weaponNames is meta.weaponNames (interned table); a record naming an
// index outside it decodes as null (unknown — never guessed). Malformed
// bytes throw (a corrupt stream must fail loudly, not render garbage).
export function parseState(buffer, weaponNames = []) {
  const dv = new DataView(buffer);
  const end = dv.byteLength;
  let off = 0;
  const records = [];
  const bad = (why) => {
    throw new Error(`state: ${why} at byte ${off}`);
  };
  while (off < end) {
    // Absolute frame (LEB128) — accumulated in float-safe steps.
    let frame = 0;
    let shift = 0;
    for (;;) {
      if (off >= end) bad('truncated frame varint');
      const b = dv.getUint8(off++);
      frame += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 56) bad('unterminated frame varint');
    }
    if (off + 2 > end) bad('truncated record header');
    const slot = dv.getUint8(off++);
    const mask = dv.getUint8(off++);
    if (mask & ~0x7f) bad('unknown field bits');
    const rec = { frame, slot, mask };

    const u8 = () => {
      if (off >= end) bad('truncated record');
      return dv.getUint8(off++);
    };
    const u16 = () => {
      if (off + 2 > end) bad('truncated record');
      const v = dv.getUint16(off, true);
      off += 2;
      return v;
    };
    const name = (i) => (i < weaponNames.length ? weaponNames[i] : null);

    if (mask & STATE_FIELDS.HP) rec.hp = u8();
    if (mask & STATE_FIELDS.ARMOR) rec.armor = u8();
    if (mask & STATE_FIELDS.WEAPON) {
      const i = u8();
      rec.weaponIndex = i;
      rec.weapon = name(i);
    }
    if (mask & STATE_FIELDS.INVENTORY) {
      const n = u8();
      if (off + n > end) bad('truncated inventory');
      const inv = [];
      for (let k = 0; k < n; k++) inv.push(name(dv.getUint8(off++)));
      rec.inventory = inv;
    }
    if (mask & STATE_FIELDS.MAG_AMMO) rec.magAmmo = u16();
    if (mask & STATE_FIELDS.RESERVE_AMMO) rec.reserveAmmo = u16();
    if (mask & STATE_FIELDS.ATTACK) {
      const v = u8();
      if (v > 1) bad('attack flag not 0/1');
      rec.attack = v === 1;
    }
    records.push(rec);
  }
  return { records };
}

// buildStateIndex folds records into per-slot, per-field series of
// { frames, values } — the shape seeks binary-search (stateAt). Fields
// absent from every record of a slot stay empty series = unknown.
export function buildStateIndex(records, slotCount) {
  const slots = [];
  for (let s = 0; s < slotCount; s++) {
    const slot = {};
    for (const [key] of SERIES) slot[key] = { frames: [], values: [] };
    slots.push(slot);
  }
  for (const rec of records) {
    if (rec.slot >= slotCount) continue; // unknown slot — skip, like Go
    const slot = slots[rec.slot];
    for (const [key, bit] of SERIES) {
      if (!(rec.mask & bit)) continue; // unchanged — previous value stands
      slot[key].frames.push(rec.frame);
      slot[key].values.push(key === 'inventory' ? rec.inventory : rec[key]);
    }
  }
  return { slots, recordCount: records.length };
}

// stateAt returns a series' last value at or before frame — null when the
// slot has no value yet (before its first seed: unknown, never a guess).
export function stateAt(series, frame) {
  const frames = series.frames;
  let lo = 0;
  let hi = frames.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid] <= frame) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans < 0 ? null : series.values[ans];
}

// slotStateAt reconstructs one slot's full state at a frame: a plain
// object of every series key (null = unknown at that frame).
export function slotStateAt(index, slot, frame) {
  const out = {};
  const s = index.slots[slot];
  for (const [key] of SERIES) out[key] = s ? stateAt(s[key], frame) : null;
  return out;
}

// stateCapable: meta.json says the match carries the stream (the meta
// route — never a schema column, so old dev DBs stay untouched).
export function stateCapable(meta) {
  return !!meta && meta.stateFormatVersion === 1;
}

// fetchStateMeta reads the sidecar's meta.json (null when unreadable).
export async function fetchStateMeta(matchId) {
  const res = await fetch(`/api/sidecar/${matchId}/meta`);
  if (!res.ok) return null;
  return res.json();
}

// fetchState pulls the raw state stream (whole match by default).
// 404 = the match predates the stream → null (absent, not an error);
// other HTTP failures throw.
export async function fetchState(matchId, { from = 0, to = 0 } = {}) {
  const res = await fetch(`/api/sidecar/${matchId}/state?from=${from}&to=${to}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`state data unavailable (HTTP ${res.status})`);
  return res.arrayBuffer();
}

// loadState is the one-stop loader: capability check via meta.json, then
// fetch + decode + index. Returns null when the match has no state
// stream (old import) — callers treat null as "hide/unknown", exactly
// like a missing position sidecar.
export async function loadState(matchId) {
  const meta = await fetchStateMeta(matchId);
  if (!stateCapable(meta)) return null;
  const buf = await fetchState(matchId);
  if (!buf) return null;
  const { records } = parseState(buf, meta.weaponNames || []);
  const index = buildStateIndex(records, (meta.players || []).length);
  index.meta = meta;
  return index;
}
