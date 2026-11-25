// jsdom driver for the manual (DocsPopup over DocBlocks and the real Dialog). The current design is one
// flat section list in document order, a header search that marks matches in the body and steps through
// them, Escape that clears the query before it closes, and in-manual links that stay in the popup.
//
// Counts come from the registry, not from pins, so adding a section does not touch this file.
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --conditions browser test/docs.dom.mjs
// (must be run with frontend/ as the working directory)
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// svelte's package exports pick the SERVER build without the `browser` condition; the driver adds it.
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
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'NodeFilter',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'DOMParser',
]) {
  if (!(k in dom.window)) continue;
  try {
    globalThis[k] = dom.window[k];
  } catch {
    Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

// Uncaught errors end the run loudly: a stray rejection must not look like a clean pass.
let failures = 0;
const errors = [];
process.on('uncaughtException', (e) => {
  errors.push(e);
  process.exitCode = 1;
  console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  errors.push(e);
  process.exitCode = 1;
  console.error('REJECTION: ' + (e && e.stack ? e.stack : e));
});

// --- build: the lib tree is copied into the cache so the popup and the registry share one module instance.
const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'docs');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
cpSync('src/lib', join(dir, 'lib'), { recursive: true });

const compileTo = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};
const comp = (name) => join(dir, 'lib', 'components', name);
compileTo(readFileSync('src/lib/components/Dialog.svelte', 'utf8'), 'Dialog.svelte', comp('Dialog.js'));
compileTo(readFileSync('src/lib/components/DocBlocks.svelte', 'utf8'), 'DocBlocks.svelte', comp('DocBlocks.js'));
compileTo(
  readFileSync('src/lib/components/DocsPopup.svelte', 'utf8')
    .replace("from './Dialog.svelte'", "from './Dialog.js'")
    .replace("from './DocBlocks.svelte'", "from './DocBlocks.js'"),
  'DocsPopup.svelte',
  comp('DocsPopup.js'),
);
compileTo(readFileSync('test/docs.harness.svelte', 'utf8').replace("'./lib/components/DocsPopup.js'", `'${pathToFileURL(comp('DocsPopup.js')).href}'`), 'harness.svelte', join(dir, 'harness.js'));

const { mount, flushSync } = await import('svelte');
const registry = await import(pathToFileURL(join(dir, 'lib', 'docs', 'registry.js')).href);
const harness = await import(pathToFileURL(join(dir, 'harness.js')).href);

const docs = registry.listDocs();
const guide = registry.getDoc('user-guide');
const sections = guide.sections;
const target = document.createElement('div');
document.body.appendChild(target);
mount(harness.default, { target });

const sleep = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const settle = async () => {
  await sleep();
  flushSync();
  await sleep();
};
const check = (name, cond, detail = '') => {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
};
const $ = (sel) => [...document.querySelectorAll(sel)];
const q = (sel) => document.querySelector(sel);
const tocItems = () => $('.doc-toc-item');
const tocCurrent = () => document.querySelector('.doc-toc-item.active');
const body = () => q('.doc-body');
const searchBox = () => q('.doc-search');
const type = async (value) => {
  const box = searchBox();
  box.value = value;
  box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await settle();
};
const key = (el, k, shift = false) => {
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
};
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
// jsdom has no layout: each section heading sits 500px below the previous one.
const layoutHeadings = () =>
  $('.doc-section h2').forEach((h, i) => Object.defineProperty(h, 'offsetTop', { value: i * 500, configurable: true }));
const headingOf = (sectionId) => q('#' + registry.sectionAnchor(guide.id, sectionId));
const titleOf = (sectionId) => sections.find((s) => s.id === sectionId).title;

// A word that the guide's body text contains, so the search has real hits to mark.
const needle = (() => {
  for (const s of sections) {
    const m = (s.blocks || '').match(/\b[a-z]{6,}\b/i);
    if (m) return m[0].toLowerCase();
  }
  return '';
})();

console.log('A. the popup opens at the first section, with every section in the list');
globalThis.__set({ open: true, section: null, token: 0 });
await settle();
check('the sheet is open', !!q('.doc-panel'));
check('the header carries the guide title', q('.doc-head h1')?.textContent === guide.title, q('.doc-head h1')?.textContent);
check('one list entry per section', tocItems().length === sections.length, `${tocItems().length} vs ${sections.length}`);
check('one body section per section', $('.doc-section').length === sections.length);
check('the first section is current', tocCurrent()?.textContent === sections[0].title, tocCurrent()?.textContent);
check('the switcher shows only when there is more than one manual', !!q('.doc-switch') === (docs.length > 1));
layoutHeadings();

