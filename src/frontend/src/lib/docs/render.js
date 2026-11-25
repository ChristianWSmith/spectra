// render.js: the manual's markdown renderer. Content is markdown source (the sections' `blocks`);
// marked turns it into HTML, and DOMPurify removes everything the manual does not allow. Raw HTML
// in the source is shown as text, never run. The popup owns <h1> (the document title) and <h2> (a
// section title), so content headings start at <h3>.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

// In the browser DOMPurify is already bound to the window; under node (the DOM tests) it is a factory.
const purifier = typeof DOMPurify.sanitize === 'function' ? DOMPurify : DOMPurify(globalThis.window);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    heading({ tokens, depth }) {
      const level = Math.min(depth + 2, 5);
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titled = title ? ` title="${escapeHtml(title)}"` : '';
      // An in-manual link (#section) stays inside the popup; anything else opens in a new tab.
      if (href.startsWith('#')) return `<a class="doc-link" href="${escapeHtml(href)}"${titled}>${text}</a>`;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titled}>${text}</a>`;
    },
    image({ text }) {
      return escapeHtml(text);
    },
    html({ text }) {
      return escapeHtml(text);
    },
    table({ header, rows }) {
      const head = header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('');
      const body = rows
        .map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`)
        .join('');
      return `<div class="table-scroll"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>\n`;
    },
  },
});

// renderMarkdown returns the section source as sanitized HTML.
export function renderMarkdown(source) {
  const html = marked.parse(String(source ?? ''), { async: false });
  return purifier.sanitize(html, { ADD_ATTR: ['target'] });
}

// plainText is the section source as searchable text: block boundaries become line breaks, markup
// and entities are dropped.
export function plainText(source) {
  const html = renderMarkdown(source).replace(/<\/(p|li|h[1-6]|pre|tr|table|ul|ol)>/g, '\n$&');
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
