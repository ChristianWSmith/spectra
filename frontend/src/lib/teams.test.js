// JS fixture for the team_<player> synthesis — the cross-layer twin of
// Go's TestSynthTeamNames (internal/report/report_test.go): SAME inputs,
// SAME outputs, SAME tie-break (lowest SteamID per side, then name), so
// the JS display surfaces (lib/teams.js) and Go's GetTeamNames/report
// render agree. The Go test's comment names this file as its fixture.
// Run: node --test src/lib/teams.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { synthTeamName, teamNames, teamStartClass, playerStartClass } from './teams.js';

// Same scoreboard as TestSynthTeamNames (models.PlayerStatsRow → the JS
// row shape: steamId/name/side), including the sideless player that must
// never name a side.
const SB = [
  { steamId: 'B00', name: 'zed', side: 't' },
  { steamId: 'A00', name: 'kRaSnaL', side: 'ct' },
  { steamId: 'A01', name: 'lowix', side: 'ct' },
  { steamId: 'C00', name: 'sideless', side: '' },
];

test('synthTeamNames picks the lowest SteamID per side (Go fixture)', () => {
  // Go: ct, tn := synthTeamNames(sb) → team_kRaSnaL / team_zed
  assert.equal(synthTeamName(SB, 'ct'), 'team_kRaSnaL');
  assert.equal(synthTeamName(SB, 't'), 'team_zed');
  // Sides without a player yield '' (teamNames falls back to CT/T).
  assert.equal(synthTeamName(null, 'ct'), '');
  assert.equal(synthTeamName(SB, 'ct2'), '');
});

test('input order does not matter (callers pass store-sorted scoreboards)', () => {
  const reordered = [SB[3], SB[2], SB[1], SB[0]];
  assert.equal(synthTeamName(reordered, 'ct'), 'team_kRaSnaL');
  assert.equal(synthTeamName(reordered, 't'), 'team_zed');
});

test('tie-break: equal SteamIDs fall back to the lower name', () => {
  const tied = [
    { steamId: 'A00', name: 'zulu', side: 'ct' },
    { steamId: 'A00', name: 'alpha', side: 'ct' },
  ];
  assert.equal(synthTeamName(tied, 'ct'), 'team_alpha');
});

test('empty names never name a side', () => {
  const noNames = [{ steamId: 'A00', name: '', side: 'ct' }];
  assert.equal(synthTeamName(noNames, 'ct'), '');
});

test('teamNames: clan name wins, then synthesized, then the bare side', () => {
  assert.deepEqual(teamNames({ ctName: 'Alpha', tName: 'Bravo', players: SB }), {
    ct: 'Alpha',
    t: 'Bravo',
  });
  assert.deepEqual(teamNames({ ctName: '', tName: '', players: SB }), {
    ct: 'team_kRaSnaL',
    t: 'team_zed',
  });
  assert.deepEqual(teamNames({ ctName: '', tName: '', players: [] }), {
    ct: 'CT',
    t: 'T',
  });
  // no-argument call stays total (both labels non-empty)
  assert.deepEqual(teamNames(), { ct: 'CT', t: 'T' });
});

test('teamStartClass: start-side identity colors (changes #10/#20)', () => {
  // Regulation (one switch): the team that FINISHED CT started the first
  // half on T → orange; the team that finished T started on CT → indigo.
  assert.equal(teamStartClass('ct', 1), 'team-start-t');
  assert.equal(teamStartClass('t', 1), 'team-start-ct');
  // No switch recorded → they started on the side they ended on.
  assert.equal(teamStartClass('ct', 0), 'team-start-ct');
  assert.equal(teamStartClass('t', 0), 'team-start-t');
  // Unknown side → no color (never a guessed fallback).
  assert.equal(teamStartClass('', 1), '');
  assert.equal(teamStartClass('ct2', 1), '');
});

test('playerStartClass: steam-id lookup first, exact-name fallback, else no color', () => {
  // Steam id wins when the row carries one (scoreboard/round rows).
  assert.equal(playerStartClass(SB, 1, 'A00', 'zed'), 'team-start-t'); // A00 finished ct
  assert.equal(playerStartClass(SB, 1, 'B00', 'kRaSnaL'), 'team-start-ct'); // B00 finished t
  // Exact-name fallback when the id is unknown or absent (kill feed,
  // chat, first-blood names).
  assert.equal(playerStartClass(SB, 1, '', 'lowix'), 'team-start-t');
  // Unresolvable player or a player with no recorded side → ''.
  assert.equal(playerStartClass(SB, 1, 'missing', 'nobody'), '');
  assert.equal(playerStartClass(SB, 1, 'missing', 'sideless'), '');
  assert.equal(playerStartClass(null, 1, 'A00', 'kRaSnaL'), '');
});
