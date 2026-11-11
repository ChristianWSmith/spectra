// jsdom driver for App's replay keep-alive dock (the mini-player panel —
// src/App.svelte's .rp-keepalive wrapper): the wrapper's ONE expand path
// (click + Enter/Space on the collapsed panel), the close (X) button's
// event isolation (it must close and NEVER also fire the wrapper's
// expand handlers) and the keep-alive transitions around them.
//
// Section A — off the replay route there is no dock; the replay route
// mounts the instance EXPANDED (no DOCK X: the top bar owns its own
// Close · Minimize · Theater cluster — Replay's contract, pinned in
// replay.dom.mjs — while this .rp-keepalive-close dock X stays
// collapsed-only) and pins the fresh-entry mount count.
// Section B — a same-id match route COLLAPSES the same instance (no
// remount — the keep-alive), the X appears only while collapsed, and the
// wrapper's own handlers are the positive controls: a click or Enter on
// the WRAPPER itself expands (so the isolation pins below are
// meaningful — the harness can see an expansion when one happens).
// Section C — the X's isolation: Enter dispatched on the X never
// reaches the wrapper's onDockKey (the hash does not move), and a
// click closes (alive = null → the wrapper unmounts, the route stays).
// Section D — reopening after a close is a FRESH entry (the kept
// instance was really destroyed: the stub Replay re-mounts), the
// onClose prop App hands Replay IS this teardown (invoking it destroys,
// never docks), and style.css carries the .rp-keepalive-close rule
// (jsdom has no layout,
// so the rule's APPLICATION is what is pinned — never pixel geometry).
// Section E — the collapsed dock's caption-flush CSS: the inherited
// 10px column gap the mini panel zeroes (frame flush to .rp-mini-bar),
// characterized against the expanded rhythm it must not change.
//
// SCOPE: App's wiring only. The views are inert stubs (Replay's stub
// counts mounts and mirrors the App-passed props as data attributes) —
// every view's own contract lives in its own driver (replay.dom.mjs,
// library.dom.mjs, …). The nav/router/keepalive layer is the REAL pure
// source, copied verbatim with its relative layout intact.
//
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it. From frontend/ run:
//   node --test test/app-dock.dom.mjs
// (must be run with frontend/ as the working directory)
import { registerHooks } from 'node:module';

const { JSDOM } = await import('jsdom');
const { compile } = await import('svelte/compiler');
const { readFileSync, writeFileSync, mkdirSync, readdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');

// svelte's package exports pick the SERVER build without the `browser`
// condition (mount() then throws "lifecycle_function_unavailable") — the
// same redirect replay.dom.mjs uses, applied before any compiled
// component imports svelte. The generated bindings App.svelte links
// (AppService) resolve through the shared test stub — this driver never
// calls into them (only the resize report would, and jsdom never fires
// it). Hooks are per-process; this file runs under `node --test` in its
// own process.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'svelte' || specifier.startsWith('svelte/')) {
      return nextResolve(specifier, {
        ...context,
        conditions: ['browser', ...(context.conditions || [])],
      });
    }
    if (specifier.includes('bindings/github.com')) {
      return { url: pathToFileURL(join('test', 'stubs', 'bindings.mjs')).href, shortCircuit: true };
    }
    if (specifier === '@wailsio/runtime') {
      return { url: pathToFileURL(join('test', 'stubs', 'wails-runtime.mjs')).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of [
  'window', 'document', 'navigator', 'location', 'history', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLAnchorElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'DOMParser',
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

// Inert stand-ins: nothing in this driver's stub graph draws or fetches,
// but the copied lib tree may reference them — surprises become no-ops.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.fetch = async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) });

const errors = [];
process.on('uncaughtException', (e) => {
  errors.push(e);
  console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  errors.push(e);
  console.error('REJECTION: ' + (e && e.stack ? e.stack : e));
});

// --- Build App's module tree in a cache dir ---------------------------------
const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'app-dock');
mkdirSync(join(dir, 'lib', 'views'), { recursive: true });
mkdirSync(join(dir, 'lib', 'components'), { recursive: true });

// The REAL pure layer App links (router/nav/keepalive + their transitive
// imports — nav → router + replay/landmarks → rounds/fmt/teams, all
// pure): the whole src/lib .js tree is copied with its relative layout
// intact, so every relative import resolves without import chasing. No
// real view source goes in — the views are stubbed below.
function copyJs(srcDir, destDir) {
  for (const e of readdirSync(srcDir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      copyJs(join(srcDir, e.name), join(destDir, e.name));
      continue;
    }
    if (!e.name.endsWith('.js')) continue;
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, e.name), readFileSync(join(srcDir, e.name)));
  }
}
copyJs('src/lib', join(dir, 'lib'));

