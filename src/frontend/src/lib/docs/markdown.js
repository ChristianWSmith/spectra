// The docs content model's markdown SUBSET parser (design §2.3): pure
// data in → AST out, no dependencies, no npm markdown library. The one
// renderer (DocBlocks.svelte) interpolates every span as Svelte TEXT —
// there is deliberately NO {@html} path anywhere in this feature, so
// HTML embedded in content is inert text by construction.
//
// Block level (parseBlocks):
//   heading    # / ## / ### at line start → {level: 1..3}
//              (the renderer maps level + 2: content sits under the
//              popup's <h1> title and the <h2> section titles)
//   paragraph  blank-line separated, soft-wrapped lines joined with a space
//   code       ```lang … ``` fenced block (unclosed runs to end of input)
//   list       -/* unordered, 1./1) ordered, nested by ≥2-space indent,
//              nesting capped at depth 4 (deeper items flatten into the
//              deepest list)
//   table      GFM pipe table with a |---| separator row
// Unsupported constructs degrade to paragraph text and NEVER throw:
// images, raw HTML, reference links, footnotes, setext headings, `>`
// blockquotes (the marker is dropped, the line stays a paragraph) and
// ####+ headings (kept literal).
//
// Inline (parseInline): text · `code` · **strong** · *em* · _em_
// (GFM-style: underscores only outside word characters, so
// `match_trade_opps` is never emphasis) · [text](href). Every span is
// data; strong/em/link nest their own spans so formatting composes.

// Block-start tests, shared by the paragraph accumulator and the block
// loop — they MUST agree or a line could be seen as a block start by
// one and a continuation by the other (an infinite loop).
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const THEMATIC = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

// Inline tokenizer: alternation order matters at a shared position —
// an image's literal syntax wins first (it degrades to TEXT: v1 manuals
// ship no images, and a bare `[alt](src)` inner match would otherwise
// masquerade as a link), then code wins (its content is never
// re-scanned), then link, then **strong** before *em* (an em cannot
// even start on the first star of a `**` pair: [^*] rejects it, but the
// order makes it certain). parseInline RECURSES into strong/em/link
// content, so each call gets its OWN /g instance — a shared module-level
// regex would have its lastIndex rewritten by the inner call and spin
// the outer loop forever.
const INLINE_SRC =
  '!\\[[^\\]]*\\]\\([^)]*\\)|`([^`]+)`|\\[([^\\]]+)\\]\\(([^)]+)\\)|\\*\\*([\\s\\S]+?)\\*\\*|(?<![\\w*])\\*([^*\\n]+?)\\*(?![\\w*])|(?<![\\w])_([^_\\n]+?)_(?![\\w])';

// parseInline — text → Span[]. Never throws: unmatched markup stays
// literal text (an odd backtick, a lone asterisk, `a_b_c` intraword
// underscores all degrade to their characters).
export function parseInline(text) {
  const src = String(text ?? '');
  const out = [];
  const re = new RegExp(INLINE_SRC, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: src.slice(last, m.index) });
    if (m[0].startsWith('!')) {
      out.push({ type: 'text', text: m[0] }); // image → literal text
    } else if (m[1] !== undefined) {
      out.push({ type: 'code', text: m[1] });
    } else if (m[2] !== undefined) {
      out.push({ type: 'link', href: m[3], spans: parseInline(m[2]) });
    } else if (m[4] !== undefined) {
      out.push({ type: 'strong', spans: parseInline(m[4]) });
    } else if (m[5] !== undefined) {
      out.push({ type: 'em', spans: parseInline(m[5]) });
    } else if (m[6] !== undefined) {
      out.push({ type: 'em', spans: parseInline(m[6]) });
    }
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // zero-width guard: never spin
  }
  if (last < src.length) out.push({ type: 'text', text: src.slice(last) });
  return out;
}

// strip up to `n` leading spaces (fenced-code dedent — GFM strips the
// opening fence's indentation from every content line).
function dedent(line, n) {
  let i = 0;
  while (i < n && i < line.length && line[i] === ' ') i++;
  return line.slice(i);
}

