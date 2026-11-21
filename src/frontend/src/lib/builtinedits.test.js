// builtinedits.test.js — editing builtins in place, restore to default and
// "use as my view" (owner ruling 43; dogfood/PLAN C5f). The pure checks:
//   (a) the generated source of each builtin is checked by the save gate;
//   (c) an edited builtin that fails the gate is refused with its line;
//   (f) the user guide describes editing, restore and use as my view.
// The render checks (b), (d), (e) are in test/builtin-edits.dom.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkComponentSource } from './componentruntime/compile.js';
import { gateComponentSave, refusalText } from './componentruntime/savegate.js';
import { parseProps, placedEntries } from './componentruntime/placementrows.js';
import { PANEL_SOURCES } from './builtins/generated/sources.js';
import { BUILTIN_COMPONENTS, builtinShippedSource } from './componentbuiltins.js';
import { guideSectionsBeforeManual, guideSectionsAfterManual } from './docs/manuals/user-guide-content.js';
import { generate, OUT_FILE, panelRegistry } from '../../scripts/gen-builtin-sources.mjs';

// The compiled panels whose shipped source imports a helper module or a
// sibling (services.js, strings, shared.js). A user component imports
// nothing (compile.js refuses it at its line), so these panels' generated
// source is refused by the gate today. Owner decision pending: rewrite each to
// a self-contained user-language source (spectra.Child for children, helpers
// inlined), or keep them compiled and not editable. Pinned here so a change
// to this set is deliberate.
const PANELS_BLOCKED_BY_IMPORTS = [
  'builtin-explorer-diagnostics',
  'builtin-explorer-provenance',
  'builtin-explorer-reference',
  'builtin-match-heatmap',
  'builtin-match-combat-clutches',
  'builtin-match-combat-engagements',
  'builtin-match-tabs',
  'builtin-profile-career',
  'builtin-profile-history',
  'builtin-profile-maps',
  'builtin-profile-sides',
  'builtin-profile-trend',
  'builtin-profile-weapons',
  'builtin-reports',
  'builtin-reports-appendix',
  'builtin-reports-templates',
];

// (a) every builtin the Component builder lists passes the save gate.
test('(a) each listed builtin source compiles through the save gate', async () => {
  assert.ok(BUILTIN_COMPONENTS.length > 0);
  for (const b of BUILTIN_COMPONENTS) {
    const r = await gateComponentSave(b.source);
    assert.equal(r.ok, true, `${b.id}: ${refusalText(r)}`);
  }
});

// (a) every generated panel source compiles, except the pinned import set,
// and each of those is refused with its import line (not a silent failure).
test('(a) each generated panel source compiles, or is refused for its import', async () => {
  const refused = [];
  for (const [id, src] of Object.entries(PANEL_SOURCES)) {
    const r = await checkComponentSource(src);
    if (!r.ok) {
      refused.push(id);
      assert.match(r.message, /^Components cannot import /, `${id}: ${r.message}`);
      assert.ok(r.line > 0, `${id} refusal has no line`);
    }
  }
  assert.deepEqual(refused.sort(), [...PANELS_BLOCKED_BY_IMPORTS].sort());
  assert.equal(Object.keys(PANEL_SOURCES).length, 20, 'every compiled panel is embedded');
});

test('(a) the builtin shipped source is the text the build embedded', () => {
  for (const b of BUILTIN_COMPONENTS) assert.equal(builtinShippedSource(b.id), b.source);
  for (const id of Object.keys(PANEL_SOURCES)) assert.equal(builtinShippedSource(id), PANEL_SOURCES[id]);
  assert.equal(builtinShippedSource('builtin-no-such-thing'), null);
});

// The generator writes the module the app imports: the file on disk is the
// generator's output, and the registry maps every panel to a real .svelte file.
test('the generated module is the generator output', () => {
  assert.equal(readFileSync(OUT_FILE, 'utf8'), generate(), 'run npm run build (regenerates sources.js)');
  const reg = panelRegistry(readFileSync(new URL('./builtins/panels.js', import.meta.url), 'utf8'));
  assert.equal(reg.length, 20);
  for (const { id, file } of reg) assert.ok(file.endsWith('.svelte') && id.startsWith('builtin-'), id);
});

