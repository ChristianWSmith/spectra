// Tests for the sparse state-stream loader (lib/replay/state.js): the
// pinned wire format, corrupt-stream handling, the per-slot binary-search
// index (seeds = unknown, deltas = last value wins) and the fail-soft
// loader. Run: node --test src/lib/state.test.js
// (from frontend/; the lib test glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_FIELDS,
  parseState,
  buildStateIndex,
  stateAt,
  slotStateAt,
  fetchStateMeta,
  fetchState,
  loadState,
} from './replay/state.js';

// encodeRecords mirrors the Go writer (test-local encoder — the pinned
// byte fixtures below are the real format guard). Frame and mask are
// uvarints (LEB128), values little-endian.
function encodeRecords(records) {
  const out = [];
  const pushVarint = (v) => {
    do {
      let b = v & 0x7f;
      v = Math.floor(v / 128);
      if (v > 0) b |= 0x80;
      out.push(b);
    } while (v > 0);
  };
  for (const r of records) {
    pushVarint(r.frame); // absolute frame
    out.push(r.slot);
    pushVarint(r.mask);
    const push8 = (x) => out.push(x & 0xff);
    const push16 = (x) => {
      out.push(x & 0xff, (x >> 8) & 0xff);
    };
    if (r.mask & STATE_FIELDS.HP) push8(r.hp);
    if (r.mask & STATE_FIELDS.ARMOR) push8(r.armor);
    if (r.mask & STATE_FIELDS.WEAPON) push8(r.weaponIndex);
    if (r.mask & STATE_FIELDS.INVENTORY) {
      push8(r.inventory.length);
      for (const i of r.inventory) push8(i);
    }
    if (r.mask & STATE_FIELDS.MAG_AMMO) push16(r.magAmmo);
    if (r.mask & STATE_FIELDS.RESERVE_AMMO) push16(r.reserveAmmo);
    if (r.mask & STATE_FIELDS.ATTACK) push8(r.attack ? 1 : 0);
    if (r.mask & STATE_FIELDS.MONEY) push16(r.money);
    if (r.mask & STATE_FIELDS.HELMET) push8(r.helmet ? 1 : 0);
    if (r.mask & STATE_FIELDS.MAIN_MAG) push16(r.mainMag);
    if (r.mask & STATE_FIELDS.MAIN_RESERVE) push16(r.mainReserve);
    if (r.mask & STATE_FIELDS.RELOADING) push8(r.reloading ? 1 : 0);
  }
  return new Uint8Array(out).buffer;
}

const NAMES = ['Unknown', 'AK-47', 'USP-S', 'M4A4', 'AWP', 'Glock-18', 'SSG 08', 'MP9'];

