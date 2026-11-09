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
// This module is deliberately UNWIRED: Replay.svelte does not import it,
// so opening a replay fetches nothing extra until a UI actually renders
// player state. Capability is detected via meta.json's
// `stateFormatVersion` (matches imported before the stream simply return
// null — fail soft, never an error).
//
// Version policy: this decoder handles ONLY stateFormatVersion 4 (the
// layout below, incl. mainMag/mainReserve and reloading); v1 (pre-money/
// helmet), v2 (pre-main-weapon) and v3 (pre-reload flag) sidecars are not
// decoded and not upgraded — stateCapable reports false, loadState returns
// null, cards show unknown (pre-release no-migrations policy: a stale
// match must be REPROCESSED to regain state).
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
//     0x200 mainMag     uint16  MAIN (stowed) weapon magazine (v3)
//     0x400 mainReserve uint16  MAIN weapon reserve (v3)
//     0x800 reloading   uint8 0/1  ACTIVE weapon mid-reload, sampled
//                         alive-only (a death emits the fresh false) (v4)
//   mask is a uvarint (v2 change from v1's fixed uint8): masks < 0x80
//   stay one byte (records without money/helmet are byte-identical to
//   their v1 encoding), money/helmet masks cost one extra byte; the v3
//   and v4 fields were APPENDED after helmet, so earlier records decode
//   byte-identical (their mask simply never sets 0x200/0x400/0x800).

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

// The current state-record layout version (mirror sidecar.StateFormatVersion).
export const STATE_FORMAT_VERSION = 4;

// All defined field bits — anything outside is corruption.
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

// stateCapable: meta.json says the match carries the stream in the
// CURRENT layout (the meta route — never a schema column, so old dev DBs
// stay untouched). A v1 sidecar (pre-money/helmet), a v2 sidecar
// (pre-main-weapon ammo) or a v3 sidecar (pre-reload flag) is not
// upgraded (pre-release no-migrations policy): it reports no capability
// and callers fail soft to "no state" — the match must be reprocessed to
// regain state.
export function stateCapable(meta) {
  return !!meta && meta.stateFormatVersion === STATE_FORMAT_VERSION;
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
