// Component references come from the parsed Svelte AST, not text matching: a spectra.Child name and
// a spectra.metric name are tracked; a name that is not a string literal is refused with its line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'svelte/compiler';
import { componentRefs } from './compilecore.js';

test('reads Child names and metric names from the template and script', () => {
  const src = `<script>
  let { spectra } = $props();
  const k = spectra.metric('kills');
</script>
<spectra.Child name="leaf" />
<spectra.Child name={'other'} />
<p>{spectra.metric("deaths")} {spectra.metric('kills')}</p>`;
  const out = componentRefs(parse, src);
  assert.deepEqual(out.refs.components.sort(), ['leaf', 'other']);
  assert.deepEqual(out.refs.metrics.sort(), ['deaths', 'kills']);
});

test('a reference in a comment or string is not a reference', () => {
  const src = `<script>
  // spectra.metric('ghost')
  const s = "<spectra.Child name='ghost2' />";
</script>
<p>{s}</p>`;
  assert.deepEqual(componentRefs(parse, src).refs, { components: [], metrics: [], untracked: [] });
});

test('a Child name that is an expression is refused with its position', () => {
  const src = `<script>let { spectra, name } = $props();</script>\n<spectra.Child name={name} />`;
  const [u] = componentRefs(parse, src).refs.untracked;
  assert.equal(u.line, 2);
  assert.match(u.message, /spectra\.Child needs its name as a string/);
});

test('a metric name that is not a literal is refused', () => {
  const src = `<script>let { spectra, m } = $props();</script>\n{spectra.metric(m)}`;
  const [u] = componentRefs(parse, src).refs.untracked;
  assert.match(u.message, /spectra\.metric needs its name as a string/);
});
