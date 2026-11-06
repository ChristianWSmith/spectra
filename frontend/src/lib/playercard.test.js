// Node tests for the player-card presentation rules
// (src/lib/replay/playercard.js) — the pure half; the rendered half is
// test/player-card.dom.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ammoText,
  armorChip,
  hpBand,
  hpPct,
  moneyText,
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