// Stub views/components — inert markup. runes:true so `export const`
// (the maybePrompt App calls) and $props() are unambiguous; the props
// App passes are either declared (Replay/CommandPalette) or ignored.
const compileSvelte = (src, filename, out, opts = {}) =>
  writeFileSync(out, compile(src, { filename, generate: 'client', ...opts }).js.code);
const writeStub = (rel, src) => {
  const sveltePath = join(dir, rel);
  writeFileSync(sveltePath, src);
  compileSvelte(src, rel, sveltePath.replace(/\.svelte$/, '.js'), { runes: true });
};
for (const name of [
  'Library', 'Match', 'RoundDetail', 'Settings', 'Builder', 'SqlConsole', 'Explorer',
  'Reports', 'Profiles', 'PlayerProfile', 'CompareRounds',
]) {
  writeStub(`lib/views/${name}.svelte`, `<div class="stub-view stub-${name}" />\n`);
}
// Replay — the kept-alive component: the mount counter is THE observable
// of fresh-vs-kept (a close must destroy the instance; a keep-alive
// round trip must not remount), and the App-passed props surface as data
// attributes (active flips across the dock round trip).
writeStub(
  'lib/views/Replay.svelte',
  `<script>
  let { id = 0, query = {}, nav = () => {}, active = true, onClose = null } = $props();
  globalThis.__replayMounts = (globalThis.__replayMounts || 0) + 1;
  // The teardown half of the TOPBAR Close: App hands Replay its own
  // closeReplay through this prop (replay.dom.mjs pins the real button
  // calling it; section D here exercises the prop against App's wiring).
  globalThis.__replayClose = (e) => onClose?.(e);
</script>
<div class="stub-replay" data-id={String(id)} data-active={String(active)} />
`,
);
// CommandPalette — always mounted by App; inert here.
writeStub(
  'lib/components/CommandPalette.svelte',
  `<script>
  let { nav = () => {} } = $props();
</script>
<div class="stub-palette" />
`,
);
// MapPackPrompt — App calls mapPackPrompt?.maybePrompt() on mount (the
// real component exports it; the stub's export is a no-op).
writeStub(
  'lib/components/MapPackPrompt.svelte',
  `<script>
  export const maybePrompt = () => {};
</script>
<div class="stub-mappackprompt" />
`,
);

// App.svelte → its ./lib/**/*.svelte imports resolve to the stubs above
// (rewritten to .js like every other harness); everything else (svelte,
// the bindings, the real pure lib files) resolves through the hooks /
// the copied tree.
const appSrc = readFileSync('src/App.svelte', 'utf8').replace(
  /from '(\.\/lib\/(?:views|components)\/\w+)\.svelte'/g,
  "from '$1.js'",
);
compileSvelte(appSrc, 'App.svelte', join(dir, 'App.js'));

// --- Mount and drive the router ---------------------------------------------
const { mount } = await import('svelte');
const sleep = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const pressEnter = (el) =>
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
// One navigation: set the hash and let App's hashchange handler flush.
const go = async (hash) => {
  location.hash = hash;
  await sleep();
};
const wrapper = () => document.querySelector('.rp-keepalive');
const closeBtn = () => wrapper()?.querySelector('.rp-keepalive-close');
const stubReplay = () => document.querySelector('.stub-replay');
const mounts = () => globalThis.__replayMounts || 0;

