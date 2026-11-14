// jsdom driver for the documentation popup (the dismissable help
// side-sheet): App mounted with the app-dock machinery but Builder kept
// REAL, so ONE mount pins both entry points and the popup end-to-end.
// Section labels below match the run's console.log letters:
//   A. the sidebar Help icon — nav-chrome chrome between the spacer and
//      Settings, never active/aria-current across routes, the popup
//      opens at the guide top with the full TOC and no manual switcher
//      (only one manual ships), and the Close button dismisses with
//      focus returned to the opener;
//   B. the Builder `?` — top-right of .view-header, opens the popup at
//      the metric-language section (aria-current + the composed anchor
//      + the scrollTop formula), with the Builder still mounted and the
//      hash untouched;
//   C. dismissal by Escape and by bare-backdrop click, each returning
//      focus to its opener (the Close-button leg is A's);
//   D. TOC navigation — aria-current moves, the section takes focus,
//      Back to top resets scroll + current, and a repeated openDocs
//      (sidebar Help while open) re-targets through the token;
//   E. placeholders render ONLY the fixed "coming soon" note; the
//      metric-language sections render real prose and no note;
//   F. accuracy pins from the manual (rendered text): the subject-anchor
//      rule, metric()'s two legal positions + denials, the sum(a + b)
//      additive chain with avg/min/max single-column, the denominator
//      units;
//   G. a throwaway second manual registered into the LIVE registry makes
//      the switcher appear on the next open, and switching changes the
//      TOC + body (run last so it cannot leak into earlier pins).
//
// Known jsdom limits (the standard caveats, stated where they bite):
// there is no layout, so section offsetTop reads 0 — section D pins the
// scrollTop FORMULA with an explicit offsetTop expando instead of a
// pixel position, and section B pins the formula's consistency plus the
// aria-current target. scrollIntoView is never used (undefined in
// jsdom) — goTo() is scrollTop-only by design. No geometry, no scroll
// spy, no external links (none ship).
//
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it. From frontend/ run:
//   node --test test/docs.dom.mjs
// (must be run with frontend/ as the working directory)
import { registerHooks } from 'node:module';

const { JSDOM } = await import('jsdom');
const { compile } = await import('svelte/compiler');
const { readFileSync, writeFileSync, mkdirSync, readdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');

// Same redirection as app-dock.dom.mjs: svelte resolves to the browser
// build (mount() throws on the server build), the generated bindings
// and the event bus resolve through the shared test stubs.
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
  'localStorage',
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

// Inert stand-ins (nothing in this driver's stub graph draws or fetches).
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
const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'docs');
mkdirSync(join(dir, 'lib', 'views'), { recursive: true });
mkdirSync(join(dir, 'lib', 'components'), { recursive: true });

// The REAL pure layer (the whole src/lib .js tree — this automatically
// carries lib/docs/*.js + lib/docs/manuals/*.js with their relative
// layout intact, so the registry/manuals the popup links are the SAME
// instances the checks below import).
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

const fileURL = (p) => pathToFileURL(p).href;
const libURL = (rel) => fileURL(join(dir, 'lib', rel)); // the copied tree
const localURL = (rel) => fileURL(join(dir, rel)); // local component bundles

