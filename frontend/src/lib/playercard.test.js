// Node tests for the player-card presentation rules
// (src/lib/replay/playercard.js) — the pure half; the rendered half is
// test/player-card.dom.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ammoText,
  armorChip,
  carriesC4,
  hpBand,
  hpPct,
  moneyText,
  STATS_TITLE,
  statsText,
  utilityOf,
  weaponName,
} from './replay/playercard.js';

// The state stream's shape for one slot at one frame (state.js
// slotStateAt): every key present, null = unknown — never zero.
const st = (over = {}) => ({
  hp: 100,
  armor: 100,
  helmet: false,
  weapon: 'AK-47',
  weaponIndex: 0,
  magAmmo: 30,
  reserveAmmo: 90,
  inventory: ['AK-47'],
  money: 3250,
  attack: false,
  ...over,
});

test('utilityOf groups grenades and drops everything else', () => {
  const inv = ['AK-47', 'Smoke Grenade', 'Flashbang', 'Knife', 'Smoke Grenade', 'C4', 'Molotov'];
  assert.deepEqual(utilityOf(inv), [
    { name: 'Smoke Grenade', count: 2 },
    { name: 'Flashbang', count: 1 },
    { name: 'Molotov', count: 1 },
  ]);
});

test('utilityOf: unknown inventory is null, known-empty is []', () => {
  assert.equal(utilityOf(null), null, 'null inventory must stay unknown');
  assert.equal(utilityOf(undefined), null);
  assert.deepEqual(utilityOf(['AK-47', 'Knife', 'Defuse Kit']), [], 'a known inventory with no grenades is a fact');
  assert.deepEqual(utilityOf([]), []);
});

test('utilityOf: the sidecar "Unknown" sentinel is not utility', () => {
  assert.deepEqual(utilityOf(['Unknown']), []);
});

test('hpPct / hpBand: known values clamp, unknown stays unknown', () => {
  assert.equal(hpPct(100), 100);
  assert.equal(hpPct(0), 0);
  assert.equal(hpPct(37), 37);
  assert.equal(hpPct(null), null, 'unknown must not become 0');
  assert.equal(hpPct(undefined), null);
  assert.equal(hpBand(null), 'unknown');
  assert.equal(hpBand(100), 'high');
  assert.equal(hpBand(51), 'high');
  assert.equal(hpBand(50), 'mid');
  assert.equal(hpBand(21), 'mid');
  assert.equal(hpBand(20), 'low');
  assert.equal(hpBand(0), 'low');
});

test('ammoText renders mag / reserve and keeps a real 0', () => {
  assert.equal(ammoText(st()), '30 / 90');
  assert.equal(ammoText(st({ magAmmo: 0 })), '0 / 90', 'an empty magazine is a fact');
  assert.equal(ammoText(st({ reserveAmmo: null })), '30 / —', 'one unknown side renders inline');
  assert.equal(ammoText(st({ magAmmo: null, reserveAmmo: null })), '—');
  assert.equal(ammoText(null), '—', 'no state is never 0 / 0');
});

test('armorChip follows the helmet flag and never guesses an icon', () => {
  assert.deepEqual(armorChip(st({ helmet: true })), {
    icon: 'Kevlar + Helmet',
    text: 'Kevlar + Helmet',
  });
  assert.deepEqual(armorChip(st({ helmet: false })), {
    icon: 'Kevlar Vest',
    text: 'Kevlar Vest',
  });
  assert.deepEqual(armorChip(st({ helmet: null })), { icon: null, text: 'Armor' }, 'unknown helmet gets no icon');
  assert.deepEqual(armorChip(null), { icon: null, text: 'Armor' });
});

test('moneyText uses the canonical formatter and never fakes $0', () => {
  assert.equal(moneyText(st()), '$3,250');
  assert.equal(moneyText(st({ money: 0 })), '$0', 'a real 0 balance is a fact');
  assert.equal(moneyText(st({ money: null })), '—');
  assert.equal(moneyText(null), '—');
});

test('weaponName hides the sidecar "Unknown" sentinel', () => {
  assert.equal(weaponName(st()), 'AK-47');
  assert.equal(weaponName(st({ weapon: 'Unknown' })), null, 'unnamed weapon renders as unknown');
  assert.equal(weaponName(st({ weapon: null })), null);
  assert.equal(weaponName(null), null);
});

test('carriesC4 reads the inventory SEPARATELY from utilityOf', () => {
  // The bomb rides the card next to the util, but utilityOf still drops
  // 'C4' on purpose (the test above pins that) — the two answers differ
  // by design.
  assert.equal(carriesC4(['AK-47', 'C4', 'Flashbang']), true);
  assert.equal(carriesC4(['C4']), true);
  assert.equal(carriesC4(['AK-47', 'Flashbang']), false);
  assert.deepEqual(utilityOf(['C4']), [], 'C4 is not utility');
  // Unknown inventory never claims a bomb the stream did not say.
  assert.equal(carriesC4(null), false);
  assert.equal(carriesC4(undefined), false);
  assert.equal(carriesC4('C4'), false);
});

test('statsText renders the live row and never fakes an unknown ADR', () => {
  assert.equal(statsText({ k: 12, d: 5, a: 3, adr: 87.4375 }), 'K/D/A 12/5/3 · ADR 87.4');
  assert.equal(
    statsText({ k: 0, d: 0, a: 0, adr: null }),
    'K/D/A 0/0/0 · ADR —',
    '0 counted rounds started → honest "—", never 0',
  );
  assert.equal(
    statsText({ k: 0, d: 0, a: 0, adr: 0 }),
    'K/D/A 0/0/0 · ADR 0.0',
    '0 damage over started rounds IS a fact',
  );
  assert.equal(statsText(null), 'K/D/A — · ADR —');
  assert.equal(statsText(undefined), 'K/D/A — · ADR —');
  assert.equal(statsText({ k: 'x', d: null, a: NaN, adr: NaN }), 'K/D/A —/—/— · ADR —');
});

test('STATS_TITLE documents the exact formula the row shows', () => {
  assert.match(STATS_TITLE, /counted rounds started/);
  assert.match(STATS_TITLE, /friendly fire/);
  assert.match(STATS_TITLE, /ADR = Σdamage/);
});
