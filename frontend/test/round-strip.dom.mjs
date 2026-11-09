// jsdom driver for RoundStrip: the show_knife_warmup_rounds pref filter
// (warmup/knife cells hidden by default, shown when the pref opts in, the
// viewed round always kept), the canonical W/K display labels from
// lib/rounds.js roundIndexLabel (never the raw negative index), the
// side-parity arrows staying correct while those cells are hidden (the
// MR12 switch after round 12 and the OT cadence 27, 30, …), and the
// separator cadence (lib/rounds.js separatorAfter + the trailing-
// marker suppression) staying anchored to counted rounds.
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --conditions browser test/round-strip.dom.mjs
// (must be run with frontend/ as the working directory)
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
// their own relative imports and resolve inside this directory).
for (const f of ['rounds.js', 'sideparity.js', 'teams.js', 'router.js']) {
  writeFileSync(join(dir, f), readFileSync(join('src/lib', f), 'utf8'));
}

// kvstore stand-in: RoundStrip reads show_knife_warmup_rounds on mount;
// the driver sets globalThis.__showKnifeWarmup per scenario (undefined =
// key unset, exactly like a fresh profile).
writeFileSync(
  join(dir, 'kvstore.js'),
  'export const KVStoreService = { Get: () => Promise.resolve(globalThis.__showKnifeWarmup) };\n',
);

// RoundStrip → rewrite its ../ imports to the local copies and the
// generated kvstore binding to the stand-in.
const rsSrc = readFileSync('src/lib/components/RoundStrip.svelte', 'utf8')
  .replace("from '../sideparity.js'", "from './sideparity.js'")
  .replace("from '../teams.js'", "from './teams.js'")
  .replace("from '../rounds.js'", "from './rounds.js'")
  .replace("from '../router.js'", "from './router.js'")
  .replace(
    "from '../../../bindings/github.com/wailsapp/wails/v3/pkg/services/kvstore'",
    "from './kvstore.js'",
  );
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
  globalThis.__showKnifeWarmup = opts.pref; // undefined = unset
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

// Three pre-match rounds (two warmups + the knife) ahead of four counted
// rounds. sideSwitches=1 records a switch, but it lands AFTER counted
// round 12 — a four-round match never reaches it, so with the team-above
// having FINISHED CT it played T in all four counted rounds (era 0).
const rounds = [
  { number: -3, warmup: true, winner: 'ct', reason: 'CTWin' },
  { number: -2, pregame: true, winner: 't', reason: 'TerroristsWin' },
  { number: -1, warmup: true, winner: 'ct', reason: 'CTWin' },
  { number: 1, winner: 'ct', reason: 'CTWin' },
  { number: 2, winner: 't', reason: 'BombDefused' },
  { number: 3, winner: 'ct', reason: 'TargetBombed' },
  { number: 4, winner: 'ct', reason: 'CTWin' },
];

console.log('A. pref unset (default OFF): warmup/knife cells hidden');
await showStrip(rounds);
check('only counted cells render', JSON.stringify(labels()) === '["1","2","3","4"]', JSON.stringify(labels()));
check(
  'no W/K letters while hidden',
  !labels().includes('W') && !labels().includes('K'),
  JSON.stringify(labels()),
);
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

console.log('B. pref explicitly false: same as unset');
await showStrip(rounds, { pref: false });
check('only counted cells render', JSON.stringify(labels()) === '["1","2","3","4"]', JSON.stringify(labels()));

console.log('C. pref ON: every cell renders with the canonical W/K labels');
await showStrip(rounds, { pref: true });
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

console.log('D. pref OFF but the viewed round stays (RoundDetail current)');
await showStrip(rounds, { current: -2 });
check(
  'the viewed knife round is kept, other pre-match rounds stay hidden',
  JSON.stringify(labels()) === '["K","1","2","3","4"]',
  JSON.stringify(labels()),
);
const knife = cellFor('K');
check('the kept cell is marked current', !!knife.classList.contains('current'));
check('aria-current on the kept cell', knife.getAttribute('aria-current') === 'true');

console.log('E. parity: arrows follow the FULL round list while cells are hidden');
await showStrip(rounds); // pref OFF → only counted cells
// sideAtRound over the full list: with only FOUR counted rounds the
// recorded switch (which lands after counted round 12) has not happened
// yet, so every cell reads era 0 — the team above (which FINISHED CT)
// played T in all of them. The hidden pre-match rows must not shift any
// of it.
const wantArrows = { 1: 'point-down', 2: 'point-up', 3: 'point-down', 4: 'point-down' };
for (const [n, cls] of Object.entries(wantArrows)) {
  const c = cellFor(n);
  check(
    `round ${n} points ${cls.replace('point-', '')}`,
    !!c && c.classList.contains(cls),
    c ? c.className : 'missing cell ' + n,
  );
}

// The same strip once the match reaches round 13: the switch lands
// exactly at counted round 13, so round 12 (era 0, team above on T) keeps
// pointing down while round 13 (era 1, team above back on CT) flips up.
const thirteen = Array.from({ length: 13 }, (_, i) => ({
  number: i + 1,
  winner: 'ct',
  reason: 'CTWin',
}));
await showStrip([...rounds.slice(0, 3), ...thirteen]);
check('13 counted cells render', cells().length === 13, String(cells().length));
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

console.log('F. separators: after counted 12, then 24 and every 3 OT rounds');
// Counted rounds 1..n prefixed by the three pre-match rows (two
// warmups + the knife): with the pref OFF only the counted cells
// render, so the negative rows must not shift any marker (the counted
// counter only advances on counted cells).
const preMatch = rounds.slice(0, 3);
const counted = (n) =>
  Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    winner: i % 2 ? 't' : 'ct',
    reason: 'CTWin',
  }));
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
  await showStrip([...preMatch, ...counted(n)]); // pref OFF → counted cells only
  check(`${n} counted cells render`, cells().length === n, String(cells().length));
  const got = splitsAfter();
  check(
    `${n} counted → separator after ${want.join(', ')}`,
    JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}`,
  );
}

console.log('G. pref ON: negative knife/warmup cells never shift a separator');
await showStrip([...preMatch, ...counted(25)], { pref: true });
check('all 28 cells render (3 pre-match + 25 counted)', cells().length === 28, String(cells().length));
check(
  'pre-match cells come first with their W/K labels',
  JSON.stringify(labels().slice(0, 4)) === '["W","K","W","1"]',
  JSON.stringify(labels().slice(0, 4)),
);
check(
  'markers still sit after counted 12 and 24',
  JSON.stringify(splitsAfter()) === '["12","24"]',
  JSON.stringify(splitsAfter()),
);

console.log('H. OT parity regression: 28 counted rounds, sideSwitches=2 (golden nuke shape)');
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
