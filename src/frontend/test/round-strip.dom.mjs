// jsdom driver for RoundStrip — the POST-PREF reality (knife/warmup
// discard, Phase 3): the show_knife_warmup_rounds setting is retired,
// RoundStrip reads no kvstore key, and EVERY stored row renders — this
// driver pins that (no visibility filtering, no pref reads), the legacy
// W/K display labels from lib/rounds.js roundIndexLabel that a
// pre-reprocess match's negative rows still get (never the raw index),
// the side-parity arrows staying correct with legacy rows present (the
// MR12 switch after round 12 and the OT cadence 27, 30, …), and the
// separator cadence (lib/rounds.js separatorAfter + the trailing-marker
// suppression) staying anchored to counted rounds.
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --conditions browser test/round-strip.dom.mjs
// (must be run with frontend/ as the working directory)
// (the hook below makes the browser condition stick under a plain
// `node --test test/*.mjs` too — without it svelte resolves to the
// SERVER build and mount() throws, which the runner reports as a bare
// "pass 1" with zero checks executed).
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// svelte's package exports pick the SERVER build without the `browser`
// condition (mount() then throws "lifecycle_function_unavailable"), so
// the driver adds it for every svelte specifier before anything imports
// one (the same hook combat.dom.mjs installs).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'svelte' || specifier.startsWith('svelte/')) {
      return nextResolve(specifier, {
        ...context,
        conditions: ['browser', ...(context.conditions || [])],
      });
    }
    return nextResolve(specifier, context);
  },
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLAnchorElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver',
  'DOMParser',
]) {
  if (!(k in dom.window)) continue;
  try {
    globalThis[k] = dom.window[k];
  } catch {
    Object.defineProperty(globalThis, k, {
      value: dom.window[k],
      configurable: true,
      writable: true,
    });
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

const errors = [];
process.on('uncaughtException', (e) => {
  errors.push(e);
  console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  errors.push(e);
  console.error('REJECTION: ' + (e && e.stack ? e.stack : e));
});

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'round-strip');
mkdirSync(dir, { recursive: true });

const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};

// Plain ESM deps of RoundStrip → local copies (sideparity.js imports
// ./rounds.js and teams.js imports ./sideparity.js — the copies keep
// their own relative imports and resolve inside this directory). No
// kvstore stand-in: RoundStrip reads no preference key anymore.
for (const f of ['rounds.js', 'sideparity.js', 'teams.js', 'router.js']) {
  writeFileSync(join(dir, f), readFileSync(join('src/lib', f), 'utf8'));
}

// RoundStrip → rewrite its ../ imports to the local copies.
const rsSrc = readFileSync('src/lib/components/RoundStrip.svelte', 'utf8')
  .replace("from '../sideparity.js'", "from './sideparity.js'")
  .replace("from '../teams.js'", "from './teams.js'")
  .replace("from '../rounds.js'", "from './rounds.js'")
  .replace("from '../router.js'", "from './router.js'");
if (rsSrc.includes('kvstore')) {
  console.log('  FAIL RoundStrip imports the kvstore — the visibility pref is retired');
  process.exit(1);
}
svelteCompile(rsSrc, 'RoundStrip.svelte', join(dir, 'roundstrip-bundle.js'));

const harnessSrc = readFileSync('test/round-strip.harness.svelte', 'utf8');
svelteCompile(harnessSrc, 'harness.svelte', join(dir, 'harness.js'));

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'harness.js')).href);

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const target = document.createElement('div');
document.body.appendChild(target);

let inst = null;
async function showStrip(rounds, opts = {}) {
  if (inst) unmount(inst);
  globalThis.__rounds = rounds;
  globalThis.__current = opts.current || 0;
  globalThis.__sideSwitches = opts.sideSwitches ?? 1;
  inst = mount(mod.default, { target });
  await sleep();
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const cells = () => [...document.querySelectorAll('.round-cell')];
const labels = () => cells().map((c) => c.textContent.trim());
const aria = () => cells().map((c) => c.getAttribute('aria-label'));
const cellFor = (n) => cells().find((c) => c.textContent.trim() === String(n));

// Counted rounds only — the shape every NEW import stores (the extractor
// discards knife/warmup rounds at ingest).
const counted = (n) =>
  Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    winner: i % 2 ? 't' : 'ct',
    reason: 'CTWin',
  }));

