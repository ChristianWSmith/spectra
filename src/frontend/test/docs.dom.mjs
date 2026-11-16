// jsdom driver for the documentation popup (the dismissable help
// sheet): App mounted with the app-dock machinery but Builder kept
// REAL, so ONE mount pins both entry points and the popup end-to-end.
// Section labels below match the run's console.log letters:
//   A. the sidebar Help icon — nav-chrome chrome between the spacer and
//      Settings, never active/aria-current across routes, the popup
//      opens at the guide top with the full TOC (26 sections since the
//      2026-11-14 content onboarding — Introduction leads) and no manual
//      switcher (only one manual ships), the near-fullscreen geometry
//      (centred backdrop with its uniform margin, panel = viewport −
//      2×16px, max-height none — pinned as computed styles from the
//      component's injected CSS), the header order (title … search
//      input … Close), and the Close button dismisses with focus
//      returned to the opener;
//   B. the Builder `?` — top-right of .view-header, opens the popup at
//      the metric-language section (aria-current + the composed anchor
//      + the scrollTop formula), with the Builder still mounted and the
//      hash untouched;
//   C. dismissal by Escape and by bare-backdrop click, each returning
//      focus to its opener (the Close-button leg is A's) — plus the
//      search input's Escape contract: a non-empty query is cleared
//      FIRST (the sheet stays open), the next Escape closes it;
//   D. TOC navigation AND the scroll-spy — a TOC click moves
//      aria-current and focuses the section, the spy re-derives
//      `current` from dispatched scroll events over an explicit
//      500px-per-section offsetTop model (manual scroll → .active +
//      aria-current, the threshold that holds the previous section,
//      goTo agreement after its scroll lands, the bottom-of-doc rule),
//      and a repeated openDocs (sidebar Help while open) re-targets
//      through the token;
//   E. the onboarding reality: NO guide section is a placeholder (every
//      one carries cited prose and none renders the coming-soon note);
//      the sources section re-pinned to its count-free opener and the
//      metric-language intro still renders real prose. (The placeholder
//      RENDER path itself is pinned in I, on the throwaway manual.)
//   F. accuracy pins from the manual AND from the newly written guide
//      sections (rendered text): the subject-anchor rule, metric()'s two
//      legal positions + denials, the sum(a + b) additive chain with
//      avg/min/max single-column, the denominator units — plus the
//      guide's originals-untouched promise (importing demos), the
//      honest dash (the Library) and the SQL console's read-only
//      construction, each cited to the 2026-11-14 draft appendix;
//   G. the header search — TOC-only filtering over title + rendered
//      text (case-insensitive), the body staying complete, the honest
//      no-match line straight from the strings catalog, clearing
//      restores the full TOC, the query being transient (no URL,
//      no storage), and the content-only needle marking the hit INSIDE
//      the body prose (every <mark> carrying the exact needle, the
//      marked paragraph's text byte-identical to the unmarked render,
//      the clear removing every body mark);
//   H. the two-tier contents list (N3/N4): the ONE subsection toggle on
//      the metric-language row (children visible by default, folding
//      opt-in, no toggle on a childless major), the dual highlight (the
//      current minor .active + aria-current, its major .parent-active,
//      aria-current on exactly one entry, a current MAJOR never wearing
//      the parent style), a query expanding a FOLDED chapter so its
//      match stays listed, the fold state surviving the query, and
//      <mark> hits in a TOC label AND a body section heading with the
//      text byte-identical (clearing removes every mark) — plus the
//      body-side tier styling (C4, 2026-11-15): the declared 1.5rem
//      major / 1.15rem minor heading sizes as rendered, the separator
//      rule's `:not(:first-child)` exemption, and the `parent` criterion
//      reaching the DOM (classes + the injected rule matching a
//      non-first major only, its 14px/12px gap computing there);
//   I. a throwaway second manual registered into the LIVE registry makes
//      the switcher appear on the next open, switching changes the TOC +
//      body, and its placeholder section still renders ONLY the
//      coming-soon note (run last so it cannot leak into earlier pins).
//
// Known jsdom limits (the standard caveats, stated where they bite):
// there is no layout, so section D drives the scroll-spy with explicit
// offsetTop expandos (500px per section) and DISPATCHES the scroll
// events jsdom never delivers itself — section B pins the scrollTop
// FORMULA against the natural zeros it sees at that point in the run.
// scrollIntoView is never used (undefined in jsdom) — goTo() is
// scrollTop-only by design. DocsPopup is compiled with css:'injected'
// so section A can pin the near-fullscreen geometry as computed styles
// (jsdom resolves the calc() against its viewport; there is no pixel
// layout beyond that). No external links (none ship).
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
// copied URL, which is what makes section I's live registration
// visible to the popup). DocsPopup alone compiles with css:'injected'
// — its :global() doc-back/doc-panel shape rules must reach
// document.head so section A can pin the near-fullscreen geometry as
// computed styles (the default compile drops component CSS).
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
  .replace("import '../docs/manuals/index.js';", `import '${libURL('docs/manuals/index.js')}';`)
  .replace("from '../strings/index.js'", `from '${libURL('strings/index.js')}'`);
