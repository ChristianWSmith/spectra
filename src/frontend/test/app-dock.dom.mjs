import './compile-worker-node.mjs';
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
// Section F — the displaced-view overlay (App's derived viewRoute): the
// view beneath the expanded replay stays MOUNTED + inert, minimize
// hands it back with NO remount (the section's THE pin), close tears
// down only the overlay/instance, back-absent entries keep today's
// nothing-beneath behavior, and the overlay/collapsed CSS rules are
// source-pinned (jsdom has no layout AND does not reflect el.inert to
// an attribute, so the IDL property + the rules are the observables).
// Section G — the Match sidebar tab (L4, 2026-11-16): the session memory
// (App's lastMatchHash) resolves the tab's click back to the FULL
// remembered hash — path AND query — and style.css's disabled/hover
// rules are source-pinned (jsdom has no layout and never applies :hover).
// The BOOT leg of the same feature (the tab disabled while no match has
// been opened — the one moment the memory is empty) is pinned right
// after the mount, before section A.
// Section I — the floating background-work indicator (owner 2026-11-17):
// App's .wk-pill over lib/workstate.svelte.js — job-progress brings the
// pill up with its determinate chip point, the ✕ hides the INDICATOR
// while the job keeps running (same-source updates never re-show a
// dismissed pill), a NEW source does re-show it, the last job-done hides
// only after the settle window (resetting dismissal so the next run
// shows fresh), a held failure opens the pill with the failed chip and
// is never settled away (the ✕ dismisses it), and style.css's fixed
// bottom-right + z-45 ladder are source-pinned (jsdom has no layout —
// the rules are the pin).
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
  'Library', 'Match', 'Settings', 'Builder', 'SqlConsole', 'Explorer',
  'Reports', 'ReportsBuilder', 'ComponentBuilder', 'Profiles', 'PlayerProfile',
]) {
  // Per-view MOUNT counter (section F): the displaced-view overlay's
  // THE pin is that an expand → minimize round trip does NOT remount
  // the view beneath the overlay — the counter is the observable (it
  // survives unmounts; it counts construction, not presence).
  writeStub(
    `lib/views/${name}.svelte`,
    `<script>
  globalThis.__viewMounts = globalThis.__viewMounts || {};
  globalThis.__viewMounts['${name}'] = (globalThis.__viewMounts['${name}'] || 0) + 1;
</script>
<div class="stub-view stub-${name}" />
`,
  );
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
// DocsPopup — App mounts it unconditionally with the transient
// open/section/token/onClose props (this driver stubs every overlay;
// the popup's own contract lives in test/docs.dom.mjs). Without this
// stub App's blanket `./lib/components/*.svelte → .js` rewrite would
// point at a bundle this cache never writes and the mount would fail.
writeStub(
  'lib/components/DocsPopup.svelte',
  `<script>
  let { open = false, section = null, token = 0, onClose = () => {} } = $props();
</script>
{#if open}<div class="stub-docspopup" data-section={section ?? ''} />{/if}
`,
);

// App.svelte → its ./lib/**/*.svelte imports resolve to the stubs above
// (rewritten to .js like every other harness); everything else (svelte,
// the bindings, the real pure lib files) resolves through the hooks /
// the copied tree. StatusChip is the ONE real component App links now —
// the floating background-work indicator renders it inline (a leaf, no
// imports → local bundle, exactly builder.dom.mjs's discipline), written
// where the blanket rewrite points (lib/components/StatusChip.js).
compileSvelte(
  readFileSync('src/lib/components/StatusChip.svelte', 'utf8'),
  'StatusChip.svelte',
  join(dir, 'lib', 'components', 'StatusChip.js'),
);
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
const viewHost = () => document.querySelector('.app-views');
const viewMounts = (name) => (globalThis.__viewMounts || {})[name] || 0;

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

// L4 (R2, 2026-11-16): the Match sidebar tab's session memory — pinned at
// BOOT, the ONE moment the memory is still empty (once a match has been
// opened this session it never empties again; the empty/invalid legs of
// isNavEnabled are pure-unit pins in nav.test.js). The tab explains its
// disabled state in the tooltip (strings/common.js navMatchDisabled).
const navBtn = (label) =>
  [...document.querySelectorAll('.sidebar .nav-item')].find(
    (b) => b.getAttribute('aria-label') === label,
  );
{
  const match = navBtn('Match');
  const lib = navBtn('Library');
  check(
    'boot on the Library: the Match tab is DISABLED with its why-tooltip',
    match?.disabled === true && match?.getAttribute('title') === 'Open a match first',
    `${match?.disabled} / ${match?.getAttribute('title')}`,
  );
  check(
    'boot on the Library: the Library tab beside it is enabled',
    lib?.disabled === false,
    `disabled=${lib?.disabled}`,
  );
  check(
    'boot on the Library: the Profiles tab is enabled too (its memory policy is fallback — the directory is always a target)',
    navBtn('Profiles')?.disabled === false,
    `disabled=${navBtn('Profiles')?.disabled}`,
  );
}

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

// --- (F): the displaced-view overlay ---------------------------------------
// Option A: expanding the dock over a ?back= origin must NOT destroy the
// view beneath — it stays MOUNTED under .rp-keepalive-cover and inert
// (App's derived viewRoute), minimize hands it back with NO remount (THE
// pin), close tears down only the overlay/instance, and a back-absent
// entry keeps today's nothing-beneath behavior (minimize mounts fresh).
// jsdom has no layout AND does not implement inert's attribute
// reflection (el.inert = true is an expando there), so the IDL property
// — which both WebView targets reflect onto the attribute — is the
// observable, and the CSS rules are the source pins (section D/E
// precedent: the rule's APPLICATION is what is pinned, never pixels).
console.log('F. displaced-view overlay: the preserved view stays mounted + inert; minimize never remounts');
const host = viewHost();
check('the chain host exists (a persistent wrapper — never remounted)', !!host, host ? '' : 'no .app-views');
// The kept match and profile stay mounted in .app-views (inert while the
// overlay is up, never under .rp-keepalive): the overlay covers no view.
check(
  'back-absent entry: NO view is mounted under the overlay (kept views sit inert in .app-views)',
  !document.querySelector('.rp-keepalive .stub-view'),
  document.querySelector('.rp-keepalive .stub-view') ? 'a view stub is under the overlay' : '',
);
check(
  'back-absent entry: the empty host is still inert while the overlay is up',
  host?.inert === true,
  `host.inert=${host?.inert}`,
);

// back-absent minimize falls back to goBack's /match/:id. The match view is
// kept mounted, so the same match is reused — never remounted.
const mSameMatch = viewMounts('Match');
await go('#/match/1');
check(
  'back-absent minimize reuses the kept match view (no remount)',
  viewMounts('Match') === mSameMatch,
  `Match mounts ${mSameMatch} → ${viewMounts('Match')}`,
);
check('inert is gone once the overlay is down', viewHost()?.inert !== true, `host.inert=${viewHost()?.inert}`);
check('the route landed on the match view', location.hash === '#/match/1', location.hash);

// THE round trip: expand over ?back= → the SAME Match instance is
// preserved beneath (expand never remounts it) and the host goes inert.
const mKept = viewMounts('Match');
wrapper()?.blur(); // make the focus pin meaningful (focus was parked on the dock)
await sleep();
click(wrapper());
await sleep();
check('expanded: the hash carries the back origin', location.hash.startsWith('#/replay/1?back='), location.hash);
check(
  'expanded: the displaced match view is still MOUNTED beneath the overlay',
  !!document.querySelector('.stub-view.stub-Match'),
  document.querySelector('.stub-view.stub-Match') ? '' : 'underlying unmounted',
);
check(
  'expanded: expand did NOT remount the underlying view (same instance)',
  viewMounts('Match') === mKept,
  `Match mounts ${mKept} → ${viewMounts('Match')}`,
);
check('expanded: the host is inert under the overlay', viewHost()?.inert === true, `host.inert=${viewHost()?.inert}`);
check(
  'expanded: focus landed on the overlay container (tabindex -1)',
  document.activeElement === wrapper(),
  `activeElement=${document.activeElement?.className || document.activeElement?.nodeName}`,
);

// THE pin: minimize (goBack's exact destination — '/' + back, the very
// string viewRoute parsed at expand) → same branch, same props → the
// displaced instance BECOMES the live view: no remount, inert off.
await go('#/match/1');
check(
  'MINIMIZE: the underlying view did NOT remount (THE pin)',
  viewMounts('Match') === mKept,
  `Match mounts ${mKept} → ${viewMounts('Match')}`,
);
check('minimize: inert is gone', viewHost()?.inert !== true, `host.inert=${viewHost()?.inert}`);
check('minimize: the route is the back origin', location.hash === '#/match/1', location.hash);
check(
  'minimize: the instance collapsed into the dock (mini class, no overlay class)',
  wrapper()?.classList.contains('rp-keepalive-mini') && !wrapper()?.classList.contains('rp-keepalive-cover'),
  wrapper() ? wrapper().className : 'no wrapper',
);

// Close: the real order is Replay's Close = goBack FIRST (exit half) then
// the onClose teardown — by teardown time the underlying view is already
// the live route, so alive=null tears down ONLY the overlay/instance.
click(wrapper());
await sleep();
check('re-expanded for the close leg', location.hash.startsWith('#/replay/1?back='), location.hash);
check(
  're-expand again preserved the same underlying instance',
  viewMounts('Match') === mKept,
  `Match mounts ${mKept} → ${viewMounts('Match')}`,
);
await go('#/match/1'); // Close's exit half (goBack)
const mBeforeClose = viewMounts('Match');
globalThis.__replayClose(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep();
check(
  'close: the overlay/instance is torn down (wrapper + stub gone)',
  !wrapper() && !stubReplay(),
  `${wrapper() ? 'wrapper' : ''} ${stubReplay() ? 'stub' : ''}`.trim() || 'gone',
);
check(
  'close: the underlying view survived untouched (no remount, already live)',
  viewMounts('Match') === mBeforeClose && !!document.querySelector('.stub-view.stub-Match'),
  `Match mounts ${mBeforeClose} → ${viewMounts('Match')}, mounted=${!!document.querySelector('.stub-view.stub-Match')}`,
);
check('close: the route stays on the match view', location.hash === '#/match/1', location.hash);

// CSS source pins (jsdom has no layout — the RULES are the pins): the
// overlay rule exists with its fixed content-area geometry, and the
// collapsed dock rule keeps its own fixed panel (the wrapper gained a
// class; no existing rule was repurposed — sections A–E stay green).
const cssF = readFileSync('public/style.css', 'utf8');
check(
  'style.css: the overlay rule is position:fixed with the content-area numbers (left 52px = sidebar, padding 16/20 = .content)',
  /\.rp-keepalive\.rp-keepalive-cover\s*\{[^}]*position:\s*fixed[^}]*left:\s*52px[^}]*padding:\s*16px 20px/s.test(cssF),
  'no .rp-keepalive.rp-keepalive-cover { position:fixed; left:52px; padding:16px 20px } rule',
);
check(
  'style.css: the collapsed dock rule is still its own fixed 320px panel (untouched)',
  /\.rp-keepalive\.rp-keepalive-mini\s*\{[^}]*position:\s*fixed[^}]*width:\s*320px/s.test(cssF),
  'the .rp-keepalive.rp-keepalive-mini fixed panel rule changed',
);
check(
  'style.css: the base rule is still display:contents (the ACTIVE in-flow state survived)',
  /\.rp-keepalive\s*\{\s*display:\s*contents/s.test(cssF),
  'no .rp-keepalive { display: contents } rule',
);

console.log('G. the Match sidebar tab (L4): the session memory resolves the click, and the disabled state is styled');
// The remembered target is the FULL hash — tab AND query, so the return
// trip lands exactly where the user left off.
await go('#/match/5/scoreboard?roundFrom=3&roundTo=7');
const matchTab = navBtn('Match');
check(
  'on a match route the Match tab is enabled and lit',
  matchTab?.disabled === false && matchTab?.classList.contains('active'),
  `${matchTab?.disabled} / ${matchTab?.className}`,
);
await go('#/profiles');
check(
  'away from the match the tab stays ENABLED (the session memory holds) and only Profiles lights up',
  navBtn('Match')?.disabled === false && !navBtn('Match')?.classList.contains('active') &&
    navBtn('Profiles')?.classList.contains('active'),
  `${navBtn('Match')?.disabled} / ${navBtn('Match')?.className} / ${navBtn('Profiles')?.className}`,
);
click(navBtn('Match'));
await sleep();
check(
  'clicking it returns to the remembered FULL hash (tab + query, via resolveNavTarget)',
  location.hash === '#/match/5/scoreboard?roundFrom=3&roundTo=7',
  location.hash,
);
// jsdom has no layout and never applies :hover, so the RULES are the pins
// (the .rp-keepalive-close precedent in section D): a disabled action is
// greyed, and its hover wash is neutralized — WebKit matches :hover on a
// disabled button, hence the :not(:disabled) on the hover rule.
check(
  'style.css: a disabled nav item is greyed (muted, no pointer) after the active rule',
  /\.nav-item:disabled\s*\{[^}]*background:\s*none[^}]*color:\s*var\(--muted\)[^}]*cursor:\s*default/s.test(cssF),
  'no .nav-item:disabled { background:none; color:var(--muted); cursor:default } rule',
);
check(
  'style.css: the nav hover wash is neutralized for a disabled item',
  /\.nav-item:hover:not\(:disabled\)/.test(cssF),
  'no .nav-item:hover:not(:disabled) rule',
);

