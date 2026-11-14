// strings/common.js — shared chrome — button labels, dialog verbs, generic nouns (Save/Cancel/Retry-class copy across every view)
// Skeleton (Stage 1): empty until Sweep-B extracts the area's copy (design
// §5.2); values are plain strings with {arg} placeholders (design §3.2).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const common = {
  // docs popup (DocsPopup.svelte — routed at merge, strings Stage 1 ∥ docs wave)
  closeHelp: 'Close help',
  tocLabel: 'Contents',
  backToTop: 'Back to top',
  guideComingSoon: 'Coming soon — this part of the guide isn\'t written yet.',
};