compileSvelte(docsSrc, 'DocsPopup.svelte', localURL('docspopup.js'), { css: 'injected' });

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
  .replace("from './Dialog.svelte'", `from '${localURL('dialog.js')}'`)
  // plumbing (Strings Stage 3): the dialog imports the strings catalog —
  // through the COPIED lib tree, like every other ../ module here.
  .replace("from '../strings/index.js'", `from '${libURL('strings/index.js')}'`);
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
  .replace("from '../components/Popover.svelte'", `from '${localURL('popover.js')}'`)
  .replace("from '../strings/index.js'", `from '${libURL('strings/index.js')}'`);
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
const tocItems = () => [...document.querySelectorAll('.doc-toc-item')]; // section entries, both tiers (filtered by the header search; the fold toggles are separate buttons)
const tocCurrent = () => tocItems().find((b) => b.getAttribute('aria-current') === 'true');
const searchBox = () => document.querySelector('.doc-head input[type="search"]');
const emptyTocLine = () => document.querySelector('.doc-toc-empty');
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
// Near-fullscreen geometry (2026-11-14 sheet → sheet-on-margin change).
// DocsPopup compiles with css:'injected' in this driver, so jsdom
// resolves the shape rules — no pixel LAYOUT, but the declared geometry
// (centred, uniform margin, viewport − 2×16px, no modal cap) is
// pinnable as computed styles.
const backCS = getComputedStyle(backdrop());
check(
  'the backdrop centres the panel with a uniform 16px margin on every edge',
  backCS.justifyContent === 'center' &&
    backCS.alignItems === 'center' &&
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].every((p) => backCS[p] === '16px'),
  `justify=${backCS.justifyContent} align=${backCS.alignItems} padding=${backCS.padding}`,
);
const panelCS = getComputedStyle(panel());
check(
  'the panel fills the viewport minus 2×16px on both axes (the old modal cap is gone)',
  panelCS.width === `${window.innerWidth - 32}px` &&
    panelCS.height === `${window.innerHeight - 32}px` &&
    panelCS.maxHeight === 'none',
  `width=${panelCS.width} height=${panelCS.height} max-height=${panelCS.maxHeight} / viewport ${window.innerWidth}×${window.innerHeight}`,
);
check(
  // Re-pinned 2026-11-14 (user-manual content onboarding): 22 → 26
  // entries; the researched draft's Introduction now leads the guide.
  'the full TOC renders (26 section entries, the guide opens at its first section)',
  tocItems().length === 26 && tocCurrent()?.textContent.trim() === 'Introduction',
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
const headKids = () => [...(document.querySelector('.doc-head')?.children ?? [])];
check(
  'the header runs title … search input … Close (type=search with the catalog copy, Close last)',
  headKids().length === 3 &&
    headKids()[0]?.tagName === 'H1' &&
    headKids()[1] === searchBox() &&
    searchBox()?.getAttribute('type') === 'search' &&
    searchBox()?.getAttribute('placeholder') === 'Search sections' &&
    searchBox()?.getAttribute('aria-label') === 'Search sections' &&
    headKids()[2] === closeBtn(),
  headKids().map((c) => `${c.tagName}.${c.className}`).join(' → '),
);
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
// The search input's Escape contract (the one key DocsPopup
// intercepts): a non-empty query is cleared FIRST — stopPropagation
// keeps Dialog's backdrop handler from closing the sheet — and the
// NEXT Escape (empty input) closes through Dialog as always.
hb.focus();
click(hb);
await sleep();
searchBox().focus();
searchBox().value = 'sql';
searchBox().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await sleep();
searchBox().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
await sleep();
check(
  'Escape inside a NON-EMPTY search input clears the query first — the sheet stays open',
  searchBox()?.value === '' && !!panel() && !!backdrop(),
  `value=${JSON.stringify(searchBox()?.value)} panel=${!!panel()}`,
);
searchBox().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
await sleep();
check(
  'the next Escape (empty input) closes the sheet and returns focus to the opener',
  !panel() && !backdrop() && document.activeElement === hb,
  `${!!panel()} / ${document.activeElement?.getAttribute?.('title') || document.activeElement?.nodeName}`,
);

console.log('D. TOC navigation + scroll-spy: aria-current follows clicks AND manual scrolling, repeated openDocs re-targets');
hb.focus();
click(hb);
await sleep();
// jsdom has no layout (offsetTop reads 0): MODEL one — every section
// heading gets an explicit offsetTop expando, a uniform 500px-per-
// section layout, so both the scrollTop FORMULA (the −8 lead) and the
// scroll-spy's offsetTop math are observable. Section B ran before
// this, against the natural zeros.
const guideHeads = [...docBody().querySelectorAll('.doc-section > h2')];
guideHeads.forEach((h, i) =>
  Object.defineProperty(h, 'offsetTop', { value: i * 500, configurable: true }),
);
const headIdx = (id) => guideHeads.findIndex((h) => h.id === `doc-user-guide-${id}`);
// jsdom never delivers scroll events itself — dispatch what a real
// browser fires after a scroll (manual wheel or programmatic), then
// let Svelte flush the state → DOM update before the caller reads it.
const scrollSpy = async () => {
  docBody().dispatchEvent(new dom.window.Event('scroll'));
  await sleep();
};
const sourcesEl = headingEl('sources');
const srcIdx = headIdx('sources');
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
  'the body scrolled to the section offset minus the 8px lead (500px-per-section model)',
  docBody().scrollTop === srcIdx * 500 - 8,
  `scrollTop=${docBody().scrollTop} expected=${srcIdx * 500 - 8}`,
);
check('the hash never moved (TOC entries are buttons, never href="#…")', location.hash === '#/builder', location.hash);
// goTo agreement: the scroll event a browser fires once goTo's scroll
// lands must leave the spy on the clicked section — no flicker back.
await scrollSpy();
check(
  'after goTo’s scroll lands the spy still agrees with the clicked section',
  tocCurrent()?.textContent.trim() === 'Sources',
  tocCurrent()?.textContent.trim(),
);
// Manual scrolling: park the scroll top just PAST a section heading —
// that section becomes current, in .active AND aria-current.
const libIdx = headIdx('library');
docBody().scrollTop = libIdx * 500 + 40;
await scrollSpy();
check(
  'manual scroll: the section at the scroll top becomes current (.active + aria-current)',
  tocCurrent() === tocItems()[libIdx] &&
    tocItems()[libIdx].classList.contains('active') &&
    tocItems()[libIdx].getAttribute('aria-current') === 'true',
  `current=${tocCurrent()?.textContent.trim()} / expected=${guideHeads[libIdx].textContent.trim()}`,
);
// The threshold (SPY_THRESHOLD = 24px): the NEXT heading still sits
// 100px below the scroll top, so the highlight must NOT hand over yet
// (last-wins — the previous section keeps it).
docBody().scrollTop = (libIdx + 1) * 500 - 100;
await scrollSpy();
check(
  'a heading still below the threshold keeps the previous section current',
  tocCurrent()?.textContent.trim() === guideHeads[libIdx].textContent.trim(),
  tocCurrent()?.textContent.trim(),
);
// …and once it crosses the line the highlight follows it.
docBody().scrollTop = (libIdx + 1) * 500 + 40;
await scrollSpy();
check(
  'scrolling past the next heading hands the highlight over to it',
  tocCurrent()?.textContent.trim() === guideHeads[libIdx + 1].textContent.trim(),
  tocCurrent()?.textContent.trim(),
);
// Bottom of the document → the LAST section is current (its heading
// can sit further down than the threshold when the final section is
// taller than the viewport). The atBottom branch guards on
// scrollHeight > clientHeight, so jsdom's natural 0/0 never reads as
// "bottom" — here the driver models a scrollable body explicitly.
Object.defineProperty(docBody(), 'scrollHeight', { value: 20000, configurable: true });
Object.defineProperty(docBody(), 'clientHeight', { value: 800, configurable: true });
docBody().scrollTop = 19200;
await scrollSpy();
check(
  'bottom of the doc → the last section is current',
  tocCurrent() === tocItems()[tocItems().length - 1],
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
  tocCurrent()?.textContent.trim() === 'Introduction' && docBody().scrollTop === 0,
  `${tocCurrent()?.textContent.trim()} / scrollTop=${docBody().scrollTop}`,
);