test('pinned record bytes decode (layout pin — THE current wire format)', () => {
  // Record A: frame 300 (uvarint AC 02), slot 1, mask hp|armor|attack
  // (0x43, single-byte uvarint), hp 57, armor 100, attack true.
  // Record B: frame 301 (AD 02), slot 0, mask
  // weapon|inventory|mag|reserve (0x3C), weapon idx 3, inventory [3, 7],
  // mag 150 (Negev — u16, not u8), reserve 200.
  // Record C: the two-byte-mask case — frame 300, slot 1, mask
  // hp|money|helmet (0x181 → two-byte uvarint 81 03), hp 57,
  // money 16000 (u16 LE 80 3E), helmet 1.
  // Record D: the main-weapon case — frame 0, slot 0, mask
  // mainMag|mainReserve (0x600 → uvarint 80 0C), mainMag 30 (1E 00),
  // mainReserve 90 (5A 00).
  // Record E: the reload case — frame 301, slot 2, mask reloading
  // (0x800 → uvarint 80 10), value 1. Values ride in bit order
  // (mainMag/mainReserve/reloading after helmet), so a record that never
  // sets 0x200/0x400/0x800 carries no such bytes.
  const bytes = new Uint8Array([
    0xac, 0x02, 0x01, 0x43, 57, 100, 1,
    0xad, 0x02, 0x00, 0x3c, 0x03, 0x02, 0x03, 0x07, 0x96, 0x00, 0xc8, 0x00,
    0xac, 0x02, 0x01, 0x81, 0x03, 57, 0x80, 0x3e, 0x01,
    0x00, 0x00, 0x80, 0x0c, 0x1e, 0x00, 0x5a, 0x00,
    0xad, 0x02, 0x02, 0x80, 0x10, 0x01,
  ]);
  const { records } = parseState(bytes.buffer, NAMES);
  assert.equal(records.length, 5);

  assert.deepEqual(records[0], {
    frame: 300,
    slot: 1,
    mask: 0x43,
    hp: 57,
    armor: 100,
    attack: true,
  });

  assert.equal(records[1].frame, 301);
  assert.equal(records[1].slot, 0);
  assert.equal(records[1].weapon, 'M4A4');
  assert.deepEqual(records[1].inventory, ['M4A4', 'MP9']);
  assert.equal(records[1].magAmmo, 150);
  assert.equal(records[1].reserveAmmo, 200);
  assert.equal('attack' in records[1], false, 'absent field must not materialize');

  assert.deepEqual(records[2], {
    frame: 300,
    slot: 1,
    mask: 0x181,
    hp: 57,
    money: 16000,
    helmet: true,
  });

  assert.deepEqual(records[3], {
    frame: 0,
    slot: 0,
    mask: 0x600,
    mainMag: 30,
    mainReserve: 90,
  });

  assert.deepEqual(records[4], {
    frame: 301,
    slot: 2,
    mask: 0x800,
    reloading: true,
  });
});

test('round-trip through the test encoder', () => {
  const wire = [
    { frame: 0, slot: 0, mask: 0xfff, hp: 100, armor: 100, weaponIndex: 1, inventory: [1, 2], magAmmo: 30, reserveAmmo: 90, attack: false, money: 3400, helmet: true, mainMag: 30, mainReserve: 90, reloading: true },
    { frame: 10, slot: 0, mask: STATE_FIELDS.HP, hp: 90 },
    { frame: 11, slot: 1, mask: STATE_FIELDS.ATTACK, attack: true },
    { frame: 65536, slot: 3, mask: STATE_FIELDS.MAG_AMMO | STATE_FIELDS.RESERVE_AMMO, magAmmo: 65535, reserveAmmo: 0 },
    { frame: 65537, slot: 0, mask: STATE_FIELDS.MONEY | STATE_FIELDS.HELMET, money: 16000, helmet: false },
    { frame: 65538, slot: 2, mask: STATE_FIELDS.MAIN_MAG | STATE_FIELDS.MAIN_RESERVE, mainMag: 150, mainReserve: 200 },
  ];
  // The decoder resolves interned indices to names (weapon + inventory);
  // everything else round-trips byte-identically.
  const expected = [
    { ...wire[0], weapon: 'AK-47', inventory: ['AK-47', 'USP-S'] },
    wire[1],
    wire[2],
    wire[3],
    wire[4],
    wire[5],
  ];
  const { records } = parseState(encodeRecords(wire), NAMES);
  assert.deepEqual(records, expected);
});

