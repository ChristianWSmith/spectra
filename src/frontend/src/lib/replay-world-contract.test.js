// The world/feed decoupling contract — an fs-scan over the WORLD-side
// modules (the replay map/sfx/cue/stat consumers of the draw dataset):
// nothing on the world path may read the FEED's filter state, its
// enabled-claim stamp or its reveal rule. The two products share one
// event vocabulary (lib/replay/landmarks.js) and nothing else:
//
//   1. no `filter.cats` / `opts.cats`      — the world dataset is loaded
//      once per match and normalized without the category selection
//      (landmarks.normalizeWorld has no claim gate), so a category
//      toggle can neither re-derive nor re-push it;
//   2. no `rowCategory(` / `shouldRevealFeed` — the enabled stamp and
//      the feed-reveal rule are FEED concepts (the scrubber-marker gate
//      asks enabledClaimOf(kind, cats) in the view, never the row);
//   3. renderer.js / sfx.js never reference `.category` at all — the
//      stamp is feed-only by construction (normalizeWorld does not emit
//      the field), so no world consumer can grow a dependency on it;
//   4. the world pushes are wired ONCE each: Replay.svelte calls
//      pushWorldToRenderer / pushWorldToSfx exactly once (the renderer
//      half is pinned behaviorally in replay.dom.mjs section O — one
//      push per load, zero per filter edit; the sfx engine is never
//      constructed in that harness, so its half is pinned here);
//   5. SFX_CUE_KINDS ⊆ DRAW_KINDS — the audio cue kinds are a subset of
//      the world fetch's kind set: a cue kind outside it would be fed
//      rows the fetch never returns (dead silence), and a draw kind
//      dropped from the draw set would silently kill its cue. Nothing
//      else links the two lists.
//
// Run: node --test src/lib/replay-world-contract.test.js (from frontend/;
// the lib test glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

// Pure imports (no services/bindings in their graph) — safe before the
// hook install below.
import { DRAW_KINDS } from './replay/landmarks.js';
import { ACTION_KINDS } from './replay/bomb.js';

installEsmDirHook();

// sfx.js imports services.js (errText) for its error strings — the real
// bindings talk to a live Wails backend, so redirect them to the test
// stubs before the module graph loads (the sfx.test.js pattern; hooks
// are per-process, this file runs alone).
const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { SFX_CUE_KINDS } = await import('./replay/sfx.js');

// The world-side module set: every lib/replay consumer of the world rows
// (the view pushes the dataset into renderer/sfx; kits/drops/bomb/decoy/
// livestats/roundcut/playercard DERIVE from it).
const WORLD_MODULES = [
  'world.js',
  'renderer.js',
  'sfx.js',
  'kits.js',
  'drops.js',
  'bomb.js',
  'decoy.js',
  'livestats.js',
  'roundcut.js',
  'playercard.js',
];
const read = (rel) => readFileSync(fileURLToPath(new URL(`./replay/${rel}`, import.meta.url)), 'utf8');

test('world modules never read the feed filter / enabled stamp / reveal rule', () => {
  // `opts.cats` catches normalizeEvent's feed-only option; `filter.cats`
  // catches a view-style filter object; the two named helpers are the
  // stamp and the reveal rule themselves.
  const forbidden = [/filter\.cats/, /opts\.cats/, /rowCategory\(/, /shouldRevealFeed/];
  for (const rel of WORLD_MODULES) {
    const src = read(rel);
    for (const re of forbidden) {
      assert.ok(!re.test(src), `${rel} references ${re} — the world path must not read feed state`);
    }
  }
});

test('renderer.js / sfx.js never reference `.category` (the stamp is feed-only)', () => {
  for (const rel of ['renderer.js', 'sfx.js']) {
    const src = read(rel);
    assert.ok(
      !/\.category\b/.test(src),
      `${rel} reads .category — normalizeWorld does not even emit the field`,
    );
  }
});

test('the world pushes are wired ONCE each in Replay.svelte', () => {
  const view = readFileSync(
    fileURLToPath(new URL('./views/Replay.svelte', import.meta.url)),
    'utf8',
  );
  for (const fn of ['pushWorldToRenderer', 'pushWorldToSfx']) {
    const calls = (view.match(new RegExp(`${fn}\\(`, 'g')) || []).length;
    assert.equal(calls, 1, `${fn} must be called from exactly one site (${calls})`);
  }
});

test('SFX_CUE_KINDS ⊆ DRAW_KINDS (the audio half of the draw set)', () => {
  const draw = new Set(DRAW_KINDS);
  assert.ok(SFX_CUE_KINDS.length > 0, 'the cue-kind registry must not be empty');
  for (const k of SFX_CUE_KINDS) assert.ok(draw.has(k), `cue kind outside the draw set: ${k}`);
  // Coverage the other way: every kind the cue builders actually filter
  // on must be REGISTERED (bomb.js' ACTION_KINDS drives the two names
  // maps — bombActionCues / bombAnnouncerCues — and the rest are the
  // literals those builders compare against). A builder gaining a kind
  // without the registry following it would leave the tie unverified.
  const built = [
    'kill', 'damage', 'grenade_throw', 'grenade', 'grenade_bounce',
    'bomb_explode', 'round_end', 'round_start',
    ACTION_KINDS.plant.begin, ACTION_KINDS.plant.complete,
    ACTION_KINDS.defuse.begin, ACTION_KINDS.defuse.complete,
  ];
  for (const k of built) assert.ok(SFX_CUE_KINDS.includes(k), `cue kind not registered: ${k}`);
});

test('round-boundary terminators live only in roundcut.js (drops/kits/bomb delegate)', () => {
  // AGENTS one-canonical-way: no module may scan roundEnds itself for a
  // round terminator — every transient entity's round-scoped visibility
  // ends at roundcut.js roundCutTick (same-round round_end at/after the
  // row, else the next round_start), MIN'd with the entity's own
  // terminators (pickup / detonation / own lifetime / action
  // completion). The scans below are the hand-rolled round_end-only
  // loops that once let a post-round drop outlive the replay (the
  // golden round-2 deagle).
  for (const rel of ['drops.js', 'kits.js']) {
    const src = read(rel);
    assert.ok(
      !/for\s*\([^)]*of\s*[^)]*roundEnds/.test(src),
      `${rel} hand-scans roundEnds — delegate the round terminator to roundCutTick (roundcut.js)`,
    );
    assert.ok(src.includes("from './roundcut.js'"), `${rel} must import the canonical roundcut`);
  }
  // bomb.js keeps TWO sanctioned boundary sites, both commented in place:
  // bombEndTick (its OWN terminators min'd with sameRoundEndTick /
  // nextRoundStartTick — pinned, deliberately NOT unified with
  // roundCutTick) and actionIntervals' round fallback + next-begin cap.
  // What is forbidden is bombEvidenceAt's own scan of the bundle rows.
  const bomb = read('bomb.js');
  assert.ok(
    !/for\s*\([^)]*of\s*e\.roundEnds/.test(bomb),
    'bombEvidenceAt hand-scans e.roundEnds — delegate to roundCutTick (roundcut.js)',
  );
  assert.ok(bomb.includes("from './roundcut.js'"), 'bomb.js must import the canonical roundcut');
});
