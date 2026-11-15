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

  // App shell (App.svelte — the sidebar rail and the replay dock)
  appSidebarLabel: 'Main', // <nav class="sidebar"> accessible name
  appMarkAlt: 'Spectra', // the sidebar app-mark image (favicon) alt text
  appHelpLabel: 'Help', // sidebar Help button: title + aria-label
  appExpandReplayLabel: 'Expand replay', // collapsed dock wrapper: title + aria-label
  appCloseReplayLabel: 'Close replay', // dock close X: aria-label
  appCloseReplayTitle: 'Close the replay — it reloads when reopened', // dock close X: title

  // command palette (CommandPalette.svelte — Ctrl/Cmd-K overlay)
  commandPaletteLabel: 'Command palette', // Dialog accessible name
  commandPalettePlaceholder: 'Type a command or search…', // search input placeholder
  commandPaletteSearchLabel: 'Command palette search', // search input aria-label
  commandPaletteNoResultsPrefix: 'No results for “', // empty state, before the echoed {query}
  commandPaletteMoveHint: ' move', // footer: after the ↑↓ arrow glyphs
  commandPaletteRunHint: 'Enter run', // footer
  commandPaletteCloseHint: 'Esc close', // footer
  commandPaletteToggleHint: 'Ctrl/⌘K toggle', // footer
};
