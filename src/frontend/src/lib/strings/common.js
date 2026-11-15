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

  // economy curve panel (EconCurve.svelte — the hand-rolled SVG chart)
  econCurveEquipHeading: 'Equip value per round', // panel heading, equip metric
  econCurveNetWorthHeading: 'Team net worth per round', // panel heading, net-worth metric
  econCurveMetricGroupLabel: 'Curve metric', // toggle group aria-label
  econCurveEquipToggle: 'Equip value', // toggle button label
  econCurveNetWorthToggle: 'Net worth', // toggle button label
  econCurveNoRows: 'No economy rows for this match.', // empty state
  econCurveTeamLinesLabel: 'Team lines', // legend aria-label
  econCurveEquipAria: 'equipment value', // chart aria-label, equip metric
  econCurveNetWorthAria: 'net worth', // chart aria-label, net-worth metric
  econCurveChartAriaSuffix: ' per round, one line per team — hover for values, click a column to open the round', // chart aria-label, after the metric name
  econCurveOpenRoundAria: 'Open round ', // hit-area aria-label prefix, before {r.round}
  econCurveRoundTitle: 'Round ', // round number prefix (<title> + tooltip <strong>)
  econCurvePistolChip: 'pistol', // hover tooltip's pistol-round chip
  econCurveTooltipEquip: 'equip', // hover tooltip column label
  econCurveTooltipNetWorth: 'net worth', // hover tooltip column label
  econCurveStripLabel: 'Round strip', // winner-strip aria-label
  // Strip legend (the <p> under the strip): each phrase runs up to the
  // next codicon glyph; the values carry the exact spacing the static
  // text rendered with (edge whitespace the compiler trimmed is already
  // trimmed here — rendered text stays byte-identical).
  econCurveStripPistol: ' pistol round · ',
  econCurveStripFavorite: ' favorite (higher buy\n      type) held · ',
  econCurveStripUpset: ' upset (lower buy type\n      won) · ',
  econCurveStripEven: ' even buy (toss-up) · ',
  econCurveStripNoVerdict: ' no verdict · click a round to open\n      it',

  // confirmation dialog (ConfirmDialog.svelte — the one window.confirm replacement)
  confirmDialogCancel: 'Cancel', // the cancel button label (the confirm button's label is the caller's confirmLabel prop)

  // kill-event flag chips (EventFlags.svelte — the "no flags apply" fallback)
  eventFlagsNone: 'none', // rendered when the none prop is set and no flag chip applies

  // event-filter bar (FilterBar.svelte — the Replay feed's advanced filter)
  filterBarLabel: 'Event filters', // the group aria-label
  filterBarRound: 'Round', // the round row's label cell
  filterBarFrom: 'from', // round-from input placeholder
  filterBarTo: 'to', // round-to input placeholder
  filterBarFirstRound: 'First round', // round-from input aria-label
  filterBarLastRound: 'Last round', // round-to input aria-label
  filterBarPlayer: 'Player', // the player facet's label cell
  filterBarAll: 'All', // every unconstrained <select>'s option text
  filterBarSide: 'Side', // the side facet's label cell
  filterBarTeam: 'Team', // the team facet's label cell
  filterBarStartedCt: 'Started CT', // team option — the start-side identity spelled out
  filterBarStartedT: 'Started T', // team option — the start-side identity spelled out
  filterBarWeapon: 'Weapon', // the weapon facet's label cell
  filterBarDist: 'Dist', // the distance row's label cell
  filterBarMin: 'min', // distance-min input placeholder
  filterBarMax: 'max', // distance-max input placeholder
  filterBarMinDist: 'Minimum distance', // distance-min input aria-label
  filterBarMaxDist: 'Maximum distance', // distance-max input aria-label
  filterBarHeadshotsOnly: 'Headshots only', // the headshot facet's label cell
  // The bbox chip: one fill for the tooltip (numbers are Math.round'ed at
  // the call site) and one for the chip's readable line — the line keeps
  // the exact spacing the compiler renders the static text with (edge
  // whitespace trimmed, the run's trailing space before the clear button
  // lives in the markup beside the expression).
  filterBarBboxTitle: 'Position filter: x {minX}…{maxX}, y {minY}…{maxY} (world units)',
  filterBarBboxLine: 'bbox {minX},{minY}–{maxX},{maxY}',
  filterBarClearBbox: 'Clear position filter', // the clear × button's aria-label
  filterBarReset: 'Reset', // the local reset button

  // canvas heatmap layer (HeatmapLayer.svelte — the radar/raster overlay)
  heatmapLayerLabel: 'Heatmap over the map grid', // the canvas aria-label
  heatmapLayerDrillTitle: 'Click a region to open the replay events for that position', // drillable kind: the canvas tooltip
  heatmapLayerNoDrillTitle: 'No region drill for this heatmap kind — its raster has no event rows behind it', // non-drillable kind: the canvas tooltip
};