console.log('B. a list click scrolls its heading to the top and moves focus there');
const k = 3;
click(tocItems()[k]);
await settle();
check('the clicked entry is current', tocCurrent() === tocItems()[k], tocCurrent()?.textContent);
check('the body scrolled to that heading (offsetTop − 8)', body().scrollTop === k * 500 - 8, String(body().scrollTop));
check('focus moved to the heading', document.activeElement === headingOf(sections[k].id), document.activeElement?.tagName);

console.log('C. a requested section opens there, and a repeat request re-targets');
globalThis.__set({ section: sections[5].id, token: 1 });
await settle();
check('the requested section is current', tocCurrent()?.textContent === sections[5].title, tocCurrent()?.textContent);
globalThis.__set({ section: sections[2].id, token: 2 });
await settle();
check('a new token re-targets the same section list', tocCurrent()?.textContent === sections[2].title, tocCurrent()?.textContent);
globalThis.__set({ section: 'no-such-section', token: 3 });
await settle();
check('an unknown section goes to the top, the first section current', tocCurrent()?.textContent === sections[0].title && body().scrollTop === 0);

console.log('D. search marks the matches in the body without filtering the list');
check('a needle exists in the guide text', needle.length > 0, needle);
await type(needle);
const marks = $('.doc-body mark.doc-hit');
check('the search marks at least one body match', marks.length > 0, String(marks.length));
check('every mark is the needle', marks.every((m) => m.textContent.toLowerCase() === needle));
check('the list is not filtered', tocItems().length === sections.length, String(tocItems().length));
check('the find buttons are on', !q('.doc-find-btn')?.disabled);

console.log('E. Enter steps to the next match, Shift+Enter back, both wrap and scroll the body');
marks.forEach((m, i) => Object.defineProperty(m, 'offsetTop', { value: 300 + i * 30, configurable: true }));
const hits = $('.doc-body mark.doc-hit');
check('the first match is current as soon as the query is typed', hits[0]?.classList.contains('current'));
if (hits.length > 1) {
  key(searchBox(), 'Enter');
  await settle();
  check('Enter moves the current mark to the next match', hits[1].classList.contains('current') && !hits[0].classList.contains('current'));
  check('the body scrolled to the next match', body().scrollTop === 300 + 30 - 8, String(body().scrollTop));
  key(searchBox(), 'Enter', true);
  await settle();
  check('Shift+Enter steps back to the first match', hits[0].classList.contains('current'));
} else {
  console.log('  skip step checks: one match only');
}
check('the sheet stays open while stepping', !!q('.doc-panel'));

console.log('F. Escape clears a query first, and only an empty box lets it close the sheet');
const closedBefore = globalThis.__closed;
key(searchBox(), 'Escape');
await settle();
check('the first Escape clears the query', searchBox().value === '', JSON.stringify(searchBox().value));
check('the first Escape does not close the sheet', globalThis.__closed === closedBefore);
key(searchBox(), 'Escape');
await settle();
check('an empty box lets Escape close the sheet', globalThis.__closed > closedBefore, String(globalThis.__closed));

console.log('G. the Close button closes the sheet');
const beforeClose = globalThis.__closed;
click(q('.doc-head .btn:last-child'));
await settle();
check('Close calls onClose', globalThis.__closed > beforeClose);

console.log('H. an in-manual link stays in the popup and moves the list to its section');
globalThis.__set({ open: true, section: sections[0].id, token: 10 });
await settle();
layoutHeadings();
const inManual = $('.doc-body a.doc-link')[0];
check('the guide has an in-manual link', !!inManual);
if (inManual) {
  const dest = inManual.getAttribute('href').slice(1);
  const destSection = sections.find((s) => registry.sectionAnchor(guide.id, s.id) === dest || s.id === dest);
  const hashBefore = dom.window.location.hash;
  click(inManual);
  await settle();
  check('the link leaves the hash alone (the popup is the router)', dom.window.location.hash === hashBefore);
  check('the list moves to the linked section', !!destSection && tocCurrent()?.textContent === destSection.title, `${tocCurrent()?.textContent} vs ${destSection?.title}`);
}

console.log('I. external links open in a new tab, with no opener');
const external = $('.doc-body a[target="_blank"]')[0];
if (external) {
  check('external links carry rel="noopener noreferrer"', external.getAttribute('rel') === 'noopener noreferrer');
} else {
  // The renderer test (docsrender.test.js) pins the external-link attributes; this guide has none to click.
  console.log('  skip the guide has no external link to check here');
}

console.log(failures || errors.length ? `\n${failures} failure(s), ${errors.length} uncaught` : '\nall checks passed');
process.exitCode = failures || errors.length ? 1 : 0;
