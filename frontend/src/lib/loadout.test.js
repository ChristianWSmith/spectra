// Tests for lib/replay/loadout.js — the held-item/main-weapon rules the
// player card and the decoy's mimic weapon share.
// Run: node --test src/lib/loadout.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRIMARY_WEAPONS,
  SECONDARY_WEAPONS,
  STARTER_PISTOLS,
  isPrimaryWeapon,
  isSecondaryWeapon,
  isFirearm,
  isHeldItem,
  mainWeaponOf,
} from './replay/loadout.js';
import { GUN_WEAPONS } from './replay/bullets.js';

test('primary/secondary partition GUN_WEAPONS exactly', () => {
  for (const n of PRIMARY_WEAPONS) {
    assert.ok(GUN_WEAPONS.has(n), `${n} must be a gun too`);
    assert.ok(!SECONDARY_WEAPONS.has(n), `${n} must not be both`);
  }
  for (const n of SECONDARY_WEAPONS) assert.ok(GUN_WEAPONS.has(n), `${n} must be a gun too`);
  const union = new Set([...PRIMARY_WEAPONS, ...SECONDARY_WEAPONS]);
  assert.equal(union.size, GUN_WEAPONS.size, 'every gun is classified');
  for (const n of GUN_WEAPONS) assert.ok(union.has(n), `${n} is missing from the split`);
});

test('classification spot checks', () => {
  assert.ok(isPrimaryWeapon('AWP') && isPrimaryWeapon('MP9') && isPrimaryWeapon('Nova'));
  assert.ok(isSecondaryWeapon('Desert Eagle') && isSecondaryWeapon('Zeus x27'));
  assert.ok(!isPrimaryWeapon('USP-S') && !isSecondaryWeapon('AK-47'));
  assert.ok(isFirearm('AK-47') && isFirearm('Glock-18'));
  assert.ok(!isFirearm('Knife') && !isFirearm('HE Grenade') && !isFirearm('C4'));
  assert.ok(!isFirearm('Unknown'), 'the sentinel is never a firearm');
});

test('isHeldItem: knife, C4 and grenades are held — guns/kits/unknowns are not', () => {
  for (const held of [
    'Knife', 'C4', 'HE Grenade', 'Flashbang', 'Smoke Grenade',
    'Molotov', 'Incendiary Grenade', 'Decoy Grenade',
  ]) {
    assert.ok(isHeldItem(held), `${held} should be held`);
  }
  for (const notHeld of [
    'AK-47', 'USP-S', 'Zeus x27', 'Kevlar Vest', 'Defuse Kit', 'Unknown', '', null, undefined,
  ]) {
    assert.ok(!isHeldItem(notHeld), `${notHeld} should not be held`);
  }
});

test('mainWeaponOf: primary beats secondary, secondary is the fallback', () => {
  assert.equal(mainWeaponOf(['Kevlar Vest', 'AK-47', 'USP-S', 'Knife']), 'AK-47');
  assert.equal(mainWeaponOf(['USP-S', 'Knife']), 'USP-S', 'sidearm only → the sidearm');
  assert.equal(mainWeaponOf(['Knife']), null, 'knife round → nothing to show');
  assert.equal(mainWeaponOf([]), null);
  assert.equal(mainWeaponOf(null), null);
  assert.equal(mainWeaponOf(['Knife', 'HE Grenade']), null, 'util is never the main weapon');
  // Order inside the inventory never matters — the CLASS decides.
  assert.equal(mainWeaponOf(['USP-S', 'AWP']), 'AWP');
});

test('mainWeaponOf: the starter leg is opt-in and side-gated (never guessed)', () => {
  // Card rule (no starter): no firearm carried → null even with a side.
  assert.equal(mainWeaponOf(['Knife'], { side: 't' }), null);
  // Decoy rule (starter: true): side-issued pistol fills the gap.
  assert.equal(mainWeaponOf(['Knife'], { side: 't', starter: true }), STARTER_PISTOLS.t);
  assert.equal(mainWeaponOf(['Knife'], { side: 'ct', starter: true }), STARTER_PISTOLS.ct);
  assert.equal(STARTER_PISTOLS.t, 'Glock-18');
  assert.equal(STARTER_PISTOLS.ct, 'USP-S');
  // A real firearm still wins over the starter.
  assert.equal(mainWeaponOf(['Deagle-ish', 'Desert Eagle'], { side: 'ct', starter: true }), 'Desert Eagle');
  // Unknown side → the starter leg is suppressed (a side is never guessed).
  assert.equal(mainWeaponOf(['Knife'], { side: '', starter: true }), null);
  assert.equal(mainWeaponOf(['Knife'], { starter: true }), null);
});