test('malformed streams throw instead of decoding garbage', () => {
  // Truncated hp value.
  assert.throws(() => parseState(new Uint8Array([0x01, 0x00, STATE_FIELDS.HP]).buffer), /truncated record/);
  // Unknown field bit. (WHY: 0x800 is the legal RELOADING field, so the
  // first illegal bit is 0x1000 — one past RELOADING — uvarint 80 20;
  // an unknown bit must fail loudly, never skip; 0x80 is the legal
  // money field.)
  assert.throws(() => parseState(new Uint8Array([0x01, 0x00, 0x80, 0x20]).buffer), /unknown field bits/);
  // Truncated mask uvarint (mask byte says "more bytes follow").
  assert.throws(() => parseState(new Uint8Array([0x01, 0x00, 0x80]).buffer), /truncated mask varint/);
  // Truncated money value (money mask, stream ends before the u16).
  assert.throws(() => parseState(new Uint8Array([0x01, 0x00, 0x80, 0x01]).buffer), /truncated record/);
  // Money cut in half (first u16 byte only).
  assert.throws(() => parseState(new Uint8Array([0x01, 0x00, 0x80, 0x01, 0x80]).buffer), /truncated record/);
  // Helmet flag not 0/1 (helmet mask 0x100 = uvarint 80 02).
  assert.throws(() => parseState(new Uint8Array([0x01, 0x00, 0x80, 0x02, 5]).buffer), /helmet flag/);
  // Reloading flag not 0/1 (reloading mask 0x800 = uvarint 80 10).
  assert.throws(() => parseState(new Uint8Array([0x01, 0x00, 0x80, 0x10, 5]).buffer), /reloading flag/);
  // Unterminated frame varint.
  assert.throws(() => parseState(new Uint8Array(Array(12).fill(0x80)).buffer), /unterminated frame varint/);
  // Attack flag not 0/1.
  assert.throws(
    () => parseState(new Uint8Array([0x01, 0x00, STATE_FIELDS.ATTACK, 5]).buffer),
    /attack flag/,
  );
  // Inventory count past the end.
  assert.throws(
    () => parseState(new Uint8Array([0x01, 0x00, STATE_FIELDS.INVENTORY, 0x03, 0x01]).buffer),
    /truncated inventory/,
  );
  // Empty stream is fine (no records).
  assert.deepEqual(parseState(new ArrayBuffer(0)), { records: [] });
});

test('buildStateIndex + stateAt: seeds unknown, deltas last-wins, binary search', () => {
  const { records } = parseState(
    encodeRecords([
      { frame: 5, slot: 0, mask: STATE_FIELDS.HP | STATE_FIELDS.ARMOR, hp: 100, armor: 100 },
      { frame: 20, slot: 0, mask: STATE_FIELDS.HP, hp: 90 },
      { frame: 40, slot: 0, mask: STATE_FIELDS.HP, hp: 80 },
      { frame: 41, slot: 0, mask: STATE_FIELDS.ATTACK, attack: true },
      { frame: 42, slot: 0, mask: STATE_FIELDS.ATTACK, attack: false },
      { frame: 50, slot: 0, mask: STATE_FIELDS.MONEY, money: 4200 },
      { frame: 60, slot: 0, mask: STATE_FIELDS.HELMET, helmet: false },
    ]),
    NAMES,
  );
  const index = buildStateIndex(records, 3); // 3 slots, only slot 0 used

  const hp = index.slots[0].hp;
  // Before the first seed: unknown (null) — never a default 0/100.
  assert.equal(stateAt(hp, 0), null);
  assert.equal(stateAt(hp, 5), 100);
  assert.equal(stateAt(hp, 19), 100);
  assert.equal(stateAt(hp, 20), 90);
  assert.equal(stateAt(hp, 40), 80);
  assert.equal(stateAt(hp, 1e9), 80); // after the last record: last value

  // Armor only exists in the seed record — the hp deltas must not clear it.
  assert.equal(stateAt(index.slots[0].armor, 40), 100);

  // Attack is piecewise-constant: true only in [41, 42).
  const attack = index.slots[0].attack;
  assert.equal(stateAt(attack, 40), null);
  assert.equal(stateAt(attack, 41), true);
  assert.equal(stateAt(attack, 42), false);

  // Money/helmet behave like every other series: null before their first
  // record (unknown, never a guess), last value after it.
  assert.equal(stateAt(index.slots[0].money, 49), null);
  assert.equal(stateAt(index.slots[0].money, 50), 4200);
  assert.equal(stateAt(index.slots[0].money, 1e9), 4200);
  assert.equal(stateAt(index.slots[0].helmet, 59), null);
  assert.equal(stateAt(index.slots[0].helmet, 60), false);

  // A slot with no records: everything unknown.
  assert.deepEqual(slotStateAt(index, 2, 50), {
    hp: null,
    armor: null,
    weapon: null,
    inventory: null,
    magAmmo: null,
    reserveAmmo: null,
    attack: null,
    money: null,
    helmet: null,
    mainMag: null,
    mainReserve: null,
    reloading: null,
  });
  // Out-of-range slot: all null, no throw.
  assert.equal(slotStateAt(index, 99, 50).hp, null);

  // Full slot view at a frame.
  const view = slotStateAt(index, 0, 41);
  assert.equal(view.hp, 80);
  assert.equal(view.attack, true);
  assert.equal(view.weapon, null); // never carried a weapon record
  assert.equal(view.money, null); // money first appears at frame 50
  assert.equal(slotStateAt(index, 0, 55).money, 4200);
});

