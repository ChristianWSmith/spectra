// Registry pins for the docs content model (lib/docs/registry.js —
// design §7.1.2): validation throws, order, anchor stability and the
// shipped user guide's section shape. Importing the manuals is the same
// side-effect import the popup uses. Run from frontend/:
//   node --test src/lib/docsregistry.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDoc, getDoc, listDocs, sectionAnchor } from './docs/registry.js';
import './docs/manuals/index.js'; // registers the shipped user guide

const doc = (id, sections) => ({
  id,
  title: `Title of ${id}`,
  sections: sections || [{ id: 'one', title: 'One' }],
});

test('registerDoc rejects malformed documents (throws on every violation)', () => {
  assert.throws(() => registerDoc(null), /document object/);
  assert.throws(() => registerDoc({ id: 'Not Kebab!', title: 'x', sections: [{ id: 'a', title: 'A' }] }), /kebab/);
  assert.throws(() => registerDoc({ id: 'OK-Caps', title: 'x', sections: [{ id: 'a', title: 'A' }] }), /kebab/);
  assert.throws(() => registerDoc({ id: 'no-title', sections: [{ id: 'a', title: 'A' }] }), /title/);
  assert.throws(() => registerDoc({ id: 'empty', title: 'x', sections: [] }), /at least one section/);
  assert.throws(
    () => registerDoc({ id: 'bad-sec', title: 'x', sections: [{ id: 'Not Kebab', title: 'A' }] }),
    /section id must be kebab-case/,
  );
  assert.throws(
    () => registerDoc({ id: 'sec-no-title', title: 'x', sections: [{ id: 'a' }] }),
    /section "a" .* needs a title/,
  );
  assert.throws(
    () => registerDoc({ id: 'dup-sec', title: 'x', sections: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }),
    /duplicate section id "a"/,
  );
  // Duplicate document id: the same id registered twice.
  registerDoc(doc('dup-doc'));
  assert.throws(() => registerDoc(doc('dup-doc')), /duplicate document id "dup-doc"/);
});

test('getDoc returns the registered document and undefined on a miss', () => {
  registerDoc(doc('lookup-doc'));
  assert.equal(getDoc('lookup-doc').id, 'lookup-doc');
  assert.equal(getDoc('never-registered'), undefined);
});

test('listDocs is registration order; a second manual changes its length (the switcher condition)', () => {
  const before = listDocs().length;
  registerDoc(doc('second-manual'));
  const after = listDocs();
  assert.equal(after.length, before + 1);
  assert.deepEqual(
    after.map((d) => d.id).slice(-2),
    ['lookup-doc', 'second-manual'],
    'registration order, not alphabetical',
  );
});

test('section anchors compose from HAND-AUTHORED ids only — never from titles', () => {
  assert.equal(sectionAnchor('user-guide', 'metric-language'), 'doc-user-guide-metric-language');
  // Pure: exactly two id inputs, so rewording a title cannot move an
  // anchor (the Builder `?` deep target stays stable by construction).
  assert.equal(sectionAnchor.length, 2);
  assert.equal(sectionAnchor('a-b', 'c-d'), 'doc-a-b-c-d');
});

test('the placeholder flag survives the round-trip as a boolean', () => {
  registerDoc({
    id: 'roundtrip-doc',
    title: 'Round trip',
    sections: [
      { id: 'real', title: 'Real', blocks: 'text' },
      { id: 'soon', title: 'Soon', placeholder: true },
      { id: 'plain', title: 'Plain', placeholder: false },
    ],
  });
  const sections = getDoc('roundtrip-doc').sections;
  assert.equal(sections[0].placeholder, false, 'absent normalizes to false');
  assert.equal(sections[1].placeholder, true);
  assert.equal(sections[2].placeholder, false);
  assert.equal(sections[0].blocks, 'text');
  assert.equal(sections[1].blocks, '', 'a placeholder carries no blocks');
});

test('the shipped user guide: exact section order, the metric chapter is the only real content', () => {
  const guide = getDoc('user-guide');
  assert.ok(guide, 'manuals/index.js must have registered the guide');
  assert.equal(guide.title, 'Spectra guide');
  assert.deepEqual(
    guide.sections.map((s) => s.id),
    [
      'getting-started',
      'import',
      'library',
      'match',
      'replay',
      'reports',
      'sql-console',
      'metric-language',
      'writing-an-expression',
      'sources',
      'player-anchor',
      'operators',
      'combining-sources',
      'scope',
      'denominators',
      'metric-references',
      'missing-data',
      'previewing',
      'built-in-metrics',
      'worked-examples',
      'common-errors',
      'settings',
    ],
    'the TOC order the popup renders (placeholders bracketing the metric chapter)',
  );
  const real = guide.sections.filter((s) => !s.placeholder);
  assert.equal(real.length, 14, 'exactly the metric-language chapter is written');
  assert.equal(real[0].id, 'metric-language', 'the Builder ? deep target');
  // Every placeholder section carries NO prose — only the fixed note
  // the renderer prints lives beside its title.
  for (const s of guide.sections.filter((p) => p.placeholder)) {
    assert.equal(s.blocks, '', `${s.id} must not smuggle content`);
  }
  // Every real section parses to at least one block of real content.
  for (const s of real) {
    assert.ok(s.blocks.length > 0, `${s.id} has no content`);
  }
});
