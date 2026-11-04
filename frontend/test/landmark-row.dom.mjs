// jsdom driver for LandmarkRow: profile links inside the primary text
// (event / chat / generic sources), the row's select guard around them,
// and the plain-text fallbacks (no steam id, no resolver).
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --conditions browser test/landmark-row.dom.mjs
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

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'landmark-row');
mkdirSync(join(dir, 'replay'), { recursive: true });
mkdirSync(join(dir, 'components'), { recursive: true });

const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};

// Plain-ESM deps copied verbatim so their relative imports keep working
// at their new location: landmarks.js → rounds.js, nav.js → router.js +
// replay/landmarks.js.
for (const rel of ['rounds.js', 'router.js', 'nav.js']) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
writeFileSync(
  join(dir, 'replay', 'landmarks.js'),
  readFileSync('src/lib/replay/landmarks.js', 'utf8'),
);

// ProfileLink → components/ProfileLink.js (its ../nav.js resolves to the
// copy above); LandmarkRow's component import is rewritten to the bundle.
svelteCompile(
  readFileSync('src/lib/components/ProfileLink.svelte', 'utf8'),
  'ProfileLink.svelte',
  join(dir, 'components', 'ProfileLink.js'),
);
const rowSrc = readFileSync('src/lib/components/LandmarkRow.svelte', 'utf8').replace(
  "import ProfileLink from './ProfileLink.svelte';",
  "import ProfileLink from './ProfileLink.js';",
);
svelteCompile(rowSrc, 'LandmarkRow.svelte', join(dir, 'components', 'LandmarkRow.js'));

// Harness.
const harnessSrc = readFileSync('test/landmark-row.harness.svelte', 'utf8');
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
const slot = (id) => document.querySelector(`[data-testid="${id}"]`);
const text = (el) => (el ? el.textContent : '');
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const key = (el, k) =>
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

console.log('A. kill row: both players link, the row still selects');
const killSlot = slot('kill-row');
const main = killSlot.querySelector('.lm-main');
check(
  'lm-main is a role=button div (interactive elements may not nest in a button)',
  main.tagName === 'DIV' && main.getAttribute('role') === 'button' && main.getAttribute('tabindex') === '0',
  main.tagName,
);
const killLinks = [...killSlot.querySelectorAll('.lm-text .comb-name-btn')];
check('two profile links in the primary text', killLinks.length === 2, String(killLinks.length));
check('killer link text', text(killLinks[0]) === 'alice', text(killLinks[0]));
check('victim link text', text(killLinks[1]) === 'bob', text(killLinks[1]));
check('arrow separator kept', text(killSlot.querySelector('.lm-text')).includes(' → '), text(killSlot.querySelector('.lm-text')));
check('weapon still in the secondary slot', text(killSlot.querySelector('.lm-sec')).includes('ak47'));

globalThis.__nav = [];
globalThis.__selected = [];
click(killLinks[0]);
check('name click opens the profile', JSON.stringify(globalThis.__nav) === '["/player/76561198012345678"]', JSON.stringify(globalThis.__nav));
check('name click does not select the row', globalThis.__selected.length === 0, JSON.stringify(globalThis.__selected));

click(killSlot.querySelector('.lm-tick'));
check('row click selects the landmark', JSON.stringify(globalThis.__selected) === '["e:1"]', JSON.stringify(globalThis.__selected));

console.log('B. keyboard: Enter on the row selects, Enter on a link does not');
globalThis.__selected = [];
key(main, 'Enter');
check('Enter on the row selects', JSON.stringify(globalThis.__selected) === '["e:1"]', JSON.stringify(globalThis.__selected));
globalThis.__selected = [];
key(killLinks[1], 'Enter');
check('Enter on an inner link leaves the row unselected', globalThis.__selected.length === 0, JSON.stringify(globalThis.__selected));
globalThis.__seek = [];
click(killSlot.querySelector('.lm-play'));
check('seek button seeks to the row tick', JSON.stringify(globalThis.__seek) === '["e:1"]', JSON.stringify(globalThis.__seek));
check('seek does not select', globalThis.__selected.length === 0, JSON.stringify(globalThis.__selected));

console.log('C. non-steam names stay plain text');
const botSlot = slot('bot-row');
check('bot row has no profile link', botSlot.querySelectorAll('.comb-name-btn').length === 0);
check('bot row still shows both names', text(botSlot.querySelector('.lm-text')).includes('BOT'), text(botSlot.querySelector('.lm-text')));

console.log('D. chat sender links to the profile');
const chatSlot = slot('chat-row');
check('sender: message text', text(chatSlot.querySelector('.lm-text')) === 'alice: mid', text(chatSlot.querySelector('.lm-text')));
check('sender is a profile link', chatSlot.querySelectorAll('.lm-text .comb-name-btn').length === 1);

console.log('E. generic rows link only when a resolver returns an id');
const genericSlot = slot('generic-row');
check('resolved generic name is a link', genericSlot.querySelectorAll('.lm-text .comb-name-btn').length === 1);
const unresolvedSlot = slot('generic-unresolved-row');
check('unresolved generic name is plain text', unresolvedSlot.querySelectorAll('.lm-text .comb-name-btn').length === 0);
check('unresolved generic name still renders', text(unresolvedSlot.querySelector('.lm-text')).includes('dave'), text(unresolvedSlot.querySelector('.lm-text')));

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
