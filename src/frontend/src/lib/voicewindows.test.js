// Tests for lib/replay/voicewindows.js — the server-exact sparse-window
// map behind the voice engine's silence skip (data only). The Go twin is
// windowStarts in voiceservice.go (start = tick / windowTicks *
// windowTicks, integer division); together they pin the ONE window-math
// contract: the windows the server's map describes are exactly the
// windows the engine schedules, and every doubt fails OPEN (fetch, never
// skip).
// Run: node --test src/lib/voicewindows.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VOICE_WIN_SEC,
  voiceWindowTicks,
  buildVoiceWindowIndex,
  windowHasVoice,
} from './replay/voicewindows.js';

test('voiceWindowTicks: the ONE window-size formula (engine schedule == map request)', () => {
  // max(1, round(VOICE_WIN_SEC * normTickRate(tr))) — audio.js's scheduler
  // and Replay's GetVoiceIndex request both go through this.
  assert.equal(VOICE_WIN_SEC, 1.0);
  assert.equal(voiceWindowTicks(64), 64);
  assert.equal(voiceWindowTicks(128), 128);
  assert.equal(voiceWindowTicks(0), 64); // normTickRate fallback (absent rate)
  assert.equal(voiceWindowTicks(null), 64);
  assert.equal(voiceWindowTicks('64'), 64);
  assert.equal(voiceWindowTicks(0.4), 1); // max(1, …) — never a 0-wide window
  // Idempotent over an already-normalized rate (the engine applies it to
  // its own normTickRate(engine.tickRate)).
  assert.equal(voiceWindowTicks(voiceWindowTicks(64)), 64);
});

test('window membership: JS floor math == Go integer division, every tick', () => {
  // Mirrors windowStarts (voiceservice.go): start = tick / windowTicks *
  // windowTicks — integer division on both sides for the ≥ 0 ticks real
  // demos carry. The scheduler's from is Math.floor(end / windowTicks) *
  // windowTicks (audio.js scheduleAhead), always a window start itself,
  // so membership is exact: a tick's window is present iff the set says
  // so, and silence is never inferred from anything else.
  const windowTicks = 16;
  const ticks = [0, 15, 16, 31, 32, 63, 64, 64, 96, 100];
  const goStarts = [];
  for (const t of ticks) {
    const start = Math.trunc(t / windowTicks) * windowTicks; // Go's /
    if (goStarts[goStarts.length - 1] !== start) goStarts.push(start);
  }
  assert.deepEqual(goStarts, [0, 16, 32, 48, 64, 96]);

  const index = buildVoiceWindowIndex(
    { windowTicks, players: [{ steamId: 'A', starts: goStarts }] },
    windowTicks,
  );
  for (const t of ticks) {
    const from = Math.floor(t / windowTicks) * windowTicks; // the scheduler's from
    assert.equal(from % windowTicks, 0, 'scheduled windows are aligned');
    assert.equal(windowHasVoice(index, 'A', from), true, `tick ${t} → window ${from}`);
  }
  // Chunk-less windows around them are absent — and ONLY the exact map
  // decides that (no lane/float derivation).
  for (const from of [80, 112, 128]) {
    assert.equal(windowHasVoice(index, 'A', from), false, `window ${from} is silent`);
  }
});

test('buildVoiceWindowIndex: windowTicks mismatch or missing payload → null (fail-open)', () => {
  const windows = { windowTicks: 64, players: [{ steamId: 'A', starts: [0, 64] }] };
  assert.ok(buildVoiceWindowIndex(windows, 64));
  // A map computed for ANOTHER window size must never be used: its
  // starts are not the engine's aligned windows → skipping on it would
  // drop real speech.
  assert.equal(buildVoiceWindowIndex(windows, 128), null);
  for (const bad of [
    null,
    undefined,
    {},
    { windowTicks: 64 },
    { windowTicks: 64, players: null },
    { windowTicks: 64, players: [] },
  ]) {
    assert.equal(buildVoiceWindowIndex(bad, 64), null, JSON.stringify(bad));
  }
});

test('buildVoiceWindowIndex: a player with no starts is UNKNOWN, never "silent"', () => {
  // Empty/non-array start rows are dropped (an empty set would skip every
  // window of a player who DOES speak); if nothing trustworthy remains the
  // whole index is null.
  const partial = buildVoiceWindowIndex(
    {
      windowTicks: 64,
      players: [
        { steamId: 'A', starts: [] },
        { steamId: 'B', starts: null },
        { steamId: '', starts: [0] },
        { steamId: 'C', starts: [128] },
      ],
    },
    64,
  );
  assert.ok(partial, 'the one valid row keeps the map usable');
  assert.equal(windowHasVoice(partial, 'A', 0), true, 'empty row → fail-open fetch');
  assert.equal(windowHasVoice(partial, 'B', 0), true, 'null starts → fail-open fetch');
  assert.equal(windowHasVoice(partial, 'C', 0), false, 'mapped player skips silence');
  const allEmpty = buildVoiceWindowIndex(
    { windowTicks: 64, players: [{ steamId: 'A', starts: [] }] },
    64,
  );
  assert.equal(allEmpty, null, 'no trustworthy row → no map at all');
});

test('windowHasVoice: unknown index/player and degenerate sets all fetch', () => {
  const index = buildVoiceWindowIndex(
    { windowTicks: 64, players: [{ steamId: 'A', starts: [640] }] },
    64,
  );
  assert.equal(windowHasVoice(null, 'A', 0), true, 'no map → fetch');
  assert.equal(windowHasVoice(index, 'stranger', 640), true, 'no entry → fetch');
  assert.equal(windowHasVoice(index, null, 640), true, 'null sid → fetch');
  assert.equal(windowHasVoice(index, 'A', 640), true, 'member → fetch (it has speech)');
  assert.equal(windowHasVoice(index, 'A', 704), false, 'non-member → skip');
  // A hand-built degenerate empty set also fails open (defensive).
  assert.equal(windowHasVoice(new Map([['A', new Set()]]), 'A', 0), true);
  // A numeric steamId spelling addresses the same entry as its string
  // form (small ids only — real SteamID64s stay strings, as Go emits).
  const byId = buildVoiceWindowIndex(
    { windowTicks: 64, players: [{ steamId: '7', starts: [0] }] },
    64,
  );
  assert.equal(windowHasVoice(byId, 7, 0), true, 'number spelling hits the entry');
  assert.equal(windowHasVoice(byId, 7, 64), false, 'number spelling skips silence too');
});