console.log('E. every guide section is written — nothing ships as a placeholder (2026-11-14 re-pin)');
const soonNote = "Coming soon — this part of the guide isn't written yet.";
// The same copied-tree registry instance the popup renders (DocsPopup
// links this URL; section I registers into it below) — so E reads the
// guide's real section flags, not a second copy of the data.
const docsRegistry = await import(libURL('docs/registry.js'));
const guideDoc = docsRegistry.getDoc('user-guide');
check(
  'no guide section is a placeholder and every one carries blocks (the researched draft replaced them all)',
  guideDoc.sections.every((s) => !s.placeholder && s.blocks.length > 0),
  guideDoc.sections.filter((s) => s.placeholder).map((s) => s.id).join(', ') ||
    guideDoc.sections.filter((s) => !s.blocks.length).map((s) => s.id).join(', '),
);
check(
  'every section renders its own body and none shows the coming-soon note',
  guideDoc.sections.every((s) => {
    const el = sectionOf(s.id);
    return !!el && !normalized(el).includes(soonNote);
  }),
  guideDoc.sections.filter((s) => !sectionOf(s.id)).map((s) => s.id).join(', '),
);
const sourcesSec = sectionOf('sources');
check(
  // Re-pinned with the reconciliation edit (2026-11-14): the section's
  // opener went count-free ("Ten sources …" died with W1's 14 sources).
  'the sources section renders real prose (its count-free opener) and no placeholder note',
  normalized(sourcesSec).includes('Every source the language offers is listed below') &&
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

console.log('F. accuracy pins — rendered text from the manual AND the newly written guide sections');
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
// Guide-section accuracy pins (2026-11-14 content onboarding), each
// cited to the research draft's accuracy appendix: importing demos —
// originals untouched (`Library.svelte:1049-1072`, "Copy demos" copy);
// the Library — dashes never zeros (`Library.svelte:894-943`); the SQL
// console — read-only by construction (`SqlConsole.svelte:351-353`).
const importingText = normalized(sectionOf('importing-demos'));
check(
  'guide/importing demos: original files are never moved, modified or deleted',
  importingText.includes('never moved, modified or deleted'),
  importingText.slice(0, 100),
);
const libraryText = normalized(sectionOf('library'));
check(
  'guide/the Library: an unfinished row shows dashes — never a made-up 0',
  libraryText.includes('never a made-up 0'),
  libraryText.slice(0, 100),
);
const sqlText = normalized(sectionOf('sql-console'));
check(
  'guide/SQL console: read-only by construction — writes rejected before they run',
  sqlText.includes('read-only by construction') &&
    sqlText.includes('writes and multi-statement scripts are rejected before they run'),
  sqlText.slice(0, 100),
);

console.log('G. search: the header input filters the TOC (title + rendered text, case-insensitive) without touching the body');
const stringsCommon = (await import(libURL('strings/index.js'))).common;
const typeQuery = async (v) => {
  const el = searchBox();
  el.value = v;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep();
};
await typeQuery('INTRODUCTION');
check(
  'a title match filters the TOC — case-insensitively (uppercase query vs the mixed-case title)',
  tocItems().length === 1 && tocItems()[0].textContent.trim() === 'Introduction',
  tocItems().map((b) => b.textContent.trim()).join(', '),
);
check(
  'the filter is TOC-only: the body still renders every section while it is active',
  docBody().querySelectorAll('.doc-section').length === 26,
  docBody().querySelectorAll('.doc-section').length + ' body sections',
);
check(
  'the query is transient — the route did not move and nothing doc-shaped reached storage',
  location.hash === '#/builder' &&
    !Object.keys(dom.window.localStorage).some((k) => /doc|guide|search/i.test(k)),
  `${location.hash} / storage keys: ${Object.keys(dom.window.localStorage).join(',') || '(none)'}`,
);
// Body-prose marking (2026-11-15, manual-search): the SAME content-only
// needle now marks the hit inside the rendered body, not just the TOC.
// The paragraph is captured BEFORE the query goes in so the byte-identity
// pin compares the marked render against the unmarked one.
const importPara = [...sectionOf('importing-demos').querySelectorAll('p')].find((p) =>
  p.textContent.includes('never moved, modified or deleted'),
);
const importParaBefore = importPara ? importPara.textContent : null;
await typeQuery('never moved, modified or deleted');
check(
  'a phrase from RENDERED TEXT only (it is in no title) keeps its section in the TOC',
  tocItems().length === 1 && tocItems()[0].textContent.trim() === 'Importing demos',
  tocItems().map((b) => b.textContent.trim()).join(', '),
);
const bodyMarks = [...docBody().querySelectorAll('mark')];
check(
  'the content-only needle marks the hit inside the body prose — every <mark> carries the exact needle',
  bodyMarks.length > 0 &&
    bodyMarks.every((m) => m.textContent === 'never moved, modified or deleted') &&
    !!importPara &&
    importPara.querySelector('mark') !== null,
  `${bodyMarks.length} body marks / texts=${[...new Set(bodyMarks.map((m) => m.textContent))].join('|')}`,
);
check(
  'the marked paragraph’s textContent is byte-identical to the unmarked render (segments re-join)',
  !!importPara && importParaBefore !== null && importPara.textContent === importParaBefore,
  `${JSON.stringify(importParaBefore)} → ${JSON.stringify(importPara?.textContent)}`,
);
await typeQuery('');
check(
  'clearing the content query removes every <mark> from the body too',
  docBody().querySelectorAll('mark').length === 0,
  `${docBody().querySelectorAll('mark').length} body marks`,
);
await typeQuery('zz-no-section-can-match-this');
check(
  'no match → zero entries and the honest line straight from the strings catalog',
  tocItems().length === 0 &&
    !!emptyTocLine() &&
    emptyTocLine().textContent === stringsCommon.noSectionsMatch,
  `${tocItems().length} entries / line=${JSON.stringify(emptyTocLine()?.textContent)}`,
);
await typeQuery('');
check(
  'clearing the input restores the full TOC (26 entries, no empty-state line)',
  tocItems().length === 26 && !emptyTocLine(),
  `${tocItems().length} entries`,
);

console.log('H. two tiers: the subsection toggle, the dual highlight, <mark> search hits, and the body-side tier styling (sizes + separator)');
// The contents list is two tiers (N3): the metric chapter's minors are
// indented entries under their major, and ONLY a major that HAS
// children carries the fold toggle — children are visible by default
// (the full-TOC pins in A/G depend on it), folding is opt-in, and an
// active query overrides the fold so a match never hides.
const rowOf = (majorText) =>
  [...document.querySelectorAll('.doc-toc-row')].find(
    (r) => r.querySelector('.doc-toc-item')?.textContent.trim() === majorText,
  );
const toggleOf = (majorText) => rowOf(majorText)?.querySelector('.doc-toc-toggle') ?? null;
const minorEntries = () => [...document.querySelectorAll('.doc-toc-children .doc-toc-item')];
check(
  'the ONE subsection toggle sits on the metric-language row (expanded by default, catalog label) — no toggle on a childless major',
  document.querySelectorAll('.doc-toc-toggle').length === 1 &&
    minorEntries().length === 13 &&
    toggleOf('Metric language')?.getAttribute('aria-expanded') === 'true' &&
    toggleOf('Metric language')?.getAttribute('aria-label') === stringsCommon.collapseSubsections &&
    toggleOf('Introduction') === null,
  `${document.querySelectorAll('.doc-toc-toggle').length} toggles / ${minorEntries().length} minors / label=${toggleOf('Metric language')?.getAttribute('aria-label')}`,
);
click(toggleOf('Metric language'));
await sleep();
check(
  'folding the chapter hides its minors (13 entries remain) and flips aria-expanded to false',
  tocItems().length === 13 &&
    toggleOf('Metric language')?.getAttribute('aria-expanded') === 'false' &&
    document.querySelectorAll('.doc-toc-children').length === 0,
  `${tocItems().length} entries / children containers ${document.querySelectorAll('.doc-toc-children').length}`,
);
click(toggleOf('Metric language'));
await sleep();
check(
  'unfolding restores every entry (26) and aria-expanded back to true',
  tocItems().length === 26 && toggleOf('Metric language')?.getAttribute('aria-expanded') === 'true',
  `${tocItems().length} entries / aria-expanded=${toggleOf('Metric language')?.getAttribute('aria-expanded')}`,
);
click(tocItems().find((b) => b.textContent.trim() === 'Denominators'));
await sleep();
const denEntry = tocItems().find((b) => b.textContent.trim() === 'Denominators');
const mlEntry = tocItems().find((b) => b.textContent.trim() === 'Metric language');
check(
  'dual highlight: the current minor wears .active + aria-current, its major .parent-active — aria-current sits on exactly one entry (the true current)',
  !!denEntry &&
    denEntry.classList.contains('active') &&
    denEntry.getAttribute('aria-current') === 'true' &&
    !!mlEntry &&
    mlEntry.classList.contains('parent-active') &&
    !mlEntry.classList.contains('active') &&
    document.querySelectorAll('.doc-toc-item[aria-current]').length === 1,
  `${denEntry?.className} / ${mlEntry?.className} / aria-currents=${document.querySelectorAll('.doc-toc-item[aria-current]').length}`,
);
click(tocItems().find((b) => b.textContent.trim() === 'Settings'));
await sleep();
check(
  'a major that is ITSELF current wears .active and nothing wears .parent-active (the parent style only ever marks a containing chapter)',
  tocCurrent()?.textContent.trim() === 'Settings' &&
    document.querySelectorAll('.doc-toc-item.parent-active').length === 0 &&
    tocItems().find((b) => b.textContent.trim() === 'Settings')?.classList.contains('active'),
  `parent-active count ${document.querySelectorAll('.doc-toc-item.parent-active').length} / current=${tocCurrent()?.textContent.trim()}`,
);
click(toggleOf('Metric language')); // fold the chapter, then search into it
await sleep();
await typeQuery('denominators');
const denUnderQuery = tocItems().find((b) => b.textContent.trim() === 'Denominators');
check(
  'a query expands a FOLDED chapter: its matching minor stays listed, marked, beneath the visible major',
  !!denUnderQuery &&
    !!tocItems().find((b) => b.textContent.trim() === 'Metric language') &&
    !!denUnderQuery.querySelector('mark') &&
    denUnderQuery.querySelector('mark').textContent === 'Denominators',
  tocItems().map((b) => b.textContent.trim()).join(', '),
);
await typeQuery('');
check(
  'clearing the query keeps the user’s fold state (the chapter stays folded: 13 entries)',
  tocItems().length === 13,
  `${tocItems().length} entries`,
);
await typeQuery('INTRODUCTION');
const introEntry = tocItems()[0];
const introHeading = headingEl('introduction');
check(
  'search marks the hit in the TOC label AND the body section heading, the text byte-identical inside the <mark>',
  tocItems().length === 1 &&
    !!introEntry &&
    introEntry.textContent === 'Introduction' &&
    introEntry.querySelectorAll('mark').length === 1 &&
    introEntry.querySelector('mark').textContent === 'Introduction' &&
    !!introHeading &&
    introHeading.querySelectorAll('mark').length === 1 &&
    introHeading.querySelector('mark').textContent === 'Introduction',
  `toc=${JSON.stringify(introEntry?.textContent)} / heading marks=${introHeading?.querySelectorAll('mark').length}`,
);
await typeQuery('');
check(
  'clearing removes every <mark> from the TOC and the body',
  document.querySelectorAll('.doc-toc mark').length === 0 &&
    docBody().querySelectorAll('mark').length === 0,
  `toc marks ${document.querySelectorAll('.doc-toc mark').length} / body marks ${docBody().querySelectorAll('mark').length}`,
);
click(toggleOf('Metric language')); // unfold — leave the guide as section I found it
await sleep();

// --- Body-side tier styling (C4, 2026-11-15) ------------------------------
// The tier criterion (the registry's `parent` field: absent = major,
// set = minor) now reaches the BODY as .doc-section.major/.minor —
// global on that criterion, never scoped to one chapter. Three pins:
// both declared heading sizes with the rendered minor genuinely smaller
// (DocsPopup compiles css:'injected', so these computed styles are the
// real injected rules), the separator rule's first-section exemption as
// source text, and the criterion actually landing in the DOM.
// jsdom caveat on the applied leg: its cssstyle DROPS the whole
// `border-top` shorthand when the colour is a var() reference (probed
// 2026-11-15 — computed width resolves 0px / style none even though the
// rule is present and matches), so a border-width assertion there would
// fail for engine reasons, not ours. The applied leg therefore pins what
// jsdom can compute — the rule's 14px/12px gap on a non-first major
// only, which proves the rule cascades onto exactly the right elements —
// and discriminates the BORDER leg through the injected rule's own
// selectorText (matches the non-first major, rejects a minor and the
// first section) plus the declaration carried in its cssText. The colour
// is never asserted anywhere (jsdom cannot resolve var() colours).
const tierFirst = sectionOf(guideDoc.sections[0].id);
const tierMinor = sectionOf(guideDoc.sections.find((s) => s.parent)?.id);
const tierLaterMajor = sectionOf(
  guideDoc.sections.find((s, i) => !s.parent && i > 0)?.id,
);
const tierFs = (el) => parseFloat(getComputedStyle(el).fontSize);
const tierRootFs = parseFloat(getComputedStyle(document.documentElement).fontSize);
const tierRule = [...document.styleSheets]
  .flatMap((sheet) => {
    try {
      return [...sheet.cssRules];
    } catch {
      return []; // cross-origin rules are unreadable — none ship, but stay safe
    }
  })
  .find((r) => r.cssText?.includes('.doc-section.major'));
check(
  'tier heading sizes: the major rule declares 1.5rem (today’s rendered size) and the minor rule 1.15rem — rendered majors sit at 1.5rem, rendered minors at the smaller 1.15rem',
  /\.doc-body \.doc-section > h2\s*\{[^}]*font-size:\s*1\.5rem/.test(docsSrc) &&
    /\.doc-body \.doc-section\.minor > h2\s*\{[^}]*font-size:\s*1\.15rem/.test(docsSrc) &&
    tierFs(tierMinor.querySelector('h2')) === 1.15 * tierRootFs &&
    tierFs(tierLaterMajor.querySelector('h2')) === 1.5 * tierRootFs &&
    tierFs(tierFirst.querySelector('h2')) === tierFs(tierLaterMajor.querySelector('h2')),
  `root=${tierRootFs}px / rendered minor=${tierFs(tierMinor.querySelector('h2'))}px (want ${1.15 * tierRootFs}) major=${tierFs(tierLaterMajor.querySelector('h2'))}px (want ${1.5 * tierRootFs}) first=${tierFs(tierFirst.querySelector('h2'))}px`,
);
check(
  'the separator rule targets non-first majors ONLY (`:not(:first-child)`) and carries the 1px var(--divider) border-top with its margin/padding gap — separators stay CSS, never content',
  /\.doc-body \.doc-section\.major:not\(:first-child\)\s*\{[^}]*border-top:\s*1px solid var\(--divider\)[^}]*margin-top:\s*14px[^}]*padding-top:\s*12px/.test(
    docsSrc,
  ),
  docsSrc.match(/\.doc-section\.major:not\(:first-child\)[^}]*\}/)?.[0] ?? 'rule missing',
);
check(
  'the criterion reaches the DOM: the section classes come from `parent`, the injected rule matches a non-first major only, and its 14px/12px gap computes there — never on a minor or the first section',
  tierLaterMajor.classList.contains('major') &&
    tierMinor.classList.contains('minor') &&
    !tierMinor.classList.contains('major') &&
    tierFirst.classList.contains('major') &&
    !!tierRule &&
    tierRule.cssText.includes('border-top: 1px solid var(--divider)') &&
    tierLaterMajor.matches(tierRule.selectorText) &&
    !tierMinor.matches(tierRule.selectorText) &&
    !tierFirst.matches(tierRule.selectorText) &&
    getComputedStyle(tierLaterMajor).marginTop === '14px' &&
    getComputedStyle(tierLaterMajor).paddingTop === '12px' &&
    getComputedStyle(tierMinor).marginTop === '0px' &&
    getComputedStyle(tierFirst).marginTop === '0px',
  `classes major=${tierLaterMajor.className} minor=${tierMinor.className} / rule=${tierRule?.cssText ?? 'MISSING'} / gap major=${getComputedStyle(tierLaterMajor).marginTop}/${getComputedStyle(tierLaterMajor).paddingTop} minor=${getComputedStyle(tierMinor).marginTop} first=${getComputedStyle(tierFirst).marginTop}`,
);

console.log('I. a second manual makes the switcher appear (live registry, last section)');
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
// The placeholder RENDER path lives here since the 2026-11-14 content
// onboarding (the guide itself no longer ships a placeholder): the fixed
// note beside the title, and nothing else in the section.
const phSec = document
  .getElementById(registry.sectionAnchor('zz-second-manual', 'second'))
  ?.closest('section');
check(
  'a placeholder section renders ONLY its title and the fixed coming-soon note',
  !!phSec &&
    normalized(phSec).includes(soonNote) &&
    phSec.querySelectorAll('p').length === 1 &&
    phSec.querySelectorAll('pre, table, ul, ol').length === 0,
  phSec ? normalized(phSec) : 'no placeholder section element',
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