// The LEGACY shape a pre-reprocess match still delivers: three negative
// pre-match rows ahead of the counted rounds. Every row renders now —
// there is no visibility pref and no render filter.
const preMatch = [
  { number: -3, winner: 'ct', reason: 'CTWin' },
  { number: -2, winner: 't', reason: 'TerroristsWin' },
  { number: -1, winner: 'ct', reason: 'CTWin' },
];
const legacy = [...preMatch, ...counted(4)];

console.log('A. counted-only rows render every cell with its number');
await showStrip(counted(4));
check('four cells render', JSON.stringify(labels()) === '["1","2","3","4"]', JSON.stringify(labels()));
check(
  'counted cells keep their number as the aria-label',
  JSON.stringify(aria()) === '["Round 1","Round 2","Round 3","Round 4"]',
  JSON.stringify(aria()),
);
check(
  'title leads with the readable kind + winner',
  cells()[0].getAttribute('title') === 'Round 1 — CT · CTWin',
  cells()[0].getAttribute('title'),
);

console.log('B. legacy pre-match rows render too (no pref, no filter) with the canonical W/K labels');
await showStrip(legacy);
check(
  'all seven cells render',
  JSON.stringify(labels()) === '["W","K","W","1","2","3","4"]',
  JSON.stringify(labels()),
);
check(
  'negative indices never display as numbers',
  !labels().some((l) => l.startsWith('-')),
  JSON.stringify(labels()),
);
check(
  'aria-labels name the round kind',
  JSON.stringify(aria()) ===
    '["Warmup round","Knife round","Warmup round","Round 1","Round 2","Round 3","Round 4"]',
  JSON.stringify(aria()),
);
check(
  'knife cell title says Knife round',
  cells()[1].getAttribute('title') === 'Knife round — T · TerroristsWin',
  cells()[1].getAttribute('title'),
);

console.log('C. the viewed round keeps its current marker even on a legacy row');
await showStrip(legacy, { current: -2 });
const knifeC = cellFor('K');
check('the knife cell is marked current', !!knifeC && knifeC.classList.contains('current'));
check('aria-current on the kept cell', !!knifeC && knifeC.getAttribute('aria-current') === 'true');
check('every row still renders', cells().length === 7, String(cells().length));

console.log('D. parity: arrows follow the FULL round list, legacy rows included');
await showStrip(legacy);
// sideAtRound over the full list: with only FOUR counted rounds the
// recorded switch (which lands after counted round 12) has not happened
// yet, so every cell reads era 0 — the team above (which FINISHED CT)
// played T in all of them. The legacy pre-match rows must not shift any
// of it.
const wantArrows = { 1: 'point-down', 2: 'point-up', 3: 'point-down', 4: 'point-up' };
for (const [n, cls] of Object.entries(wantArrows)) {
  const c = cellFor(n);
  check(
    `round ${n} points ${cls.replace('point-', '')}`,
    !!c && c.classList.contains(cls),
    c ? c.className : 'missing cell ' + n,
  );
}
// The legacy cells carry era-0 arrows from the same derivation: the team
// above played T, so a T win (the knife cell) points up and a CT win
// points down.
const knifeD = cellFor('K');
check('the knife cell points up (era 0, its T win matches the team above)', !!knifeD && knifeD.classList.contains('point-up'), knifeD ? knifeD.className : 'missing knife cell');
check(
  'the legacy warmup cells point down (era 0, their CT wins do not)',
  !!cellFor('W') && cellFor('W').classList.contains('point-down'),
);

// The same strip once the match reaches round 13: the switch lands
// exactly at counted round 13, so round 12 (era 0, team above on T) keeps
// pointing down while round 13 (era 1, team above back on CT) flips up.
const thirteen = Array.from({ length: 13 }, (_, i) => ({
  number: i + 1,
  winner: 'ct',
  reason: 'CTWin',
}));
await showStrip([...preMatch, ...thirteen]);
check('16 cells render (3 legacy + 13 counted)', cells().length === 16, String(cells().length));
const r12 = cellFor('12');
const r13 = cellFor('13');
check(
  'round 12 still points down (era 0, team above played T)',
  !!r12 && r12.classList.contains('point-down'),
  r12 ? r12.className : 'missing cell 12',
);
check(
  'round 13 points up (era 1, the team above is back on CT)',
  !!r13 && r13.classList.contains('point-up'),
  r13 ? r13.className : 'missing cell 13',
);

