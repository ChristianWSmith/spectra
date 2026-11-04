// Tests for lib/nav.js: the profile return trip (profileBackTarget — the
// resolution behind PlayerProfile's top-left back button), the navigation
// guards the profile links share (isSteam/openProfile) and the sidebar
// action highlighters (NAV_ACTIONS active()).
// Run: node --test src/lib/nav.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { isSteam, openProfile, profileBackTarget, NAV_ACTIONS } from './nav.js';

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
