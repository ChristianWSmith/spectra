// THE documentation registry — documents (manuals) → sections, the
// content model the docs popup renders (design §2.1/§2.2). Pure JS with
// no Svelte runes on purpose: unit tests and jsdom drivers import this
// directly under plain `node`, and a rune here would break every
// plain-node import (viewstate.svelte.js's header states the rule).
//
// Manuals register themselves as a side effect: each module under
// docs/manuals/ calls registerDoc() at import time, and
// docs/manuals/index.js is ONE import line per manual. Adding a manual
// is a new module + one line — renderer, TOC, popup and entry points
// never change. Deliberately NOT import.meta.glob (Vite-only — it would
// break the plain-node unit tests and the jsdom drivers).
//
// Section ids are HAND-AUTHORED and stable: the anchor
// `doc-<docId>-<sectionId>` composes from ids only, never from titles,
// so rewording a section title can never break the Builder `?` deep
// target (metric-language) or any future link.
//
// Sections carry an OPTIONAL `parent` — the tier field (N3, 2026-11-14):
// absent → a MAJOR (a top-level contents entry), set to a sibling
// section's id → a MINOR (an entry nested under that major in the TOC).
// Depth is capped at TWO by registration (a parent must itself be a
// major). The body renderer still gives every section its own
// <section><h2>, whatever tier it is (rendering minors as <h3> would
// collide with the markdown headings inside their own content), but the
// field is no longer TOC-only: DocsPopup carries it into the body as
// .doc-section.major/.minor, so the heading sizes and the separator
// line between majors key off THIS criterion (C4, 2026-11-15) — global
// on `parent`, never scoped to one chapter.

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const docs = new Map(); // registration order — powers listDocs()

// sectionAnchor — THE anchor composition. Pure (docId, sectionId) →
// `doc-<docId>-<sectionId>`; collision-free across documents even if
// two ever rendered at once, and independent of every title.
export function sectionAnchor(docId, sectionId) {
  return `doc-${docId}-${sectionId}`;
}

// registerDoc — validates the whole document, normalizes every section
// (placeholder is always a boolean, blocks always a string), then
// accepts it. Throws on ANY violation — a malformed manual is a
// programming error, never something to paper over at render time.
export function registerDoc(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('registerDoc: a document object is required');
  if (typeof doc.id !== 'string' || !KEBAB.test(doc.id)) {
    throw new Error(`registerDoc: document id must be kebab-case (got ${JSON.stringify(doc.id)})`);
  }
  if (docs.has(doc.id)) throw new Error(`registerDoc: duplicate document id "${doc.id}"`);
  if (typeof doc.title !== 'string' || !doc.title.trim()) {
    throw new Error(`registerDoc: document "${doc.id}" needs a title`);
  }
  if (!Array.isArray(doc.sections) || doc.sections.length === 0) {
    throw new Error(`registerDoc: document "${doc.id}" needs at least one section`);
  }
  const seen = new Set();
  const sections = doc.sections.map((s) => {
    if (!s || typeof s !== 'object') throw new Error(`registerDoc: "${doc.id}" has a non-object section`);
    if (typeof s.id !== 'string' || !KEBAB.test(s.id)) {
      throw new Error(
        `registerDoc: section id must be kebab-case (got ${JSON.stringify(s.id)} in "${doc.id}")`,
      );
    }
    if (seen.has(s.id)) throw new Error(`registerDoc: duplicate section id "${s.id}" in "${doc.id}"`);
    seen.add(s.id);
    if (typeof s.title !== 'string' || !s.title.trim()) {
      throw new Error(`registerDoc: section "${s.id}" in "${doc.id}" needs a title`);
    }
    // The optional tier field: a parent must be a kebab id of a SIBLING
    // section (validated against the finished list below) — pass the
    // value through unchanged so the TOC can nest this section under it.
    if (s.parent !== undefined && (typeof s.parent !== 'string' || !KEBAB.test(s.parent))) {
      throw new Error(
        `registerDoc: section "${s.id}" parent must be kebab-case (got ${JSON.stringify(s.parent)} in "${doc.id}")`,
      );
    }
    // Normalize: every section carries a boolean placeholder and a
    // string blocks (placeholder sections skip their blocks at render).
    return { ...s, placeholder: s.placeholder === true, blocks: typeof s.blocks === 'string' ? s.blocks : '' };
  });
  // The two-tier contract, enforced at registration (the shipped guide's
  // shape is pinned in docsregistry.test.js): a parent must EXIST as a
  // section of this same document and must itself be a major — so no
  // section ever nests deeper than the TOC's two tiers.
  const byId = new Map(sections.map((s) => [s.id, s]));
  for (const s of sections) {
    if (s.parent === undefined) continue;
    const parent = byId.get(s.parent);
    if (!parent) {
      throw new Error(`registerDoc: section "${s.id}" parent "${s.parent}" is not a section of "${doc.id}"`);
    }
    if (parent.parent !== undefined) {
      throw new Error(
        `registerDoc: section "${s.id}" parent "${s.parent}" is not a major — the contents list is two tiers`,
      );
    }
  }
  docs.set(doc.id, { ...doc, sections });
}

// getDoc — the registered (normalized) document, or undefined on a miss.
export function getDoc(id) {
  return docs.get(id);
}

// listDocs — registration order. The popup renders its manual switcher
// only when this is longer than one (design §2.2: written generically
// on day one so the second manual needs no renderer work).
export function listDocs() {
  return [...docs.values()];
}