// (c) an edited builtin that fails the save gate is refused with its line.
test('(c) an edit that fails the save gate is refused with its line', async () => {
  const broken = '<script>\n  let x = ;\n</script>\n<p>{x}</p>';
  const r = await gateComponentSave(broken);
  assert.equal(r.ok, false);
  assert.equal(r.line, 2);
  assert.match(refusalText(r), /^Line 2: /);
  // Legacy syntax is refused at its own line too (runes-only).
  const legacy = await gateComponentSave('<script>\n  export let x = 1;\n</script>\n<p>{x}</p>');
  assert.equal(legacy.ok, false);
  assert.equal(legacy.line, 2);
});

// The placement rows a surface mounts: stored order, hidden rows out, props
// read as an object, a malformed props value read as none.
test('placements: rows mount in order, hidden rows are not mounted', () => {
  const entries = placedEntries([
    { component: 'builtin-match-rounds', props: '{"compact":true}', hidden: false },
    { component: 'ghost', props: '', hidden: true },
    { component: 'builtin-match-overview', props: 'not json', hidden: false },
  ]);
  assert.deepEqual(
    entries.map((e) => [e.component, e.props]),
    [
      ['builtin-match-rounds', { compact: true }],
      ['builtin-match-overview', {}],
    ],
  );
  assert.deepEqual(placedEntries([]), []);
  assert.deepEqual(parseProps('[1]'), {});
});

// (f) the guide describes editing a builtin, restore to default and use as
// my view, in the user's words (no table or component-id terms).
test('(f) the guide describes editing, restore to default and use as my view', () => {
  const all = [...guideSectionsBeforeManual, ...guideSectionsAfterManual];
  const section = all.find((s) => s.id === 'component-builder');
  assert.ok(section, 'the Component builder guide section exists');
  const text = section.blocks;
  assert.match(text, /Restore to default/);
  assert.match(text, /Use as my view/);
  assert.match(text, /Reset to default/);
  assert.match(text, /edit/i);
  for (const term of ['layout_placements', 'builtin_overrides', 'components table', 'surface_', 'builtin-']) {
    assert.ok(!text.includes(term), `the guide must not name ${term}`);
  }
});

// (f) for C5h (owner ruling 44): the guide describes editing a builtin report,
// editing a builtin metric, and restore to default, in the user's domain.
test('C5h (f): the guide describes editing a builtin report and metric, and restore to default', () => {
  const all = [...guideSectionsBeforeManual, ...guideSectionsAfterManual];
  const metric = all.find((s) => s.id === 'metric-builder');
  const report = all.find((s) => s.id === 'reports-builder');
  assert.ok(metric && report, 'the metric and report builder guide sections exist');
  assert.match(metric.blocks, /Built-in metrics are edited in place/);
  assert.match(metric.blocks, /\*\*Expression\*\*/);
  assert.match(metric.blocks, /\*\*Restore to default\*\*/);
  assert.match(report.blocks, /Built-in templates are edited in place/);
  assert.match(report.blocks, /\*\*Template body\*\*/);
  assert.match(report.blocks, /\*\*Restore to default\*\*/);
  // The copy stays in the user's domain: no table, column or storage terms
  // in the built-in edit paragraphs.
  const paragraph = (text, lead) => {
    const start = text.indexOf(lead);
    return text.slice(start, text.indexOf('\n\n', start));
  };
  const edits = [
    paragraph(metric.blocks, 'Built-in metrics are edited in place'),
    paragraph(report.blocks, 'Built-in templates are edited in place'),
  ];
  for (const text of edits) {
    for (const term of ['table', 'column', 'override', 'builtin_overrides', 'SQL']) {
      assert.ok(!text.includes(term), `the built-in edit copy must not name ${term}`);
    }
  }
});
