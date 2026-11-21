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
import { PANEL_SOURCES, PANEL_DIRS } from './builtins/generated/sources.js';
import { BUILTIN_HELPERS } from './componentruntime/compile.js';
import { BUILTIN_COMPONENTS, builtinShippedSource } from './componentbuiltins.js';
import { guideSectionsBeforeManual, guideSectionsAfterManual } from './docs/manuals/user-guide-content.js';
import { generate, OUT_FILE, panelRegistry } from '../../scripts/gen-builtin-sources.mjs';

// (a) every builtin the Component builder lists passes the save gate.
test('(a) each listed builtin source compiles through the save gate', async () => {
  assert.ok(BUILTIN_COMPONENTS.length > 0);
  for (const b of BUILTIN_COMPONENTS) {
    const r = await gateComponentSave(b.source);
    assert.equal(r.ok, true, `${b.id}: ${refusalText(r)}`);
  }
});

// (a) every generated panel source compiles through the save gate under the
// built-in rules (ruling 45): its relative imports are curated helpers.
test('(a) each generated panel source compiles under the built-in rules', async () => {
  assert.equal(Object.keys(PANEL_SOURCES).length, 20, 'every compiled panel is embedded');
  for (const [id, src] of Object.entries(PANEL_SOURCES)) {
    const r = await checkComponentSource(src, 'Component.svelte', PANEL_DIRS[id]);
    assert.equal(r.ok, true, `${id}: ${r.message} (line ${r.line})`);
  }
});

// Every helper the built-in panels import is listed, and the built-in rules
// refuse a helper name the registry does not list (ruling 45).
test('(a) built-in imports are curated: an unlisted name or module is refused', async () => {
  const dir = 'src/lib/builtins/profile';
  const ok = await checkComponentSource(`<script>
  import { fmt1 } from '../../fmt.js';
  let { spectra } = $props();
</script>
<p>{fmt1(1)}</p>`, 'Component.svelte', dir);
  assert.equal(ok.ok, true, ok.message);
  const name = await checkComponentSource(`<script>
  import { saveMetric } from '../../services.js';
  let { spectra } = $props();
</script>
<p>x</p>`, 'Component.svelte', dir);
  assert.equal(name.ok, false);
  assert.equal(name.line, 2);
  assert.match(name.message, /cannot import saveMetric from/);
  const mod = await checkComponentSource(`<script>
  import { x } from '../../not-a-helper.js';
  let { spectra } = $props();
</script>
<p>x</p>`, 'Component.svelte', dir);
  assert.equal(mod.ok, false);
  assert.equal(mod.line, 2);
});

// A user component imports nothing: the built-in rules are not its rules.
test('(a) a user component cannot import a helper', async () => {
  const r = await checkComponentSource(`<script>
  import { fmt1 } from '../../fmt.js';
  let { spectra } = $props();
</script>
<p>{fmt1(1)}</p>`);
  assert.equal(r.ok, false);
  assert.equal(r.line, 2);
});

// The curated surface: every listed name is exported by its module (read from
// the module's source, since the modules themselves need the Wails bindings).
test('(a) every curated helper name is exported by its module', () => {
  for (const [key, h] of Object.entries(BUILTIN_HELPERS)) {
    if (key.startsWith('bindings/') || key.endsWith('.svelte')) continue;
    const text = readFileSync(new URL('../../' + key, import.meta.url), 'utf8');
    for (const name of Object.keys(h.names)) {
      if (name === '*' || name === 'default') continue;
      const exported = new RegExp(`export\\s+(const|let|function|async function|class)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`).test(text);
      assert.ok(exported, `${key} does not export ${name}`);
    }
  }
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
