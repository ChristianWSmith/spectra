import { test } from 'node:test';
import assert from 'node:assert/strict';
import { econColumns, econValue } from './econ.js';

// Golden-demo shaped rows: equip/money pairs straight from the stored
// economy view, including the rows where the side's cash is smaller than
// the free spawn-issued default pistols it still holds (those are what
// used to push net worth below equipment value).
const goldenish = [
  { name: 'pistol round, free pistols held', equipCT: 4000, moneyCT: 600, equipT: 3600, moneyT: 1400 },
  { name: 'full buy spent to $100', equipCT: 11700, moneyCT: 1000, equipT: 20300, moneyT: 100 },
  { name: 'spend-to-zero side', equipCT: 21150, moneyCT: 750, equipT: 25700, moneyT: 15400 },
  { name: 'no cash at all', equipCT: 12000, moneyCT: 0, equipT: 0, moneyT: 0 },
];

test('net worth = equipment value + unspent money at the same freeze end', () => {
  for (const r of goldenish) {
    for (const key of ['ct', 't']) {
      const { equip, net } = econColumns(r, key);
      const cash = Number(key === 'ct' ? r.moneyCT : r.moneyT) || 0;
      assert.equal(equip, Number(key === 'ct' ? r.equipCT : r.equipT));
      assert.equal(net, equip + cash, `${r.name} (${key})`);
    }
  }
});

test('invariant: net worth is never below equipment value', () => {
  for (const r of goldenish) {
    for (const key of ['ct', 't']) {
      const { equip, net } = econColumns(r, key);
      assert.ok(
        net >= equip,
        `${r.name} (${key}): net ${net} < equip ${equip}`,
      );
    }
  }
  // Regression guard: the free spawn-issued default-pistol value must NOT
  // enter net worth. Subtracting it (the old formula) dropped net below
  // equipment value on every golden-demo row whose cash was smaller than
  // the value of the granted pistols the side still held — e.g. $600 of
  // cash against $1000 of USP-S (round 13 CT).
  for (const free of [0, 200, 600, 1000]) {
    const { equip, net } = econColumns({ equipCT: 4400, moneyCT: 600, freePistolCT: free }, 'ct');
    assert.equal(net, 5000, `free pistols (${free}) must not change net worth`);
    assert.ok(net >= equip, `equip ${equip} > net ${net}`);
  }
});

test('characterization: missing or non-numeric samples read 0', () => {
  assert.deepEqual(econColumns({}, 'ct'), { equip: 0, net: 0 });
  assert.deepEqual(econColumns({ equipCT: 'x', moneyCT: NaN }, 'ct'), { equip: 0, net: 0 });
  assert.deepEqual(econColumns({ equipT: 5000, moneyT: 250 }, 'ct'), { equip: 0, net: 0 });
  assert.deepEqual(econColumns({ equipT: 5000, moneyT: 250 }, 't'), { equip: 5000, net: 5250 });
});

test('characterization: econValue picks the metric (non-equip reads net worth)', () => {
  const r = { equipCT: 4000, moneyCT: 600 };
  assert.equal(econValue(r, 'ct', 'equip'), 4000);
  assert.equal(econValue(r, 'ct', 'networth'), 4600);
  assert.equal(econValue(r, 'ct', ''), 4600); // only two metrics exist
  assert.equal(econValue(r, 't', 'equip'), 0);
});