console.log('H. the Profiles sidebar tab (N7): the session memory remembers the last place in the tab');
// Enter the family with a full hash (path + query), leave it, then the
// click must return to that exact hash through the SAME resolveNavTarget
// the rail and the palette share.
await go('#/player/76561198012345678?back=match/5/scoreboard');
await go('#/library');
click(navBtn('Profiles'));
await sleep();
check(
  'clicking Profiles away from the family returns to the remembered FULL hash (the player page + its query)',
  location.hash === '#/player/76561198012345678?back=match/5/scoreboard',
  location.hash,
);

console.log('I. the floating background-work indicator (workstate → App .wk-pill)');
// The SAME module instances App links: workstate from the copied tree,
// the event bus through the driver's @wailsio/runtime stub (fire()).
const work = await import(pathToFileURL(join(dir, 'lib', 'workstate.svelte.js')).href);
const { fire } = await import(pathToFileURL(join('test', 'stubs', 'wails-runtime.mjs')).href);
const cssI = readFileSync('public/style.css', 'utf8');
const pill = () => document.querySelector('.wk-pill');

work.resetWorkState();
await sleep();
check('no pill while nothing is running', !pill());

fire('spectra:job-progress', { jobId: 901, stage: 'parse', progress: 0.42 });
await sleep();
check('a job starting brings the pill up', !!pill());
check(
  'the chip carries the job’s determinate point',
  (pill()?.querySelector('.chip-pct')?.textContent || '').includes('42%'),
  pill()?.textContent || '',
);
check(
  'the pill carries its short catalog label',
  (pill()?.querySelector('.wk-label')?.textContent || '') === 'Background work',
  pill()?.textContent || '',
);

