import './compile-worker-node.mjs';
// jsdom driver for MapPackPrompt: the presence-driven launch prompt —
// gate logic (any asset family missing → open, all present → closed),
// the not-found variant, "Not now" persisting NOTHING across remounts,
// the busy gate on Escape/backdrop dismissal, and close-ON-EXTRACT (the
// owner's 2026-11-17 rework: the popup has NO progress widget any more —
// the run continues behind the closed prompt and the floating work
// indicator owns its progress; failures reach the indicator through
// lib/assets.js's reportWorkError, recorded here by the workstate stub).
//
// jsdom is a declared devDependency; from frontend/ run:
//   node --conditions browser test/map-pack-prompt.dom.mjs
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

// Dialog (no imports) → local bundle; MapPackPrompt's imports rewritten
// to the local bundle/stub/assets copy; lib/assets.js (plain JS) rewritten
// to the stub services + a workstate stub (assets reports its aggregated
// failure there — the stub RECORDS the calls so the driver can pin the
// indicator wiring); harness → local bundle. MapPackPrompt no longer
// renders StatusChip (progress moved to the floating indicator), so no
// chip bundle is compiled here any more.
svelteCompile(
  readFileSync('src/lib/components/Dialog.svelte', 'utf8'),
  'Dialog.svelte',
  join(dir, 'dialog.js'),
);
writeFileSync(
  join(dir, 'workstate-stub.js'),
  `// Records the failure messages assets.js hands the work indicator.
export function runWork(source, promise) {
  return Promise.resolve(promise);
}
export function reportWorkError(msg) {
  (globalThis.__workErrors ||= []).push(String(msg));
}
`,
);
writeFileSync(
  join(dir, 'assets.js'),
  readFileSync('src/lib/assets.js', 'utf8')
    .replace("'./services.js'", "'./services-stub.js'")
    .replace("'./workstate.svelte.js'", "'./workstate-stub.js'"),
);
const promptSrc = readFileSync('src/lib/components/MapPackPrompt.svelte', 'utf8')
  .replace("'../services.js'", "'./services-stub.js'")
  .replace("'../assets.js'", "'./assets.js'")
  .replace("'./Dialog.svelte'", "'./dialog.js'")
  // plumbing (Strings Stage 3): the prompt imports the strings catalog —
  // resolve it from the real tree.
  .replace("from '../strings/index.js'", `from '${pathToFileURL('src/lib/strings/index.js').href}'`);
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

console.log('F. accept closes the popup AT ONCE — the extraction continues behind it');
// One gate PER FAMILY so the driver can hold the run open while proving
// the prompt is gone BEFORE any family resolves — close happens ahead of
// the first awaited extraction (owner 2026-11-17).
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
globalThis.__workErrors = [];
await maybePrompt();
check('opens', open());
click(primary());
await sleep(60);
check(
  'closes at once on Extract — while every family is still gated in flight',
  !open(),
  JSON.stringify(document.querySelector('.dlg-back')?.textContent?.slice(0, 80)),
);
check(
  'the popup renders no progress widget anywhere (the floating indicator owns progress now)',
  !document.querySelector('.chip-block'),
  document.body.textContent.slice(0, 120),
);
// spectra:asset-progress still fires — the prompt subscribes to nothing:
// it must drive NO widget in the popup.
emitProgress({ family: 'map-packs', stage: 'extract', done: 1, total: 4 });
await sleep();
check(
  'an asset-progress payload drives nothing in the popup (no subscriber left)',
  !document.querySelector('.chip-block'),
);
check(
  'no "Extracting…" button label anywhere while the run is in flight',
  ![...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('Extracting…')),
  document.body.textContent.slice(0, 160),
);

console.log('F2. the busy gate still holds if the prompt is open again mid-run');
await maybePrompt(); // the launch probe re-opening while the run is in flight
check('the prompt can be open again while the run is in flight', open());
check('extract button disabled while busy', primary()?.disabled === true);
// The busy-button exemption (owner ruling): a busy BUTTON keeps its
// plain "Extracting…" label — no spinner, no ring inside the button.
check(
  'busy button label stays plain text (busy-button exemption)',
  (primary()?.textContent || '').trim() === 'Extracting…' &&
    !primary()?.querySelector('.chip-spin, .chip-ring, .chip-block'),
  JSON.stringify(primary()?.textContent),
);
check('Not now disabled while busy', notNow()?.disabled === true);
key(backdrop(), 'Escape');
await sleep();
check('Escape ignored while busy', open());
click(backdrop());
await sleep();
check('backdrop click ignored while busy', open());
check(
  'no per-step copy left in the popup (the old details line died with the widget)',
  !(panel()?.textContent || '').includes('Extracting radar map packs'),
  panel()?.textContent.slice(0, 160),
);

console.log('F3. run lands: the popup keeps its error slot, the failure reaches the indicator');
releaseMaps();
releaseIcons();
releaseSounds();
await sleep(100);
check(
  'aggregated error line (partial failure — still rendered by the reopened prompt)',
  errorLine() === 'icons: VPK unreadable.',
  JSON.stringify(errorLine()),
);
check(
  'the SAME aggregated failure was reported to the work indicator',
  (globalThis.__workErrors || []).includes('icons: VPK unreadable.'),
  JSON.stringify(globalThis.__workErrors),
);
check('stays open after a partial failure', open());
check('busy cleared — buttons enabled again', primary()?.disabled === false);
check(
  'no counts/result line (the success line left with the popup)',
  !resultLine(),
  JSON.stringify(resultLine()),
);
check(
  'no progress row after the run either',
  !document.querySelector('.chip-block') && !(panel()?.textContent || '').includes('Extracting radar'),
);

console.log('G. a second Extract closes at once too (the success auto-close died with the popup)');
globalThis.__stub = {
  ...globalThis.__stub,
  extractIcons: async () => ({ count: 120, note: '' }),
  extractSounds: async () => ({ count: 45, note: '' }),
};
click(primary());
await sleep(60);
check('closes at once on a full-success run too', !open());

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