console.log('E. separators: after counted 12, then 24 and every 3 OT rounds');
// The label of the cell each `.round-split` immediately FOLLOWS (cells
// and markers are siblings in DOM order inside .round-strip).
const splitsAfter = () => {
  const kids = [...document.querySelector('.round-strip').children];
  const at = [];
  kids.forEach((el, i) => {
    if (!el.classList.contains('round-split')) return;
    const prev = kids[i - 1];
    at.push(prev && prev.classList.contains('round-cell') ? prev.textContent.trim() : '(?)');
  });
  return at;
};
// The cadence (… 12 | … 24 | 25 26 27 | 28 29 30 | …) plus the
// trailing-marker rule: a separator renders only while a later counted
// round follows it, so a match ending exactly on a boundary cell (24,
// 30, 33) gets no dangling marker after its last cell.
const matrix = [
  [13, ['12']],
  [24, ['12']], // after 24 suppressed — no round 25 follows
  [25, ['12', '24']],
  [28, ['12', '24', '27']],
  [30, ['12', '24', '27']], // after 30 suppressed — no round 31 follows
  [31, ['12', '24', '27', '30']],
  [33, ['12', '24', '27', '30']], // after 33 suppressed — no round 34 follows
  [34, ['12', '24', '27', '30', '33']],
];
for (const [n, want] of matrix) {
  await showStrip(counted(n));
  check(`${n} counted cells render`, cells().length === n, String(cells().length));
  const got = splitsAfter();
  check(
    `${n} counted → separator after ${want.join(', ')}`,
    JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}`,
  );
}

console.log('F. legacy negative cells never shift a separator (all rows render)');
await showStrip([...preMatch, ...counted(25)]);
check('all 28 cells render (3 legacy + 25 counted)', cells().length === 28, String(cells().length));
check(
  'legacy cells come first with their W/K labels',
  JSON.stringify(labels().slice(0, 4)) === '["W","K","W","1"]',
  JSON.stringify(labels().slice(0, 4)),
);
check(
  'markers still sit after counted 12 and 24',
  JSON.stringify(splitsAfter()) === '["12","24"]',
  JSON.stringify(splitsAfter()),
);
check(
  'no marker hangs after a legacy cell',
  splitsAfter().every((s) => !s.startsWith('-')),
  JSON.stringify(splitsAfter()),
);

console.log('G. OT parity regression: 28 counted rounds, sideSwitches=2 (golden nuke shape)');
// The switch cadence is 12, then 27 (NO switch at OT start), so rounds
// 13-27 are era 1: the team above (final CT) played T through OT rounds
// 25-27 and is back on CT only from round 28. The old equal-era formula
// flipped at 10 and 19 instead, which pointed the 25-27 arrows at the
// wrong team — the reported bug.
const otRounds = Array.from({ length: 28 }, (_, i) => {
  const n = i + 1;
  const winner = n === 25 || n === 27 ? 't' : 'ct';
  return { number: n, winner, reason: winner === 'ct' ? 'CTWin' : 'TerroristsWin' };
});
await showStrip(otRounds, { sideSwitches: 2 });
check('28 counted cells render', cells().length === 28, String(cells().length));
// Arrows point at the team that WON the round: era 0 → team above on CT,
// era 1 (13-27) → team above on T, era 2 (28) → team above on CT again.
const otWants = { 12: 'point-up', 13: 'point-down', 25: 'point-up', 26: 'point-down', 27: 'point-up', 28: 'point-up' };
for (const [n, cls] of Object.entries(otWants)) {
  const c = cellFor(n);
  check(
    `round ${n} points ${cls.replace('point-', '')}`,
    !!c && c.classList.contains(cls),
    c ? c.className : 'missing cell ' + n,
  );
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
