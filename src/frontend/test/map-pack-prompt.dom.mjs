// jsdom driver for MapPackPrompt: the presence-driven launch prompt —
// gate logic (any asset family missing → open, all present → closed),
// the not-found variant, "Not now" persisting NOTHING across remounts,
// the busy gate on Escape/backdrop dismissal, the StatusChip progress
// pattern, and the counts-only result line from lib/assets.js.
//
// jsdom is a declared devDependency; from frontend/ run:
//   node --conditions browser test/map-pack-prompt.dom.mjs
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
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement',
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

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'map-pack-prompt');
mkdirSync(dir, { recursive: true });

// The services stub: every function MapPackPrompt (and lib/assets.js)
// pulls from lib/services.js reads its behaviour from globalThis.__stub,
// which the driver swaps per case. setCS2Dir calls are recorded — the
// prompt must only ever call it for a real folder pick, never for a
// dismissal (the retired suppression write is gone).
writeFileSync(
  join(dir, 'services-stub.js'),
  `const stub = () => globalThis.__stub;

export async function getMapPackStatus() { return stub().status; }
export async function getIconManifest() { return stub().icons; }
export async function getSoundManifest() { return stub().sounds; }
export async function extractMapPacks(cs2Dir) { return stub().extractMapPacks(cs2Dir); }
export async function extractIcons(cs2Dir) { return stub().extractIcons(cs2Dir); }
export async function extractSounds(cs2Dir) { return stub().extractSounds(cs2Dir); }
export async function setCS2Dir(path) {
  const s = stub();
  (s.setCS2DirCalls ||= []).push(path);
}
export async function chooseCS2Dir() { return stub().chooseDir || ''; }
export function onAssetProgress(cb) {
  const subs = (globalThis.__progressSubs ||= []);
  subs.push(cb);
  return () => {
    const i = subs.indexOf(cb);
    if (i >= 0) subs.splice(i, 1);
  };
}
export function errText(e) { return String((e && e.message) || e); }
`,
);

const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};

// Dialog + StatusChip (no imports) → local bundles; MapPackPrompt's
// imports rewritten to the local bundles/stub/assets copy; lib/assets.js
// (plain JS) rewritten to the stub; harness → local bundle.
svelteCompile(
  readFileSync('src/lib/components/Dialog.svelte', 'utf8'),
  'Dialog.svelte',
  join(dir, 'dialog.js'),
);
svelteCompile(
  readFileSync('src/lib/components/StatusChip.svelte', 'utf8'),
  'StatusChip.svelte',
  join(dir, 'statuschip.js'),
);
writeFileSync(
  join(dir, 'assets.js'),
  readFileSync('src/lib/assets.js', 'utf8').replace("'./services.js'", "'./services-stub.js'"),
);
const promptSrc = readFileSync('src/lib/components/MapPackPrompt.svelte', 'utf8')
  .replace("'../services.js'", "'./services-stub.js'")
  .replace("'../assets.js'", "'./assets.js'")
  .replace("'./Dialog.svelte'", "'./dialog.js'")
  .replace("'./StatusChip.svelte'", "'./statuschip.js'");
svelteCompile(promptSrc, 'MapPackPrompt.svelte', join(dir, 'mappackprompt-bundle.js'));
svelteCompile(
  readFileSync('test/map-pack-prompt.harness.svelte', 'utf8'),
  'harness.svelte',
  join(dir, 'harness.js'),
);

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'harness.js')).href);
const target = document.createElement('div');
document.body.appendChild(target);
let app = mount(mod.default, { target });

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
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const key = (el, k) =>
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const panel = () => $('.dlg-panel')[0];
const backdrop = () => $('.dlg-back')[0];
const open = () => $('.dlg-back').length > 0;
const actions = () => $('.pk-actions button');
const actionLabels = () => actions().map((b) => b.textContent.trim());
const primary = () => actions().find((b) => b.classList.contains('primary'));
const notNow = () => actions().find((b) => b.textContent.trim() === 'Not now');
const resultLine = () => panel()?.querySelector('.pk-result')?.textContent.trim();
const errorLine = () => panel()?.querySelector('p.error[role="alert"]')?.textContent.trim();
const emitProgress = (p) => [...(globalThis.__progressSubs || [])].forEach((cb) => cb(p));

// The all-present baseline: every family extracted.
const allPresent = () => ({
  status: {
    found: true,
    path: '/games/steam/steamapps/common/Counter-Strike Global Offensive',
    manual: false,
    maps: ['de_mirage', 'de_nuke'],
  },
  icons: { extracted: true, count: 120, icons: {} },
  sounds: { extracted: true, count: 45, sounds: {} },
  setCS2DirCalls: [],
  chooseDir: '',
  extractMapPacks: async () => ({ maps: ['de_mirage'], errors: [] }),
  extractIcons: async () => ({ count: 120, note: '' }),
  extractSounds: async () => ({ count: 45, note: '' }),
});
const maybePrompt = async () => {
  await globalThis.__prompt.maybePrompt();
  await sleep();
};

