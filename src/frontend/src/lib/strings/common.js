// strings/common.js — shared chrome — button labels, dialog verbs, generic nouns (Save/Cancel/Retry-class copy across every view)
// Skeleton (Stage 1): empty until Sweep-B extracts the area's copy (design
// §5.2); values are plain strings with {arg} placeholders (design §3.2).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const common = {
  // docs popup (DocsPopup.svelte — routed at merge, strings Stage 1 ∥ docs wave)
  closeHelp: 'Close help',
  tocLabel: 'Contents',
  searchSections: 'Search sections', // header input: placeholder + aria-label
  noSectionsMatch: 'No sections match your search.', // TOC empty state under a filter
  guideComingSoon: 'Coming soon — this part of the guide isn\'t written yet.',
  // manual TOC subsection toggle (manual-console wave, 2026-11-14) — the
  // one per-major fold button; the label reads from the EXPANDED state
  // (aria-expanded carries the state too)
  collapseSubsections: 'Collapse subsections',
  expandSubsections: 'Expand subsections',
};
