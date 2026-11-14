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
    // Normalize: every section carries a boolean placeholder and a
    // string blocks (placeholder sections skip their blocks at render).
    return { ...s, placeholder: s.placeholder === true, blocks: typeof s.blocks === 'string' ? s.blocks : '' };
  });
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