// Compile/link/mount failure below would otherwise be swallowed by the
// uncaughtException handler and exit 0 — fail loudly instead.
try {
  const mod = await import(pathToFileURL(join(dir, 'App.js')).href);
  const target = document.createElement('div');
  document.body.appendChild(target);
  mount(mod.default, { target });
} catch (e) {
  console.error('APP MOUNT FAILED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
}
await sleep(); // onMount: the hashchange listener is registered

console.log('A. off the replay route there is no dock; the replay route mounts the instance (no DOCK X — the top bar cluster is Replay\'s own)');
check('no keep-alive wrapper on the library route', !wrapper(), wrapper() ? 'wrapper present' : '');
check(
  'the stub Replay is not mounted either',
  !stubReplay(),
  stubReplay() ? 'stub present' : '',
);
await go('#/replay/1');
check(
  'the replay route mounts the instance EXPANDED (no mini class)',
  !!wrapper() && !wrapper().classList.contains('rp-keepalive-mini'),
  wrapper() ? wrapper().className : 'no wrapper',
);
check('no DOCK close X on the full replay view (the top bar cluster is Replay\'s own — pinned in replay.dom.mjs)', !closeBtn(), closeBtn() ? 'X present' : '');
check('fresh entry: the stub Replay mounted once', mounts() === 1, `mounts=${mounts()}`);
check(
  'the instance reads ACTIVE on the replay route',
  stubReplay()?.getAttribute('data-active') === 'true',
  stubReplay()?.getAttribute('data-active'),
);

console.log('B. a same-id match route collapses the SAME instance (keep-alive) and the X appears only while collapsed');
await go('#/match/1');
check(
  'collapsed: the wrapper wears the mini class',
  wrapper()?.classList.contains('rp-keepalive-mini'),
  wrapper() ? wrapper().className : 'no wrapper',
);
check(
  'keep-alive: the SAME instance survives the round trip (no remount)',
  mounts() === 1,
  `mounts=${mounts()}`,
);
check(
  'the instance reads INACTIVE over the match view',
  stubReplay()?.getAttribute('data-active') === 'false',
  stubReplay()?.getAttribute('data-active'),
);
check(
  'the wrapper keeps its expand affordance (role=button + label)',
  wrapper()?.getAttribute('role') === 'button' &&
    wrapper()?.getAttribute('aria-label') === 'Expand replay',
  `${wrapper()?.getAttribute('role')} / ${wrapper()?.getAttribute('aria-label')}`,
);
check('the close X renders ONLY while collapsed', !!closeBtn(), closeBtn() ? 'X present' : 'no X');
check(
  'the X is labelled Close replay and explains the reload',
  closeBtn()?.getAttribute('aria-label') === 'Close replay' &&
    /reloads when reopened/.test(closeBtn()?.getAttribute('title') || ''),
  `${closeBtn()?.getAttribute('aria-label')} / ${closeBtn()?.getAttribute('title')}`,
);
check('the X carries the codicon glyph', !!closeBtn()?.querySelector('.codicon-close'));
// Positive controls: the wrapper's OWN handlers expand (click and
// Enter/Space) — so section C's "nothing happened" pins prove the X's
// isolation, not a dead handler.
click(wrapper());
await sleep();
check(
  'positive control: clicking the wrapper expands (hash → #/replay/1?back=…)',
  location.hash.startsWith('#/replay/1') && !closeBtn(),
  location.hash,
);
check('expanding keeps the SAME instance (no remount)', mounts() === 1, `mounts=${mounts()}`);
await go('#/match/1');
pressEnter(wrapper());
await sleep();
check(
  'positive control: Enter on the wrapper expands (onDockKey)',
  location.hash.startsWith('#/replay/1') && !closeBtn(),
  location.hash,
);
check('Enter-expanding keeps the SAME instance', mounts() === 1, `mounts=${mounts()}`);

console.log("C. the X's event isolation: Enter closes-never-expands, a click closes and stays");
await go('#/match/1');
const xBefore = closeBtn();
check('the X is there for the isolation round', !!xBefore, 'no X');
pressEnter(xBefore);
await sleep();
check(
  "Enter on the X never reaches the wrapper's onDockKey (hash unchanged)",
  location.hash === '#/match/1',
  location.hash,
);
check(
  'the dock is still collapsed after the keydown (no expand)',
  wrapper()?.classList.contains('rp-keepalive-mini'),
  wrapper() ? wrapper().className : 'no wrapper',
);
check(
  'the instance is still alive after the keydown (Enter closes only via the button click)',
  mounts() === 1 && !!stubReplay(),
  `mounts=${mounts()}`,
);
click(xBefore);
await sleep();
check('clicking the X closes the dock (alive = null → the wrapper unmounts)', !wrapper(), wrapper() ? 'wrapper present' : 'gone');
check('the instance was destroyed (the stub Replay unmounted)', !stubReplay(), stubReplay() ? 'stub present' : 'gone');
check('the user stays on the match route', location.hash === '#/match/1', location.hash);

console.log('D. reopening after a close is a FRESH entry (no instance ever existed); the onClose prop shares the teardown');
await go('#/replay/1');
check('the wrapper is back on the replay route', !!wrapper(), 'no wrapper');
check('FRESH: the stub Replay mounted a SECOND time', mounts() === 2, `mounts=${mounts()}`);
check('expanded again: no X', !closeBtn(), closeBtn() ? 'X present' : '');
check(
  'style.css pins .rp-keepalive-close to the panel top-right (jsdom has no layout — the rule is the pin)',
  /\.rp-keepalive-close\s*\{[^}]*position:\s*absolute[^}]*\btop:\s*6px[^}]*\bright:\s*6px/s.test(
    readFileSync('public/style.css', 'utf8'),
  ),
  'no absolute top:6px right:6px .rp-keepalive-close rule',
);

