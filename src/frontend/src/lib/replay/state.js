// The sparse player-state stream loader (lib/replay/state.js) — the
// frontend half of the sidecar state stream (Go: internal/sidecar's
// state.go is the format authority; this decoder must stay byte-compatible
// with it).
//
// The stream carries per-CHANGE samples of HP, armor, unspent money,
// helmet, active weapon, inventory, magazine/reserve ammo, the stowed
// MAIN weapon's ammo, the attack trigger and the reload state, anchored
// to position-stream frame indices. Records only
// contain fields that CHANGED (or a round-start seed), so reads
// reconstruct by keeping the last value at or before a frame — never zero
// defaults: a field with no record yet is UNKNOWN (null).
//
// This module is loaded by Replay.svelte through loadState (the
// one-stop loader): an absent stream — no meta.json, a 404 on /state, or
// any transport error — resolves to null and the cards render state-less,
// exactly like a match that never had a stream. Corrupt bytes are loud
// (the unknown-field-bit guard below), never rendered as garbage.
//
// Layout per record (little-endian):
//   uvarint  frame (absolute frame index, LEB128)
//   uint8    slot        — the positions sidecar slot table (meta.players)
//   uvarint  mask        — bit per present field, values in bit order:
//     0x001 hp          uint8
//     0x002 armor       uint8 (read as-is even when dead)
//     0x004 weapon      uint8 index into meta.weaponNames
//     0x008 inventory   uint8 count, then count × uint8 name index
//     0x010 magAmmo     uint16
//     0x020 reserveAmmo uint16
//     0x040 attack      uint8 0/1
//     0x080 money       uint16  unspent account (as-read even when dead)
//     0x100 helmet      uint8 0/1 (as-read even when dead)
//     0x200 mainMag     uint16  MAIN (stowed) weapon magazine
//     0x400 mainReserve uint16  MAIN weapon reserve
//     0x800 reloading   uint8 0/1  ACTIVE weapon mid-reload, sampled
//                         alive-only (a death emits the fresh false)
//   mask is a uvarint: masks < 0x80 stay one byte, masks ≥ 0x80 cost
//   one extra byte; values ride in bit order, so mainMag/mainReserve/
//   reloading sit after helmet in the value order (a record that never
//   sets 0x200/0x400/0x800 carries no such bytes).

// Field-mask bits (mirror internal/sidecar's State* constants).
export const STATE_FIELDS = {
  HP: 0x001,
  ARMOR: 0x002,
  WEAPON: 0x004,
  INVENTORY: 0x008,
  MAG_AMMO: 0x010,
  RESERVE_AMMO: 0x020,
  ATTACK: 0x040,
  MONEY: 0x080,
  HELMET: 0x100,
  MAIN_MAG: 0x200,
  MAIN_RESERVE: 0x400,
  RELOADING: 0x800,
};

// The defined field set of THE current layout — anything outside it is
// corruption: parseState fails loudly on unknown bits (they mean a
// different/corrupt stream, never a field to skip or guess).
const STATE_ALL_FIELDS = 0xfff;

// The series every slot index keeps (record key → mask bit), in bit order.
const SERIES = [
  ['hp', STATE_FIELDS.HP],
  ['armor', STATE_FIELDS.ARMOR],
  ['weapon', STATE_FIELDS.WEAPON],
  ['inventory', STATE_FIELDS.INVENTORY],
  ['magAmmo', STATE_FIELDS.MAG_AMMO],
  ['reserveAmmo', STATE_FIELDS.RESERVE_AMMO],
  ['attack', STATE_FIELDS.ATTACK],
  ['money', STATE_FIELDS.MONEY],
  ['helmet', STATE_FIELDS.HELMET],
  ['mainMag', STATE_FIELDS.MAIN_MAG],
  ['mainReserve', STATE_FIELDS.MAIN_RESERVE],
  ['reloading', STATE_FIELDS.RELOADING],
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
  // LEB128 uvarint reader (frame and mask share it), accumulated in
  // float-safe steps.
  const varint = (what) => {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (off >= end) bad(`truncated ${what} varint`);
      const b = dv.getUint8(off++);
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 56) bad(`unterminated ${what} varint`);
    }
    return v;
  };
  while (off < end) {
    // Absolute frame (LEB128).
    const frame = varint('frame');
    if (off + 1 > end) bad('truncated record header');
    const slot = dv.getUint8(off++);
    const mask = varint('mask');
    // Arithmetic (not bitwise) check: masks wider than 32 bits must not
    // truncate into the valid field set.
    if (mask >= STATE_ALL_FIELDS + 1) bad('unknown field bits');
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
    if (mask & STATE_FIELDS.MONEY) rec.money = u16();
    if (mask & STATE_FIELDS.HELMET) {
      const v = u8();
      if (v > 1) bad('helmet flag not 0/1');
      rec.helmet = v === 1;
    }
    if (mask & STATE_FIELDS.MAIN_MAG) rec.mainMag = u16();
    if (mask & STATE_FIELDS.MAIN_RESERVE) rec.mainReserve = u16();
    if (mask & STATE_FIELDS.RELOADING) {
      const v = u8();
      if (v > 1) bad('reloading flag not 0/1');
      rec.reloading = v === 1;
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

// fetchStateMeta reads the sidecar's meta.json (null when unreadable).
export async function fetchStateMeta(matchId) {
  const res = await fetch(`/api/sidecar/${matchId}/meta`);
  if (!res.ok) return null;
  return res.json();
}

// fetchState pulls the raw state stream (the whole stored stream by
// default — since the pre-pistol sanitization gate it starts at round 1).
// 404 = the stream is absent → null (absent, not an error); other HTTP
// failures throw.
export async function fetchState(matchId, { from = 0, to = 0 } = {}) {
  const res = await fetch(`/api/sidecar/${matchId}/state?from=${from}&to=${to}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`state data unavailable (HTTP ${res.status})`);
  return res.arrayBuffer();
}

// loadState is the one-stop loader: meta.json, then fetch + decode +
// index. Every absence mode resolves to null — no meta.json, a 404 on
// /state (the stream was never written), or any transport error — so an
// absent stream renders exactly like a match that never had one: cards
// show their state-less placeholders, never an error. Only corrupt bytes
// are loud (parseState's unknown-field-bit guard), and Replay.svelte
// treats null as "no state", exactly like a missing position sidecar.
export async function loadState(matchId) {
  let meta = null;
  try {
    meta = await fetchStateMeta(matchId);
  } catch {
    return null;
  }
  if (!meta) return null;
  let buf = null;
  try {
    buf = await fetchState(matchId);
  } catch {
    return null;
  }
  if (!buf) return null;
  const { records } = parseState(buf, meta.weaponNames || []);
  const index = buildStateIndex(records, (meta.players || []).length);
  index.meta = meta;
  return index;
}
