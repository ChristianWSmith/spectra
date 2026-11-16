// strings/heatmaps.js — Heatmaps view chrome (controls, legend, hints)
// Extracted from views/Heatmaps.svelte (Strings Stage 3, Sweep-B); values
// are plain strings with {arg} placeholders — compose at the call site with
// fill() from strings/index.js (the catalog contract).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const heatmaps = {
  dismissError: 'Dismiss error', // the ✕ inside the load/generate alert
  kindLabel: 'Kind',
  floorLabel: 'Floor', // field label + the floor group's aria-label
  playerLabel: 'Player',
  allPlayers: 'All players',
  sideLabel: 'Side',
  bothSides: 'Both',
  roundsFrom: 'Rounds from',
  roundsTo: 'Rounds to',
  allRounds: 'All', // both round-range selects' open-bound option
  controlsChanged: 'controls changed — press Regenerate to redraw the heatmap',
  plottedSuffix: ' plotted points · ', // after the sample count
  gridSuffix: ' grid · square-root scale', // after the W×H cell count
  bboxHint:
    'Drag a box on the map to open the replay events for that region (padded\n        to the splat’s reach); a single click opens one square.',
  noRowsSuffix: ' has no event rows behind it — a drag or click opens nothing.',
  emptyState: 'Choose filters and press Generate — heatmaps are computed on demand.',
};
