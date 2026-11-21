// builtinhelpers.test.js — the copies the Economy and Utility builtins carry
// (builtinhelpers.js) give the same answers as the app's own modules. A builtin
// cannot import app code, so each helper is copied as text; this test evaluates
// the copied text and compares it with the original on a grid of inputs, so a
// copy cannot drift silently.
//
// Run: node --test src/lib/builtinhelpers.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { FMT_HELPERS, TICK_HELPERS, TEAM_HELPERS, ECON_HELPERS, NAV_HELPERS } from './builtinhelpers.js';
import { fmtMs, fmtClock, fmtMoney, fmtInt, fmtMetric, roundClock, fmtZeroDash } from './fmt.js';
import { roundIndexLabel, roundScoreLabel, separatorFlags, moneyResetIndexes, roundStartTick, roundEndTick } from './rounds.js';
import { teamNames, playerSideClassAt, teamStartClass } from './teams.js';
import { sideAtRound, winnerTeamKey, teamKeyAt, flipIndexes } from './sideparity.js';
import { econValue, lossPips } from './econ.js';
import { entryLoopAround, entryLoopSpan } from './nav.js';
import { roundsByNumber } from './replay/landmarks.js';

// The copies, evaluated once: every block in one scope.
const copies = new Function(
  [FMT_HELPERS, TICK_HELPERS, TEAM_HELPERS, ECON_HELPERS, NAV_HELPERS].join('\n') +
    `
  return { fmtMs, fmtClock, fmtMoney, fmtInt, fmtStoredValue, roundClock, roundIndexLabel, roundScoreLabel,
    separatorFlags, moneyResetIndexes, roundStartTick, roundEndTick, teamNames, playerSideClassAt,
    teamStartClass, sideAtRound, winnerTeamKey, teamKeyAt, flipIndexes, econValue, lossPips,
    entryLoopAround, entryLoopSpan, fmtZeroDash, roundsByNumber, applyLossBonuses, sideFlips };`,
)();

// A match of 30 counted rounds with a winner pattern and two side switches
// (the 12 and 27 flips), plus a knife round at -2 that carries no count.
const ROUNDS = [{ number: -2, winner: 'ct', startTick: 0, endTick: 100 }];
for (let n = 1; n <= 30; n++) {
  ROUNDS.push({ number: n, winner: n % 3 === 0 ? 't' : n % 5 === 0 ? '' : 'ct', startTick: 1000 * n, endTick: 1000 * n + 900 });
}
const SWITCHES = [0, 1, 2];
const TICK_RATES = [0, 64, 128];

test('the number formatters match fmt.js on a grid of values', () => {
  const values = [0, 1, 0.5, 1.25, 33.333, -4.5, 1234567.8, NaN, null, undefined];
  for (const v of values) {
    assert.equal(copies.fmtInt(v), fmtInt(v), `fmtInt(${v})`);
    assert.equal(copies.fmtMoney(v), fmtMoney(v), `fmtMoney(${v})`);
    for (const format of ['int', 'float1', 'float2', 'percent', 'currency']) {
      assert.equal(copies.fmtStoredValue(v, format), fmtMetric(v, format), `fmtStoredValue(${v}, ${format})`);
    }
  }
  for (const ms of [0, 1, 1499, 2500, 60000]) assert.equal(copies.fmtMs(ms), fmtMs(ms), `fmtMs(${ms})`);
  for (const s of [0, 5.4, 61, 3599, 3600, 3725.6, -1, NaN]) assert.equal(copies.fmtClock(s), fmtClock(s), `fmtClock(${s})`);
  for (const v of [0, 1, -1, NaN, null]) assert.equal(copies.fmtZeroDash(v, 'dmg'), fmtZeroDash(v, 'dmg'), `fmtZeroDash(${v})`);
});

