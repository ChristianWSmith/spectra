// Parser pins for the docs content model's markdown SUBSET
// (lib/docs/markdown.js — design §7.1.1). The renderer is the other
// half of the no-{@html} contract, so this file also scans the two docs
// components for the tag. Run from frontend/:
//   node --test src/lib/docsmd.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseBlocks, parseInline } from './docs/markdown.js';

const text = (t) => ({ type: 'text', text: t });

test('headings: #/##/### map to levels 1/2/3 (the renderer adds +2), ####+ degrades to a literal paragraph', () => {
  const blocks = parseBlocks('# one\n## two\n### three\n#### four');
  assert.deepEqual(
    blocks.map((b) => [b.type, b.level]),
    [
      ['heading', 1],
      ['heading', 2],
      ['heading', 3],
      ['paragraph', undefined],
    ],
  );
  assert.deepEqual(blocks[3].spans, [text('#### four')]);
  // No heading-level is ever invented beyond the subset: a 7-hash line
  // is not a heading either (the regex needs the space after ≤6 hashes).
  const seven = parseBlocks('####### nope');
  assert.equal(seven[0].type, 'paragraph');
});

test('paragraphs split on blank lines; soft-wrapped lines join with a space', () => {
  const blocks = parseBlocks('line one\nline two\n\nsecond para');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].spans, [text('line one line two')]);
  assert.deepEqual(blocks[1].spans, [text('second para')]);
});

test('fenced code: lang is kept, the opener’s indent is dedented, an unclosed fence runs to EOF', () => {
  assert.deepEqual(parseBlocks('```js\nlet x = 1;\n```'), [
    { type: 'code', lang: 'js', text: 'let x = 1;' },
  ]);
  // Opener indented 2 → both fence lines and content dedent by 2.
  assert.deepEqual(parseBlocks('  ```\n    indented\n  ```'), [
    { type: 'code', lang: '', text: '  indented' },
  ]);
  // Unclosed never throws and never loops: the rest is the block.
  assert.deepEqual(parseBlocks('```\nabc\ndef'), [{ type: 'code', lang: '', text: 'abc\ndef' }]);
});

test('lists: unordered, ordered, and nesting by ≥2-space indent', () => {
  const [ul] = parseBlocks('- a\n- b');
  assert.equal(ul.type, 'list');
  assert.equal(ul.ordered, false);
  assert.deepEqual(ul.items[0].spans, [text('a')]);

  const [ol] = parseBlocks('1. one\n2. two');
  assert.equal(ol.type, 'list');
  assert.equal(ol.ordered, true);
  assert.deepEqual(ol.items.map((i) => i.spans[0].text), ['one', 'two']);

  const [nested] = parseBlocks('- a\n  - b\n    - c');
  const a = nested.items[0];
  assert.equal(a.children.length, 1);
  const bList = a.children[0];
  assert.equal(bList.items[0].spans[0].text, 'b');
  assert.equal(bList.items[0].children[0].items[0].spans[0].text, 'c');
  // A 1-space indent is NOT nesting (the rule is ≥2).
  const [flat] = parseBlocks('- a\n - b');
  assert.equal(flat.items.length, 2);
  assert.equal(flat.items[0].children.length, 0, 'a flat item has no nested lists');
});

