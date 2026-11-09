// Node tests for the canonical client-side bot filter (src/lib/players.js)
// — the frontend twin of store.HumanOnly / store.HumanOnlyBySteamID.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isBot, isBotId, isHuman, listedPlayers } from './players.js';

// The synthetic bot identity extract hands bots (extract.isBotKey:
// 0xFF00000000000000|entityID — the nuke demo's Crew).
const CREW = '18374686479671623692';
// A real SteamID64 (17 digits, 7656119…).
const HUMAN = '76561198067285210';

test('isBotId: the synthetic 0xFF id shape claims only bot ids', () => {
  assert.equal(isBotId(CREW), true);
  assert.equal(isBotId('18374686479671623680'), true, 'the id floor (0xFF00000000000000)');
  assert.equal(isBotId('18374686496448817151'), true, 'the id ceiling (+0x0FFFFFFF)');
  assert.equal(isBotId(HUMAN), false, 'every real SteamID64 is 17 digits');
  assert.equal(isBotId(''), false);
  assert.equal(isBotId(null), false);
  assert.equal(isBotId(undefined), false);
  assert.equal(isBotId('1837468647967162369a'), false, 'not digits');
});

test('isBot: the stored flag first, the synthetic id as its backstop', () => {
  assert.equal(isBot({ steamId: HUMAN, isBot: false }), false);
  assert.equal(isBot({ steamId: HUMAN, isBot: true }), true, 'flag wins');
  assert.equal(isBot({ steamId: CREW }), true, 'no flag → id shape');
  assert.equal(isBot({ steamId: CREW, isBot: false }), true, 'id shape overrides a false flag');
  assert.equal(isBot({ name: 'no identity' }), false, 'no identity is never a bot');
  assert.equal(isBot(null), false);
  assert.equal(isBot(undefined), false);
  // The snake_case spelling (career/SQL-shaped rows).
  assert.equal(isBot({ steam_id: CREW }), true);
});

test('isHuman is the listing predicate (the negation, one spelling)', () => {
  assert.equal(isHuman({ steamId: HUMAN }), true);
  assert.equal(isHuman({ steamId: CREW }), false);
  assert.equal(isHuman(null), true, 'absence of evidence never hides a row');
});

test('listedPlayers drops bot rows and keeps order; non-arrays pass through', () => {
  const rows = [
    { steamId: HUMAN, name: 'alice' },
    { steamId: CREW, name: 'Crew' },
    { steamId: '76561198000000002', name: 'bob' },
  ];
  assert.deepEqual(
    listedPlayers(rows).map((r) => r.name),
    ['alice', 'bob'],
  );
  assert.equal(listedPlayers(null), null, 'fail-soft with the reads it wraps');
  assert.equal(listedPlayers(undefined), undefined);
  assert.deepEqual(listedPlayers([]), []);
});