test('the clock and round label helpers match rounds.js and fmt.js', () => {
  const byNumber = roundsByNumber(ROUNDS);
  const copyByNumber = copies.roundsByNumber(ROUNDS);
  for (const rate of TICK_RATES) {
    for (const r of [...ROUNDS, undefined]) {
      for (const tick of [0, 500, 1500, 3999, 25000]) {
        const ours = copies.roundClock(tick, r, rate);
        const theirs = roundClock(tick, r, rate);
        assert.equal(ours, theirs, `roundClock(${tick}, ${r && r.number}, ${rate})`);
      }
    }
    for (const n of [1, 12, 27, 99]) {
      assert.equal(copies.roundClock(4000, copyByNumber.get(n), rate), roundClock(4000, byNumber.get(n), rate));
    }
  }
  for (const v of [1, 12, -2, -5, 0, '3', null, '', ROUNDS[3]]) {
    assert.equal(copies.roundIndexLabel(v), roundIndexLabel(v), `roundIndexLabel(${JSON.stringify(v)})`);
  }
  for (const n of [1, 5, 12, 30, 99]) {
    assert.equal(copies.roundScoreLabel(ROUNDS, n), roundScoreLabel(ROUNDS, n), `roundScoreLabel(${n})`);
    assert.equal(copies.roundStartTick(ROUNDS, n), roundStartTick(ROUNDS, n));
    assert.equal(copies.roundEndTick(ROUNDS, n), roundEndTick(ROUNDS, n));
  }
  assert.deepEqual(copies.separatorFlags(ROUNDS), separatorFlags(ROUNDS), 'separatorFlags');
  assert.deepEqual(copies.separatorFlags(ROUNDS.slice(0, 13)), separatorFlags(ROUNDS.slice(0, 13)));
  for (const n of [0, 1, 12, 13, 30, 40]) {
    assert.deepEqual(copies.moneyResetIndexes(n), moneyResetIndexes(n), `moneyResetIndexes(${n})`);
  }
});

test('the side and team helpers match sideparity.js and teams.js', () => {
  const players = [
    { steamId: '76561198000000002', name: 'bravo', side: 'ct' },
    { steamId: '76561198000000001', name: 'alpha', side: 't' },
    { steamId: '76561198000000003', name: 'charlie', side: 'ct' },
    { steamId: '76561198000000004', name: 'delta', side: 't' },
  ];
  for (const sw of SWITCHES) {
    for (const n of [0, 1, 12, 30]) {
      assert.deepEqual(copies.flipIndexes(n, sw), flipIndexes(n, sw), `flipIndexes(${n}, ${sw})`);
    }
    for (const side of ['ct', 't', '']) {
      assert.equal(copies.teamStartClass(side, sw), teamStartClass(side, sw), `teamStartClass(${side}, ${sw})`);
      for (let i = 0; i < 30; i += 7) {
        assert.equal(copies.teamKeyAt(side, i, 30, sw), teamKeyAt(side, i, 30, sw), `teamKeyAt(${side}, ${i}, 30, ${sw})`);
      }
    }
    for (const n of [1, 5, 12, 13, 28, 99]) {
      for (const side of ['ct', 't']) {
        assert.equal(copies.sideAtRound(ROUNDS, sw, n, side), sideAtRound(ROUNDS, sw, n, side), `sideAtRound(${n}, ${side}, ${sw})`);
        assert.equal(copies.winnerTeamKey(ROUNDS, sw, n, side), winnerTeamKey(ROUNDS, sw, n, side), `winnerTeamKey(${n}, ${side}, ${sw})`);
      }
    }
    for (const who of [['76561198000000001', ''], ['', 'bravo'], ['', 'nobody'], ['76561198000000009', '']]) {
      for (const n of [1, 13, 29]) {
        assert.equal(
          copies.playerSideClassAt(players, sw, ROUNDS, n, who[0], who[1]),
          playerSideClassAt(players, sw, ROUNDS, n, who[0], who[1]),
          `playerSideClassAt(${who}, ${n}, ${sw})`,
        );
      }
    }
  }
  const named = [
    { name: '', ctName: '', tName: '', players: [] },
    { name: '', ctName: 'Clan', tName: '', players },
    { name: '', ctName: '', tName: '', players },
    { name: '', ctName: '', tName: 'Other', players: [] },
  ];
  for (const c of named) {
    const ours = copies.teamNames(c.ctName, c.tName, c.players);
    assert.deepEqual(ours, teamNames({ ctName: c.ctName, tName: c.tName, players: c.players }), 'teamNames');
  }
});

