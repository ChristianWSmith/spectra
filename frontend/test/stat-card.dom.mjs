// jsdom driver for StatCard: the clickable cell still drills to its own
// onclick while the sub line's ProfileLink keeps its own destination
// (click AND keyboard), including the nested-button markup.
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --conditions browser test/stat-card.dom.mjs
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

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'stat-card');
mkdirSync(join(dir, 'replay'), { recursive: true });
mkdirSync(join(dir, 'components'), { recursive: true });

const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// Plain-ESM deps copied verbatim (same layout as the landmark-row driver):
// ProfileLink → ../nav.js → router.js + replay/landmarks.js → rounds.js
// + fmt.js (nav's entryLoopAround reads fmt.normTickRate).
for (const rel of ['rounds.js', 'router.js', 'nav.js', 'fmt.js']) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
writeFileSync(
  join(dir, 'replay', 'landmarks.js'),
  readFileSync('src/lib/replay/landmarks.js', 'utf8'),
);
svelteCompile(
  readFileSync('src/lib/components/ProfileLink.svelte', 'utf8'),
  'ProfileLink.svelte',
  join(dir, 'components', 'ProfileLink.js'),
);
// StatCard carries no imports of its own — the ProfileLink comes in
// through the harness's subSlot snippet.
svelteCompile(
  readFileSync('src/lib/components/StatCard.svelte', 'utf8'),
  'StatCard.svelte',
  join(dir, 'components', 'StatCard.js'),
);
const harnessSrc = readFileSync('test/stat-card.harness.svelte', 'utf8');
const harnessOut = join(dir, 'harness.js');
svelteCompile(harnessSrc, 'harness.svelte', harnessOut);

const { mount } = await import('svelte');
const mod = await import(pathToFileURL(harnessOut).href);
const target = document.createElement('div');
document.body.appendChild(target);
mount(mod.default, { target });

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
await sleep();

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const cell = () => document.querySelector('.stat-cell');
const link = () => document.querySelector('.stat-sub .comb-name-btn');
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const key = (el, k) =>
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

console.log('A. structure');
check('cell is a real button', !!cell() && cell().tagName === 'BUTTON');
check('sub line renders the link', !!link(), 'no .comb-name-btn in .stat-sub');
check('the link is inside the cell (component-inserted, not parsed apart)', !!link().closest('button.stat-cell'));
check('cell title kept', cell().getAttribute('title') === 'Open Replay events filtered to donk');
check('value and label rendered', cell().textContent.includes('20/10/3') && cell().textContent.includes('Top fragger'));

console.log('B. clicks: the link opens the profile, the cell keeps its drill');
globalThis.__nav = [];
globalThis.__drill = 0;
click(link());
check('link click opens the profile', JSON.stringify(globalThis.__nav) === '["/player/76561198012345678"]', JSON.stringify(globalThis.__nav));
check('link click does NOT drill the cell', globalThis.__drill === 0, String(globalThis.__drill));
click(document.querySelector('.stat-value'));
check('cell click drills', globalThis.__drill === 1, String(globalThis.__drill));
click(document.querySelector('.field-label'));
check('label click drills too', globalThis.__drill === 2, String(globalThis.__drill));

console.log('C. keyboard: Enter on the link stays on the link, Enter on the cell drills');
globalThis.__nav = [];
globalThis.__drill = 0;
key(link(), 'Enter');
check('Enter on the link does not drill the cell', globalThis.__drill === 0, String(globalThis.__drill));
key(cell(), 'Enter');
check('Enter on the cell drills', globalThis.__drill === 1, String(globalThis.__drill));

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
