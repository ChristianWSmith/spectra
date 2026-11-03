// jsdom driver for MatchPicker: open/close, filtering, keyboard nav,
// selection, click-outside.
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --conditions browser test/match-picker.dom.mjs
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

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'match-picker');
mkdirSync(dir, { recursive: true });

const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};

// fmt.js (plain ESM) → local copy.
writeFileSync(join(dir, 'fmt.js'), readFileSync('src/lib/fmt.js', 'utf8'));

// StatusChip (no imports) → local bundle.
svelteCompile(
  readFileSync('src/lib/components/StatusChip.svelte', 'utf8'),
  'StatusChip.svelte',
  join(dir, 'statuschip.js'),
);

// MatchPicker → rewrite its .svelte / ../fmt.js imports to local bundles.
const popSrc = readFileSync('src/lib/components/Popover.svelte', 'utf8');
svelteCompile(popSrc, 'Popover.svelte', join(dir, 'popover.js'));

const mpSrc = readFileSync('src/lib/components/MatchPicker.svelte', 'utf8')
  .replace("import { fmtDate, fmtDuration } from '../fmt.js';", "import { fmtDate, fmtDuration } from './fmt.js';")
  .replace("import StatusChip from './StatusChip.svelte';", "import StatusChip from './statuschip.js';")
  .replace("import Popover from './Popover.svelte';", "import Popover from './popover.js';");
svelteCompile(mpSrc, 'MatchPicker.svelte', join(dir, 'matchpicker-bundle.js'));

// Harness.
const harnessSrc = readFileSync('test/match-picker.harness.svelte', 'utf8');
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
const $ = (sel) => [...document.querySelectorAll(sel)];
const trigger = () => $('.mp-trigger')[0];
const pop = () => $('.mp-pop')[0];
const rows = () => $('.mp-opt');
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const key = (el, k) =>
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

console.log('A. trigger shows the current match');
check('trigger exists', !!trigger());
check('map shown', trigger().textContent.includes('de_cache'), trigger().textContent);
check('score shown', trigger().textContent.includes('10') && trigger().textContent.includes('13'));
check('id shown', trigger().textContent.includes('#2'));
check('aria-expanded false when closed', trigger().getAttribute('aria-expanded') === 'false');
check('id kept for the glossary', trigger().id === 'expl-match');

console.log('B. click opens the popover');
click(trigger());
await sleep();
check('popover open', !!pop());
check('3 options listed', rows().length === 3, String(rows().length));
check('aria-expanded true', trigger().getAttribute('aria-expanded') === 'true');
check('current row marked', !!$('.mp-opt.current'));
check(
  'current row is the selected match',
  $('.mp-opt.current')[0]?.id === 'mp-opt-2',
  $('.mp-opt.current')[0]?.id,
);
check('first row highlighted', rows()[0].classList.contains('active'));
check('status chip rendered', !!$('.mp-opt .chip.status'));
check(
  'matchup line present',
  $('.mp-opt')[0].textContent.includes('Team Alpha vs Team Beta'),
  $('.mp-opt')[0].textContent,
);
check(
  'missing matchup falls back gracefully',
  $('.mp-opt')[1].textContent.includes('#5'),
  $('.mp-opt')[1].textContent,
);
await sleep(30);
check('filter input focused', document.activeElement === $('.mp-search')[0]);

console.log('C. filtering');
const input = $('.mp-search')[0];
input.value = 'mirage';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await sleep();
check('one row after filter', rows().length === 1, String(rows().length));
check('filtered row is de_mirage', rows()[0].textContent.includes('de_mirage'));
input.value = 'zzz';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await sleep();
check('empty state message', document.body.textContent.includes('No matches match'), '');
check('no rows for no match', rows().length === 0);
input.value = '';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await sleep();
check('filter cleared restores list', rows().length === 3);

console.log('D. keyboard: arrows move, Enter selects');
key(input, 'ArrowDown');
await sleep(10);
check('arrow moves highlight to row 1', rows()[1].classList.contains('active'));
key(input, 'ArrowDown');
await sleep(10);
check('arrow moves highlight to row 2', rows()[2].classList.contains('active'));
key(input, 'Enter');
await sleep();
check('selection recorded', JSON.stringify(globalThis.__selected) === '[7]', JSON.stringify(globalThis.__selected));
check('popover closed after select', !pop());
check('trigger now shows de_nuke', trigger().textContent.includes('de_nuke'), trigger().textContent);
check(
  'focus returned to trigger',
  document.activeElement === trigger(),
  document.activeElement && document.activeElement.className,
);

console.log('E. Escape closes');
click(trigger());
await sleep();
check('reopened', !!pop());
key(document, 'Escape');
await sleep();
check('escape closed it', !pop());

console.log('F. click outside closes');
click(trigger());
await sleep();
check('reopened again', !!pop());
document.body.dispatchEvent(
  new dom.window.Event('pointerdown', { bubbles: true }),
);
await sleep();
check('outside pointerdown closed it', !pop());

console.log('G. clicking the trigger while open closes (no double toggle)');
click(trigger());
await sleep();
check('open', !!pop());
click(trigger());
await sleep();
check('closed by trigger click', !pop());

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