// Stub views/components — everything EXCEPT Builder (kept real) and
// DocsPopup (kept real). Inert markup; App's own blanket
// `./lib/(views|components)/*.svelte → .js` rewrite resolves here.
const compileSvelte = (src, filename, out, opts = {}) => {
  // `out` may be a plain path (stubs, leaf bundles) or a file:// URL
  // (the shared localURL() bundles) — writeFileSync takes a URL OBJECT.
  const dest = String(out).startsWith('file:') ? new URL(out) : out;
  writeFileSync(dest, compile(src, { filename, generate: 'client', ...opts }).js.code);
};
const writeStub = (rel, src) => {
  const sveltePath = join(dir, rel);
  writeFileSync(sveltePath, src);
  compileSvelte(src, rel, sveltePath.replace(/\.svelte$/, '.js'), { runes: true });
};
for (const name of [
  'Library', 'Match', 'RoundDetail', 'Settings', 'SqlConsole', 'Explorer',
  'Reports', 'Profiles', 'PlayerProfile', 'CompareRounds',
]) {
  writeStub(
    `lib/views/${name}.svelte`,
    `<script>
  let { nav = () => {}, ...rest } = $props();
</script>
<div class="stub-view stub-${name}" />
`,
  );
}
writeStub(
  'lib/views/Replay.svelte',
  `<script>
  let { id = 0, query = {}, nav = () => {}, active = true, onClose = null } = $props();
</script>
<div class="stub-replay" data-id={String(id)} data-active={String(active)} />
`,
);
writeStub(
  'lib/components/CommandPalette.svelte',
  `<script>
  let { nav = () => {} } = $props();
</script>
<div class="stub-palette" />
`,
);
writeStub(
  'lib/components/MapPackPrompt.svelte',
  `<script>
  export const maybePrompt = () => {};
</script>
<div class="stub-mappackprompt" />
`,
);

// --- The REAL components ----------------------------------------------------
// Dialog is a leaf; DocBlocks is a leaf; DocsPopup links Dialog +
// DocBlocks locally and the docs layer through the COPIED tree (one
// module instance each — the registry the checks import is this same
// copied URL, which is what makes section G's live registration
// visible to the popup).
compileSvelte(
  readFileSync('src/lib/components/Dialog.svelte', 'utf8'),
  'Dialog.svelte',
  localURL('dialog.js'),
);
compileSvelte(
  readFileSync('src/lib/components/DocBlocks.svelte', 'utf8'),
  'DocBlocks.svelte',
  localURL('docblocks.js'),
);
const docsSrc = readFileSync('src/lib/components/DocsPopup.svelte', 'utf8')
  .replace("from './Dialog.svelte'", `from '${localURL('dialog.js')}'`)
  .replace("from './DocBlocks.svelte'", `from '${localURL('docblocks.js')}'`)
  .replace("from '../docs/registry.js'", `from '${libURL('docs/registry.js')}'`)
  .replace("from '../docs/markdown.js'", `from '${libURL('docs/markdown.js')}'`)
  .replace("from '../docs/manuals/index.js'", `from '${libURL('docs/manuals/index.js')}'`)
  .replace("import '../docs/manuals/index.js';", `import '${libURL('docs/manuals/index.js')}';`);
compileSvelte(docsSrc, 'DocsPopup.svelte', localURL('docspopup.js'));

// Builder + its component deps — the compile discipline of
// builder.dom.mjs: components to local bundles, plain-ESM lib imports
// to the SAME copied URLs App resolves (one instance each).
compileSvelte(
  readFileSync('src/lib/components/StatusChip.svelte', 'utf8'),
  'StatusChip.svelte',
  localURL('statuschip.js'),
);
const plSrc = readFileSync('src/lib/components/ProfileLink.svelte', 'utf8')
  .replace("from '../nav.js'", `from '${libURL('nav.js')}'`)
  .replace("from '../services.js'", `from '${libURL('services.js')}'`);
compileSvelte(plSrc, 'ProfileLink.svelte', localURL('profilelink.js'));
const moSrc = readFileSync('src/lib/components/MetricOrderDialog.svelte', 'utf8')
  .replace("from '../services.js'", `from '${libURL('services.js')}'`)
  .replace("from '../metricorder.js'", `from '${libURL('metricorder.js')}'`)
  .replace("from './Dialog.svelte'", `from '${localURL('dialog.js')}'`);