test('list nesting caps at depth 4 — deeper items flatten into the deepest list, text never drops', () => {
  // Six levels: indents 0/2/4/6/8/10 → lists only at depths 1..4.
  const src = ['- l0', '  - l1', '    - l2', '      - l3', '        - l4', '          - l5'].join('\n');
  const [root] = parseBlocks(src);
  let deepest = 0;
  const texts = [];
  const walk = (list, depth) => {
    deepest = Math.max(deepest, depth);
    for (const item of list.items) {
      texts.push(item.spans[0].text);
      for (const child of item.children || []) walk(child, depth + 1);
    }
  };
  walk(root, 1);
  assert.equal(deepest, 4, 'a fifth list level must not exist');
  assert.deepEqual(texts, ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'], 'every item survives the cap');
});

test('pipe tables: header row + |---| separator + body rows become span cells', () => {
  const [table] = parseBlocks('| A | B |\n|---|---|\n| 1 | `x` |');
  assert.equal(table.type, 'table');
  assert.deepEqual(table.header, [[text('A')], [text('B')]]);
  assert.deepEqual(table.rows, [
    [[text('1')], [{ type: 'code', text: 'x' }]],
  ]);
  // A `|` line whose next line is not a separator is just a paragraph.
  const [p] = parseBlocks('a | b\nc | d');
  assert.equal(p.type, 'paragraph');
});

test('inline: text, code, strong, em, underscore-em and links nest as spans', () => {
  assert.deepEqual(parseInline('a `c` **s** *e* [t](#h)'), [
    text('a '),
    { type: 'code', text: 'c' },
    text(' '),
    { type: 'strong', spans: [text('s')] },
    text(' '),
    { type: 'em', spans: [text('e')] },
    text(' '),
    { type: 'link', href: '#h', spans: [text('t')] },
  ]);
  // _em_ is GFM-style: OUTSIDE word characters only, so identifiers
  // like match_trade_opps / a_b_c are never emphasis.
  assert.deepEqual(parseInline('_u_'), [{ type: 'em', spans: [text('u')] }]);
  assert.deepEqual(parseInline('match_trade_opps'), [text('match_trade_opps')]);
  assert.deepEqual(parseInline('a_b_c'), [text('a_b_c')]);
  // Strong composes with code inside it (the draft's `**…**` never
  // flattens markup to characters).
  assert.deepEqual(parseInline('**x `y` z**'), [
    { type: 'strong', spans: [text('x '), { type: 'code', text: 'y' }, text(' z')] },
  ]);
});

test('HTML in source stays inert text (the renderer interpolates spans — never {@html})', () => {
  assert.deepEqual(parseInline('<b>hi</b> & "q"'), [text('<b>hi</b> & "q"')]);
  const [p] = parseBlocks('<script>alert(1)</script>');
  assert.equal(p.type, 'paragraph');
  assert.deepEqual(p.spans, [text('<script>alert(1)</script>')]);
  // The no-{@html} half of the contract: neither docs component may
  // contain the tag (the only {@html} in the app is Reports.svelte).
  // Comments are stripped first — they legitimately NAME the tag they
  // forbid (webstorage.test.js strips for the same reason).
  const stripComments = (s) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const rel of ['./components/DocBlocks.svelte', './components/DocsPopup.svelte']) {
    const src = stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
    assert.ok(!src.includes('{@html}'), `${rel} must not contain {@html}`);
  }
});

test('unsupported constructs degrade to paragraph text and never throw', () => {
  const cases = [
    ['image', '![alt](x.png)', '![alt](x.png)'],
    ['raw HTML', '<div>x</div>', '<div>x</div>'],
    ['reference link', 'see [docs][ref]', 'see [docs][ref]'],
    ['footnote', 'note[^1]', 'note[^1]'],
    ['blockquote marker dropped', '> quoted words', 'quoted words'],
    ['setext heading', 'Title\n---', 'Title ---'], // two paragraphs, no heading invented
    ['#### heading', '#### deep', '#### deep'],
  ];
  for (const [name, src, expected] of cases) {
    let blocks;
    assert.doesNotThrow(() => {
      blocks = parseBlocks(src);
    }, name);
    assert.ok(
      blocks.every((b) => b.type === 'paragraph'),
      `${name}: every block degrades to a paragraph`,
    );
    const joined = blocks.map((b) => b.spans.map((s) => s.text ?? '').join('')).join(' ');
    assert.equal(joined, expected, name);
  }
});

test('a blank line after a bullet ends the list — an indented fence under a bullet degrades to a top-level code block', () => {
  // The shape the metric manual's "Combining sources" section uses:
  // bullet, blank, indented example. The text must survive in order.
  const blocks = parseBlocks('- **point.** text\n\n  ```\n  from x: count()\n  ```\n- next');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['list', 'code', 'list'],
  );
  assert.equal(blocks[1].text, 'from x: count()');
  assert.deepEqual(blocks[2].items[0].spans, [text('next')]);
});
