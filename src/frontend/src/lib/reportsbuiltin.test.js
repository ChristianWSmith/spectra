// The Reports and Explorer builtins: the pure export
// helpers, and the guard that no panel reads a retired preference (ruling 33).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

// reports/shared.js reads its helpers through builtinhelpers.js, which re-exports services.js: the
// bindings directory is stood in for (as services-cache.test.js does) and resolved through the hook.
installEsmDirHook();
const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { fmtVal, findTemplate, reportFilename, targetReady, mdCell, esc, appendixMd, appendixHtml, compositeText } = await import('./builtins/reports/shared.js');

const here = dirname(fileURLToPath(import.meta.url));

test('fmtVal shows a dash for a missing value and never a zero for NULL', () => {
  assert.equal(fmtVal(null), '—');
  assert.equal(fmtVal(undefined), '—');
  assert.equal(fmtVal(NaN), '—');
  assert.equal(fmtVal(0), '0');
  assert.equal(fmtVal(1.236), '1.24');
});

test('findTemplate returns the selected row or null', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(findTemplate(list, 'b'), { id: 'b' });
  assert.equal(findTemplate(list, 'z'), null);
  assert.equal(findTemplate(undefined, 'a'), null);
});

test('reportFilename slugs the title and names the target and extension', () => {
  const tpl = { title: 'Match Summary!', scope: 'match', format: 'html' };
  assert.equal(reportFilename(tpl, { matchId: 7, steamId: '', roundNo: 1 }), 'match-summary-match-7.html');
  const player = { title: 'Player card', scope: 'player', format: 'md' };
  assert.equal(reportFilename(player, { matchId: 7, steamId: '765', roundNo: 1 }), 'player-card-765.md');
  const round = { title: 'Round', scope: 'round', format: 'md' };
  assert.equal(reportFilename(round, { matchId: 7, steamId: '', roundNo: 3 }), 'round-round-3.md');
});

test('targetReady gates the save button on the template target', () => {
  assert.equal(targetReady(null, { matchId: 1, steamId: '', roundNo: 1 }), false);
  assert.equal(targetReady({ scope: 'player' }, { matchId: 1, steamId: '', roundNo: 1 }), false);
  assert.equal(targetReady({ scope: 'player' }, { matchId: 1, steamId: '765', roundNo: 1 }), true);
  assert.equal(targetReady({ scope: 'round' }, { matchId: 1, steamId: '', roundNo: 0 }), false);
  assert.equal(targetReady({ scope: 'match' }, { matchId: 0, steamId: '', roundNo: 1 }), false);
  assert.equal(targetReady({ scope: 'match' }, { matchId: 1, steamId: '', roundNo: 1 }), true);
});

test('mdCell and esc keep table cells and markup intact', () => {
  assert.equal(mdCell('a|b\nc'), 'a\\|b c');
  assert.equal(mdCell(null), '');
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

const ENTRIES = [
  {
    title: 'Kills',
    line: 'per player · 2 rows · match #7',
    hasTable: true,
    rows: [
      { id: '765', label: 'Alpha', value: 12 },
      { id: '766', label: 'Bravo', value: null },
    ],
  },
  { title: 'Top fragger', line: 'value not computed — behind', hasTable: false, rows: [] },
];

test('appendixMd writes one table per entry and a dash for a NULL value', () => {
  const md = appendixMd(ENTRIES);
  assert.ok(md.startsWith('\n\n## Stats appendix\n\n'));
  assert.ok(md.includes('| 765 | Alpha | 12 |'));
  assert.ok(md.includes('| 766 | Bravo | — |'));
  assert.ok(md.includes('### Top fragger\n\nvalue not computed — behind\n\n'));
  assert.equal(md.includes('| Group | Label | Value |', md.indexOf('Top fragger')), false);
});

test('appendixHtml escapes titles and labels', () => {
  const html = appendixHtml([{ title: '<b>x</b>', line: 'l', hasTable: true, rows: [{ id: 'i', label: '&', value: 1 }] }]);
  assert.ok(html.includes('<h3>&lt;b&gt;x&lt;/b&gt;</h3>'));
  assert.ok(html.includes('<td>&amp;</td>'));
});

test('compositeText is the body alone without entries, and body plus appendix with them', () => {
  assert.equal(compositeText('body', [], 'md'), 'body');
  assert.ok(compositeText('body', ENTRIES, 'md').startsWith('body\n\n## Stats appendix'));
  assert.ok(compositeText('<p>body</p>', ENTRIES, 'html').startsWith('<p>body</p><section class="rep-appendix-doc">'));
});

// The retired preferences (owner ruling 33): metric ordering, hiding, the
// overview and economy pins, and the transposed scoreboard. A panel of the
// Reports or Explorer builtin must not read any of them.
const RETIRED = [
  'metric_order_',
  'metric_hidden_',
  'metric_pins_overview',
  'metric_economy',
  'scoreboard_starts_transposed',
  'readOrder',
  'writeOrder',
  'readHidden',
  'readOverviewPins',
  'readEconomyPins',
  'readStartsTransposed',
  'ORDER_KEYS',
  'HIDDEN_KEYS',
  'STARTS_TRANSPOSED_KEY',
  'ECONOMY_KEY',
  'OVERVIEW_PINS_KEY',
];

function sourcesIn(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.svelte') || f.endsWith('.js'))
    .map((f) => [join(dir, f), readFileSync(join(dir, f), 'utf8')]);
}

test('no Reports panel reads a retired preference', () => {
  const files = [
    ...sourcesIn(join(here, 'builtins', 'reports')),
    [join(here, 'views', 'Reports.svelte'), readFileSync(join(here, 'views', 'Reports.svelte'), 'utf8')],
  ];
  const hits = [];
  for (const [file, src] of files) {
    for (const key of RETIRED) if (src.includes(key)) hits.push(`${file}: ${key}`);
  }
  assert.deepEqual(hits, []);
});