test('the economy helpers match econ.js, and lossPips is the one ladder', () => {
  const row = { equipCT: 1500, equipT: 2400, moneyCT: 300, moneyT: 0 };
  for (const key of ['ct', 't']) {
    for (const metric of ['equip', 'networth']) {
      assert.equal(copies.econValue(row, key, metric), econValue(row, key, metric), `econValue(${key}, ${metric})`);
    }
  }
  for (const v of [0, 1400, 1900, 2400, 3400, 4000, NaN, null]) {
    assert.equal(copies.lossPips(v), lossPips(v), `lossPips(${v})`);
  }
});

test('the replay link helpers match nav.js', () => {
  for (const rate of TICK_RATES) {
    for (const secs of [1, 5, 60]) {
      for (const t of [0, 1000, 25000]) {
        assert.equal(copies.entryLoopAround(t, rate, secs), entryLoopAround(t, rate, secs), `entryLoopAround(${t}, ${rate}, ${secs})`);
      }
    }
  }
  assert.equal(copies.entryLoopSpan(100, 200), entryLoopSpan(100, 200));
  assert.equal(copies.entryLoopSpan(200, 100), entryLoopSpan(200, 100));
  assert.equal(copies.entryLoopSpan(null, 100), entryLoopSpan(null, 100));
});

test('the loss-bonus reconstruction follows the Go rules it copies (analytics.applyLossBonuses)', () => {
  // A match whose first round is lost by CT, with a side switch at round 13:
  // the losing team's count steps up each loss, down each win, and resets at
  // a half. These are the CS2 rules the Go oracle pins (CS2.md "Loss bonus").
  const rows = [
    { round: 1, winner: 'ct' },
    { round: 2, winner: 't' },
    { round: 3, winner: 't' },
    { round: 4, winner: 'ct' },
  ];
  copies.applyLossBonuses(rows, [false, false, false, false]);
  // Every half starts at count 1: round 1's bonus is 1900 for both teams.
  assert.equal(rows[0].lossBonusCT, 1900, 'round 1 CT team starts at the half count 1');
  assert.equal(rows[0].lossBonusT, 1900, 'round 1 T team starts at the half count 1');
  // CT won round 1: CT steps down to 0, T steps up to 2. Round 2 (T won):
  // CT loses with 0 → the base 1400, T loses with 2 → 2400.
  assert.equal(rows[1].lossBonusCT, 1400);
  assert.equal(rows[1].lossBonusT, 2400);
  // T won round 2: T steps down to 1, CT up to 1. Round 3 → 1900 each.
  assert.equal(rows[2].lossBonusCT, 1900);
  assert.equal(rows[2].lossBonusT, 1900);
  // T won round 3: T steps down to 0, CT up to 2. Round 4 (no flip): CT → 2400, T → 1400.
  assert.equal(rows[3].lossBonusCT, 2400);
  assert.equal(rows[3].lossBonusT, 1400);
  // A flip at index 3 swaps which team is on CT and resets both counts to 1.
  copies.applyLossBonuses(rows, [false, false, false, true]);
  assert.equal(rows[3].lossBonusCT, 1900, 'a half resets the count to 1');
});

test('sideFlips marks a boundary only when a player is seen on the other side', () => {
  const rows = [{ round: 1 }, { round: 2 }, { round: 3 }];
  const exact = new Map([
    [1, new Map([['p1', 'ct'], ['p2', 't']])],
    [2, new Map([['p1', 'ct'], ['p2', 't']])],
    [3, new Map([['p1', 't'], ['p2', 'ct']])],
  ]);
  assert.deepEqual(copies.sideFlips(rows, exact), [false, false, true]);
  assert.deepEqual(copies.sideFlips(rows, new Map()), [false, false, false], 'no samples, no flip');
});