// The ✕ hides the INDICATOR while the job keeps running (Q1).
const dismissBtn = pill()?.querySelector('.wk-dismiss');
check(
  'the icon-only ✕ carries its catalog aria-label + title',
  !!dismissBtn &&
    dismissBtn.getAttribute('aria-label') === 'Hide indicator' &&
    dismissBtn.getAttribute('title') === 'Hide the indicator — background work keeps running',
);
click(dismissBtn);
await sleep();
check('the ✕ hides the pill while the job is live', !pill());
fire('spectra:job-progress', { jobId: 901, stage: 'parse', progress: 0.7 });
await sleep();
check('same-source progress never re-shows a dismissed pill', !pill());

// A NEW source starting re-shows it (Q3).
fire('spectra:metric-progress', { metricId: 'wk1', stage: 'compute', done: 2, total: 4 });
await sleep();
check('a NEW source re-shows the dismissed pill', !!pill());

fire('spectra:metric-done');
await sleep();
check('the pill stays while the job is still live', !!pill());
fire('spectra:job-done', { jobId: 901 });
await sleep();
check('all work done → still up inside the settle window', !!pill());
await sleep(500);
check('settle window elapsed → hidden', !pill());
fire('spectra:job-progress', { jobId: 902, stage: 'hash', progress: 0 });
await sleep();
check('the next run shows fresh (dismissal reset at hide)', !!pill());
fire('spectra:job-done', { jobId: 902 });
await sleep(500);