console.log('A. all three families present → no dialog');
globalThis.__stub = allPresent();
await maybePrompt();
check('stays closed', !open());

console.log('B. missing map packs → found-variant dialog, all-assets copy');
globalThis.__stub = { ...allPresent(), status: { ...allPresent().status, maps: [] } };
await maybePrompt();
check('opens', open());
check(
  'panel labelled "Extract CS2 assets"',
  panel()?.getAttribute('aria-label') === 'Extract CS2 assets',
  panel()?.getAttribute('aria-label'),
);
check(
  'title = Found Counter-Strike 2',
  panel()?.querySelector('.pk-title')?.textContent === 'Found Counter-Strike 2',
  panel()?.querySelector('.pk-title')?.textContent,
);
check(
  'offers to extract ALL assets',
  primary()?.textContent.trim() === 'Extract all CS2 assets',
  primary()?.textContent.trim(),
);
const bodyText = panel()?.querySelector('.pk-body').textContent || '';
check('copy mentions equipment icons', bodyText.includes('equipment icons'));
check('copy mentions replay sounds', bodyText.includes('replay sounds'));
check('not-found variant absent', !bodyText.includes('not found'));

console.log('C. missing icons or sounds alone also opens the dialog');
click(notNow());
await sleep();
globalThis.__stub = { ...allPresent(), icons: { extracted: false, count: 0, icons: {} } };
await maybePrompt();
check('missing icons → opens', open());
click(notNow());
await sleep();
globalThis.__stub = { ...allPresent(), sounds: { extracted: false, count: 0, sounds: {} } };
await maybePrompt();
check('missing sounds → opens', open());
click(notNow());
await sleep();
check('C cleanup closed', !open());

console.log('D. no CS2 install → the not-found variant (unchanged UX)');
globalThis.__stub = {
  ...allPresent(),
  status: { found: false, path: '', manual: false, maps: [] },
  icons: { extracted: false, count: 0, icons: {} },
  sounds: { extracted: false, count: 0, sounds: {} },
};
await maybePrompt();
check('opens', open());
check(
  'panel labelled "Counter-Strike 2 not found"',
  panel()?.getAttribute('aria-label') === 'Counter-Strike 2 not found',
  panel()?.getAttribute('aria-label'),
);
check(
  'offers Choose folder… + Not now',
  JSON.stringify(actionLabels()) === JSON.stringify(['Choose folder…', 'Not now']),
  JSON.stringify(actionLabels()),
);
check('no extract button in the not-found variant', !primary());

console.log('E. "Not now" closes this launch only — nothing persists across mounts');
globalThis.__stub = { ...allPresent(), status: { ...allPresent().status, maps: [] } };
await maybePrompt();
check('opens (maps missing)', open());
click(notNow());
await sleep();
check('closes', !open());
check('decline persisted nothing', (globalThis.__stub.setCS2DirCalls || []).length === 0);
// Fresh mount = the next launch: same missing state, no suppression pref
// in sight → the prompt must open again.
unmount(app);
target.replaceChildren();
app = mount(mod.default, { target });
await sleep();
await maybePrompt();
check('reopens after a remount (no suppression)', open());
click(notNow());
await sleep();

console.log('F. accept: busy gate + StatusChip progress + counts-only result');
// One gate PER FAMILY so the driver can hold each step open while it
// feeds that step's spectra:asset-progress payloads (all three families
// emit now — mappackservice.go's shared emitter).
let releaseMaps, releaseIcons, releaseSounds;
const gateMaps = new Promise((r) => (releaseMaps = r));
const gateIcons = new Promise((r) => (releaseIcons = r));
const gateSounds = new Promise((r) => (releaseSounds = r));
globalThis.__stub = {
  ...allPresent(),
  status: { ...allPresent().status, maps: [] },
  extractMapPacks: async () => {
    await gateMaps;
    return { maps: ['de_mirage'], errors: [] };
  },
  extractIcons: async () => {
    await gateIcons;
    return { count: 0, note: 'VPK unreadable' }; // partial failure
  },
  extractSounds: async () => {
    await gateSounds;
    return { count: 5, note: '' };
  },
};
await maybePrompt();
check('opens', open());
click(primary());
await sleep(60);
check('extract button disabled while busy', primary()?.disabled === true);
check('Not now disabled while busy', notNow()?.disabled === true);
const chip = panel()?.querySelector('.chip.status');
const chipText = () => panel()?.querySelector('.chip.status')?.textContent || '';
check('StatusChip shown while extracting', !!chip, panel()?.textContent.slice(0, 120));
check(
  'step text names the running family',
  (panel()?.textContent || '').includes('Extracting radar map packs'),
  panel()?.textContent.slice(0, 160),
);
key(backdrop(), 'Escape');
await sleep();
check('Escape ignored while busy', open());
click(backdrop());
await sleep();
check('backdrop click ignored while busy', open());
emitProgress({ family: 'map-packs', stage: 'extract', done: 1, total: 4 });
await sleep();
check(
  'determinate chip shows 25%',
  (panel()?.textContent || '').includes('25%'),
  panel()?.querySelector('.chip.status')?.textContent,
);

