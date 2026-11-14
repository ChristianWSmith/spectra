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

test('the shipped user guide: exact section order, every section is real content', () => {
  const guide = getDoc('user-guide');
  assert.ok(guide, 'manuals/index.js must have registered the guide');
  assert.equal(guide.title, 'Spectra guide');
  // Re-pinned 2026-11-14 (user-manual content onboarding): 22 → 26
  // entries — the researched draft replaced all eight placeholders and
  // added its four derived sections (lead rulings 2026-11-14: accept all
  // four), so the guide is now 12 written guide sections + the 14
  // metric-language chapter. The draft's ids won where the old shipped
  // placeholders differed (import → importing-demos, match →
  // understanding-a-match; the titles followed), and Introduction leads.
  assert.deepEqual(
    guide.sections.map((s) => s.id),
    [
      'introduction',
      'getting-started',
      'importing-demos',
      'library',
      'understanding-a-match',
      'match-analysis',
      'replay',
      'profiles',
      'metric-builder',
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
      'reports',
      'sql-console',
      'settings',
    ],
    'the TOC order the popup renders (the researched guide sections bracketing the metric chapter)',
  );
  const real = guide.sections.filter((s) => !s.placeholder);
  assert.equal(real.length, 26, 'every section is written since the content onboarding');
  // The Builder `?` deep target must exist as a section (App's
  // openDocs('metric-language') composes its anchor from this id).
  assert.ok(
    guide.sections.some((s) => s.id === 'metric-language'),
    'the metric-language section (Builder ? deep target) must keep its id',
  );
  // Every placeholder section carries NO prose — only the fixed note
  // the renderer prints lives beside its title (the guide ships none
  // today; this stays the invariant for any section that falls back).
  for (const s of guide.sections.filter((p) => p.placeholder)) {
    assert.equal(s.blocks, '', `${s.id} must not smuggle content`);
  }
  // Every real section parses to at least one block of real content.
  for (const s of real) {
    assert.ok(s.blocks.length > 0, `${s.id} has no content`);
  }
});