function matchListItem(line) {
  const m = LIST_ITEM.exec(line);
  if (!m) return null;
  return { indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] };
}

// parseList — one list level starting at `start`. A blank line, a
// non-list line (an indented fence or continuation under a bullet
// degrades to a top-level block) or a dedent below the level ends it.
// Nesting: an item indented ≥ base+2 opens a nested list inside the
// PREVIOUS item, capped at LIST_CAP depth (deeper items flatten into
// the deepest list rather than growing an unbounded tree).
const LIST_CAP = 4;

function parseList(lines, start, baseIndent, depth) {
  const first = matchListItem(lines[start]);
  const list = { type: 'list', ordered: first.ordered, items: [] };
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') break;
    const it = matchListItem(line);
    if (!it || it.indent < baseIndent) break;
    if (it.indent >= baseIndent + 2) {
      const parent = list.items[list.items.length - 1];
      if (!parent) {
        // Nested content with no item to hang on (leading indent) —
        // flatten: treat it as a same-level item, never drop the text.
        list.items.push({ spans: parseInline(it.text), children: [] });
        i++;
        continue;
      }
      if (depth >= LIST_CAP) {
        // Cap reached: flatten deeper levels into this list.
        list.items.push({ spans: parseInline(it.text), children: [] });
        i++;
        continue;
      }
      if (!parent.children) parent.children = [];
      const sub = parseList(lines, i, it.indent, depth + 1);
      parent.children.push(sub.list);
      i = sub.next;
      continue;
    }
    list.items.push({ spans: parseInline(it.text), children: [] });
    i++;
  }
  return { list, next: i };
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((cell) => parseInline(cell.trim()));
}

// parseBlocks — src → Block[]. Never throws on any input (every
// unsupported construct degrades; an unclosed fence consumes the rest
// of the input as code).
export function parseBlocks(src) {
  const lines = String(src ?? '').split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code: `​````lang` … closing fence (same char, ≥ the opener's
    // length, nothing else on the line); unclosed → rest of the input.
    const fence = FENCE.exec(line);
    if (fence) {
      const [, indent, marker, info] = fence;
      const close = new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(dedent(lines[i], indent.length));
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence
      blocks.push({ type: 'code', lang: info.trim(), text: body.join('\n') });
      continue;
    }

    // Heading — only #/##/### are in the subset; ####+ degrades to a
    // paragraph carrying the literal line (never a throw, never a
    // silently deeper heading than the renderer maps).
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      i++;
      if (level <= 3) {
        blocks.push({ type: 'heading', level, spans: parseInline(h[2].trim()) });
      } else {
        blocks.push({ type: 'paragraph', spans: parseInline(line) });
      }
      continue;
    }

    // Pipe table: a `|` line immediately followed by the separator row.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // List.
    const item = matchListItem(line);
    if (item) {
      const parsed = parseList(lines, i, item.indent, 1);
      blocks.push(parsed.list);
      i = parsed.next;
      continue;
    }

    // Thematic break / setext underline degrades to its own paragraph
    // of literal text (a `Title\n---` pair therefore stays two
    // paragraphs — text preserved, no heading invented).
    if (THEMATIC.test(line)) {
      blocks.push({ type: 'paragraph', spans: parseInline(line.trim()) });
      i++;
      continue;
    }

    // Paragraph: accumulate until blank or any block start (tests above,
    // re-checked so the two loops can never disagree). Soft-wrapped
    // lines join with a space (GFM renders the break as a space).
    const buf = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (FENCE.test(l) || HEADING.test(l) || THEMATIC.test(l) || matchListItem(l)) break;
      if (l.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) break;
      buf.push(l.replace(/^>\s?/, '').trim());
      i++;
    }
    blocks.push({ type: 'paragraph', spans: parseInline(buf.join(' ')) });
  }
  return blocks;
}