compileSvelte(moSrc, 'MetricOrderDialog.svelte', localURL('metricorderdialog.js'));
compileSvelte(
  readFileSync('src/lib/components/Popover.svelte', 'utf8'),
  'Popover.svelte',
  localURL('popover.js'),
);
const bldSrc = readFileSync('src/lib/views/Builder.svelte', 'utf8')
  .replace("from '../services.js'", `from '${libURL('services.js')}'`)
  .replace("from '../metricorder.js'", `from '${libURL('metricorder.js')}'`)
  .replace("from '../metricformats.js'", `from '${libURL('metricformats.js')}'`)
  .replace("from '../fmt.js'", `from '${libURL('fmt.js')}'`)
  .replace("from '../metricstate.js'", `from '${libURL('metricstate.js')}'`)
  .replace("from '../viewstate.svelte.js'", `from '${libURL('viewstate.svelte.js')}'`)
  .replace("from '../components/ProfileLink.svelte'", `from '${localURL('profilelink.js')}'`)
  .replace("from '../components/StatusChip.svelte'", `from '${localURL('statuschip.js')}'`)
  .replace("from '../components/MetricOrderDialog.svelte'", `from '${localURL('metricorderdialog.js')}'`)
  .replace("from '../components/Popover.svelte'", `from '${localURL('popover.js')}'`);
compileSvelte(bldSrc, 'Builder.svelte', localURL('builder-bundle.js'));

// App.svelte: the blanket stub rewrite, then point the two REAL
// components at their local bundles (the stub tree has no
// DocsPopup.js and deliberately no Builder.js).
const appSrc = readFileSync('src/App.svelte', 'utf8')
  .replace(/from '(\.\/lib\/(?:views|components)\/\w+)\.svelte'/g, "from '$1.js'")
  .replace("from './lib/views/Builder.js'", `from '${localURL('builder-bundle.js')}'`)
  .replace("from './lib/components/DocsPopup.js'", `from '${localURL('docspopup.js')}'`);
compileSvelte(appSrc, 'App.svelte', localURL('App.js'));

// --- Scripted backend (the shared bindings stub) ----------------------------
const bindings = await import(pathToFileURL(join('test', 'stubs', 'bindings.mjs')).href);
// The four the design scripts, plus the reads Builder's mount fires
// around them — empty/safe values so no chip, row or error is ever
// fabricated from a null reply.
bindings.MetricsService.ListMetrics = () => Promise.resolve([]);
bindings.handlers.ListMetricsPage = () => ({ rows: [], hasNext: false });
bindings.PlatformService.ListPlugins = () => Promise.resolve([]);
bindings.handlers.ValidateExpr = () => [true, {}];
bindings.handlers.GetMetricComputeState = () => [];
bindings.handlers.ListMatches = () => [];
bindings.handlers.ListPlayers = () => [];
bindings.handlers.GetMetric = () => null;
bindings.handlers.CompileMetric = () => 'select 1';

// --- Mount ------------------------------------------------------------------
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
const key = (el, k) =>
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const go = async (hash) => {
  location.hash = hash;
  await sleep();
};
const helpBtn = () =>
  [...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.getAttribute('title') === 'Help');
const panel = () => document.querySelector('.dlg-panel.doc-panel');
const backdrop = () => document.querySelector('.dlg-back.doc-back');
const docBody = () => document.querySelector('.doc-body');
const tocItems = () => [...document.querySelectorAll('.doc-toc-item')]; // section entries (Back to top is .doc-toc-top)
const tocCurrent = () => tocItems().find((b) => b.getAttribute('aria-current') === 'true');
// The id rides the section's <h2> (registry.sectionAnchor): headingEl is
// that heading (the goTo focus/offsetTop target), sectionOf is the
// <section> wrapper that holds its heading + body.
const headingEl = (id) => document.getElementById(`doc-user-guide-${id}`);
const sectionOf = (id) => headingEl(id)?.closest('section') ?? null;
const normalized = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