// The TOPBAR Close reaches the same teardown through the onClose prop
// App passes down (closeReplay — never forked): the exit half is
// Replay's goBack (its destination is pinned in replay.dom.mjs; it runs
// BEFORE onClose so query.back is still live), so here the teardown
// half alone must destroy exactly like the dock X did — NOT collapse (a
// dock would keep the wrapper alive), route untouched, next entry fresh.
await go('#/match/1'); // compose with the exit half: land on the match route first
check(
  'collapsed for the prop-teardown leg (the keep-alive holds)',
  wrapper()?.classList.contains('rp-keepalive-mini'),
  wrapper() ? wrapper().className : 'no wrapper',
);
globalThis.__replayClose(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep();
check(
  'the onClose prop IS the dock teardown (alive = null → the wrapper is GONE, not docked)',
  !wrapper(),
  wrapper() ? `wrapper "${wrapper().className}" survived` : 'gone',
);
check(
  'the prop itself never navigates (the exit half is Replay goBack)',
  location.hash === '#/match/1',
  location.hash,
);
await go('#/replay/1');
check(
  'entry after the prop teardown is FRESH again (a third mount)',
  mounts() === 3 && !!wrapper() && !wrapper().classList.contains('rp-keepalive-mini'),
  `mounts=${mounts()}`,
);

// --- (E): the collapsed dock's caption sits FLUSH against the frame -------
// jsdom has no layout, so the RULES are the pins (the .rp-keepalive-close
// precedent in section D). The dead gap between the frozen frame and
// .rp-mini-bar was .replay-main's inherited 10px flex gap: at full size
// it separates the topbar / stage / transport lines (harmless, wanted),
// but while collapsed those siblings unmount and it became dead space
// above the caption. The dock zeroes it INSIDE the mini panel only — the
// expanded rhythm is characterized right beside it, so a regression that
// moves the spacing in EITHER direction fails.
console.log('E. collapsed dock: the frame sits flush against the caption (CSS rules — jsdom has no layout)');
const cssE = readFileSync('public/style.css', 'utf8');
check(
  'the inherited spacing is characterized: .replay-main keeps its 10px column gap (the expanded rhythm)',
  /\.replay-main\s*\{[^}]*gap:\s*10px/s.test(cssE),
  'no .replay-main { gap: 10px } rule',
);
check(
  'the collapsed dock zeroes that gap WHEN THE FRAME IS PRESENT (flush frame → caption; the loading/error states keep their spacing)',
  /\.rp-keepalive-mini\s+\.replay-main:has\(>\s*\.replay-body\)\s*\{[^}]*gap:\s*0/s.test(cssE),
  'no .rp-keepalive-mini .replay-main:has(> .replay-body) { gap: 0 } rule',
);
check(
  'the caption styles its real play/pause control (the retired ▶ marker class is gone)',
  /\.rp-mini-toggle\s*\{/.test(cssE) && !/\.rp-mini-resume\s*\{/.test(cssE),
  'expected a .rp-mini-toggle rule and NO .rp-mini-resume rule',
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
