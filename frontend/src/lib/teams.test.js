// JS fixture for the team_<player> synthesis — the cross-layer twin of
// Go's TestSynthTeamNames (internal/report/report_test.go): SAME inputs,
// SAME outputs, SAME tie-break (lowest SteamID per side, then name), so
// the JS display surfaces (lib/teams.js) and Go's GetTeamNames/report
// render agree. The Go test's comment names this file as its fixture.
// Run: node --test src/lib/teams.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { synthTeamName, teamNames, teamStartClass, playerStartClass, playerSideClassAt, displayHalfScore } from './teams.js';

// Round rows for the per-round helper: a warmup (-1) plus 24 counted
// rounds (MR12 regulation, one side switch — the same shape as the
// sideparity fixture runner).
const ROUNDS = [
  { number: -1 },
  ...Array.from({ length: 24 }, (_, i) => ({ number: i + 1 })),
];

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

test('teamStartClass: start-side identity colors', () => {
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

test('displayHalfScore orders the half score by the teams’ display order', () => {
  // Golden demo (donk.dem): halfCT 8 / halfT 4 with one side switch — the
  // team shown FIRST finished CT, so it played T in the first half and the
  // header must read "half 4–8", not the stored 8–4.
  assert.deepEqual(displayHalfScore({ halfCT: 8, halfT: 4, sideSwitches: 1 }), {
    first: 4,
    second: 8,
  });
  // No side switch recorded: first-half sides ARE final sides, so the
  // stored order already matches the display order.
  assert.deepEqual(displayHalfScore({ halfCT: 8, halfT: 4, sideSwitches: 0 }), {
    first: 8,
    second: 4,
  });
  // Two switches (overtime): parity brings the sides back around.
  assert.deepEqual(displayHalfScore({ halfCT: 8, halfT: 4, sideSwitches: 2 }), {
    first: 8,
    second: 4,
  });
  // Missing/garbage fields read as 0 — total, never throws.
  assert.deepEqual(displayHalfScore(), { first: 0, second: 0 });
  assert.deepEqual(displayHalfScore(null), { first: 0, second: 0 });
  assert.deepEqual(displayHalfScore({ halfCT: 'x', halfT: null, sideSwitches: undefined }), {
    first: 0,
    second: 0,
  });
});

test('playerSideClassAt: the SIDE the player had in that round, not the team start side', () => {
  // A00 finished CT → the aggregate color is the team's start side (T =
  // orange .team-start-t), but in round 13 (second half) they were CT, so
  // the round-scoped color is the CT side color (.side-ct). This is the
  // golden demo's FREELOOK-on-round-13 case in one assertion pair.
  assert.equal(playerStartClass(SB, 1, 'A00', ''), 'team-start-t');
  assert.equal(playerSideClassAt(SB, 1, ROUNDS, 13, 'A00', ''), 'side-ct');
  // First half flips it back: round 1 is still the opening-half side.
  assert.equal(playerSideClassAt(SB, 1, ROUNDS, 1, 'A00', ''), 'side-t');
  assert.equal(playerSideClassAt(SB, 1, ROUNDS, 12, 'A00', ''), 'side-t');
  // A player who finished T was CT in the first half.
  assert.equal(playerSideClassAt(SB, 1, ROUNDS, 1, 'B00', ''), 'side-ct');
  assert.equal(playerSideClassAt(SB, 1, ROUNDS, 24, 'B00', ''), 'side-t');
  // Steam-id lookup first, exact-name fallback — the same resolution
  // playerStartClass uses (round/chat rows may carry only a name).
  assert.equal(playerSideClassAt(SB, 1, ROUNDS, 13, '', 'lowix'), 'side-ct');
  assert.equal(playerSideClassAt(SB, 1, ROUNDS, 13, '', 'zed'), 'side-t');
});

test('playerSideClassAt: unresolvable inputs fall back to the aggregate color, never a guess', () => {
  // No rounds list (not fetched / fetch failed) → the per-MATCH start-side
  // color, exactly what the surface rendered before the round was known.
  assert.equal(playerSideClassAt(SB, 1, [], 13, 'A00', ''), 'team-start-t');
  // Round not in the list → same aggregate fallback.
  assert.equal(playerSideClassAt(SB, 1, ROUNDS, 99, 'A00', ''), 'team-start-t');
  // Unknown player or a player with no recorded side → no color at all.
  assert.equal(playerSideClassAt(SB, 1, ROUNDS, 13, 'missing', 'nobody'), '');
  assert.equal(playerSideClassAt(SB, 1, ROUNDS, 13, 'C00', 'sideless'), '');
  assert.equal(playerSideClassAt(null, 1, ROUNDS, 13, 'A00', 'kRaSnaL'), '');
});
