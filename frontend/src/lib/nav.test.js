// Tests for lib/nav.js: the profile return trip (profileBackTarget — the
// resolution behind PlayerProfile's top-left back button), the navigation
// guards the profile links share (isSteam/openProfile), the sidebar
// action highlighters (NAV_ACTIONS active()) and the replay entry time
// resolver (entrySeekTick — the ?tick=/?round= contract every link into
// THE event browser relies on).
// Run: node --test src/lib/nav.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { isSteam, openProfile, profileBackTarget, NAV_ACTIONS, entrySeekTick } from './nav.js';

test('an explicit ?back= origin wins (durable, deep-linkable)', () => {
  assert.equal(
    profileBackTarget({ back: 'match/5/scoreboard' }, '#/profiles'),
    '/match/5/scoreboard',
  );
  assert.equal(
    profileBackTarget({ back: 'compare/5?rounds=3,5' }, ''),
    '/compare/5?rounds=3,5',
  );
});

test('without ?back= the in-app origin (the hash before this one) wins', () => {
  assert.equal(profileBackTarget({}, '#/profiles'), '/profiles');
  assert.equal(profileBackTarget({}, '#/match/5/scoreboard'), '/match/5/scoreboard');
  assert.equal(profileBackTarget({}, '#/replay/5?cat=chat'), '/replay/5?cat=chat');
});

test('another profile is never an origin; no origin → the Profiles list', () => {
  // Profile → profile is a sibling jump, not a way back.
  assert.equal(
    profileBackTarget({}, '#/player/76561198012345678?back=match/5'),
    '/profiles',
  );
  assert.equal(profileBackTarget({}, '#/player/76561198012345678'), '/profiles');
  // Opened directly: deep link, refresh, first navigation of the session.
  assert.equal(profileBackTarget({}, ''), '/profiles');
  assert.equal(profileBackTarget({}, '#'), '/profiles');
  assert.equal(profileBackTarget(undefined, undefined), '/profiles');
});

test('isSteam: exactly 17 digits are linkable', () => {
  assert.equal(isSteam('76561198012345678'), true);
  assert.equal(isSteam('7656119801234567'), false); // 16
  assert.equal(isSteam('765611980123456789'), false); // 18
  assert.equal(isSteam('BOT'), false);
  assert.equal(isSteam(''), false);
  assert.equal(isSteam(undefined), false);
});

test('openProfile navigates only for a well-formed Steam id', () => {
  const seen = [];
  const nav = (hash) => seen.push(hash);
  openProfile(nav, '76561198012345678');
  openProfile(nav, 'bot');
  openProfile(nav, '');
  openProfile(nav, undefined);
  assert.deepEqual(seen, ['/player/76561198012345678']);
});

test('sidebar active(): the player profile highlights Profiles, not Library', () => {
  // The profile's back button returns to the Profiles directory
  // (profileBackTarget), so the profile route belongs to that action.
  const active = Object.fromEntries(NAV_ACTIONS.map((a) => [a.label, a.active]));
  const route = (name) => ({ name });
  assert.equal(active.Profiles(route('player')), true);
  assert.equal(active.Library(route('player')), false);
  // The directory itself stays Profiles-active.
  assert.equal(active.Profiles(route('profiles')), true);
  // Match detail routes still light up the Library hub.
  for (const name of ['library', 'match', 'round', 'replay', 'compare']) {
    assert.equal(active.Library(route(name)), true, `Library on ${name}`);
    assert.equal(active.Profiles(route(name)), false, `Profiles on ${name}`);
  }
});

test('sidebar active(): exactly one action lights up per route', () => {
  const routes = [
    'library',
    'match',
    'round',
    'replay',
    'compare',
    'player',
    'profiles',
    'builder',
    'sql',
    'settings',
  ];
  for (const name of routes) {
    const on = NAV_ACTIONS.filter((a) => a.active({ name })).map((a) => a.label);
    assert.equal(on.length, 1, `${name} → ${on.join(', ')}`);
  }
});

// --- entrySeekTick: the replay entry time target --------------------------
const ROUNDS = [
  { number: -2, startTick: 100 }, // knife
  { number: -1, startTick: 400 }, // warmup
  { number: 1, startTick: 1200 },
  { number: 7, startTick: 24500 },
];

test('entrySeekTick: an exact ?tick= link wins over everything', () => {
  // RoundDetail's "Watch round" / Combat's EventPlay / Utility's
  // "replay" buttons all stamp an exact tick.
  assert.equal(entrySeekTick({ tick: '9999' }, ROUNDS), 9999);
  assert.equal(entrySeekTick({ tick: '9999', round: '7' }, ROUNDS), 9999);
  assert.equal(entrySeekTick({ tick: 9999 }, ROUNDS), 9999);
  assert.equal(entrySeekTick({ tick: '0' }, ROUNDS), 0); // tick 0 = first frame
});

test('entrySeekTick: a ?round= link resolves to that round\'s start tick', () => {
  // The Economy gap-round card, Combat's round chips and every "events"
  // button promise round N — the replay must land on N's start tick,
  // never the first frame (the reported "lands at the first tick" bug).
  assert.equal(entrySeekTick({ round: '7' }, ROUNDS), 24500);
  assert.equal(entrySeekTick({ round: 1 }, ROUNDS), 1200);
  // Negative-numbered rounds are real rounds too (knife/warmup) — the
  // knife (-2) resolves; see the sentinel case below for -1.
  assert.equal(entrySeekTick({ round: '-2' }, ROUNDS), 100);
});

test('entrySeekTick: no usable time target → 0 (first frame), never a guess', () => {
  assert.equal(entrySeekTick({}, ROUNDS), 0);
  assert.equal(entrySeekTick(undefined, ROUNDS), 0);
  assert.equal(entrySeekTick({ round: '12' }, ROUNDS), 0); // unknown round
  assert.equal(entrySeekTick({ round: '0' }, ROUNDS), 0); // round 0 never exists
  assert.equal(entrySeekTick({ round: 'x' }, ROUNDS), 0); // malformed
  assert.equal(entrySeekTick({ round: '1' }, []), 0); // rounds not loaded
  assert.equal(entrySeekTick({ round: '1' }, null), 0);
  // Parsed -1 is the "all rounds" sentinel (parseLandmarkFilter): an
  // absent round and the warmup round's number are indistinguishable
  // post-parse, so -1 never seeks — a pre-existing filter quirk.
  assert.equal(entrySeekTick({ round: '-1' }, ROUNDS), 0);
});
