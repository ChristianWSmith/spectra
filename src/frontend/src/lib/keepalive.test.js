// Tests for lib/keepalive.js — the Replay mini-player dock's pure
// navigation state: the keep-alive scope transition (which routes keep
// the mounted Replay instance alive, which freeze the captured hash,
// which destroy it), the resume rule (never resume a user's pause) and
// the ?back= origin capture.
// Run: node --test src/lib/keepalive.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { nextReplayAlive, shouldResumeOnReturn, backOrigin } from './keepalive.js';

// Route shapes exactly as parseHash produces them (router.js).
const replay = (id) => ({ name: 'replay', id });
const match = (id, tab) => ({ name: 'match', id, ...(tab ? { tab } : {}) });
const round = (id, n) => ({ name: 'round', id, round: n });

test('a replay route creates the instance, and refreshes its captured hash', () => {
  // First entry: nothing alive → record created with the raw hash.
  const first = nextReplayAlive(null, replay(5), '#/replay/5?back=match/5/rounds');
  assert.deepEqual(first, { id: 5, hash: '#/replay/5?back=match/5/rounds' });

  // Every later replay-route navigation (filter change, ?follow= release,
  // a same-id palette jump) REFRESHES the hash so the expand path always
  // carries the latest state — but the id stays the same key, so
  // App's {#key id} never remounts the component.
  const refreshed = nextReplayAlive(first, replay(5), '#/replay/5?cat=chat&back=match/5/economy');
  assert.deepEqual(refreshed, { id: 5, hash: '#/replay/5?cat=chat&back=match/5/economy' });

  // A DIFFERENT id replaces the record (App keys on id → old instance
  // destroyed, fresh load for the new match).
  const other = nextReplayAlive(first, replay(7), '#/replay/7');
  assert.deepEqual(other, { id: 7, hash: '#/replay/7' });
});

test('same-id match routes keep the instance and FREEZE the captured hash', () => {
  const prev = { id: 5, hash: '#/replay/5?cat=kill&back=match/5/rounds' };

  // Overview, every tab route and the round route all keep the SAME
  // record — object identity included (the hash must not be re-captured
  // from a match hash, or the expand path would lose the replay query).
  assert.equal(nextReplayAlive(prev, match(5), '#/match/5'), prev);
  assert.equal(nextReplayAlive(prev, match(5, 'Economy'), '#/match/5/economy'), prev);
  assert.equal(nextReplayAlive(prev, match(5, 'Rounds'), '#/match/5/rounds'), prev);
  assert.equal(nextReplayAlive(prev, round(5, 3), '#/match/5/round/3'), prev);
});

test('any other route destroys the instance (unmount cleanup runs as before)', () => {
  const prev = { id: 5, hash: '#/replay/5' };

  // Another match id, even a match route — out of scope.
  assert.equal(nextReplayAlive(prev, match(6), '#/match/6'), null);
  assert.equal(nextReplayAlive(prev, round(6, 1), '#/match/6/round/1'), null);
  // Non-match destinations: library, compare (even SAME id), player,
  // settings and friends — none of them stay in scope.
  assert.equal(nextReplayAlive(prev, { name: 'library' }, '#/library'), null);
  assert.equal(nextReplayAlive(prev, { name: 'compare', id: 5 }, '#/compare/5'), null);
  assert.equal(nextReplayAlive(prev, { name: 'settings' }, '#/settings'), null);
  assert.equal(nextReplayAlive(prev, { name: 'player', steamId: '76561198012345678' }, '#/player/76561198012345678'), null);

  // Cold start on a non-replay route: nothing alive, nothing created.
  assert.equal(nextReplayAlive(null, match(5), '#/match/5'), null);
  assert.equal(nextReplayAlive(null, { name: 'library' }, '#/library'), null);
  // Defensive: no route at all → no instance.
  assert.equal(nextReplayAlive({ id: 5, hash: 'x' }, undefined, ''), null);
});

test('the resume rule: an in-flight load or a playing engine resumes; a deliberate pause does not', () => {
  // Load still in progress (no engine): a fresh entry autoplays, so
  // returning must play — both orders (load finishing before vs. after
  // the return) are covered by this flag plus startEngine's active gate.
  assert.equal(shouldResumeOnReturn(false, false), true);
  assert.equal(shouldResumeOnReturn(false, true), true);
  // Engine live and playing when the user left → paused on leave,
  // resumed on return.
  assert.equal(shouldResumeOnReturn(true, true), true);
  // Engine live and PAUSED → the user's deliberate pause, never resumed.
  assert.equal(shouldResumeOnReturn(true, false), false);
});

test('backOrigin: the current hash as a ?back= value (no #, no leading /)', () => {
  assert.equal(backOrigin('#/match/5/economy'), 'match/5/economy');
  assert.equal(backOrigin('#/match/5'), 'match/5');
  assert.equal(backOrigin('#/match/5/round/3?back=match/5/rounds'), 'match/5/round/3?back=match/5/rounds');
  assert.equal(backOrigin('#match/5'), 'match/5'); // tolerated, no slash
  assert.equal(backOrigin(''), '');
  assert.equal(backOrigin(undefined), '');
});