console.log('F2. icon/sound steps: their own emitters drive the bar');
releaseMaps();
await sleep();
check(
  'step advances to equipment icons',
  (panel()?.textContent || '').includes('Extracting equipment icons'),
  panel()?.textContent.slice(0, 160),
);
// The previous step's payload must NOT drive this step's bar: it stays
// the animated indeterminate one until an icons payload lands.
check(
  'icons step starts indeterminate (stale map-packs payload gated out)',
  !!panel()?.querySelector('.chip-bar-fill.indeterminate') &&
    !(panel()?.textContent || '').includes(' of '),
  panel()?.textContent.slice(0, 200),
);
emitProgress({ family: 'icons', stage: 'extract', done: 60, total: 120 });
await sleep();
check('icons emitter → determinate chip shows 50%', chipText().includes('50%'), chipText());
check(
  'icons step row shows 60 of 120',
  (panel()?.textContent || '').includes('60 of 120'),
  panel()?.textContent.slice(0, 200),
);
// A stale payload for another family (here: the finished map-pack run)
// must never retarget this step's bar OR clobber its numbers: the
// listener filters on the running step's family (assets.js).
emitProgress({ family: 'map-packs', stage: 'extract', done: 4, total: 4 });
await sleep();
check(
  'stale map-packs payload ignored during the icons step',
  (panel()?.textContent || '').includes('60 of 120') && chipText().includes('50%'),
  chipText(),
);
releaseIcons();
await sleep();
check(
  'step advances to replay sounds',
  (panel()?.textContent || '').includes('Extracting replay sounds'),
  panel()?.textContent.slice(0, 160),
);
emitProgress({ family: 'sounds', stage: 'extract', done: 45, total: 45 });
await sleep();
check(
  'sounds emitter → closing payload renders 45 of 45',
  (panel()?.textContent || '').includes('45 of 45'),
  panel()?.textContent.slice(0, 200),
);

releaseSounds();
await sleep(100);
check(
  'counts-only result line',
  resultLine() === 'Extracted 1 map pack, 5 sounds.',
  JSON.stringify(resultLine()),
);
check('aggregated error line', errorLine() === 'icons: VPK unreadable.', JSON.stringify(errorLine()));
check('stays open after a partial failure', open());
check('busy cleared — buttons enabled again', primary()?.disabled === false);
check(
  'progress row gone after the run',
  !(panel()?.textContent || '').includes('Extracting'),
);

console.log('G. full success → counts line + auto-close');
globalThis.__stub = {
  ...globalThis.__stub,
  extractIcons: async () => ({ count: 120, note: '' }),
  extractSounds: async () => ({ count: 45, note: '' }),
};
click(primary());
await sleep(100);
check(
  'full counts line',
  resultLine() === 'Extracted 1 map pack, 120 icons, 45 sounds.',
  JSON.stringify(resultLine()),
);
check('no error line', !errorLine());
await sleep(1100);
check('auto-closed after full success', !open());

console.log('H. probe failure routes into the dialog error slot — never the console');
// A REAL rejection only: the resolved "family absent" states keep their
// normal gate (A–E above pin it). With no status in hand the prompt
// takes the same "no status → not-found" variant the gate computes.
globalThis.__stub = {
  ...allPresent(),
  status: Promise.reject(new Error('status probe failed')),
};
await maybePrompt();
check('probe rejection surfaces in the dialog (visible, not swallowed)', open());
check(
  'failure routed to p.error[role="alert"] with the probe context',
  errorLine() === 'Couldn’t check the CS2 asset status: status probe failed',
  JSON.stringify(errorLine()),
);
check('the slot stays dismissible through the Dialog actions', !!notNow());
click(notNow());
await sleep();
check('dismissed in place', !open());
// The presence gate itself is untouched: a healthy probe with every
// family present still never opens.
globalThis.__stub = allPresent();
await maybePrompt();
check('healthy probe → still closed (gate unchanged)', !open());

if (errors.length) failures += errors.length;
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