// Compile/link/mount failure below would otherwise be swallowed by the
// uncaughtException handler and exit 0 — fail loudly instead.
try {
  const mod = await import(localURL('App.js'));
  const target = document.createElement('div');
  document.body.appendChild(target);
  mount(mod.default, { target });
} catch (e) {
  console.error('APP MOUNT FAILED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
}
await sleep(); // onMount: the hashchange listener is registered

console.log("A. sidebar Help: nav chrome above Settings, opens the guide at the top, Close returns focus");
const hb = helpBtn();
check(
  'the Help button wears nav-item chrome with the Help labels and the question glyph',
  !!hb &&
    hb.classList.contains('nav-item') &&
    hb.getAttribute('title') === 'Help' &&
    hb.getAttribute('aria-label') === 'Help' &&
    !!hb.querySelector('.codicon-question'),
  hb ? hb.outerHTML.slice(0, 120) : 'no Help button',
);
const spacer = document.querySelector('.sidebar .spacer');
check(
  'it sits directly after the spacer and directly before the Settings gear',
  !!spacer && spacer.nextElementSibling === hb && hb.nextElementSibling?.getAttribute('title') === 'Settings',
  `${spacer?.nextElementSibling?.className} / ${hb?.nextElementSibling?.getAttribute('title')}`,
);
check(
  'it announces the popup (aria-haspopup=dialog, aria-expanded=false while closed)',
  hb?.getAttribute('aria-haspopup') === 'dialog' && hb?.getAttribute('aria-expanded') === 'false',
  `${hb?.getAttribute('aria-haspopup')} / ${hb?.getAttribute('aria-expanded')}`,
);
for (const hash of ['#/library', '#/builder', '#/settings']) {
  await go(hash);
  check(
    `never active and never aria-current on ${hash} (a button, not a tab)`,
    !hb.classList.contains('active') && !hb.hasAttribute('aria-current'),
    `${hb.className} / aria-current=${hb.getAttribute('aria-current')}`,
  );
}
hb.focus();
click(hb);
await sleep();
check(
  'opens the side-sheet: the variant backdrop + panel, dialog role and aria-modal',
  !!backdrop() && backdrop().classList.contains('doc-back') &&
    !!panel() && panel().classList.contains('doc-panel') &&
    panel().getAttribute('role') === 'dialog' && panel().getAttribute('aria-modal') === 'true',
  `${backdrop()?.className} / ${panel()?.className}`,
);
check(
  'the panel is labelled with the document title (h1 + aria-label = "Spectra guide")',
  normalized(document.querySelector('.doc-head h1')) === 'Spectra guide' &&
    panel()?.getAttribute('aria-label') === 'Spectra guide',
  `${document.querySelector('.doc-head h1')?.textContent} / ${panel()?.getAttribute('aria-label')}`,
);
check(
  'the full TOC renders (22 section entries, the guide opens at its first section)',
  tocItems().length === 22 && tocCurrent()?.textContent.trim() === 'Getting started',
  `${tocItems().length} entries / current=${tocCurrent()?.textContent.trim()}`,
);
check(
  'only one manual ships → no doc switcher yet (the listDocs().length > 1 condition)',
  !document.querySelector('.doc-switch'),
  document.querySelector('.doc-switch') ? 'switcher present' : '',
);
check(
  'the trigger reads expanded and the route did not move',
  hb.getAttribute('aria-expanded') === 'true' && location.hash === '#/settings',
  `${hb.getAttribute('aria-expanded')} / ${location.hash}`,
);
const closeBtn = () => document.querySelector('.doc-head button[aria-label="Close help"]');
click(closeBtn());
await sleep();
check('the Close button dismisses the sheet', !panel() && !backdrop(), panel() ? 'panel still up' : '');
check(
  'focus returned to the Help opener',
  document.activeElement === hb,
  document.activeElement?.getAttribute?.('title') || document.activeElement?.nodeName,
);

console.log("B. Builder ?: header top-right, opens AT the metric-language section, nothing behind changes");
await go('#/builder');
const viewHeader = document.querySelector('.view.bld-view .view-header');
const qBtn = viewHeader?.querySelector('button[aria-label="Metric language help"]');
check(
  'the ? button is the header’s last element (right of the spacer) with the end-user labels + glyph',
  !!qBtn && viewHeader.lastElementChild === qBtn &&
    qBtn.getAttribute('title') === 'Metric language help' &&
    !!qBtn.querySelector('.codicon-question'),
  viewHeader ? [...viewHeader.children].map((c) => c.className || c.tagName).join(',') : 'no header',
);
qBtn.focus();
click(qBtn);
await sleep();
check('the popup opens from Builder', !!panel() && !!backdrop(), panel() ? '' : 'no panel');
check(
  'the metric-language TOC entry is the current one (aria-current)',
  tocCurrent()?.textContent.trim() === 'Metric language',
  tocCurrent()?.textContent.trim(),
);
const target = headingEl('metric-language');
check(
  'the composed anchor exists and the body scrolled by the goTo formula (offsetTop − 8)',
  !!target && docBody()?.scrollTop === Math.max(0, target.offsetTop - 8),
  `target=${!!target} scrollTop=${docBody()?.scrollTop} offsetTop=${target?.offsetTop}`,
);
check(
  'the Builder stayed mounted behind the sheet (no route change, no remount)',
  !!document.querySelector('.view.bld-view') && location.hash === '#/builder',
  `${!!document.querySelector('.view.bld-view')} / ${location.hash}`,
);

console.log("C. dismissal: Escape on the panel and a bare-backdrop click, each returning focus to its opener");
key(panel(), 'Escape');
await sleep();
check('Escape on the panel dismisses it', !panel() && !backdrop(), panel() ? 'panel still up' : '');
check(
  'focus returned to the Builder ? opener',
  document.activeElement === qBtn,
  document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.nodeName,
);
hb.focus();
click(hb);
await sleep();
check('reopened from the sidebar for the backdrop leg', !!panel(), 'no panel');
click(backdrop());
await sleep();
check('a click on the bare backdrop dismisses it', !panel() && !backdrop(), panel() ? 'panel still up' : '');
check(
  'focus returned to the Help opener',
  document.activeElement === hb,
  document.activeElement?.getAttribute?.('title') || document.activeElement?.nodeName,
);

console.log('D. TOC navigation: aria-current moves, sections take focus, Back to top + repeated openDocs re-target');
hb.focus();
click(hb);
await sleep();
// jsdom has no layout (offsetTop is always 0): pin the scrollTop FORMULA
// with an explicit offsetTop so the −8 lead is observable for real.
const sourcesEl = headingEl('sources');
Object.defineProperty(sourcesEl, 'offsetTop', { value: 500, configurable: true });
const sourcesToc = tocItems().find((b) => b.textContent.trim() === 'Sources');
click(sourcesToc);
await sleep();
check(
  'clicking a TOC entry moves aria-current to that section',
  tocCurrent()?.textContent.trim() === 'Sources',
  tocCurrent()?.textContent.trim(),
);
check(
  'the section heading receives focus (tabindex -1 target)',
  document.activeElement === sourcesEl,
  document.activeElement?.id || document.activeElement?.nodeName,
);
check(
  'the body scrolled to the section offset minus the 8px lead',
  docBody().scrollTop === 492,
  `scrollTop=${docBody().scrollTop}`,
);
check('the hash never moved (TOC entries are buttons, never href="#…")', location.hash === '#/builder', location.hash);
docBody().scrollTop = 42;
click(document.querySelector('.doc-toc-top'));
await sleep();
check('Back to top resets the scroll', docBody().scrollTop === 0, `scrollTop=${docBody().scrollTop}`);
check(
  'Back to top returns current to the first section',
  tocCurrent()?.textContent.trim() === 'Getting started',
  tocCurrent()?.textContent.trim(),
);
// The token leg: re-requesting a target while already open re-runs the
// popup's effect (openDocs bumps docsToken even for an identical
// section — value-keyed effects alone would not re-run).
click(tocItems().find((b) => b.textContent.trim() === 'Settings'));
await sleep();
docBody().scrollTop = 42;
click(hb); // sidebar Help while the sheet is up (keyboard-reachable; no focus trap by design)
await sleep();
check(
  'a repeated openDocs re-targets to the guide top even while open (token)',
  tocCurrent()?.textContent.trim() === 'Getting started' && docBody().scrollTop === 0,
  `${tocCurrent()?.textContent.trim()} / scrollTop=${docBody().scrollTop}`,
);

console.log('E. placeholders are placeholders; the metric chapter is real prose');
const soonNote = "Coming soon — this part of the guide isn't written yet.";
const soonEl = sectionOf('getting-started');
check(
  'a placeholder section renders ONLY its title and the fixed coming-soon note',
  normalized(soonEl).includes(soonNote) &&
    soonEl.querySelectorAll('p').length === 1 &&
    soonEl.querySelectorAll('pre, table, ul, ol').length === 0,
  normalized(soonEl),
);
const sourcesSec = sectionOf('sources');
check(
  'the sources section renders real prose and no placeholder note',
  normalized(sourcesSec).includes('Ten sources are available') &&
    !normalized(sourcesSec).includes('Coming soon'),
  normalized(sourcesSec).slice(0, 80),
);
const introSec = sectionOf('metric-language');
check(
  'the metric-language intro (the Builder ? target) renders real prose and no note',
  normalized(introSec).includes('A metric is one number for one player') &&
    !normalized(introSec).includes('Coming soon'),
  normalized(introSec).slice(0, 80),
);

console.log('F. accuracy pins — rendered text from the engine-verified manual');
const bodyText = normalized(docBody());
check(
  'subject-anchor rule: a round source may not lead, with the verbatim refusal',
  bodyText.includes('expression is not player-anchored') &&
    bodyText.includes('primary source "rounds" has no player subject'),
  bodyText.slice(0, 0),
);
check(
  "metric(): exactly two legal positions, denied inside sum() and inside a condition",
  bodyText.includes('Exactly two positions') &&
    bodyText.includes('metric() is a value reference — it cannot appear inside sum()') &&
    bodyText.includes('cannot appear in a condition or filter'),
  '',
);
check(
  'the sum(a + b) additive chain, with avg/min/max staying single-column',
  bodyText.includes('only sum(a + b) may add columns') &&
    bodyText.includes('avg() takes a single column — only sum() accepts an additive column expression'),
  '',
);
check(
  'denominators are exactly rounds/matches counted in the units of the scope',
  bodyText.includes('exactly two choices, rounds and matches') &&
    bodyText.includes('the denominator always counts the units of the scope'),
  '',
);

console.log('G. a second manual makes the switcher appear (live registry, last section)');
click(closeBtn());
await sleep();
const registry = await import(libURL('docs/registry.js'));
registry.registerDoc({
  id: 'zz-second-manual',
  title: 'ZZ second manual',
  sections: [
    { id: 'first', title: 'First section', blocks: 'Hello from the second manual.' },
    { id: 'second', title: 'Second section', placeholder: true },
  ],
});
hb.focus();
click(hb);
await sleep();
check(
  'the switcher appears once listDocs() holds two manuals',
  !!document.querySelector('.doc-switch') &&
    document.querySelectorAll('.doc-switch button').length === 2,
  document.querySelectorAll('.doc-switch button').length + ' switch buttons',
);
click([...document.querySelectorAll('.doc-switch button')].find((b) => b.textContent.trim() === 'ZZ second manual'));
await sleep();
check(
  'switching swaps the TOC to the other manual’s sections',
  tocItems().length === 2 && tocItems()[0].textContent.trim() === 'First section',
  tocItems().map((b) => b.textContent.trim()).join(', '),
);
check(
  'and its body renders that manual’s content',
  normalized(docBody()).includes('Hello from the second manual.'),
  normalized(docBody()).slice(0, 80),
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
