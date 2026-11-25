// The manual's renderer (docs/render.js): marked for the markdown, DOMPurify for what the popup
// may show. Pins what a manual author relies on: heading offsets, inert raw HTML, link routing,
// tables, and the plain text the search reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOMPurify needs a window under node; the renderer picks it up from globalThis when it loads.
globalThis.window = new JSDOM('').window;
const { renderMarkdown, plainText } = await import('./docs/render.js');

test('headings start at h3 (the popup owns h1 and h2), and ####+ caps at h5', () => {
  assert.match(renderMarkdown('# Title'), /<h3>Title<\/h3>/);
  assert.match(renderMarkdown('## Title'), /<h4>Title<\/h4>/);
  assert.match(renderMarkdown('#### Deep'), /<h5>Deep<\/h5>/);
});

test('raw HTML in the source is shown as text, never run', () => {
  const html = renderMarkdown('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  // The markup is escaped text: no element is made, the tag shows as written.
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('an in-manual link stays in the popup; any other link opens in a new tab', () => {
  const inManual = renderMarkdown('[replay](#replay)');
  assert.match(inManual, /<a class="doc-link" href="#replay">replay<\/a>/);
  assert.doesNotMatch(inManual, /target="_blank"/);

  const external = renderMarkdown('[site](https://example.com/x)');
  assert.match(external, /href="https:\/\/example\.com\/x"/);
  assert.match(external, /target="_blank"/);
  assert.match(external, /rel="noopener noreferrer"/);
});

test('pipe tables render as scrollable data tables with header and body cells', () => {
  const html = renderMarkdown('| Name | Value |\n| --- | --- |\n| adr | 80 |');
  assert.match(html, /<div class="table-scroll"><table class="data-table">/);
  assert.match(html, /<th>Name<\/th><th>Value<\/th>/);
  assert.match(html, /<td>adr<\/td><td>80<\/td>/);
});

test('plainText is the searchable text: markup dropped, blocks separated', () => {
  const text = plainText('**Bold** text\n\nSecond & last');
  assert.doesNotMatch(text, /[<>]/);
  assert.match(text, /Bold text/);
  assert.match(text, /Second & last/);
  assert.match(text, /Bold text\n/);
});
