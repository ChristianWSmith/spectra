// jsdom driver: mount the PayloadTree harness and assert the rendering
// contract (flat render, lazy branches, toggling, filtering, errors,
// scale). This is a component-level regression test for the payload
// browser's "loading hangs" bug — see the header of PayloadTree.svelte.
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --conditions browser test/payload-tree.dom.mjs
// (must be run with frontend/ as the working directory)
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
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLAnchorElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment',
  'DocumentFragment', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'CustomEvent', 'Event', 'KeyboardEvent',
  'MouseEvent', 'MutationObserver', 'DOMParser',
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

// Bundle PayloadTree (component + its pure helper module) into one JS file.
// The output must live under frontend/ so Node resolves `svelte` from its
// node_modules.
const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'payload-tree');
mkdirSync(dir, { recursive: true });
const treeSrc = readFileSync('src/lib/components/PayloadTree.svelte', 'utf8').replace(
  /import\s*\{[\s\S]*?\}\s*from\s*'\.\.\/payloadTree\.js';/,
  '',
);
const helpers = readFileSync('src/lib/payloadTree.js', 'utf8').replace(/export /g, '');
const treeCode = compile(treeSrc, { filename: 'PayloadTree.svelte', generate: 'client' })
  .js.code;
writeFileSync(join(dir, 'pt-bundle.js'), helpers + '\n' + treeCode);

const harnessPath = join(dir, 'harness.svelte');
const harnessSrc = readFileSync('test/payload-tree.harness.svelte', 'utf8');
writeFileSync(harnessPath, harnessSrc);
const harnessCode = compile(harnessSrc, {
  filename: 'harness.svelte',
  generate: 'client',
}).js.code;
const harnessOut = join(dir, 'harness.js');
writeFileSync(harnessOut, harnessCode);

const { mount } = await import('svelte');
const mod = await import(pathToFileURL(harnessOut).href);
const target = document.createElement('div');
document.body.appendChild(target);
mount(mod.default, { target });

const sleep = (ms = 25) => new Promise((r) => setTimeout(r, ms));
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
const texts = (sel) => $(sel).map((e) => e.textContent.trim());

console.log('A. flat payload (item_equip shape)');
globalThis.__set(
  JSON.stringify({
    canzoom: false,
    defindex: 0,
    hassilencer: true,
    item: 'hkp2000',
    userid: 9,
    weptype: 1,
  }),
  '',
  1,
);
await sleep();
check('6 kv rows', $('.kv-row').length === 6, 'got ' + $('.kv-row').length);
check('no details for flat payload', $('details').length === 0);

console.log('B. nested payload: root open, deeper collapsed (lazy)');
globalThis.__set(
  JSON.stringify({
    round: { score: 5, sub: { x: 1, y: 2 } },
    name: 'donk',
    flag: true,
  }),
  '',
  1,
);
await sleep();
check(
  '3 rows visible (score, name, flag)',
  $('.kv-row').length === 3,
  texts('.kv-key').join(','),
);
check('2 branches rendered (round, sub)', $('details').length === 2, String($('details').length));
check('depth-0 branch open', $('details')[0]?.open === true);
check('depth-1 branch closed', $('details')[1]?.open === false);
check(
  'grandchildren NOT in DOM (lazy)',
  !texts('.kv-key').includes('x') && !texts('.kv-key').includes('y'),
  texts('.kv-key').join(','),
);

console.log('C. toggle a collapsed branch → children mount');
const sub = $('details').find((d) => d.querySelector('.kv-key')?.textContent === 'sub');
check('found sub details', !!sub);
if (sub) {
  sub.open = true;
  sub.dispatchEvent(new dom.window.Event('toggle'));
  await sleep();
  check('children mounted after open', texts('.kv-key').includes('x'), texts('.kv-key').join(','));
  check(
    'both children present',
    texts('.kv-key').filter((t) => t === 'x' || t === 'y').length === 2,
  );
  sub.open = false;
  sub.dispatchEvent(new dom.window.Event('toggle'));
  await sleep();
  check(
    'children unmounted after close',
    !texts('.kv-key').includes('x'),
    texts('.kv-key').join(','),
  );
}

console.log('D. filter shows only matching keys + ancestors');
globalThis.__set(JSON.stringify({ round: { score: 5, sub: { x: 1 } }, name: 'donk' }), 'x', 1);
await sleep();
check('ancestor chain visible', texts('.kv-key').join(',') === 'round,sub', texts('.kv-key').join(','));
check(
  'non-matching siblings hidden',
  !texts('.kv-key').includes('score') && !texts('.kv-key').includes('name'),
);
globalThis.__set(JSON.stringify({ round: { score: 5 }, name: 'donk' }), 'zzz', 1);
await sleep();
check('no-match message shown', document.body.textContent.includes('No keys match'), '');
check('no rows for no-match query', $('.kv-row').length === 0 && $('details').length === 0);

console.log('E. unparseable payload');
globalThis.__set('{oops', '', 1);
await sleep();
check('error pre rendered', $('.expl-kv-err').length === 1, String($('.expl-kv-err').length));

console.log('F. scale: 100 nested payloads');
const nested = JSON.stringify({
  a: { b1: 1, b2: 'x', b3: { c1: 1, c2: 2, c3: 3 } },
  d: 4,
  e: 5,
  f: { g: { h: { i: 1 } } },
  j: 6,
  k: 7,
  l: 8,
});
const t0 = performance.now();
globalThis.__set(nested, '', 100);
await sleep(60);
const t1 = performance.now();
const nodes = document.querySelectorAll('.kv-row, details').length;
const t2 = performance.now();
globalThis.__set(nested, 'b');
await sleep(60);
const t3 = performance.now();
console.log(
  JSON.stringify({
    render100Ms: +(t1 - t0).toFixed(1),
    domNodes: nodes,
    keystrokeMs: +(t3 - t2).toFixed(1),
  }),
);
check('100 instances render their root level', nodes >= 800, String(nodes));

console.log('G. original crash probe: bare {node(...)} is gone');
const explorer = readFileSync('src/lib/views/Explorer.svelte', 'utf8');
const tree = readFileSync('src/lib/components/PayloadTree.svelte', 'utf8');
// Ignore comment lines — the component's header comment documents the bug.
const codeOnly = (s) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
check('Explorer has no bare snippet calls', !/\{node\(/.test(codeOnly(explorer)));
check('PayloadTree has no bare snippet calls', !/\{node\(/.test(codeOnly(tree)));
check('PayloadTree invokes snippets with {@render', tree.includes('{@render node('));

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