// A held failure (Q2): the failed chip + message, never settled away.
work.reportWorkError('icons: VPK unreadable.');
await sleep();
check(
  'a failure opens the pill with the failed chip + the message',
  !!pill() &&
    !!pill()?.querySelector('.chip.status.bad') &&
    (pill()?.querySelector('.wk-error')?.textContent || '') === 'icons: VPK unreadable.',
  pill()?.textContent || '',
);
await sleep(500);
check('the failure is never hidden by the settle window', !!pill());
click(pill()?.querySelector('.wk-dismiss'));
await sleep();
check('the ✕ dismisses the held failure', !pill());

// Positioning + the z ladder — the RULES are the pin (jsdom has no
// layout): fixed at the window's bottom-right corner (right 26 /
// bottom 26) with the CONDITIONAL raise to bottom 264 while an
// occupant (.rp-keepalive / .cmp-float) holds that corner — w30,
// 2026-11-17 — and 45 between the keep-alive cover (40) and the probe
// HUD (50).
check(
  'style.css: the pill sits at the window corner (fixed right 26px / bottom 26px / z-index 45) and raises to bottom 264px while .rp-keepalive or .cmp-float holds the corner',
  /\.wk-pill\s*\{[^}]*position:\s*fixed[^}]*right:\s*26px[^}]*bottom:\s*26px[^}]*z-index:\s*45/s.test(cssI) &&
    /\.shell:has\(\.rp-keepalive\)\s+\.wk-pill,\s*\.shell:has\(\.cmp-float\)\s+\.wk-pill\s*\{\s*bottom:\s*264px;\s*\}/s.test(
      cssI,
    ),
  'no corner-default .wk-pill rule or conditional 264px raise rule',
);
check(
  'style.css: the ladder keeps cover 40 < pill 45 < probe HUD 50 < dialogs 60',
  /\.rp-keepalive\.rp-keepalive-cover\s*\{[^}]*z-index:\s*40/s.test(cssI) &&
    /\.probe-hud\s*\{[^}]*z-index:\s*50/s.test(cssI) &&
    /\.dlg-back\s*\{[^}]*z-index:\s*60/s.test(cssI),
  'cover/probe/dialog z-index literals moved',
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