test('loadState fails soft: dead meta route → null; 404 stream → null', async () => {
  const realFetch = globalThis.fetch;
  try {
    // meta.json unreadable (no sidecar / dead route) → null, and the
    // stream is never fetched.
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 500 };
    };
    assert.equal(await loadState(7), null);
    assert.equal(calls, 1, 'only meta is attempted, never the stream');

    // meta.json readable but the stream 404s (deleted/partial sidecar)
    // → null: an absent stream is "no state", not an error.
    calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      if (String(url).endsWith('/meta')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ players: [111, 222], weaponNames: NAMES }),
        };
      }
      assert.match(String(url), /\/state\?from=0&to=0$/);
      return { ok: false, status: 404 };
    };
    assert.equal(await loadState(7), null);
    assert.equal(calls, 2, 'meta then stream');

    // Transport failure on either fetch also resolves to null (never a
    // rejected promise the view would have to catch).
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    assert.equal(await loadState(7), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('loadState happy path: fetch → decode → per-slot index', async () => {
  const realFetch = globalThis.fetch;
  try {
    const body = encodeRecords([
      { frame: 0, slot: 0, mask: STATE_FIELDS.HP | STATE_FIELDS.WEAPON | STATE_FIELDS.MONEY, hp: 100, weaponIndex: 1, money: 3500 },
      { frame: 64, slot: 1, mask: STATE_FIELDS.HP | STATE_FIELDS.HELMET, hp: 42, helmet: true },
    ]);
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/meta')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ players: [111, 222], weaponNames: NAMES }),
        };
      }
      return { ok: true, status: 200, arrayBuffer: async () => body };
    };
    const index = await loadState(7);
    assert.ok(index, 'a match with a stream must load');
    assert.equal(index.slots.length, 2, 'one index per slot-table entry');
    assert.equal(index.recordCount, 2);
    assert.equal(index.meta.weaponNames.length, NAMES.length, 'meta rides the index');
    assert.equal(slotStateAt(index, 0, 0).hp, 100);
    assert.equal(slotStateAt(index, 0, 0).weapon, 'AK-47');
    assert.equal(slotStateAt(index, 0, 0).money, 3500, 'money rides the seed');
    assert.equal(slotStateAt(index, 1, 64).hp, 42);
    assert.equal(slotStateAt(index, 1, 64).helmet, true);
    assert.equal(slotStateAt(index, 1, 64).money, null, 'never carried → unknown, not 0');
    assert.equal(slotStateAt(index, 1, 0).hp, null, 'no seed yet at frame 0 → unknown');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchStateMeta returns null on a dead meta route', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    assert.equal(await fetchStateMeta(1), null);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ a: 1 }) });
    assert.deepEqual(await fetchStateMeta(1), { a: 1 });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchState: 404 → null (absent), other HTTP errors throw', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.equal(await fetchState(1), null);
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    await assert.rejects(() => fetchState(1), /HTTP 500/);
    globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
    assert.ok((await fetchState(1)) instanceof ArrayBuffer);
  } finally {
    globalThis.fetch = realFetch;
  }
});
