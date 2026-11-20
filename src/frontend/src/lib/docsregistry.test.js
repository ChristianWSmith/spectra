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
  // N3 tier validation: `parent` must be a kebab id of a SIBLING section
  // that is itself a major (the contents list is two tiers, no deeper).
  assert.throws(
    () => registerDoc({ id: 'bad-parent', title: 'x', sections: [{ id: 'a', title: 'A', parent: 'Not Kebab' }] }),
    /parent must be kebab-case/,
  );
  assert.throws(
    () => registerDoc({ id: 'ghost-parent', title: 'x', sections: [{ id: 'a', title: 'A', parent: 'missing' }] }),
    /is not a section/,
  );
  assert.throws(
    () =>
      registerDoc({
        id: 'deep-parent',
        title: 'x',
        sections: [
          { id: 'top', title: 'Top' },
          { id: 'mid', title: 'Mid', parent: 'top' },
          { id: 'deep', title: 'Deep', parent: 'mid' },
        ],
      }),
    /is not a major/,
  );
  // …and a well-formed two-tier document registers (its tiers pass
  // through untouched — a minor's parent survives normalization).
  registerDoc({
    id: 'tiered-doc',
    title: 'Tiers',
    sections: [
      { id: 'chapter', title: 'Chapter' },
      { id: 'leaf', title: 'Leaf', parent: 'chapter' },
    ],
  });
  assert.equal(getDoc('tiered-doc').sections[1].parent, 'chapter');
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
  // 26 → 27 (w21, reports-builder): the Reports builder gained its own
  // section beside `reports`, taking the written count to 13.
  // 27 → 28 (2026-11-18, metrics Phase 7): the metric-language chapter
  // gained its `partitions` section (the partition option's manual
  // home).
  // 28 → 29 (C3, components): the Component builder gained its own
  // section beside `reports-builder`.
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
      'metric-cancel',
      'metric-language',
      'writing-an-expression',
      'sources',
      'player-anchor',
      'operators',
      'combining-sources',
      'scope',
      'partitions',
      'denominators',
      'metric-references',
      'missing-data',
      'previewing',
      'built-in-metrics',
      'worked-examples',
      'common-errors',
      'reports',
      'reports-builder',
      'component-builder',
      'sql-console',
      'settings',
    ],
    'the TOC order the popup renders (the researched guide sections bracketing the metric chapter)',
  );
  const real = guide.sections.filter((s) => !s.placeholder);
  assert.equal(real.length, 30, 'every section is written since the content onboarding');
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

test('the shipped guide is exactly two tiers: majors/minors partition it, every minor hangs off a major', () => {
  // N3 (2026-11-14): the contents list is TWO levels deep — the owner's
  // model: the twelve guide sections plus `metric-language` are MAJORS,
  // the metric chapter's other sections are MINORS under it (so
  // Denominators is a subheading of Metric language, not a peer of The
  // replay). The body renderer is deliberately tier-agnostic (every
  // section keeps its <h2>), so THIS is the pin on the tier data.
  const guide = getDoc('user-guide');
  const majors = guide.sections.filter((s) => s.parent === undefined);
  const minors = guide.sections.filter((s) => s.parent !== undefined);
  // Partition: the two classes cover the set exactly, at the model's
  // counts (15 + 14 = the 29 the order pin above lists; minors 13 → 14
  // with the 2026-11-18 `partitions` section; majors 14 → 15 with the
  // C3 Component builder section).
  assert.equal(majors.length + minors.length, guide.sections.length, 'no section is unclassified or double-counted');
  assert.equal(majors.length, 16, 'the 15 guide sections + Metric language');
  assert.equal(minors.length, 14, "the metric chapter's other sections");
  // Every minor's parent exists, IS a major, precedes it in document
  // order (TOC order must stay body order — the driver's index pins
  // line the two lists up), and every minor hangs off the SAME chapter.
  for (const m of minors) {
    const idx = guide.sections.findIndex((s) => s.id === m.parent);
    assert.ok(idx >= 0, `${m.id}: parent "${m.parent}" exists`);
    assert.equal(guide.sections[idx].parent, undefined, `${m.parent} is a major`);
    assert.ok(idx < guide.sections.indexOf(m), `${m.id} follows its parent`);
    assert.equal(m.parent, 'metric-language', `${m.id} hangs off the metric chapter`);
  }
  // No depth beyond two: no minor's parent may itself be a minor
  // (registration enforces this too — registerDoc rejects a nested
  // parent, this pins the shipped data against the same rule).
  const minorIds = new Set(minors.map((s) => s.id));
  for (const m of minors) {
    assert.equal(minorIds.has(m.parent), false, `${m.parent} must not itself be a minor`);
  }
  // The owner's worked example, pinned literally.
  assert.equal(guide.sections.find((s) => s.id === 'denominators').parent, 'metric-language');
});
